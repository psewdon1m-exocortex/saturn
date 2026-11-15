import "reflect-metadata";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Database, migrate } from "@saturn/database";
import { CatalogCommitCoordinator, FileService, PostgresFileRepository, PostgresRootJournal,
  type CommitUploadRecord, type UploadPublicationReceipt, type RootJournalEvent, type RootJournalProjection, type Resource } from "@saturn/file-core";
import { LocalStorageAdapter } from "@saturn/storage";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import { DatabaseMetadataExporter, PostgresCommandToolchain, guardRecoveryMutation } from "@saturn/recovery";
import { expect, it, vi } from "vitest";
import { SyncClientController } from "./sync-client.controller.js";
import { AUTH_SERVICE, DEVICE_SERVICE } from "./tokens.js";

const fixturePath = process.env.SYNC_CATALOG_CJ01_FIXTURE;
const exec = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
interface Status { id: string; status: string; etag?: string; publicationReceipt?: UploadPublicationReceipt }
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const sqlScope = new AsyncLocalStorage<boolean>();

class ObservedDatabase extends Database {
  lostPublicationAck = false;
  override async transaction<T>(action: (sql: Transaction) => Promise<T>): Promise<T> {
    const result = await super.transaction(sql => sqlScope.run(true, () => action(sql)));
    if (this.lostPublicationAck && typeof result === "object" && result !== null && "publicationReceipt" in result) {
      this.lostPublicationAck = false;
      throw new Error("Fixture lost acknowledgement after actual PostgreSQL COMMIT");
    }
    return result;
  }
}

it.skipIf(!fixturePath)("qualifies inactive CJ01 sealed uploads as one catalog/receipt/event transaction through HTTP, PostgreSQL and actual local bytes", async () => {
  if (!fixturePath) throw new Error("Explicit owned CJ01 fixture is required");
  const fixture = JSON.parse(await fs.readFile(fixturePath,"utf8")) as { containerId: string; runId: string; databaseUrl: string; fixtureDirectory: string };
  const owned = JSON.parse((await exec("docker",["inspect",fixture.containerId],{ windowsHide: true })).stdout) as { Id: string; Config: { Labels: Record<string,string> }; State: { Running: boolean } }[];
  expect(owned[0]?.Id).toBe(fixture.containerId); expect(owned[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId); expect(owned[0]?.State.Running).toBe(true);
  const directory = path.join(fixture.fixtureDirectory,randomUUID().replaceAll("-","")); await fs.mkdir(directory);
  const admin = new Database(fixture.databaseUrl,{ max: 2 }), dbName = "catalog_"+randomUUID().replaceAll("-","");
  await admin.withSql(sql => sql.unsafe(`CREATE DATABASE ${dbName}`));
  const url = new URL(fixture.databaseUrl); url.pathname = "/"+dbName;
  const db = new ObservedDatabase(url.toString(),{ max: 12 });
  const storage = new LocalStorageAdapter(path.join(directory,"storage"));
  let app: NestFastifyApplication | undefined, passed = false;
  const checks: string[] = [], failures: { phase: string; message: string; code?: string }[] = [];
  const backendCounts: Record<string,number> = {}, sqlIoViolations: string[] = [];
  const storageSpies = (["stat","exists","write","openRead","mkdir","rename","delete","truncate","copy"] as const).map(method => {
    const original = storage[method].bind(storage);
    const spy = vi.spyOn(storage,method);
    // Each method retains its concrete signature; mockImplementation has the
    // union signature only at this test instrumentation boundary.
    spy.mockImplementation((...values: unknown[]) => {
      backendCounts[method] = (backendCounts[method] ?? 0)+1;
      if (sqlScope.getStore()) sqlIoViolations.push(method);
      return Reflect.apply(original,storage,values) as Promise<never>;
    });
    return spy;
  });
  try {
    await migrate(url.toString(),fileURLToPath(new URL("../../../packages/database/migrations/",import.meta.url)));
    await storage.initialize();
    const legacyRepository = new PostgresFileRepository(db), legacyFiles = new FileService(legacyRepository,storage);
    await legacyFiles.initializeStorage();
    const deviceRepository = new PostgresDeviceRepository(db);
    const options = { enabled: true, publicOrigin: "https://fixture.invalid", uploadChunkMaxBytes: 1024*1024, propfindMaxItems: 100, deleteMaxItems: 10, deleteWindowMs: 10000 };
    const makeDevices = (files: FileService) => new DeviceService({ repository: deviceRepository, files, pepper: "cj01-fixture-pepper-123456789012345678", options });
    const enrolling = makeDevices(legacyFiles);
    const enrolled = await enrolling.redeemWindowsEnrollment((await enrolling.createWindowsEnrollment("CJ01 A")).code,"fixture");
    const second = await enrolling.redeemWindowsEnrollment((await enrolling.createWindowsEnrollment("CJ01 B")).code,"fixture");
    const legacy = await enrolling.redeemWindowsEnrollment((await enrolling.createWindowsEnrollment("CJ01 legacy")).code,"fixture");
    const rootId = enrolled.device.syncRootId, secondRoot = second.device.syncRootId;
    if (!rootId || !secondRoot) throw new Error("No actual assigned fixture roots");
    const parents: Resource[] = [];
    for (let index=0;index<8;index++) parents.push(await legacyFiles.createFolder(index%2 ? secondRoot : rootId,"parent"+String(index)));
    const journal = new PostgresRootJournal(db), clock = await journal.registerRoot(rootId), peerClock = await journal.registerRoot(secondRoot);
    const backendIdentity = "owned-local:"+fixture.runId;
    const coordinator = new CatalogCommitCoordinator(db,[{ rootId,epoch: clock.epoch,backendIdentity },{ rootId: secondRoot,epoch: peerClock.epoch,backendIdentity }]);
    const repository = new PostgresFileRepository(db,{ catalogCommitCoordinator: coordinator });
    const files = new FileService(repository,storage,{ catalogBackendIdentity: backendIdentity });
    const devices = makeDevices(files);
    @Module({ controllers: [SyncClientController], providers: [{ provide: DEVICE_SERVICE,useValue: devices },{ provide: AUTH_SERVICE,useValue: {} }] })
    class TestModule { readonly fixture = "catalog-cj01"; }
    const adapter = new FastifyAdapter({ logger: false });
    adapter.getInstance().addContentTypeParser("application/octet-stream",(_request,payload,done) => done(null,payload));
    adapter.getInstance().addHook("onSend",(request,reply,payload,done) => { if (request.headers["x-fixture-lose-response"] === "yes") reply.raw.destroy(); done(null,payload); });
    app = await NestFactory.create<NestFastifyApplication>(TestModule,adapter,{ logger: false }); app.setGlobalPrefix("api/v1"); await app.listen(0,"127.0.0.1");
    const address = adapter.getInstance().server.address(); if (!address || typeof address === "string") throw new Error("No loopback fixture port");
    const base = `http://127.0.0.1:${String(address.port)}/api/v1/sync/uploads`;
    const send = (method: string,endpoint: string,payload?: object|Buffer,extra: Record<string,string> = {},token = enrolled.token) => fetch(endpoint,{ method, headers: { authorization: "Bearer "+token,
      ...(payload === undefined ? {} : Buffer.isBuffer(payload) ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" }),...extra },
      ...(payload === undefined ? {} : { body: Buffer.isBuffer(payload) ? payload : JSON.stringify(payload) }) });
    const json = async (response: Response): Promise<Status> => { expect(response.status,await response.clone().text()).toBeLessThan(300); expect(response.status).toBeGreaterThanOrEqual(200); return await response.json() as Status; };
    const input = (name: string,value: string,rootName = "CJ01 A",ifMatch?: string) => ({ path: "sync/"+rootName+"/"+name,expectedSize: Buffer.byteLength(value),expectedSha256: hash(value),idempotencyKey: hash(randomUUID()),
      ...(ifMatch === undefined ? { ifNoneMatch: "*" } : { ifMatch }) });
    const create = async (payload: ReturnType<typeof input>,token = enrolled.token) => json(await send("POST",base,payload,{},token));
    const append = async (upload: Status,value: string,token = enrolled.token) => { const bytes=Buffer.from(value); expect((await send("PATCH",base+"/"+upload.id,bytes,{ "upload-offset": "0","content-length": String(bytes.length) },token)).status).toBe(200); };
    const complete = async (upload: Status,token = enrolled.token) => json(await send("POST",base+"/"+upload.id+"/complete",undefined,{},token));
    const snapshot = () => db.withSql(sql => sql<{ root_id: string; epoch: string; published_seq: string; nodes: RootJournalEvent[] }[]>`SELECT c.root_id,c.epoch,c.published_seq::text,
      coalesce((SELECT jsonb_agg(document ORDER BY seq) FROM sync_root_changes WHERE root_id=c.root_id AND epoch=c.epoch),'[]'::jsonb) AS nodes FROM sync_root_clock c ORDER BY root_id`);
    const recordErrors = async (phase: string,action: () => Promise<unknown>) => { try { await action(); throw new Error("Expected fixture failure: "+phase); } catch (error) {
      if (!(error instanceof Error)) throw error; if (error.message.startsWith("Expected fixture failure")) throw error;
      failures.push({ phase,message: error.message,...(typeof error === "object" && "code" in error && typeof error.code === "string" ? { code: error.code } : {}) });
    } };
    const checkPublication = async (uploadId: string) => {
      const row = (await db.withSql(sql => sql<{ status: string; state: string; upload_receipt: UploadPublicationReceipt; sync_result: object; sync_first_seq: string; sync_last_seq: string; count: string }[]>`
        SELECT u.status,j.state,j.upload_receipt,j.sync_result,j.sync_first_seq::text,j.sync_last_seq::text,
          (SELECT count(*)::text FROM sync_root_changes WHERE operation_id=j.id) AS count FROM upload_sessions u JOIN operation_journal j ON j.id=u.id WHERE u.id=${uploadId}`))[0];
      expect(row).toBeDefined(); if (!row) throw new Error("No publication row");
      expect(row.status).toBe("active"); expect(row.state).toBe("active"); expect(row.sync_result).toMatchObject({ publicationReceipt: row.upload_receipt });
      expect(BigInt(row.sync_last_seq)-BigInt(row.sync_first_seq)+1n).toBe(BigInt(row.count));
      const events = await db.withSql(sql => sql<{ node_id: string; document: RootJournalEvent; parent_id: string|null; name: string; type: string; size_bytes: string; sha256: string|null; current_version_id: string|null }[]>`
        SELECT e.node_id,e.document,CASE WHEN r.id=j.sync_root_id THEN NULL ELSE r.parent_id END AS parent_id,r.name,r.type,r.size_bytes::text,r.sha256,r.current_version_id
        FROM sync_root_changes e JOIN operation_journal j ON j.id=e.operation_id JOIN resources r ON r.id=e.node_id WHERE e.operation_id=${uploadId} ORDER BY e.seq`);
      for (const event of events) expect(event.document.description).toEqual({ parentId: event.parent_id,name: event.name,type: event.type,sizeBytes: event.size_bytes,sha256: event.sha256,versionId: event.current_version_id });
      return row.upload_receipt;
    };

    const firstInput=input("parent0/versioned.txt","first payload"), first=await create(firstInput); await append(first,"first payload");
    await expect(send("POST",base+"/"+first.id+"/complete",undefined,{ "x-fixture-lose-response": "yes" })).rejects.toThrow();
    const v1=await checkPublication(first.id);
    expect(hash(await fs.readFile(path.join(directory,"storage",(await files.getResource(v1.resourceId)).storagePath)))).toBe(v1.sha256);
    expect((await snapshot()).find(row => row.root_id===rootId)?.nodes.map(node => node.nodeId).sort()).toEqual([rootId,parents[0]?.id,v1.resourceId].sort());
    const v2Input=input("parent0/versioned.txt","second payload", "CJ01 A",v1.etag), overwrite=await create(v2Input); await append(overwrite,"second payload");
    const v2=(await complete(overwrite)).publicationReceipt; if (!v2) throw new Error("No V2 receipt"); await checkPublication(overwrite.id);
    const replayBefore={ backend: { ...backendCounts },snapshot: await snapshot(),versions: await db.withSql(sql => sql`SELECT id FROM file_versions WHERE resource_id=${v1.resourceId}`) };
    for (const response of [await send("GET",base+"/"+first.id),await send("POST",base+"/"+first.id+"/complete"),await send("POST",base,firstInput)]) {
      const replay=await json(response); expect(replay.publicationReceipt).toEqual(v1); expect(replay.etag).toBe(v2.etag);
    }
    expect(backendCounts).toEqual(replayBefore.backend); expect(await snapshot()).toEqual(replayBefore.snapshot);
    expect(await db.withSql(sql => sql`SELECT id FROM file_versions WHERE resource_id=${v1.resourceId}`)).toEqual(replayBefore.versions);
    checks.push("actual lost V1 HTTP response, qualified V2 overwrite, historic V1 replay/current V2 etag, zero extra backend/version/event/clock effect");
    const rootBefore=await snapshot();
    for (const changed of [{ ifNoneMatch: undefined },{ ifMatch: '"other"' },{ expectedSha256: hash("other") },{ expectedSize: 1 },{ path: "sync/CJ01 A/other.txt" }]) expect((await send("POST",base,{ ...firstInput,...changed })).status).toBe(409);
    expect((await send("GET",base+"/"+first.id,undefined,{},second.token)).status).toBe(404); expect(await snapshot()).toEqual(rootBefore);
    const legacyUpload=await create(input("legacy.txt","legacy bytes","CJ01 legacy"),legacy.token); await append(legacyUpload,"legacy bytes",legacy.token); const legacyResult=await complete(legacyUpload,legacy.token);
    expect(legacyResult.publicationReceipt).toBeDefined(); expect((await snapshot())).toEqual(rootBefore);
    checks.push("exact changed intent/conditions rejected and peer hidden; unregistered existing Windows root keeps legacy receipt path without journal activation");

    await db.withSql(sql => sql.unsafe(`CREATE TABLE cj01_fault(phase text PRIMARY KEY); CREATE FUNCTION cj01_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS(SELECT 1 FROM cj01_fault WHERE phase=TG_TABLE_NAME) THEN RAISE EXCEPTION 'CJ01 injected atomic failure %',TG_TABLE_NAME; END IF;
      IF TG_TABLE_NAME='resources' AND EXISTS(SELECT 1 FROM cj01_fault WHERE phase='slow_resource') THEN PERFORM pg_sleep(1.5); END IF;
      IF TG_TABLE_NAME='resources' AND EXISTS(SELECT 1 FROM cj01_fault WHERE phase='delayed_concurrent') THEN PERFORM pg_sleep(0.004); END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER cj01_fault_resources BEFORE INSERT ON resources FOR EACH ROW EXECUTE FUNCTION cj01_fault();
      CREATE TRIGGER cj01_fault_versions BEFORE INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION cj01_fault();
      CREATE TRIGGER cj01_fault_changes BEFORE INSERT ON sync_root_changes FOR EACH ROW EXECUTE FUNCTION cj01_fault();
      CREATE TRIGGER cj01_fault_clock BEFORE UPDATE ON sync_root_clock FOR EACH ROW EXECUTE FUNCTION cj01_fault();
      CREATE FUNCTION cj01_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.upload_receipt IS NOT NULL AND OLD.upload_receipt IS NULL AND EXISTS(SELECT 1 FROM cj01_fault WHERE phase='receipt') THEN RAISE EXCEPTION 'CJ01 injected receipt failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER cj01_receipt_fault BEFORE UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION cj01_receipt_fault();`));
    let capturedRecord: CommitUploadRecord | undefined;
    const originalCommit=repository.commitUpload.bind(repository);
    const capture=vi.spyOn(repository,"commitUpload").mockImplementation(record => { capturedRecord=structuredClone(record); return originalCommit(record); });
    for (const phase of ["resources","file_versions","sync_root_changes","receipt","sync_root_clock","slow_resource"]) {
      const payload="fault payload "+phase, request=await create(input("fault-"+phase+".txt",payload)); await append(request,payload);
      const before=await snapshot(); await db.withSql(sql => sql`INSERT INTO cj01_fault(phase) VALUES(${phase})`);
      await recordErrors(phase,() => files.completeUpload(request.id));
      await db.withSql(sql => sql`DELETE FROM cj01_fault`);
      expect(await snapshot()).toEqual(before);
      const retained=await files.getUpload(request.id); expect(retained.status).toBe("failed_retryable"); expect(retained.publicationReceipt).toBeUndefined();
      expect(await storage.exists(retained.tempPath)).toBe(true); expect(await storage.exists(retained.targetPath)).toBe(false);
      expect((await db.withSql(sql => sql`SELECT id FROM operation_journal WHERE id=${request.id} AND sync_root_id=${rootId} AND sync_result IS NULL`)).length).toBe(1);
      await complete(request); await checkPublication(request.id);
    }
    checks.push("resource/version/event/receipt/clock failures and real pg_sleep callback deadline roll back all metadata/ranges; exact accepted key and verified temp bytes retained; addressed retries pass with no seq gaps");
    capture.mockRestore();
    if (!capturedRecord?.catalogEvidence) throw new Error("No actual verified FileService record captured");
    const replayRecord = capturedRecord;

    const ackRequest=await create(input("lost-sql-ack.txt","ack bytes")); await append(ackRequest,"ack bytes"); db.lostPublicationAck=true;
    const renameBefore=backendCounts.rename ?? 0; const ackResult=await complete(ackRequest); expect(ackResult.publicationReceipt).toBeDefined(); expect((backendCounts.rename ?? 0)-renameBefore).toBe(1); await checkPublication(ackRequest.id);
    checks.push("actual PostgreSQL COMMIT followed by lost application SQL acknowledgement returns original committed receipt without compensation/new effect (not a wire-level TCP fault claim)");

    const duplicate=await create(input("same-session.txt","same session bytes"));await append(duplicate,"same session bytes");
    const duplicateBefore={rename:backendCounts.rename ?? 0,clock:await snapshot()};
    const duplicates=await Promise.all(Array.from({length:12},()=>complete(duplicate)));
    expect(new Set(duplicates.map(row=>row.publicationReceipt?.versionId)).size).toBe(1);expect((backendCounts.rename ?? 0)-duplicateBefore.rename).toBe(1);
    expect(await db.withSql(sql=>sql`SELECT id FROM file_versions WHERE resource_id=${duplicates[0]?.publicationReceipt?.resourceId ?? ""}`)).toHaveLength(1);
    await checkPublication(duplicate.id);
    const replayBeforeDirect=await snapshot();const replayBytes={...backendCounts};
    const directReplay=await repository.commitUpload(replayRecord);expect(directReplay.publicationReceipt?.uploadId).toBe(replayRecord.uploadId);
    expect(await snapshot()).toEqual(replayBeforeDirect);expect(backendCounts).toEqual(replayBytes);
    if(!replayRecord.catalogEvidence)throw new Error("No prepared identity");
    for(const changed of [{rootId:secondRoot},{epoch:randomUUID()},{backendIdentity:"other-backend"},{uploadId:randomUUID()}]) {
      await expect(repository.commitUpload({...replayRecord,catalogEvidence:{...replayRecord.catalogEvidence,...changed}})).rejects.toMatchObject({code:"unprepared_upload"});
    }
    await expect(repository.commitUpload({...replayRecord,filename:"other-sealed-name.txt"})).rejects.toMatchObject({code:"operation_reused"});
    expect(await snapshot()).toEqual(replayBeforeDirect);expect(backendCounts).toEqual(replayBytes);
    checks.push("12 same-session actual HTTP completes publish exactly one physical rename/version/event range; transaction-bound direct original-record replay returns receipt without new effect");

    const unsealed=await legacyFiles.createUpload({parentId:rootId,filename:"bound-unsealed.txt",expectedSize:0,idempotencyKey:"bound-unsealed-"+randomUUID()});
    await journal.bindOperation(rootId,clock.epoch,unsealed.id,hash("isolated unsealed legacy binding"));
    const unsealedBefore={...backendCounts};await expect(files.completeUpload(unsealed.id)).rejects.toMatchObject({code:"unprepared_upload"});expect(backendCounts).toEqual(unsealedBefore);
    const missingComposition=new FileService(new PostgresFileRepository(db),storage);
    await expect(missingComposition.completeUpload(unsealed.id)).rejects.toThrow("requires its catalog commit coordinator");expect(backendCounts).toEqual(unsealedBefore);
    checks.push("unsealed foundation-bound legacy operation is explicitly unqualified; both coordinator and old composition reject before verification/backend IO rather than silently publishing/backfilling");

    const deep=await db.withSql(sql=>sql<{id:string;hops:number;storage_path:string}[]>`WITH RECURSIVE chain AS (
      SELECT gen_random_uuid() AS id,${rootId}::uuid AS parent_id,'d1'::text AS name,'sync/CJ01 A/d1'::text AS storage_path,1 AS hops
      UNION ALL SELECT gen_random_uuid(),id,'d'||(hops+1)::text,storage_path||'/d'||(hops+1)::text,hops+1 FROM chain WHERE hops<129
    ), inserted AS (INSERT INTO resources(id,type,parent_id,name,storage_path,status) SELECT id,'folder',parent_id,name,storage_path,'active' FROM chain RETURNING id,storage_path)
    SELECT i.id,c.hops,i.storage_path FROM inserted i JOIN chain c ON c.id=i.id ORDER BY c.hops`);
    const deep127=deep.find(row=>row.hops===127),deep128=deep.find(row=>row.hops===128);if(!deep127||!deep128)throw new Error("No bounded ancestry fixture");
    const deep128Upload=await create(input("parent6/qualified.txt","")),deep129Upload=await create(input("parent6/too-deep.txt","")),cycleUpload=await create(input("parent6/cycle.txt",""));
    const cycleParent=parents[6];if(!cycleParent)throw new Error("No cycle parent");
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${deep127.id} WHERE id=${cycleParent.id}`);
    expect(await coordinator.prepareUpload(deep128Upload.id,backendIdentity)).toBeDefined();
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${deep128.id} WHERE id=${cycleParent.id}`);
    const ancestryBytes={...backendCounts};await expect(coordinator.prepareUpload(deep129Upload.id,backendIdentity)).rejects.toMatchObject({code:"membership_changed"});
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=id WHERE id=${cycleParent.id}`);
    await expect(coordinator.prepareUpload(cycleUpload.id,backendIdentity)).rejects.toMatchObject({code:"membership_changed"});
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${rootId},status='trashed' WHERE id=${cycleParent.id}`);
    await expect(coordinator.prepareUpload(cycleUpload.id,backendIdentity)).rejects.toMatchObject({code:"membership_changed"});
    await db.withSql(sql=>sql`UPDATE resources SET status='active' WHERE id=${cycleParent.id}`);
    expect(backendCounts).toEqual(ancestryBytes);
    checks.push("actual preparation permits scoped depth128 and rejects129/cycle/inactive chain with zero physical IO (metadata-only fixture paths, no publication/feed authority claimed)");

    const admissionRequests=[];
    for(let index=0;index<5;index++) admissionRequests.push(await create(input("admission-"+String(index)+".txt","queued bytes")));
    let releaseClock: (() => void) | undefined, lockedClock: (() => void) | undefined;
    const locked = new Promise<void>(resolve => {lockedClock=resolve;});
    const release = new Promise<void>(resolve => {releaseClock=resolve;});
    const holder=db.transaction(async sql => {await sql`SELECT root_id FROM sync_root_clock WHERE root_id=${rootId} FOR UPDATE`;lockedClock?.();await release;});
    await locked;
    const admitted=admissionRequests.slice(0,4).map(request=>coordinator.prepareUpload(request.id,backendIdentity));
    try {
      let waiting=0;
      for(let attempt=0;attempt<100 && waiting<4;attempt++) {
        waiting=Number((await db.withSql(sql=>sql<{ count:string }[]>`SELECT count(*)::text FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT root_id,epoch,published_seq%'`))[0]?.count);
        if(waiting<4)await new Promise(resolve=>setTimeout(resolve,5));
      }
      expect(waiting).toBe(4);
      const lookup=vi.spyOn(db,"withSql"),transactionLookup=vi.spyOn(db,"transaction");
      await expect(coordinator.prepareUpload(admissionRequests[4]?.id ?? "",backendIdentity)).rejects.toMatchObject({code:"admission_full"});
      const cancelled=new AbortController();cancelled.abort();
      await expect(coordinator.prepareUpload(admissionRequests[4]?.id ?? "",backendIdentity,undefined,cancelled.signal)).rejects.toMatchObject({code:"cancelled"});
      expect(lookup).not.toHaveBeenCalled();expect(transactionLookup).not.toHaveBeenCalled();lookup.mockRestore();transactionLookup.mockRestore();
    } finally {releaseClock?.();await holder;await Promise.all(admitted);}
    checks.push("four locked-clock admissions maximum; fifth and pre-cancelled calls fail before candidate SQL/pool access; no unbounded coordinator wait queue");

    const concurrent=[];
    for(let index=0;index<100;index++) {
      const token=index%2 ? second.token : enrolled.token, payload="concurrent bytes "+String(index);
      const request=await create(input("parent"+String(index%8)+"/concurrent-"+String(index)+".txt",payload,index%2 ? "CJ01 B" : "CJ01 A"),token);
      await append(request,payload,token);concurrent.push(request);
    }
    // One hundred callers exercise the bounded coordinator, not one hundred
    // unbounded PostgreSQL transactions. Only admission rejections are retried.
    await db.withSql(sql=>sql`INSERT INTO cj01_fault(phase) VALUES('delayed_concurrent')`);
    const readStop=new AbortController();let consistentReads=0,readerError: unknown;
    const reader=(async()=>{while(!readStop.signal.aborted){
      const mixed=(await db.withSql(sql=>sql<{mixed:boolean}[]>`SELECT EXISTS(SELECT 1 FROM operation_journal j JOIN upload_sessions u ON u.id=j.upload_id
        WHERE j.sync_root_id IS NOT NULL AND j.upload_intent IS NOT NULL AND j.state='active' AND (j.sync_result IS NULL OR j.upload_receipt IS NULL OR u.status<>'active'
          OR NOT EXISTS(SELECT 1 FROM resources r JOIN file_versions v ON v.resource_id=r.id WHERE r.id=u.resource_id AND v.id=j.upload_published_version_id)
          OR (SELECT count(*) FROM sync_root_changes WHERE operation_id=j.id)<>j.sync_last_seq-j.sync_first_seq+1))
        OR EXISTS(SELECT 1 FROM sync_root_clock c WHERE c.published_seq<>(SELECT count(*) FROM sync_root_changes e WHERE e.root_id=c.root_id AND e.epoch=c.epoch)) AS mixed`))[0]?.mixed;
      expect(mixed).toBe(false);consistentReads++;await new Promise(resolve=>setTimeout(resolve,2));
    }})().catch((error:unknown)=>{readerError=error;readStop.abort();});
    const firstWave=await Promise.allSettled(concurrent.map(request=>files.completeUpload(request.id)));
    const retry: (Status | undefined)[]=[];
    for(let index=0;index<firstWave.length;index++) {
      const result=firstWave[index];
      if(result?.status==="rejected") {expect(result.reason).toMatchObject({code:"admission_full"});retry.push(concurrent[index]);}
    }
    expect(retry.length).toBeGreaterThan(0);
    let cursor=0;
    try {await Promise.all(Array.from({length:4},async()=>{while(cursor<retry.length){const request=retry[cursor++];if(request)await files.completeUpload(request.id);}}));}
    finally {readStop.abort();await reader;await db.withSql(sql=>sql`DELETE FROM cj01_fault WHERE phase='delayed_concurrent'`);}
    expect(readerError).toBeUndefined();expect(consistentReads).toBeGreaterThan(5);
    for(const request of concurrent)expect((await files.getUpload(request.id)).status).toBe("active");
    const prefixes=await snapshot();
    for(const prefix of prefixes) {
      const sequences=await db.withSql(sql=>sql<{seq:string}[]>`SELECT e.seq::text FROM sync_root_changes e WHERE root_id=${prefix.root_id} AND epoch=${prefix.epoch} ORDER BY e.seq`);
      expect(sequences.map(row=>row.seq)).toEqual(Array.from({length:sequences.length},(_,index)=>String(index+1)));
      expect(prefix.published_seq).toBe(String(sequences.length));
      const latest=new Map<string,RootJournalProjection>();for(const event of prefix.nodes)latest.set(event.nodeId,event.description);
      const current=await db.withSql(sql=>sql<{id:string;parent_id:string|null;name:string;type:"file"|"folder";size_bytes:string;sha256:string|null;current_version_id:string|null}[]>`
        SELECT id,CASE WHEN id=${prefix.root_id} THEN NULL ELSE parent_id END AS parent_id,name,type,size_bytes::text,sha256,current_version_id FROM resources WHERE id=ANY(${[...latest.keys()]}::uuid[])`);
      for(const row of current)expect(latest.get(row.id)).toEqual({parentId:row.parent_id,name:row.name,type:row.type,sizeBytes:row.size_bytes,sha256:row.sha256,versionId:row.current_version_id});
    }
    checks.push("100 concurrent actual uploads across two roots/eight parents with delayed SQL: fixed four admissions, only admission retries, all active; globally sorted shared accounting ancestor locks; independent contiguous commit prefixes/latest full-event projections equal SQL catalog; "+String(consistentReads)+" concurrent one-statement readers observe no partial catalog/version/session/receipt/event/clock commit");

    const timeoutBefore=await snapshot();let lateError: unknown;
    const lateAttempt=new Promise<void>(resolve=>{
      void coordinator.commitUpload(replayRecord,async sql=>{
        setTimeout(()=>{void sql`SELECT id FROM operation_journal WHERE id=${replayRecord.uploadId}`.catch((error: unknown)=>{lateError=error;resolve();});},1100);
        await new Promise(resolveTimer=>setTimeout(resolveTimer,1500));
        throw new Error("Late callback must never complete");
      }).catch((error: unknown)=>{failures.push({phase:"late_callback",message:error instanceof Error ? error.message : String(error)});});
    });
    await lateAttempt;expect(lateError).toMatchObject({code:"callback_expired"});expect(await snapshot()).toEqual(timeoutBefore);
    await expect(coordinator.commitUpload(capturedRecord,async sql=>{await sql.unsafe("COMMIT");throw new Error("forbidden SQL unexpectedly allowed");})).rejects.toMatchObject({code:"invalid_input"});
    const cancel=new AbortController();
    const cancelledCommit=coordinator.commitUpload(capturedRecord,async sql=>{await sql.unsafe("SELECT pg_sleep(1.5)");throw new Error("cancelled callback completed");},cancel.signal);
    setTimeout(()=>cancel.abort(),20);await expect(cancelledCommit).rejects.toMatchObject({code:"cancelled"});expect(await snapshot()).toEqual(timeoutBefore);
    checks.push("actual callback timeout invalidates late SQL facade; transaction-control SQL rejected; in-flight pg_sleep cancellation rolls back without publishing or changing prefixes");

    const uncertain=await create(input("unknown-rollback.txt","unknown bytes"));await append(uncertain,"unknown bytes");
    const renameSpy=storageSpies.find((_spy,index)=>index===5);if(!renameSpy)throw new Error("No instrumented rename");
    const ordinaryRename=renameSpy.getMockImplementation();if(!ordinaryRename)throw new Error("No actual rename implementation");
    renameSpy.mockImplementationOnce(async(...args: unknown[])=>{await Reflect.apply(ordinaryRename,storage,args);await db.withSql(sql=>sql`UPDATE devices SET state='revoked' WHERE id=${enrolled.device.id}`);}).mockRejectedValueOnce(new Error("CJ01 injected rollback uncertainty"));
    const beforeUnknown=await snapshot();expect((await send("POST",base+"/"+uncertain.id+"/complete")).status).toBe(500);
    const retained=await files.getUpload(uncertain.id);expect(retained.status).toBe("committing");expect(retained.publicationReceipt).toBeUndefined();
    expect(await storage.exists(retained.targetPath)).toBe(true);expect(await storage.exists(retained.tempPath)).toBe(false);expect(await snapshot()).toEqual(beforeUnknown);
    const unknownBackend={...backendCounts};await expect(files.completeUpload(uncertain.id)).rejects.toMatchObject({code:"authorization_changed"});expect(backendCounts).toEqual(unknownBackend);
    await expect(files.abandonUpload(uncertain.id)).rejects.toThrow("cannot be abandoned");
    await expect(db.withSql(sql=>sql`DELETE FROM operation_journal WHERE id=${uncertain.id}`)).rejects.toThrow("cannot be deleted");
    await db.withSql(sql=>sql`UPDATE devices SET state='active' WHERE id=${enrolled.device.id}`);
    await complete(uncertain);await checkPublication(uncertain.id);
    checks.push("post-rename auth loss plus failed compensation preserves committing/UNKNOWN verified target and accepted key; revoked worker performs zero backend IO; abandonment/deletion blocked; explicit restored auth reconciles original UUID once");

    const pathRequest=await create(input("parent0/path-drift.txt","path bytes"));await append(pathRequest,"path bytes");
    const pathBefore=await snapshot(), oldPath=parents[0]?.storagePath;if(!oldPath)throw new Error("No parent path");
    renameSpy.mockImplementationOnce(async(...args:unknown[])=>{await Reflect.apply(ordinaryRename,storage,args);await db.withSql(sql=>sql`UPDATE resources SET storage_path=${oldPath+"-late"} WHERE id=${parents[0]?.id ?? ""}`);});
    const pathConflict = await send("POST", base + "/" + pathRequest.id + "/complete");
    expect(pathConflict.status).toBe(409);
    expect(await pathConflict.json()).toMatchObject({ code: "membership_changed" });
    expect((await files.getUpload(pathRequest.id)).status).toBe("failed_retryable");expect(await snapshot()).toEqual(pathBefore);
    await db.withSql(sql=>sql`UPDATE resources SET storage_path=${oldPath} WHERE id=${parents[0]?.id ?? ""}`);await complete(pathRequest);await checkPublication(pathRequest.id);
    checks.push("verified physical destination mismatch against final locked parent path aborts catalog/receipt/events, compensates to temp and retries only after explicit fixture path restoration");

    const beforeBigint=(await snapshot()).find(row=>row.root_id===rootId)?.published_seq;if(!beforeBigint)throw new Error("No bigint clock");
    await db.withSql(sql=>sql`UPDATE sync_root_clock SET published_seq=9007199254740993 WHERE root_id=${rootId}`);
    const bigintUpload=await create(input("exact-bigint.txt","bigint bytes"));await append(bigintUpload,"bigint bytes");await complete(bigintUpload);
    const bigRange=(await db.withSql(sql=>sql<{first:string;last:string}[]>`SELECT sync_first_seq::text AS first,sync_last_seq::text AS last FROM operation_journal WHERE id=${bigintUpload.id}`))[0];
    expect(bigRange?.first).toBe("9007199254740994");expect(bigRange?.last).toBe("9007199254740995");
    const capped=await create(input("counter-exhausted.txt","cap bytes"));await append(capped,"cap bytes");
    await db.withSql(sql=>sql`UPDATE sync_root_clock SET published_seq=9223372036854775807 WHERE root_id=${rootId}`);const capBefore=await snapshot();
    await expect(files.completeUpload(capped.id)).rejects.toMatchObject({code:"counter_exhausted"});expect(await snapshot()).toEqual(capBefore);expect((await files.getUpload(capped.id)).status).toBe("failed_retryable");
    // Isolated synthetic high-sequence fixture intentionally has a jump; it is
    // precision/exhaustion evidence, never an authoritative contiguous feed.
    await db.withSql(sql=>sql`UPDATE sync_root_clock SET published_seq=${bigRange?.last ?? beforeBigint} WHERE root_id=${rootId}`);await complete(capped);
    checks.push("actual PostgreSQL seq >2^53 remains exact decimal; signed-bigint exhaustion rolls back metadata/ranges and retains retryable payload (synthetic jumped prefix, not feed authority)");

    const tool=(database:Database,databaseUrl:string)=>new PostgresCommandToolchain({database,databaseUrl,maximumDumpBytes:32*1024*1024,commandTimeoutMs:15000,snapshotTimeoutMs:15000,
      pgDumpExecutable:"docker",pgRestoreExecutable:"docker",pgDumpPrefixArgs:["exec",fixture.containerId,"pg_dump"],pgRestorePrefixArgs:["exec","-i",fixture.containerId,"pg_restore"],
      commandConnectionArgs:["--username","postgres","--dbname",new URL(databaseUrl).pathname.slice(1)]});
    const currentOwner=JSON.parse((await exec("docker",["inspect",fixture.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>}}[];
    expect(currentOwner[0]?.Id).toBe(fixture.containerId);expect(currentOwner[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);
    const dump=path.join(directory,"cj01.dump"),metadata=path.join(directory,"metadata");
    await tool(db,url.toString()).createCoherentBackup(dump,metadata,new DatabaseMetadataExporter(db));
    const manifest=JSON.parse(await fs.readFile(path.join(metadata,"coherence.json"),"utf8")) as {journal:{registeredRoots:string;finalReceipts:string;pendingOperations:string;dumpPolicy:string}};
    expect(manifest.journal.registeredRoots).toBe("2");expect(BigInt(manifest.journal.finalReceipts)).toBeGreaterThanOrEqual(110n);expect(BigInt(manifest.journal.pendingOperations)).toBeGreaterThan(0n);
    expect(manifest.journal.dumpPolicy).toBe("durable-journal-with-upload-dependencies");
    const exportedOps=(await fs.readFile(path.join(metadata,"operation_journal.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line) as {id:string;sync_first_seq:string;sync_result:object});
    expect(exportedOps.find(row=>row.id===bigintUpload.id)?.sync_first_seq).toBe("9007199254740994");
    const originalResult=(await db.withSql(sql=>sql<{sync_result:object}[]>`SELECT sync_result FROM operation_journal WHERE id=${first.id}`))[0]?.sync_result;
    expect(exportedOps.find(row=>row.id===first.id)?.sync_result).toEqual(originalResult);
    const restoredName="catalog_restore_"+randomUUID().replaceAll("-","");await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${restoredName}`));
    const restoredUrl=new URL(fixture.databaseUrl);restoredUrl.pathname="/"+restoredName;const restoredDb=new Database(restoredUrl.toString(),{max:2});
    try {
      const restoredTool=tool(restoredDb,restoredUrl.toString());await restoredTool.restoreDump(dump,"clean");
      expect((await new PostgresFileRepository(restoredDb).getUpload(first.id))?.publicationReceipt).toEqual(v1);
      expect((await restoredDb.withSql(sql=>sql<{sync_result:object}[]>`SELECT sync_result FROM operation_journal WHERE id=${first.id}`))[0]?.sync_result).toEqual(originalResult);
      await expect(restoredTool.verifyRestoredDatabase()).rejects.toThrow("explicit backend reconciliation");
      await expect(restoredTool.commitReplacement()).rejects.toThrow("explicit backend reconciliation");
      await expect(tool(restoredDb,restoredUrl.toString()).checkReady()).rejects.toThrow("Interrupted restore");
      await restoredTool.rollbackReplacement();
    } finally {await restoredDb.close();await admin.withSql(sql=>sql.unsafe(`DROP DATABASE ${restoredName} WITH (FORCE)`));}
    await expect(tool(db,url.toString()).beginReplacement()).rejects.toThrow("explicit backend reconciliation");
    await expect(db.transaction(sql=>guardRecoveryMutation(sql))).rejects.toThrow("explicit backend reconciliation");
    checks.push("current coherent real pg_dump/pg_restore preserves CJ01 pending/final unified operations, events, immutable receipt and exact decimal ranges; registered restored/source reset/replacement/restart remain inspection-only fail closed");
    const capabilities=await devices.syncMetadataCapabilities(await devices.authenticate("Bearer "+enrolled.token),rootId);
    expect(capabilities.features).toMatchObject({ snapshot: false,deltaFeed: false,conditionalVersions: false,newSyncEngine: false,immutableUploadReceipt: false });
    expect(sqlIoViolations).toEqual([]);
    checks.push("explicit coordinator fixture composition only; actual storage calls never inherit SQL transaction scope; all live capabilities unchanged false");
    passed=true;
  } finally {
    storageSpies.forEach(spy => spy.mockRestore());
    await fs.writeFile(path.join(directory,"results.json"),JSON.stringify({ ok: passed,checks,failures,backendCounts,sqlIoViolations,coverage: "inactive CJ01 actual local backend; wider writers/feed/snapshot/takeover/native/endurance OPEN" },null,2));
    await app?.close().catch(() => undefined); await storage.close().catch(() => undefined); await db.close();
    await admin.withSql(sql => sql.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`)); await admin.close();
  }
},120000);
