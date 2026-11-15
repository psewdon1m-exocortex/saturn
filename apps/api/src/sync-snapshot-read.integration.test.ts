import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {Database,migrate} from "@saturn/database";
import {qualifyCatalogDatabaseRoles,type CatalogDatabaseRolePolicy} from "../../../packages/database/src/catalog-role-qualification.js";
import {FileService,PostgresFileRepository,PostgresRootJournal,PostgresCurrentNamespace,CatalogFolderAuthorityIssuer,ROOT_RESOURCE_ID,SYNC_RESOURCE_ID,type CatalogFolderRequest} from "@saturn/file-core";
import {CatalogFolderDatabaseCoordinator} from "../../../packages/file-core/src/catalog-folder-database.js";
import {namespaceDescriptor,type NamespaceProjectionRow} from "../../../packages/file-core/src/current-namespace.js";
import {DeviceService,PostgresDeviceRepository} from "@saturn/sync";
import {PostgresSyncSnapshotStage,type SyncSnapshotProgress} from "../../../packages/sync/src/sync-snapshot-stage.js";
import {LocalStorageAdapter} from "@saturn/storage";
import {expect,it} from "vitest";
import Fastify from "fastify";
import {guardedSyncHttp} from "./guarded-sync-http.js";
import {PostgresSyncSnapshotReader} from "../../../packages/sync/src/sync-snapshot-read.js";
import {readSyncSnapshotEntriesPage} from "../../../packages/contracts/src/sync-snapshot-page.js";
import {parseSyncJson,validateSyncFeedPage,validateSyncSnapshotReady,type SyncSnapshotReady} from "../../../packages/contracts/src/sync-protocol.js";

const fixturePath=process.env.SYNC_SNAPSHOT_READ_FIXTURE,exec=promisify(execFile);
type TransactionSql=Parameters<Parameters<Database["transaction"]>[0]>[0];
class LostStageAckDatabase extends Database {
  loseAck=false;lostResult:unknown;
  override async transaction<T>(action:(sql:TransactionSql)=>Promise<T>):Promise<T> {
    const result=await super.transaction(action);
    if(this.loseAck&&typeof result==="object"&&result!==null&&("snapshotId" in result||"snapshot_id" in result||result instanceof Uint8Array)){this.loseAck=false;this.lostResult=result;throw new Error("fixture lost committed stage response");}
    return result;
  }
}

it.skipIf(!fixturePath).each(["0","9007199254740993"])("serves bounded durable snapshot/feed sessions with exact replay on actual PostgreSQL at seed %s",async seed=>{
  if(!fixturePath)throw new Error("Owned fixture required");
  const fixture=JSON.parse(await fs.readFile(fixturePath,"utf8")) as {containerId:string;runId:string;databaseUrl:string;fixtureDirectory:string};
  const owned=JSON.parse((await exec("docker",["inspect",fixture.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>};HostConfig:{NanoCpus:number;Memory:number};State:{Running:boolean}}[];
  expect(owned[0]?.Id).toBe(fixture.containerId);expect(owned[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);expect(owned[0]?.State.Running).toBe(true);
  expect(owned[0]?.HostConfig.NanoCpus).toBeLessThanOrEqual(1e9);expect(owned[0]?.HostConfig.Memory).toBeLessThanOrEqual(512*1024*1024);
  const suffix=randomUUID().replaceAll("-",""),name="stage_"+suffix,directory=path.join(fixture.fixtureDirectory,suffix);await fs.mkdir(directory);
  const admin=new Database(fixture.databaseUrl,{max:2}),roles=["stage_runtime_"+suffix,"stage_writer_"+suffix,"stage_owner_"+suffix] as const,password=randomUUID().replaceAll("-","");
  await fs.writeFile(path.join(directory,"ownership.json"),JSON.stringify({name,seed,roles,containerId:fixture.containerId,runId:fixture.runId}),{flag:"wx"});
  const runtimeRole=roles[0],writerLogin=roles[1],writerOwner=roles[2];
  let db:Database|undefined,runtime:LostStageAckDatabase|undefined,writer:Database|undefined,passed=false;
  const checks:string[]=[],refusals:{phase:string;code?:string;message:string}[]=[],storage=new LocalStorageAdapter(path.join(directory,"storage"));
  const reject=async(phase:string,action:()=>Promise<unknown>,code?:string)=>{try{await action();throw new Error("Missing rejection: "+phase);}catch(error){if(!(error instanceof Error)||error.message.startsWith("Missing rejection:"))throw error;if(code)expect(error).toMatchObject({code});refusals.push({phase,message:error.message,...("code" in error?{code:String(error.code)}:{})});}};
  try {
    await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${name}`));const url=new URL(fixture.databaseUrl);url.pathname="/"+name;db=new Database(url.toString(),{max:4});
    const migrations=fileURLToPath(new URL("../../../packages/database/migrations/",import.meta.url)),cut=path.join(directory,"migrations");await fs.mkdir(cut);
    for(const file of await fs.readdir(migrations))if(Number(file.slice(0,4))<=53||Number(file.slice(0,4))===55)await fs.copyFile(path.join(migrations,file),path.join(cut,file));
    await migrate(url.toString(),cut);await storage.initialize();const legacy=new FileService(new PostgresFileRepository(db),storage);await legacy.initializeStorage();
    const isolatedSchema="snapshot_legacy_"+suffix;await db.withSql(sql=>sql.unsafe(`CREATE SCHEMA ${isolatedSchema}`));const isolatedUrl=new URL(url);isolatedUrl.searchParams.set("options","-csearch_path="+isolatedSchema);const isolated=new Database(isolatedUrl.toString(),{max:1});
    try{await migrate(isolatedUrl.toString(),cut);await isolated.withSql(sql=>sql`INSERT INTO sync_root_clock(root_id,epoch) VALUES(${ROOT_RESOURCE_ID},${randomUUID()})`);await isolated.withSql(sql=>sql`UPDATE sync_root_clock SET published_seq=2,retained_after_seq=1 WHERE root_id=${ROOT_RESOURCE_ID}`);
      const pinned=(await isolated.withSql(sql=>sql<{source:string}[]>`SELECT pg_get_functiondef(p.oid) AS source FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${isolatedSchema} AND p.proname='guard_sync_snapshot_retention'`))[0]?.source;expect(pinned).toContain(isolatedSchema+".sync_snapshot_stage");expect(pinned).not.toContain("public.sync_snapshot_stage");
      const isolatedDown=await fs.readFile(path.join(cut,"0055_sync_snapshot_cursor_lease.down.sql"),"utf8");await isolated.transaction(sql=>sql.unsafe(isolatedDown));await isolated.withSql(sql=>sql`UPDATE sync_root_clock SET published_seq=3,retained_after_seq=2 WHERE root_id=${ROOT_RESOURCE_ID}`);
      checks.push("trusted generated-schema installation binds retention to own tables; unregistered legacy retained-prefix advance remains functional before and after unused0055down");
    }finally{await isolated.close();await db.withSql(sql=>sql.unsafe(`DROP SCHEMA ${isolatedSchema} CASCADE`));}
    const devices=new DeviceService({repository:new PostgresDeviceRepository(db),files:legacy,pepper:"stage-fixture-pepper-1234567890123456",options:{enabled:true,publicOrigin:"https://fixture.invalid",uploadChunkMaxBytes:1048576,propfindMaxItems:100,deleteMaxItems:10,deleteWindowMs:10000}});
    const enrolled=await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment("S1 windows")).code,"fixture"),rootId=enrolled.device.syncRootId;
    if(!rootId)throw new Error("Missing canonical root");
    const counter=(n:number)=>(BigInt(seed)+BigInt(n)).toString();
    const parent=await legacy.createFolder(rootId,"wide"),journal=new PostgresRootJournal(db),clock=await journal.registerRoot(rootId),namespace=new PostgresCurrentNamespace(db);
    const binding=await namespace.qualifyFixture(rootId,[rootId,parent.id]);
    // Explicit boundary fixture starts with a retained empty prefix at C. It
    // does not synthesize any historical events or claim production coverage.
    await db.withSql(sql=>sql`UPDATE sync_root_clock SET published_seq=${seed},retained_after_seq=${seed} WHERE root_id=${rootId}`);
    // Fixture-only known UNKNOWN catalogue rows: no physical-byte or AVAILABLE claim.
    await db.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status,metadata_version,sync_availability,size_bytes)
      SELECT ('ffffffff-ffff-4fff-8fff-'||lpad(to_hex(n),12,'0'))::uuid,'file',${parent.id},'base-'||n::text,'fixture/base-'||n::text,'active',gen_random_uuid(),'UNKNOWN',n
      FROM generate_series(1,1500) n`);
    for(const role of roles)await admin.withSql(sql=>sql.unsafe(`CREATE ROLE ${role} ${role===writerOwner?"NOLOGIN":`LOGIN PASSWORD '${password}'`} NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT`));
    await db.withSql(sql=>sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${roles.join(",")}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}; GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${writerOwner};
      GRANT INSERT,UPDATE ON resources,operation_journal,sync_root_clock,sync_root_changes TO ${writerOwner}; GRANT UPDATE ON devices TO ${writerOwner};
      ALTER FUNCTION public.catalog_folder_command(text,jsonb,jsonb) OWNER TO ${writerOwner}; GRANT EXECUTE ON FUNCTION public.catalog_folder_command(text,jsonb,jsonb) TO ${writerLogin}`));
    const ru=new URL(url);ru.username=runtimeRole;ru.password=password;const wu=new URL(url);wu.username=writerLogin;wu.password=password;
    runtime=new LostStageAckDatabase(ru.toString(),{max:4});writer=new Database(wu.toString(),{max:4});
    const folderUp=await fs.readFile(path.join(cut,"0052_catalog_writer_guard.up.sql"),"utf8"),source=folderUp.match(/CREATE FUNCTION catalog_folder_command[\s\S]*?AS \$\$([\s\S]*?)\$\$;/)?.[1];if(!source)throw new Error("No pinned writer source");
    const policy:CatalogDatabaseRolePolicy={runtimeRole,writerLogin,writerOwner,migratorRole:"postgres",connection:"runtime",approvedFunctions:[{identity:"public.catalog_folder_command(text,jsonb,jsonb)",sourceSha256:createHash("sha256").update(source).digest("hex")}]};
    await qualifyCatalogDatabaseRoles(runtime,policy);await qualifyCatalogDatabaseRoles(writer,{...policy,connection:"writer"});
    const guardRevision=randomUUID();await db.transaction(sql=>sql`INSERT INTO catalog_guard_roots(root_id,guard_revision,writer_contract,runtime_role,writer_login,writer_owner,backend_identity,control_ancestor_ids)
      VALUES(${rootId},${guardRevision},'folder-only-g1.v1',${runtimeRole},${writerLogin},${writerOwner},'stage-local',ARRAY[${ROOT_RESOURCE_ID}::uuid,${SYNC_RESOURCE_ID}::uuid])`);
    const rdb=runtime,issuer=new CatalogFolderAuthorityIssuer(rdb,{authenticateDevice:a=>devices.authenticate(a)}),proof=await issuer.device("Bearer "+enrolled.token,rootId);
    const scope={wire:{protocol:"neptune-sync/1" as const,descriptor_schema:"saturn.current-namespace.v1" as const,server_identity:"stage-fixture",root_id:rootId,server_epoch:clock.epoch,policy_version:"stage-policy-v1",binding_version:binding},guard:{rootId,epoch:clock.epoch,bindingVersion:binding,guardRevision}};
    const stage=new PostgresSyncSnapshotStage(rdb,issuer,scope),coordinator=new CatalogFolderDatabaseCoordinator(writer,issuer,[{rootId,epoch:clock.epoch,backendIdentity:"stage-local",namespaceBindingVersion:binding}]);
    const files=new FileService(new PostgresFileRepository(rdb),storage,{catalogBackendIdentity:"stage-local",catalogFolderCoordinator:coordinator}),request=(label:string):CatalogFolderRequest=>({operationId:randomUUID(),idempotencyKey:randomUUID(),rootId,epoch:clock.epoch,bindingVersion:binding,parentId:parent.id,name:label,mode:"ensure"});
    const first=await stage.start(proof);expect(first.entries).toBe("1");expect(first.startSeq).toBe(seed);
    await stage.step(first.snapshotId,proof); // Root -> durable parent frontier.
    await stage.step(first.snapshotId,proof); // First500 siblings observed at C.
    const after=(await rdb.withSql(sql=>sql<{last_child_id:string}[]>`SELECT last_child_id FROM sync_snapshot_frontier WHERE snapshot_id=${first.snapshotId} AND parent_id=${parent.id}`))[0]?.last_child_id;if(!after)throw new Error("Missing persisted keyset");
    const created=await files.ensureCatalogFolder(request("inserted-before-keyset"),proof);expect(created.result.status).toBe("CREATED");expect(created.result.description.node_id<after).toBe(true);
    const persisted=(await rdb.withSql(sql=>sql`SELECT to_jsonb(f) AS f FROM sync_snapshot_frontier f WHERE snapshot_id=${first.snapshotId} ORDER BY parent_id`));
    rdb.loseAck=true;await reject("lost committed page ACK",()=>stage.step(first.snapshotId,proof));
    expect(await rdb.withSql(sql=>sql`SELECT to_jsonb(f) AS f FROM sync_snapshot_frontier f WHERE snapshot_id=${first.snapshotId} ORDER BY parent_id`)).not.toEqual(persisted);
    const restart=new PostgresSyncSnapshotStage(rdb,issuer,scope);let result:SyncSnapshotProgress=first,steps=0;
    while(result.state!=="READY"&&steps++<30)result=await restart.step(first.snapshotId,proof);
    expect(result.state).toBe("READY");expect(result.snapshotId).toBe(first.snapshotId);expect(result.cutSeq).toBe(counter(1));expect(result.entries).toBe("1503");
    const finalRows=await db.withSql(sql=>sql<NamespaceProjectionRow[]>`SELECT id,parent_id,name,type,size_bytes::text,sha256,current_version_id,metadata_version,sync_availability,status FROM resources WHERE status='active' AND (id IN (${rootId},${parent.id}) OR parent_id=${parent.id}) ORDER BY id`);
    const staged=await rdb.withSql(sql=>sql<{document:unknown}[]>`SELECT document FROM sync_snapshot_entries WHERE snapshot_id=${first.snapshotId} ORDER BY node_id`);
    expect(staged.map(row=>row.document)).toEqual(finalRows.map(row=>namespaceDescriptor(row,rootId)));
    expect(staged.some(row=>(row.document as {availability:string}).availability==="UNKNOWN")).toBe(true);
    checks.push("actual restricted runtime/writer;1500UNKNOWN siblings, earlier-ID physical folder, lost stage ACK and exact complete cut D=1");
    const keys=[{id:"fixture1",secret:Uint8Array.from({length:32},(_,i)=>i+1)}],reader=()=>new PostgresSyncSnapshotReader(rdb,issuer,scope,"fixture1",keys);
    const preCursorCatalog=await db.withSql(sql=>sql`SELECT to_jsonb(r) AS row FROM resources r ORDER BY id`),cursorDown=await fs.readFile(path.join(cut,"0055_sync_snapshot_cursor_lease.down.sql"),"utf8"),cursorUp=await fs.readFile(path.join(cut,"0055_sync_snapshot_cursor_lease.up.sql"),"utf8");
    await db.transaction(sql=>sql.unsafe(cursorDown));await db.transaction(sql=>sql.unsafe(cursorUp));expect(await db.withSql(sql=>sql`SELECT to_jsonb(r) AS row FROM resources r ORDER BY id`)).toEqual(preCursorCatalog);
    await db.withSql(sql=>sql.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON sync_snapshot_cursor TO ${runtimeRole}; GRANT SELECT ON sync_snapshot_cursor TO ${writerOwner}`));
    rdb.loseAck=true;await reject("lost committed READY response",()=>reader().ready(first.snapshotId,proof));
    const lostReady=rdb.lostResult as SyncSnapshotReady,ready=await reader().ready(first.snapshotId,proof);expect(ready.entries_cursor).toBe(lostReady.entries_cursor);expect(ready.changes_cursor).toBe(lostReady.changes_cursor);expect(ready.cut_seq).toBe(counter(1));
    const originalAbsolute=(await rdb.withSql(sql=>sql<{absolute:string}[]>`SELECT absolute_until::text AS absolute FROM sync_snapshot_stage WHERE id=${first.snapshotId}`))[0]?.absolute;
    expect((await rdb.withSql(sql=>sql<{count:number}[]>`SELECT cursor_count AS count FROM sync_snapshot_stage WHERE id=${first.snapshotId}`))[0]?.count).toBe(2);
    await fs.writeFile(path.join(directory,"ready.json"),JSON.stringify(ready,null,2));
    rdb.loseAck=true;await reject("lost committed entries response",()=>reader().entries(ready.entries_cursor,proof));
    const lostPage=rdb.lostResult as Uint8Array,firstPageRaw=await reader().entries(ready.entries_cursor,proof);expect(firstPageRaw).toEqual(lostPage);
    const firstPage=readSyncSnapshotEntriesPage(firstPageRaw,ready,null);expect(firstPage.items).toHaveLength(500);expect(firstPage.has_more).toBe(true);
    await fs.writeFile(path.join(directory,"entries-page-1.json"),firstPageRaw);
    const all=[...firstPage.items];let page=firstPage,n=1;
    while(page.has_more&&n++<10){const raw=await reader().entries(page.next_cursor,proof);await fs.writeFile(path.join(directory,`entries-page-${String(n)}.json`),raw);page=readSyncSnapshotEntriesPage(raw,ready,page.last_node_id);all.push(...page.items);}
    expect(all).toEqual(staged.map(row=>row.document));expect(all).toHaveLength(1503);expect(all.some(row=>row.availability==="UNKNOWN")).toBe(true);
    const terminalRaw=await reader().entries(page.next_cursor,proof),terminal=readSyncSnapshotEntriesPage(terminalRaw,ready,page.last_node_id);expect(terminal.items).toHaveLength(0);expect(terminal.last_node_id).toBe(page.last_node_id);expect(terminal.has_more).toBe(false);
    checks.push("READY and500-item snapshot lost SQL ACKs replay exact registered tokens/raw bytes after instance restart;4pages equal final D catalogue;terminal emptiness preserves last ID;UNKNOWN retained");
    const feed=(raw:Uint8Array,after:string)=>{const p=parseSyncJson(raw);validateSyncFeedPage(p,{...scope.wire,after_seq:after});return p;};
    const emptyRaw=await reader().changes(ready.changes_cursor,proof),empty=feed(emptyRaw,counter(1));expect(empty.items).toHaveLength(0);expect(empty.to_inclusive).toBe(counter(1));expect(empty.next_cursor).not.toBe(ready.changes_cursor);
    const poll2Raw=await reader().changes(empty.next_cursor,proof),poll2=feed(poll2Raw,counter(1));expect(poll2.next_cursor).not.toBe(empty.next_cursor);
    await files.ensureCatalogFolder(request("feed-two"),proof);await files.ensureCatalogFolder(request("feed-three"),proof);
    expect(await reader().changes(ready.changes_cursor,proof)).toEqual(emptyRaw);expect(await reader().entries(ready.entries_cursor,proof)).toEqual(firstPageRaw);
    rdb.loseAck=true;await reject("lost committed feed response",()=>reader().changes(poll2.next_cursor,proof));const lostFeed=rdb.lostResult as Uint8Array;
    await files.ensureCatalogFolder(request("feed-four"),proof);
    const replayRaw=await reader().changes(poll2.next_cursor,proof);expect(replayRaw).toEqual(lostFeed);const replay=feed(replayRaw,counter(1));expect(replay.items.map(row=>row.seq)).toEqual([counter(2),counter(3)]);expect(replay.has_more).toBe(false);
    const nextRaw=await reader().changes(replay.next_cursor,proof),next=feed(nextRaw,counter(3));expect(next.items.map(row=>row.seq)).toEqual([counter(4)]);
    for(const [name,raw] of [["empty-feed",emptyRaw],["replayed-feed",replayRaw],["fresh-feed",nextRaw]] as const)await fs.writeFile(path.join(directory,name+".json"),raw);
    checks.push("same-second fresh empty polls have distinct registered handles; old empty/page replays unchanged after new writes;lost feed ACK covers exact2/3 while later4 arrives only through successor cursor");
    const tokensBefore=await db.withSql(sql=>sql`SELECT to_jsonb(c) AS c FROM sync_snapshot_cursor c WHERE snapshot_id=${first.snapshotId} ORDER BY token_hash`);
    await reject("unknown opaque nonce",()=>reader().changes("pg1."+randomUUID()+ready.changes_cursor.slice(40),proof),"invalid_cursor");
    await reject("wrong token kind",()=>reader().entries(ready.changes_cursor,proof),"invalid_cursor");
    await reject("wrong key",()=>new PostgresSyncSnapshotReader(rdb,issuer,scope,"fixture1",[{id:"fixture1",secret:new Uint8Array(32)}]).changes(ready.changes_cursor,proof));
    await reject("wrong binding/guard",()=>new PostgresSyncSnapshotReader(rdb,issuer,{...scope,guard:{...scope.guard,guardRevision:randomUUID()}},"fixture1",keys).changes(ready.changes_cursor,proof));
    expect(await db.withSql(sql=>sql`SELECT to_jsonb(c) AS c FROM sync_snapshot_cursor c WHERE snapshot_id=${first.snapshotId} ORDER BY token_hash`)).toEqual(tokensBefore);
    const ownerDb=db;
    await reject("READY descriptor overwrite refused",()=>rdb.withSql(sql=>sql`UPDATE sync_snapshot_entries SET document=jsonb_set(document,'{name}','"overwritten"') WHERE snapshot_id=${first.snapshotId} AND node_id=${rootId}`),"55000");
    await reject("READY entries truncate refused",()=>ownerDb.withSql(sql=>sql`TRUNCATE sync_snapshot_entries`),"55000");
    await reject("READY original deadline extension refused",()=>rdb.withSql(sql=>sql`UPDATE sync_snapshot_stage SET absolute_until=absolute_until+interval '1 second' WHERE id=${first.snapshotId}`),"55000");
    await reject("READY cut mutation refused",()=>rdb.withSql(sql=>sql`UPDATE sync_snapshot_stage SET cut_seq=${counter(2)},applied_seq=${counter(2)} WHERE id=${first.snapshotId}`),"55000");
    await reject("READY D pins retained prefix",()=>ownerDb.transaction(async sql=>{await sql`ALTER TABLE sync_root_clock DISABLE TRIGGER catalog_guard_rows`;await sql`UPDATE sync_root_clock SET retained_after_seq=${counter(2)} WHERE root_id=${rootId}`;}),"55000");
    const exactEvent=(await db.transaction(async sql=>{await sql`ALTER TABLE sync_root_changes DISABLE TRIGGER catalog_guard_rows`;const rows=await sql<{root_id:string;epoch:string;seq:string;node_id:string;operation_id:string;document:unknown;committed_at:string}[]>`DELETE FROM sync_root_changes WHERE root_id=${rootId} AND seq=${counter(4)} RETURNING root_id,epoch,seq::text,node_id,operation_id,document,committed_at::text`;await sql`ALTER TABLE sync_root_changes ENABLE TRIGGER catalog_guard_rows`;return rows;}))[0];if(!exactEvent)throw new Error("Missing exact event preimage");
    await reject("covered feed replay detects missing retained event",()=>reader().changes(replay.next_cursor,proof),"journal_gap");
    await db.transaction(async sql=>{await sql`ALTER TABLE sync_root_changes DISABLE TRIGGER catalog_guard_rows`;await sql`INSERT INTO sync_root_changes(root_id,epoch,seq,node_id,operation_id,document,committed_at) VALUES(${exactEvent.root_id},${exactEvent.epoch},${exactEvent.seq},${exactEvent.node_id},${exactEvent.operation_id},${JSON.stringify(exactEvent.document)}::text::jsonb,${exactEvent.committed_at}::timestamptz)`;await sql`ALTER TABLE sync_root_changes ENABLE TRIGGER catalog_guard_rows`;});expect(await reader().changes(replay.next_cursor,proof)).toEqual(nextRaw);
    const pending=request("pending-reader"),prepared=await coordinator.prepare(pending,proof,"stage-local");await coordinator.beginPhysical(prepared,proof);await reject("original physical pending closes historical READY reader",()=>reader().changes(next.next_cursor,proof),"reconciliation_required");await storage.mkdir(prepared.storagePath);await coordinator.commit(prepared,proof);
    const overlayBuild=await stage.start(proof);let overlayProgress=overlayBuild,baseSteps=0;while(overlayProgress.state==="BASE"&&baseSteps++<30)overlayProgress=await stage.step(overlayBuild.snapshotId,proof);expect(overlayProgress.state).toBe("OVERLAY");
    for(let i=0;i<501;i++)await files.ensureCatalogFolder(request("bounded-feed-"+String(i)),proof);
    expect((await stage.step(overlayBuild.snapshotId,proof)).state).toBe("OVERLAY");expect((await stage.step(overlayBuild.snapshotId,proof)).cutSeq).toBe(counter(506));
    const wideRaw=await reader().changes(next.next_cursor,proof),wide=feed(wideRaw,counter(4));expect(wide.items).toHaveLength(500);expect(wide.to_inclusive).toBe(counter(504));expect(wide.has_more).toBe(true);expect(wideRaw.byteLength).toBeLessThan(4*1024*1024);
    const tailRaw=await reader().changes(wide.next_cursor,proof),tail=feed(tailRaw,counter(504));expect(tail.items).toHaveLength(2);expect(tail.to_inclusive).toBe(counter(506));expect(tail.has_more).toBe(false);
    expect(await reader().changes(next.next_cursor,proof)).toEqual(wideRaw);await fs.writeFile(path.join(directory,"feed-500.json"),wideRaw);await fs.writeFile(path.join(directory,"feed-tail.json"),tailRaw);
    checks.push("502real fixed folder commits drained as exactly500+2 complete events;received bytes<4MiB and exact prior500-event replay;decimal counter boundary retained");
    await rdb.withSql(sql=>sql`UPDATE devices SET can_read=false WHERE id=${enrolled.device.id}`);await reject("current read revoke",()=>reader().entries(ready.entries_cursor,proof),"authorization_changed");await rdb.withSql(sql=>sql`UPDATE devices SET can_read=true WHERE id=${enrolled.device.id}`);
    await db.withSql(sql=>sql`UPDATE sync_snapshot_stage SET last_observed_at=clock_timestamp()+interval '1 minute' WHERE id=${first.snapshotId}`);await reject("clock reverse after restart",()=>reader().changes(next.next_cursor,proof),"cursor_expired");await db.withSql(sql=>sql`UPDATE sync_snapshot_stage SET last_observed_at=clock_timestamp() WHERE id=${first.snapshotId}`);
    checks.push("nonce/kind/key/guard/currentread/originalpending/clock reversal refuse;live READY independently pins D;missing covered event rejects exact replay and restoring same primary event restores bytes");
    await reject("cursor-bearing downgrade refuses",()=>ownerDb.transaction(sql=>sql.unsafe(cursorDown)),"55000");
    const leases=(await rdb.withSql(sql=>sql<{absolute:string;count:number}[]>`SELECT absolute_until::text AS absolute,cursor_count AS count FROM sync_snapshot_stage WHERE id=${first.snapshotId}`))[0];expect(leases).toBeDefined();expect(leases?.absolute).toBe(originalAbsolute);
    await db.withSql(sql=>sql`UPDATE sync_snapshot_stage SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${first.snapshotId}`);await reject("expired session refuses old tokens",()=>reader().entries(ready.entries_cursor,proof),"cursor_expired");
    const namespaceBeforeGc=await db.withSql(sql=>sql`SELECT to_jsonb(r) AS row FROM resources r ORDER BY id`),operationsBeforeGc=await db.withSql(sql=>sql`SELECT to_jsonb(j) AS row FROM operation_journal j ORDER BY id`),clockBeforeGc=await db.withSql(sql=>sql`SELECT to_jsonb(c) AS row FROM sync_root_clock c WHERE root_id=${rootId}`);
    const tokenGc=await reader().collectExpired();expect(tokenGc.tokensRemoved).toBe(leases?.count);expect(tokenGc.tokensRemoved).toBeLessThanOrEqual(500);expect((await reader().collectExpired()).tokensRemoved).toBe(0);
    const stageGc=[];for(let i=0;i<4;i++)stageGc.push(await stage.collectExpired());expect(stageGc.map(row=>row.entriesRemoved)).toEqual([500,500,500,3]);expect(stageGc[3]?.headerRemoved).toBe(true);
    expect(await db.withSql(sql=>sql`SELECT to_jsonb(r) AS row FROM resources r ORDER BY id`)).toEqual(namespaceBeforeGc);expect(await db.withSql(sql=>sql`SELECT to_jsonb(j) AS row FROM operation_journal j ORDER BY id`)).toEqual(operationsBeforeGc);expect(await db.withSql(sql=>sql`SELECT to_jsonb(c) AS row FROM sync_root_clock c WHERE root_id=${rootId}`)).toEqual(clockBeforeGc);
    await db.transaction(sql=>sql.unsafe(cursorDown));await db.transaction(sql=>sql.unsafe(cursorUp));checks.push("immutable original absolute session deadline;cursor-bearing downgrade refuses;expired token then500-document stage GC preserves namespace/originaloperations/rootclock and allows safe down-up");
    await fs.writeFile(path.join(directory,"bounded-gc.json"),JSON.stringify({tokenGc,stageGc},null,2));
    // Real loopback HTTP, with the exact restricted SQL/runtime/physical folder
    // services above. No fake authority from a parsed response and no normal
    // production API bootstrap/capability activation.
    await db.withSql(sql=>sql.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON sync_snapshot_cursor TO ${runtimeRole}; GRANT SELECT ON sync_snapshot_cursor TO ${writerOwner}`));
    let httpStage=new PostgresSyncSnapshotStage(rdb,issuer,scope);
    const http=Fastify({logger:false});
    await http.register(guardedSyncHttp,{root:async id=>id===rootId?{binding:scope.wire,authority:issuer,stage:httpStage,reader:reader(),ensureFolder:(operation,p)=>files.ensureCatalogFolder(operation,p)}:undefined});
    const address=await http.listen({host:"127.0.0.1",port:0}),httpEvidence:{route:string;status:number;bytes:number}[]=[];
    const post=async(route:string,payload:unknown,token:string="Bearer "+enrolled.token)=>{
      const response=await fetch(address+"/sync/v1/roots/"+rootId+route,{method:"POST",headers:{"Content-Type":"application/json",authorization:token},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
      const bytes=new Uint8Array(await response.arrayBuffer());httpEvidence.push({route,status:response.status,bytes:bytes.length});
      return {status:response.status,bytes,value:parseSyncJson(bytes)};
    };
    try {
      const httpId=randomUUID(),payload={binding:scope.wire,snapshot_id:httpId};rdb.loseAck=true;
      expect((await post("/snapshots/start",payload)).status).toBe(500);
      httpStage=new PostgresSyncSnapshotStage(rdb,issuer,scope);
      const resumed=await post("/snapshots/start",payload);expect(resumed.status).toBe(200);expect(resumed.value).toMatchObject({snapshotId:httpId,state:"BASE",startSeq:counter(506)});
      let state=resumed.value as SyncSnapshotProgress,walk=0;while(state.state!=="READY"&&walk++<600){const reply=await post("/snapshots/step",payload);expect(reply.status).toBe(200);state=reply.value as SyncSnapshotProgress;}expect(state.state).toBe("READY");
      const readyReply=await post("/snapshots/ready",payload);expect(readyReply.status).toBe(200);const httpReady=readyReply.value as SyncSnapshotReady;validateSyncSnapshotReady(httpReady);expect(httpReady.cut_seq).toBe(counter(506));
      const entryPayload={binding:scope.wire,cursor:httpReady.entries_cursor},httpFirst=await post("/entries",entryPayload),httpRepeat=await post("/entries",entryPayload);expect(httpFirst.status).toBe(200);expect(httpRepeat.bytes).toEqual(httpFirst.bytes);expect(readSyncSnapshotEntriesPage(httpFirst.bytes,httpReady,null).items).toHaveLength(500);
      const directoryPayload={binding:scope.wire,operation_id:randomUUID(),idempotency_key:randomUUID(),parent_id:parent.id,name:"http-original-directory",mode:"ensure"};
      const ensure=await post("/directories/ensure",directoryPayload),ensureAgain=await post("/directories/ensure",directoryPayload);expect(ensure.status).toBe(200);expect(ensure.value).toMatchObject({result:{status:"CREATED"}});expect(ensureAgain.value).toMatchObject({replayed:true,result:(ensure.value as {result:unknown}).result});
      const httpFeed=await post("/changes",{binding:scope.wire,cursor:httpReady.changes_cursor});expect(httpFeed.status).toBe(200);const change=feed(httpFeed.bytes,counter(506));expect(change.to_inclusive).toBe(counter(507));expect(change.items).toHaveLength(1);
      expect((await post("/snapshots/start",{...payload,binding:{...scope.wire,binding_version:randomUUID()}})).status).toBe(409);
      expect((await post("/snapshots/start",{...payload,extra:true})).status).toBe(400);
      expect((await post("/snapshots/start",payload,"Bearer invalid-token")).status).toBe(401);
      const duplicate=await fetch(address+"/sync/v1/roots/"+rootId+"/snapshots/start",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"binding":{},"binding":{},"snapshot_id":"'+httpId+'"}',signal:AbortSignal.timeout(10000)});expect(duplicate.status).toBe(400);
      const oversized=await fetch(address+"/sync/v1/roots/"+rootId+"/snapshots/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({padding:"x".repeat(16384)}),signal:AbortSignal.timeout(10000)});expect(oversized.status).toBe(413);
      await rdb.withSql(sql=>sql`UPDATE devices SET can_read=false WHERE id=${enrolled.device.id}`);expect((await post("/entries",entryPayload)).status).toBe(403);await rdb.withSql(sql=>sql`UPDATE devices SET can_read=true WHERE id=${enrolled.device.id}`);
      checks.push("real loopback HTTP uses private fresh proof/fullbinding and exact actualSQL services;lostadmissionACK/reinstantiation resumes originalUUID;bounded strict snapshot/page/replay+physicalfolder samekey/feed507;duplicate/oversize/extra/forgedtoken/wrongbinding/currentread revoke reject");
      await fs.writeFile(path.join(directory,"http-routes.json"),JSON.stringify(httpEvidence,null,2));await fs.writeFile(path.join(directory,"http-ready.json"),readyReply.bytes);await fs.writeFile(path.join(directory,"http-entries-first.json"),httpFirst.bytes);await fs.writeFile(path.join(directory,"http-feed.json"),httpFeed.bytes);
    }finally{await http.close();}
    passed=true;
  } finally {
    await storage.close();await writer?.close();await runtime?.close();await db?.close();await fs.writeFile(path.join(directory,"results.json"),JSON.stringify({passed,checks,refusals,scope:"inactive restricted folder-only READY/page/feed; no public ACTIVE/CAS/allwriters/native/performance claim"},null,2));
    // Retain the owned database and role identities for independent readback.
    await admin.close();
  }
},180000);
