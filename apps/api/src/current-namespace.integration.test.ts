import "reflect-metadata";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash,randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter,type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Database,migrate,listMigrationPairs } from "@saturn/database";
import { CatalogCommitCoordinator,FileService,PostgresFileRepository,PostgresRootJournal,PostgresCurrentNamespace,namespaceTombstone,
  type NamespaceChange,type NamespaceDescriptor,type UploadPublicationReceipt } from "@saturn/file-core";
import { LocalStorageAdapter } from "@saturn/storage";
import { DeviceService,PostgresDeviceRepository } from "@saturn/sync";
import { DatabaseMetadataExporter,PostgresCommandToolchain,guardRecoveryMutation } from "@saturn/recovery";
import { inspectJournal } from "../../../packages/recovery/src/consistent-snapshot.js";
import { expect,it,vi } from "vitest";
import { SyncClientController } from "./sync-client.controller.js";
import { AUTH_SERVICE,DEVICE_SERVICE } from "./tokens.js";
const fixturePath=process.env.SYNC_CATALOG_CJ02_FIXTURE,exec=promisify(execFile);
const hash=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
interface Status {id:string;etag?:string;publicationReceipt?:UploadPublicationReceipt}
function fixtureId(ids:readonly string[],index:number):string { const value=ids[index];if(value===undefined)throw new Error('Missing fixture identity');return value; }
type Sql=Parameters<Parameters<Database["withSql"]>[0]>[0];
class RecordingDatabase extends Database {
  recording=false;statements=0;projection:{strings:TemplateStringsArray;parameters:readonly unknown[]}|undefined;
  override withSql<T>(action:(sql:Sql)=>Promise<T>):Promise<T>{return super.withSql(sql=>action(new Proxy(sql,{apply:(target,thisArg,args:unknown[])=>{
    const strings=args[0] as TemplateStringsArray;
    if(this.recording && typeof strings[0]==="string"){this.statements++;if(strings[0].includes("WITH RECURSIVE binding"))this.projection={strings,parameters:args.slice(1)};}
    return Reflect.apply(target,thisArg,args) as unknown;
  }})));}
}

it.skipIf(!fixturePath)("qualifies inactive metadata UUID, full namespace publication, atomic binding invalidation and coherent recovery on owned PostgreSQL and HTTP",async()=>{
  if(!fixturePath)throw new Error("Explicit owned fixture required");
  const fixture=JSON.parse(await fs.readFile(fixturePath,"utf8")) as {containerId:string;runId:string;databaseUrl:string;fixtureDirectory:string};
  const owned=JSON.parse((await exec("docker",["inspect",fixture.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>};HostConfig:{NanoCpus:number;Memory:number};State:{Running:boolean}}[];
  expect(owned[0]?.Id).toBe(fixture.containerId);expect(owned[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);expect(owned[0]?.State.Running).toBe(true);
  expect(owned[0]?.HostConfig.NanoCpus).toBeLessThanOrEqual(1e9);expect(owned[0]?.HostConfig.Memory).toBeLessThanOrEqual(512*1024*1024);
  const directory=path.join(fixture.fixtureDirectory,randomUUID().replaceAll("-",""));await fs.mkdir(directory);
  const admin=new Database(fixture.databaseUrl,{max:2}),name="metadata_"+randomUUID().replaceAll("-","");await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${name}`));
  const url=new URL(fixture.databaseUrl);url.pathname="/"+name;const db=new RecordingDatabase(url.toString(),{max:8});
  const storage=new LocalStorageAdapter(path.join(directory,"storage"));let app:NestFastifyApplication|undefined,passed=false;
  const checks:string[]=[],backend:Record<string,number>={};const spies=(["write","rename","openRead","stat","exists","mkdir"] as const).map(method=>{
    const original=storage[method].bind(storage);return vi.spyOn(storage,method).mockImplementation((...args:unknown[])=>{backend[method]=(backend[method]??0)+1;return Reflect.apply(original,storage,args) as Promise<never>;});
  });
  // Keep the 0049→0050 regression explicit; a separate latest-schema test applies
  // every current migration so this cutoff cannot conceal future incompatibility.
  const sourceMigrations=fileURLToPath(new URL("../../../packages/database/migrations/",import.meta.url));
  const migrations=path.join(directory,"qualified-0050-migrations"),prior=path.join(directory,"prior-migrations");
  const failures:{phase:string;message:string}[]=[];
  const reject=async(phase:string,action:()=>Promise<unknown>)=>{try{await action();throw new Error("Missing expected failure "+phase);}catch(error){if(!(error instanceof Error)||error.message.startsWith("Missing expected"))throw error;failures.push({phase,message:error.message});}};
  try{
    await fs.mkdir(prior);await fs.mkdir(migrations);
    for(const pair of await listMigrationPairs(sourceMigrations)){
      const number=Number(pair.name.split('_')[0]);if(number>50)continue;
      for(const file of [pair.up,pair.down]){
        await fs.copyFile(file,path.join(migrations,path.basename(file)));
        if(number<50)await fs.copyFile(file,path.join(prior,path.basename(file)));
      }
    }
    expect((await listMigrationPairs(migrations)).at(-1)?.name).toBe("0050_current_namespace_metadata");
    await migrate(url.toString(),prior);await storage.initialize();const legacyRepo=new PostgresFileRepository(db),legacyFiles=new FileService(legacyRepo,storage);await legacyFiles.initializeStorage();
    const deviceRepo=new PostgresDeviceRepository(db),options={enabled:true,publicOrigin:"https://fixture.invalid",uploadChunkMaxBytes:1024*1024,propfindMaxItems:100,deleteMaxItems:10,deleteWindowMs:10000};
    const makeDevices=(files:FileService)=>new DeviceService({repository:deviceRepo,files,pepper:"cj02-fixture-pepper-123456789012345678",options});
    const enrolling=makeDevices(legacyFiles),enrolled=await enrolling.redeemWindowsEnrollment((await enrolling.createWindowsEnrollment("CJ02 A")).code,"fixture"),peer=await enrolling.redeemWindowsEnrollment((await enrolling.createWindowsEnrollment("CJ02 B")).code,"fixture");
    const rootId=enrolled.device.syncRootId,peerRoot=peer.device.syncRootId;if(!rootId||!peerRoot)throw new Error("Missing assigned root");
    const parent=await legacyFiles.createFolder(rootId,"parent"),untouched=await legacyFiles.createFolder(rootId,"untouched");
    const oldAccepted=await enrolling.createResumableUpload(await enrolling.authenticate("Bearer "+enrolled.token),{
      path:"sync/CJ02 A/parent/pre-upgrade-pending.txt",expectedSize:8,expectedSha256:hash("oldbytes"),idempotencyKey:hash("old-accepted-"+randomUUID()),ifNoneMatch:"*"});
    const oldWal=await db.withSql(sql=>sql`SELECT * FROM operation_journal ORDER BY id`),oldSessions=await db.withSql(sql=>sql`SELECT * FROM upload_sessions ORDER BY id`);
    expect(oldWal.length).toBeGreaterThan(0);
    const before=await db.withSql(sql=>sql`SELECT id,parent_id,name,storage_path,status,size_bytes::text FROM resources ORDER BY id`),devicesBefore=await db.withSql(sql=>sql`SELECT * FROM devices ORDER BY id`);
    const walBefore=(await db.withSql(sql=>sql<{lsn:string}[]>`SELECT pg_current_wal_lsn()::text AS lsn`))[0]?.lsn;
    expect(await migrate(url.toString(),migrations)).toBe(1);
    expect(await db.withSql(sql=>sql`SELECT id,parent_id,name,storage_path,status,size_bytes::text FROM resources ORDER BY id`)).toEqual(before);expect(await db.withSql(sql=>sql`SELECT * FROM devices ORDER BY id`)).toEqual(devicesBefore);
    expect(await db.withSql(sql=>sql`SELECT * FROM operation_journal ORDER BY id`)).toEqual(oldWal);expect(await db.withSql(sql=>sql`SELECT * FROM upload_sessions ORDER BY id`)).toEqual(oldSessions);expect((await legacyFiles.getUpload(oldAccepted.id)).status).not.toBe("active");
    expect(await db.withSql(sql=>sql`SELECT id FROM resources WHERE metadata_version IS NOT NULL OR sync_availability IS NOT NULL`)).toHaveLength(0);
    const down=await fs.readFile(path.join(migrations,"0050_current_namespace_metadata.down.sql"),"utf8"),up=await fs.readFile(path.join(migrations,"0050_current_namespace_metadata.up.sql"),"utf8");
    await db.transaction(sql=>sql.unsafe(down));await db.transaction(sql=>sql.unsafe(up));
    expect(await db.withSql(sql=>sql`SELECT id,parent_id,name,storage_path,status,size_bytes::text FROM resources ORDER BY id`)).toEqual(before);
    checks.push("additive 0049→0050 preserves old catalogue, native device/token identity and existing WAL; nullable unused downgrade/up preserves catalogue without backfill");
    const journal=new PostgresRootJournal(db),clock=await journal.registerRoot(rootId),namespace=new PostgresCurrentNamespace(db);
    await expect(namespace.qualifyFixture(rootId,[rootId,peerRoot])).rejects.toThrow("projection_unqualified");
    const binding=await namespace.qualifyFixture(rootId,[rootId,parent.id]);
    const descriptor=async(id:string,bindingId=binding):Promise<NamespaceDescriptor>=>{const result=(await namespace.read(rootId,bindingId,[id]))[0];if(result?.status!=="FOUND")throw new Error("No qualified descriptor");return result.descriptor;};
    expect(await descriptor(rootId)).toMatchObject({parent_id:null,availability:"UNKNOWN"});
    expect(await namespace.read(rootId,binding,[untouched.id,peerRoot,randomUUID()])).toEqual([{status:"UNKNOWN",nodeId:untouched.id},{status:"UNKNOWN",nodeId:peerRoot},expect.objectContaining({status:"UNKNOWN"})]);
    await expect(namespace.read(rootId,binding,Array.from({length:501},()=>randomUUID()))).rejects.toThrow("invalid_input");
    await expect(namespace.read(rootId,binding,[parent.id,parent.id])).rejects.toThrow("invalid_input");
    const many=Array.from({length:500},()=>randomUUID());
    await db.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
      SELECT id,'folder',${rootId}::uuid,'bounded-'||ordinal,'fixture-only/bounded-'||ordinal,'active'
      FROM unnest(${many}::uuid[]) WITH ORDINALITY AS entries(id,ordinal)`);
    expect((await namespace.read(rootId,binding,many)).every(row=>row.status==="FOUND" && row.descriptor.availability==="UNKNOWN")).toBe(true);
    const deep=Array.from({length:129},()=>randomUUID());
    await db.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
      SELECT id,'folder',CASE WHEN ordinal=1 THEN ${rootId}::uuid ELSE (${deep}::uuid[])[ordinal::integer-1] END,'depth-'||ordinal,'fixture-only/depth-'||ordinal,'active'
      FROM unnest(${deep}::uuid[]) WITH ORDINALITY AS entries(id,ordinal)`);
    expect((await namespace.read(rootId,binding,[fixtureId(deep,127),fixtureId(deep,128)])).map(row=>row.status)).toEqual(["FOUND","UNKNOWN"]);
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${fixtureId(deep,128)} WHERE id=${fixtureId(deep,128)}`);
    expect((await namespace.read(rootId,binding,[fixtureId(deep,128)]))[0]?.status).toBe("UNKNOWN");
    await db.withSql(sql=>sql`UPDATE resources SET status='trashed' WHERE id=${fixtureId(deep,0)}`);
    expect((await namespace.read(rootId,binding,[fixtureId(deep,10)]))[0]?.status).toBe("UNKNOWN");
    const nested=await journal.registerRoot(fixtureId(many,0));
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${nested.rootId} WHERE id=${fixtureId(many,1)}`);
    expect((await namespace.read(rootId,binding,[fixtureId(many,1)]))[0]?.status).toBe("UNKNOWN");
    const huge=fixtureId(many,2);await db.withSql(sql=>sql`UPDATE resources SET name=repeat('x',2048) WHERE id=${huge}`);
    await expect(namespace.read(rootId,binding,[huge])).rejects.toThrow("invalid_input");
    await db.withSql(sql=>sql`UPDATE resources SET name='bounded-restored' WHERE id=${huge}`);
    checks.push("bounded500 descriptors/501+duplicate rejection, exact128 ancestor boundary, cycles/inactive chain/nested registered scope hidden as UNKNOWN; oversized SQL name never transferred to Node");
    const lockedRead=async(action:()=>Promise<void>)=>{
      let announce:()=>void=()=>{throw new Error("Lock announcement uninitialized");},release:()=>void=()=>{throw new Error("Lock release uninitialized");};
      const ready=new Promise<void>(resolve=>{announce=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});
      const lock=db.transaction(async sql=>{await sql`LOCK TABLE resources IN ACCESS EXCLUSIVE MODE`;announce();await done;});
      await ready;try{await action();}finally{release();await lock;}
    };
    await lockedRead(async()=>{
      db.recording=true;db.statements=0;const reads=Array.from({length:4},()=>namespace.read(rootId,binding,[parent.id]));
      await expect(namespace.read(rootId,binding,[parent.id])).rejects.toMatchObject({code:"admission_full"});expect(db.statements).toBe(4);db.recording=false;
      // Read queries must settle while lock is held; timeout cancels them and
      // leaves no detached late successful query or queued admission.
      const outcomes=await Promise.allSettled(reads);expect(outcomes.every(result=>result.status==="rejected" && result.reason instanceof Error && result.reason.message==="read_timeout")).toBe(true);
    });
    expect((await namespace.read(rootId,binding,[parent.id]))[0]?.status).toBe("FOUND");
    checks.push("actual table-blocked reads enforce fixed4 admission before SQL, fifth rejected/no queue, all queries canceled and settled by2s deadline, next read recovers");
    const original=await descriptor(parent.id);await db.withSql(sql=>sql`UPDATE resources SET storage_path=storage_path,updated_at=now(),metadata_version=${randomUUID()} WHERE id=${parent.id}`);expect(await descriptor(parent.id)).toEqual(original);
    const originalPath=parent.storagePath;await db.withSql(sql=>sql`UPDATE resources SET storage_path=${originalPath+"-private"} WHERE id=${parent.id}`);expect(await descriptor(parent.id)).toEqual(original);await db.withSql(sql=>sql`UPDATE resources SET storage_path=${originalPath} WHERE id=${parent.id}`);
    for(const mutation of ["name","parent","size","status","availability"]){
      const old=await descriptor(parent.id);
      if(mutation==="name")await db.withSql(sql=>sql`UPDATE resources SET name='renamed' WHERE id=${parent.id}`);
      if(mutation==="parent")await db.withSql(sql=>sql`UPDATE resources SET parent_id=${untouched.id} WHERE id=${parent.id}`);
      if(mutation==="size")await db.withSql(sql=>sql`UPDATE resources SET size_bytes=9007199254740993 WHERE id=${parent.id}`);
      if(mutation==="status")await db.withSql(sql=>sql`UPDATE resources SET status='trashed' WHERE id=${parent.id}`);
      if(mutation==="availability")await db.withSql(sql=>sql`UPDATE resources SET sync_availability='UNAVAILABLE' WHERE id=${parent.id}`);
      const changed=(await db.withSql(sql=>sql<{metadata_version:string}[]>`SELECT metadata_version FROM resources WHERE id=${parent.id}`))[0]?.metadata_version;expect(changed).not.toBe(old.version);
      if(mutation==="size")expect((await descriptor(parent.id)).size_bytes).toBe("9007199254740993");
      await db.withSql(sql=>sql`UPDATE resources SET name='parent',parent_id=${rootId},size_bytes=0,status='active',sync_availability=NULL WHERE id=${parent.id}`);
    }
    checks.push("direct SQL semantic UUID renewal for rename/reparent/status/availability/exact bigint aggregate; private path, updated_at and forged no-op UUID remain stable; no claim of journal coverage");
    const backendIdentity="owned-local:"+fixture.runId,coordinator=new CatalogCommitCoordinator(db,[{rootId,epoch:clock.epoch,backendIdentity,namespaceBindingVersion:binding}]);
    const repository=new PostgresFileRepository(db,{catalogCommitCoordinator:coordinator}),files=new FileService(repository,storage,{catalogBackendIdentity:backendIdentity}),devices=makeDevices(files);
    @Module({controllers:[SyncClientController],providers:[{provide:DEVICE_SERVICE,useValue:devices},{provide:AUTH_SERVICE,useValue:{}}]})class TestModule{readonly fixture="cj02";}
    const adapter=new FastifyAdapter({logger:false});adapter.getInstance().addContentTypeParser("application/octet-stream",(_request,payload,done)=>done(null,payload));
    adapter.getInstance().addHook("onSend",(request,reply,payload,done)=>{if(request.headers["x-fixture-lose-response"]==="yes")reply.raw.destroy();done(null,payload);});
    app=await NestFactory.create<NestFastifyApplication>(TestModule,adapter,{logger:false});app.setGlobalPrefix("api/v1");await app.listen(0,"127.0.0.1");
    const address=adapter.getInstance().server.address();if(!address||typeof address==="string")throw new Error("No loopback port");const base=`http://127.0.0.1:${String(address.port)}/api/v1/sync/uploads`;
    const send=(method:string,endpoint:string,payload?:object|Buffer,extra:Record<string,string>={},token=enrolled.token)=>fetch(endpoint,{method,headers:{authorization:"Bearer "+token,...(payload===undefined?{}:Buffer.isBuffer(payload)?{"content-type":"application/octet-stream"}:{"content-type":"application/json"}),...extra},...(payload===undefined?{}:{body:Buffer.isBuffer(payload)?payload:JSON.stringify(payload)})});
    const json=async(response:Response):Promise<Status>=>{expect(response.status,await response.clone().text()).toBeLessThan(300);return await response.json() as Status;};
    const input=(filename:string,content:string,ifMatch?:string)=>({path:"sync/CJ02 A/parent/"+filename,expectedSize:Buffer.byteLength(content),expectedSha256:hash(content),idempotencyKey:hash(randomUUID()),...(ifMatch?{ifMatch}:{ifNoneMatch:"*"})});
    const create=async(payload:ReturnType<typeof input>)=>json(await send("POST",base,payload));
    const append=async(upload:Status,content:string)=>{expect((await send("PATCH",base+"/"+upload.id,Buffer.from(content),{"upload-offset":"0"})).status).toBe(200);};
    const complete=async(upload:Status)=>json(await send("POST",base+"/"+upload.id+"/complete"));
    const clockNow=()=>db.withSql(sql=>sql<{root_id:string;epoch:string;published_seq:string;namespace_state:string;binding_version:string|null}[]>`SELECT root_id,epoch,published_seq::text,namespace_state,binding_version FROM sync_root_clock ORDER BY root_id`);
    const checkPublication=async(uploadId:string)=>{
      const events=await db.withSql(sql=>sql<{node_id:string;document:NamespaceChange}[]>`SELECT node_id,document FROM sync_root_changes WHERE operation_id=${uploadId} ORDER BY seq`);
      expect(events.length).toBeGreaterThan(0);for(const event of events){expect(event.document.schema).toBe("saturn.current-namespace-change.v1");expect(event.document.description).toEqual(await descriptor(event.node_id));}
      return events;
    };
    const firstInput=input("versioned.txt","identical payload"),first=await create(firstInput);await append(first,"identical payload");const parentBefore=await descriptor(parent.id),rootBefore=await descriptor(rootId);
    await expect(send("POST",base+"/"+first.id+"/complete",undefined,{"x-fixture-lose-response":"yes"})).rejects.toThrow();
    const v1=(await files.getUpload(first.id)).publicationReceipt;if(!v1)throw new Error("Missing V1 receipt");await checkPublication(first.id);
    const d1=await descriptor(v1.resourceId);expect(d1.availability).toBe("AVAILABLE");expect((await descriptor(parent.id)).version).not.toBe(parentBefore.version);expect((await descriptor(rootId)).version).not.toBe(rootBefore.version);
    const second=await create(input("versioned.txt","identical payload",v1.etag));await append(second,"identical payload");const beforeSameParents=[await descriptor(parent.id),await descriptor(rootId)];
    const v2=(await complete(second)).publicationReceipt;if(!v2)throw new Error("Missing V2 receipt");expect(v2.sha256).toBe(v1.sha256);expect(v2.versionId).not.toBe(v1.versionId);
    const d2=await descriptor(v1.resourceId);expect(d2.version).not.toBe(d1.version);expect(d2.content_version_id).toBe(v2.versionId);expect([await descriptor(parent.id),await descriptor(rootId)]).toEqual(beforeSameParents);
    expect((await checkPublication(second.id)).map(e=>e.node_id)).toEqual([v1.resourceId]);
    const replayBefore={backend:{...backend},clock:await clockNow(),events:await db.withSql(sql=>sql`SELECT * FROM sync_root_changes ORDER BY seq`)};
    for(const response of [await send("GET",base+"/"+first.id),await send("POST",base+"/"+first.id+"/complete"),await send("POST",base,firstInput)]){const replay=await json(response);expect(replay.publicationReceipt).toEqual(v1);expect(replay.etag).toBe(v2.etag);}
    expect(backend).toEqual(replayBefore.backend);expect(await clockNow()).toEqual(replayBefore.clock);expect(await db.withSql(sql=>sql`SELECT * FROM sync_root_changes ORDER BY seq`)).toEqual(replayBefore.events);
    expect((await send("GET",base+"/"+first.id,undefined,{},peer.token)).status).toBe(404);
    await expect(journal.read({rootId,epoch:clock.epoch,afterSeq:"0"})).rejects.toMatchObject({code:"projection_mismatch"});
    checks.push("actual lost V1 HTTP response, same-SHA V2 renews content/metadata identity but NOOP aggregates stable; immutable V1 replay/current V2 ETag has zero backend/version/event effects; legacy reader rejects new document discriminator");
    await db.withSql(sql=>sql`UPDATE resources SET name='unqualified-direct-name' WHERE id=${v1.resourceId}`);
    expect((await descriptor(v1.resourceId)).availability).toBe("UNKNOWN");
    await db.withSql(sql=>sql`UPDATE resources SET name='versioned.txt',sync_availability='AVAILABLE' WHERE id=${v1.resourceId}`);
    // A verified same-byte publication is the path that reestablishes availability;
    // a direct same-value AVAILABLE carried through another public mutation is reset.
    expect((await descriptor(v1.resourceId)).availability).toBe("AVAILABLE");
    checks.push("unqualified direct namespace mutation invalidates previously AVAILABLE content rather than silently carrying old verification forward");
    const concurrent=await create(input("concurrent.txt","concurrent"));await append(concurrent,"concurrent");const completions=await Promise.all(Array.from({length:3},()=>complete(concurrent)));expect(new Set(completions.map(r=>r.publicationReceipt?.versionId)).size).toBe(1);await checkPublication(concurrent.id);
    const beforeInvalidation=await db.withSql(sql=>sql`SELECT id,metadata_version,sync_availability FROM resources ORDER BY id`),beforeClock=await clockNow();
    const late=await create(input("late-uncertain.txt","verified physical uncertainty"));await append(late,"verified physical uncertainty");
    const lateClock=await clockNow(),rename=spies[1];let uncertain="",invalidated=false;
    if(!rename)throw new Error("Missing rename observer");
    // Capture original concrete method rather than calling the spied method recursively.
    rename.mockRestore();const actualRename=storage.rename.bind(storage);
    const lateRename=vi.spyOn(storage,"rename").mockImplementation(async(source,destination)=>{backend.rename=(backend.rename??0)+1;await actualRename(source,destination);if(!invalidated){invalidated=true;uncertain=await namespace.markBackendUncertain(rootId,binding);}});
    await reject("late backend uncertainty after verified physical rename",()=>files.completeUpload(late.id));lateRename.mockRestore();
    spies.push(vi.spyOn(storage,"rename").mockImplementation(async(source,destination)=>{backend.rename=(backend.rename??0)+1;await actualRename(source,destination);}));
    expect(uncertain).not.toBe(binding);expect(await db.withSql(sql=>sql`SELECT id,metadata_version,sync_availability FROM resources ORDER BY id`)).toEqual(beforeInvalidation);
    const pending=(await db.withSql(sql=>sql<{upload_receipt:unknown;sync_result:unknown;sync_root_id:string|null}[]>`SELECT upload_receipt,sync_result,sync_root_id FROM operation_journal WHERE id=${late.id}`))[0];
    expect(pending).toMatchObject({upload_receipt:null,sync_result:null,sync_root_id:rootId});expect((await clockNow())[0]?.published_seq).toBe(lateClock[0]?.published_seq);
    expect(await namespace.read(rootId,binding,[v1.resourceId,rootId])).toEqual([{status:"UNKNOWN",nodeId:v1.resourceId},{status:"UNKNOWN",nodeId:rootId}]);
    const blocked=await create(input("uncertain.txt","retained unknown"));await append(blocked,"retained unknown");const beforeBlocked={...backend};
    await reject("uncertain root prepare before backend",()=>files.completeUpload(blocked.id));expect(backend).toEqual(beforeBlocked);expect((await files.getUpload(blocked.id)).status).not.toBe("active");
    const requalified=await namespace.qualifyFixture(rootId,[rootId,parent.id]);expect(requalified).not.toBe(binding);expect(requalified).not.toBe(uncertain);
    await reject("old qualified binding never resurrects",()=>files.completeUpload(blocked.id));expect(backend).toEqual(beforeBlocked);
    expect((await clockNow())[0]).toMatchObject({epoch:beforeClock[0]?.epoch,published_seq:beforeClock[0]?.published_seq});
    checks.push("concurrent completion has one publication; BACKEND_UNCERTAIN atomically invalidates whole binding without descendant rewrite/epoch rotation; old binding blocked before physical work even after explicit requalification");
    const retained=await descriptor(v1.resourceId,requalified),tombstone=namespaceTombstone(retained,"fixture.confirmed.delete",{type:"fixture",id:fixture.runId},"confirmed_sql_namespace_removal");
    await db.withSql(sql=>sql`UPDATE resources SET status='trashed' WHERE id=${v1.resourceId}`);
    expect(await namespace.read(rootId,requalified,[v1.resourceId])).toEqual([{status:"UNKNOWN",nodeId:v1.resourceId}]);expect(tombstone.before_version).toBe(retained.version);expect(tombstone.description.version).not.toBe(retained.version);
    await db.withSql(sql=>sql`UPDATE resources SET status='active' WHERE id=${v1.resourceId}`);
    checks.push("confirmed deletion fixture retains scoped full preimage and independent deletion UUID; inactive/hidden lookup stays UNKNOWN, never implicit tombstone or ABSENT");
    const inspect=()=>db.withSql(sql=>inspectJournal(sql));expect(await inspect()).toMatchObject({namespaceShape:"saturn.current-namespace.v1",namespaceBindings:"1",dumpPolicy:"durable-journal-with-upload-dependencies"});
    await db.withSql(sql=>sql`UPDATE resources SET size_bytes=9007199254740993 WHERE id=${untouched.id}`);
    await reject("partial namespace shape",()=>db.transaction(async sql=>{await sql`ALTER TABLE resources RENAME COLUMN metadata_version TO broken_metadata_version`;await inspectJournal(sql);}));
    await reject("disabled namespace guard",()=>db.transaction(async sql=>{await sql`ALTER TABLE resources DISABLE TRIGGER resource_metadata_version_guard`;await inspectJournal(sql);}));
    await reject("initialized downgrade",()=>db.transaction(sql=>sql.unsafe(down)));
    await expect(db.transaction(sql=>guardRecoveryMutation(sql))).rejects.toThrow("explicit backend reconciliation");
    const tool=(database:Database,databaseUrl:string)=>new PostgresCommandToolchain({database,databaseUrl,maximumDumpBytes:32*1024*1024,commandTimeoutMs:15000,snapshotTimeoutMs:15000,pgDumpExecutable:"docker",pgRestoreExecutable:"docker",
      pgDumpPrefixArgs:["exec",fixture.containerId,"pg_dump"],pgRestorePrefixArgs:["exec","-i",fixture.containerId,"pg_restore"],commandConnectionArgs:["--username","postgres","--dbname",new URL(databaseUrl).pathname.slice(1)]});
    const ownerAgain=JSON.parse((await exec("docker",["inspect",fixture.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>}}[];expect(ownerAgain[0]?.Id).toBe(fixture.containerId);expect(ownerAgain[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);
    const dump=path.join(directory,"namespace.dump"),metadata=path.join(directory,"metadata");await tool(db,url.toString()).createCoherentBackup(dump,metadata,new DatabaseMetadataExporter(db));
    const manifest=JSON.parse(await fs.readFile(path.join(metadata,"coherence.json"),"utf8")) as {journal:object};expect(manifest.journal).toEqual(await inspect());
    const exports=(await fs.readFile(path.join(metadata,"resources.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line) as {id:string;metadata_version:string|null;sync_availability:string|null;size_bytes:string});expect(exports.find(r=>r.id===v1.resourceId)?.metadata_version).toBe((await descriptor(v1.resourceId,requalified)).version);expect(exports.find(r=>r.id===untouched.id)?.size_bytes).toBe("9007199254740993");
    const restoredName="metadata_restore_"+randomUUID().replaceAll("-","");await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${restoredName}`));const restoredUrl=new URL(fixture.databaseUrl);restoredUrl.pathname="/"+restoredName;const restored=new Database(restoredUrl.toString(),{max:2});
    try{const restoredTool=tool(restored,restoredUrl.toString());await restoredTool.restoreDump(dump,"clean");expect(await restored.withSql(sql=>inspectJournal(sql))).toEqual(await inspect());expect((await new PostgresFileRepository(restored).getUpload(first.id))?.publicationReceipt).toEqual(v1);
      expect(await restored.withSql(sql=>sql`SELECT root_id,epoch,published_seq::text,namespace_state,binding_version FROM sync_root_clock ORDER BY root_id`)).toEqual(await clockNow());
      await expect(restoredTool.verifyRestoredDatabase()).rejects.toThrow("explicit backend reconciliation");await expect(tool(restored,restoredUrl.toString()).checkReady()).rejects.toThrow("Interrupted restore");await restoredTool.rollbackReplacement();
    }finally{await restored.close();await admin.withSql(sql=>sql.unsafe(`DROP DATABASE ${restoredName} WITH (FORCE)`));}
    expect((await devices.syncMetadataCapabilities(await devices.authenticate("Bearer "+enrolled.token),rootId)).features).toMatchObject({snapshot:false,deltaFeed:false,conditionalVersions:false,newSyncEngine:false,immutableUploadReceipt:false});
    checks.push("actual same-cut pg_dump/restore retains namespace bindings, descriptor metadata and immutable receipts; partial/disabled schema, reset, downgrade and registered recovery fail closed; runtime flags remain false");
    await db.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
      SELECT md5('cj02-plan-'||n)::uuid,'folder',${rootId}::uuid,'plan-'||n,'fixture-only/plan-'||n,'active' FROM generate_series(1,100000) n`);
    await db.withSql(sql=>sql`ANALYZE resources`);
    const samples:number[]=[];db.recording=true;
    for(let pass=0;pass<3;pass++){db.statements=0;const start=performance.now();expect(await namespace.read(rootId,requalified,many)).toHaveLength(500);samples.push(performance.now()-start);expect(db.statements).toBe(1);}
    db.recording=false;const query=db.projection;if(!query)throw new Error("Actual namespace SQL not captured");
    const strings=[...query.strings];strings[0]="EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+(strings[0]??"");const template=Object.assign(strings,{raw:[...strings]}) as unknown as TemplateStringsArray;
    const plan=await db.withSql(sql=>Reflect.apply(sql,sql,[template,...query.parameters]) as Promise<unknown>);
    const walk=(value:unknown):boolean=>{if(Array.isArray(value))return value.some(walk);if(typeof value!=="object"||value===null)return false;const object=value as Record<string,unknown>;return object["Node Type"]==="Seq Scan" && object["Relation Name"]==="resources" || Object.values(object).some(walk);};
    await fs.writeFile(path.join(directory,"projection-plan.json"),JSON.stringify(plan,null,2));expect(walk(plan)).toBe(false);
    await fs.writeFile(path.join(directory,"projection-benchmark.json"),JSON.stringify({syntheticAddedRows:100000,items:500,statements:1,samplesMs:samples,scope:"DB-only synthetic current namespace metadata; no physical backend or production throughput qualification"},null,2));
    checks.push("actual captured one-statement500-item projection on100k catalogue uses bounded LATERAL/PK lookup with no resources Seq Scan; synthetic DB-only benchmark separate from physical publication");
    await fs.writeFile(path.join(directory,"wal.json"),JSON.stringify({before:walBefore,after:(await db.withSql(sql=>sql<{lsn:string}[]>`SELECT pg_current_wal_lsn()::text AS lsn`))[0]?.lsn,note:"WAL advanced normally; existing catalog/device identities preserved, not a WAL backup qualification"},null,2));
    passed=true;
  }finally{spies.forEach(s=>s.mockRestore());await fs.writeFile(path.join(directory,"results.json"),JSON.stringify({ok:passed,checks,failures,backend,scope:"inactive CJ02 fixture; all-writer/feed/snapshot/CAS/takeover/retention/native/endurance OPEN"},null,2));await app?.close().catch(()=>undefined);await storage.close().catch(()=>undefined);await db.close();await admin.withSql(sql=>sql.unsafe(`DROP DATABASE ${name} WITH (FORCE)`));await admin.close();}
},120000);
