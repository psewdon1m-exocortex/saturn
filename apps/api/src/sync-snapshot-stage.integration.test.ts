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

const fixturePath=process.env.SYNC_SNAPSHOT_STAGE_FIXTURE,exec=promisify(execFile);
type TransactionSql=Parameters<Parameters<Database["transaction"]>[0]>[0];
class LostStageAckDatabase extends Database {
  loseAck=false;
  override async transaction<T>(action:(sql:TransactionSql)=>Promise<T>):Promise<T> {
    const result=await super.transaction(action);
    if(this.loseAck&&typeof result==="object"&&result!==null&&"snapshotId" in result){this.loseAck=false;throw new Error("fixture lost committed stage response");}
    return result;
  }
}

it.skipIf(!fixturePath)("builds one durable guarded namespace cut from bounded base pages plus complete overlay on actual PostgreSQL",async()=>{
  if(!fixturePath)throw new Error("Owned fixture required");
  const fixture=JSON.parse(await fs.readFile(fixturePath,"utf8")) as {containerId:string;runId:string;databaseUrl:string;fixtureDirectory:string};
  const owned=JSON.parse((await exec("docker",["inspect",fixture.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>};HostConfig:{NanoCpus:number;Memory:number};State:{Running:boolean}}[];
  expect(owned[0]?.Id).toBe(fixture.containerId);expect(owned[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);expect(owned[0]?.State.Running).toBe(true);
  expect(owned[0]?.HostConfig.NanoCpus).toBeLessThanOrEqual(1e9);expect(owned[0]?.HostConfig.Memory).toBeLessThanOrEqual(512*1024*1024);
  const suffix=randomUUID().replaceAll("-",""),name="stage_"+suffix,directory=path.join(fixture.fixtureDirectory,suffix);await fs.mkdir(directory);
  const admin=new Database(fixture.databaseUrl,{max:2}),roles=["stage_runtime_"+suffix,"stage_writer_"+suffix,"stage_owner_"+suffix] as const,password=randomUUID().replaceAll("-","");
  const runtimeRole=roles[0],writerLogin=roles[1],writerOwner=roles[2];
  let db:Database|undefined,runtime:LostStageAckDatabase|undefined,writer:Database|undefined,passed=false;
  const checks:string[]=[],refusals:{phase:string;code?:string;message:string}[]=[],storage=new LocalStorageAdapter(path.join(directory,"storage"));
  const reject=async(phase:string,action:()=>Promise<unknown>,code?:string)=>{try{await action();throw new Error("Missing rejection: "+phase);}catch(error){if(!(error instanceof Error)||error.message.startsWith("Missing rejection:"))throw error;if(code)expect(error).toMatchObject({code});refusals.push({phase,message:error.message,...("code" in error?{code:String(error.code)}:{})});}};
  try {
    await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${name}`));const url=new URL(fixture.databaseUrl);url.pathname="/"+name;db=new Database(url.toString(),{max:4});
    const migrations=fileURLToPath(new URL("../../../packages/database/migrations/",import.meta.url)),cut=path.join(directory,"migrations");await fs.mkdir(cut);
    for(const file of await fs.readdir(migrations))if(Number(file.slice(0,4))<=53)await fs.copyFile(path.join(migrations,file),path.join(cut,file));
    await migrate(url.toString(),cut);await storage.initialize();const legacy=new FileService(new PostgresFileRepository(db),storage);await legacy.initializeStorage();
    const devices=new DeviceService({repository:new PostgresDeviceRepository(db),files:legacy,pepper:"stage-fixture-pepper-1234567890123456",options:{enabled:true,publicOrigin:"https://fixture.invalid",uploadChunkMaxBytes:1048576,propfindMaxItems:100,deleteMaxItems:10,deleteWindowMs:10000}});
    const enrolled=await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment("S1 windows")).code,"fixture"),rootId=enrolled.device.syncRootId;
    if(!rootId)throw new Error("Missing canonical root");
    const parent=await legacy.createFolder(rootId,"wide"),journal=new PostgresRootJournal(db),clock=await journal.registerRoot(rootId),namespace=new PostgresCurrentNamespace(db);
    const binding=await namespace.qualifyFixture(rootId,[rootId,parent.id]);
    // Fixture-only known UNKNOWN catalogue rows: no physical-byte or AVAILABLE claim.
    await db.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status,metadata_version,sync_availability,size_bytes)
      SELECT ('ffffffff-ffff-4fff-8fff-'||lpad(to_hex(n),12,'0'))::uuid,'file',${parent.id},'base-'||n::text,'fixture/base-'||n::text,'active',gen_random_uuid(),'UNKNOWN',n
      FROM generate_series(1,1500) n`);
    const planParent=await legacy.createFolder(ROOT_RESOURCE_ID,"plan-outside");
    const before=await db.withSql(sql=>sql`SELECT to_jsonb(r) AS row FROM resources r ORDER BY id`),down=await fs.readFile(path.join(cut,"0053_sync_snapshot_stage.down.sql"),"utf8"),up=await fs.readFile(path.join(cut,"0053_sync_snapshot_stage.up.sql"),"utf8");
    await db.transaction(sql=>sql.unsafe(down));await db.transaction(sql=>sql.unsafe(up));expect(await db.withSql(sql=>sql`SELECT to_jsonb(r) AS row FROM resources r ORDER BY id`)).toEqual(before);
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
    const originalSnapshotId=randomUUID();rdb.loseAck=true;
    await reject("lost committed admission ACK",()=>stage.start(proof,originalSnapshotId));
    const originalAdmission=await rdb.withSql(sql=>sql`SELECT absolute_until,start_seq,entry_count,document_bytes FROM sync_snapshot_stage WHERE id=${originalSnapshotId}`);
    const admittedAgain=new PostgresSyncSnapshotStage(rdb,issuer,scope);
    const admitted=await Promise.all([admittedAgain.start(proof,originalSnapshotId),stage.start(proof,originalSnapshotId)]);
    const first=admitted[0];
    expect(admitted[1].snapshotId).toBe(originalSnapshotId);expect(first.snapshotId).toBe(originalSnapshotId);
    expect(first.entries).toBe("1");expect(first.startSeq).toBe("0");
    expect(await rdb.withSql(sql=>sql`SELECT absolute_until,start_seq,entry_count,document_bytes FROM sync_snapshot_stage WHERE id=${originalSnapshotId}`)).toEqual(originalAdmission);
    expect(await rdb.withSql(sql=>sql`SELECT count(*)::int AS n FROM sync_snapshot_stage`)).toEqual([{n:1}]);
    await reject("noncanonical original admission UUID",()=>stage.start(proof,"not-a-uuid"),"invalid_input");
    checks.push("original snapshotUUID persisted before admission; actual committed lostACK,newinstance/concurrent sameUUID resume one header/rootdocument,originalcut/absolutedeadline/count/bytes unchanged");
    await stage.step(first.snapshotId,proof); // Root -> durable parent frontier.
    await stage.step(first.snapshotId,proof); // First500 siblings observed at C.
    const after=(await rdb.withSql(sql=>sql<{last_child_id:string}[]>`SELECT last_child_id FROM sync_snapshot_frontier WHERE snapshot_id=${first.snapshotId} AND parent_id=${parent.id}`))[0]?.last_child_id;if(!after)throw new Error("Missing persisted keyset");
    const created=await files.ensureCatalogFolder(request("inserted-before-keyset"),proof);expect(created.result.status).toBe("CREATED");expect(created.result.description.node_id<after).toBe(true);
    const persisted=(await rdb.withSql(sql=>sql`SELECT to_jsonb(f) AS f FROM sync_snapshot_frontier f WHERE snapshot_id=${first.snapshotId} ORDER BY parent_id`));
    rdb.loseAck=true;await reject("lost committed page ACK",()=>stage.step(first.snapshotId,proof));
    expect(await rdb.withSql(sql=>sql`SELECT to_jsonb(f) AS f FROM sync_snapshot_frontier f WHERE snapshot_id=${first.snapshotId} ORDER BY parent_id`)).not.toEqual(persisted);
    const restart=new PostgresSyncSnapshotStage(rdb,issuer,scope);let result:SyncSnapshotProgress=first,steps=0;
    while(result.state!=="READY"&&steps++<30)result=await restart.step(first.snapshotId,proof);
    expect(result.state).toBe("READY");expect(result.snapshotId).toBe(first.snapshotId);expect(result.cutSeq).toBe("1");expect(result.entries).toBe("1503");
    const finalRows=await db.withSql(sql=>sql<NamespaceProjectionRow[]>`SELECT id,parent_id,name,type,size_bytes::text,sha256,current_version_id,metadata_version,sync_availability,status FROM resources WHERE status='active' AND (id IN (${rootId},${parent.id}) OR parent_id=${parent.id}) ORDER BY id`);
    const staged=await rdb.withSql(sql=>sql<{document:unknown}[]>`SELECT document FROM sync_snapshot_entries WHERE snapshot_id=${first.snapshotId} ORDER BY node_id`);
    expect(staged.map(row=>row.document)).toEqual(finalRows.map(row=>namespaceDescriptor(row,rootId)));
    expect(staged.some(row=>(row.document as {availability:string}).availability==="UNKNOWN")).toBe(true);
    checks.push("actual0053unused down-up preserves catalog; separate restricted runtime/fixed writer proof;1500UNKNOWN base siblings with durable500keysets, earlier-ID physical folder commit, lostSQLpageACK/reinstantiation, complete(C,D]overlay equals one final catalog query at D=1");
    // Clock pin is checked by the actual database trigger independently of reader code.
    const build=await stage.start(proof);await files.ensureCatalogFolder(request("pin-event"),proof);const ownerDb=db;
    await reject("retention beyond unfinished C",()=>ownerDb.transaction(async sql=>{await sql`ALTER TABLE sync_root_clock DISABLE TRIGGER catalog_guard_rows`;await sql`UPDATE sync_root_clock SET retained_after_seq=2 WHERE root_id=${rootId}`;}),"55000");
    checks.push("unfinished C pin rejects owner fault-injected retention independently; failed transaction restores disabled guard and clock");
    const preserved=await rdb.withSql(sql=>sql`SELECT to_jsonb(s) AS s FROM sync_snapshot_stage s WHERE id=${build.snapshotId}`);
    await reject("binding revision mismatch",()=>new PostgresSyncSnapshotStage(rdb,issuer,{...scope,guard:{...scope.guard,guardRevision:randomUUID()}}).step(build.snapshotId,proof));
    expect(await rdb.withSql(sql=>sql`SELECT to_jsonb(s) AS s FROM sync_snapshot_stage s WHERE id=${build.snapshotId}`)).toEqual(preserved);
    await reject("forged process proof",()=>stage.step(build.snapshotId,JSON.parse(JSON.stringify(proof)) as typeof proof),"authority_invalid");
    await db.withSql(sql=>sql`UPDATE sync_snapshot_stage SET last_observed_at=clock_timestamp()+interval '1 minute' WHERE id=${build.snapshotId}`);await reject("database clock reversal",()=>stage.step(build.snapshotId,proof),"cursor_expired");
    await db.withSql(sql=>sql`UPDATE sync_snapshot_stage SET last_observed_at=clock_timestamp(),lease_until=clock_timestamp()-interval '1 second' WHERE id=${build.snapshotId}`);await reject("expired idle lease",()=>stage.step(build.snapshotId,proof),"cursor_expired");
    const expiredBefore=await rdb.withSql(sql=>sql`SELECT to_jsonb(s) AS s FROM sync_snapshot_stage s WHERE id=${build.snapshotId}`);
    await reject("same UUID admission cannot revive expired lease",()=>stage.start(proof,build.snapshotId),"cursor_expired");
    expect(await rdb.withSql(sql=>sql`SELECT to_jsonb(s) AS s FROM sync_snapshot_stage s WHERE id=${build.snapshotId}`)).toEqual(expiredBefore);
    checks.push("exact guard revision/privateauthority/DBclockreverse/idle expiry refuse without advancing stage; UNKNOWN remains a known entry");
    const gap=await stage.start(proof);await files.ensureCatalogFolder(request("gap-event"),proof);let gapProgress=gap,gapSteps=0;
    while(gapProgress.state==="BASE"&&gapSteps++<30)gapProgress=await stage.step(gap.snapshotId,proof);expect(gapProgress.state).toBe("OVERLAY");
    const gapBefore=await rdb.withSql(sql=>sql`SELECT to_jsonb(s) AS s FROM sync_snapshot_stage s WHERE id=${gap.snapshotId}`);
    const removedEvent=await db.transaction(async sql=>{await sql`ALTER TABLE sync_root_changes DISABLE TRIGGER catalog_guard_rows`;const rows=await sql<{root_id:string;epoch:string;seq:string;node_id:string;operation_id:string;document:Record<string,unknown>;committed_at:string}[]>`DELETE FROM sync_root_changes WHERE root_id=${rootId} AND seq=3 RETURNING root_id,epoch,seq::text,node_id,operation_id,document,committed_at::text`;await sql`ALTER TABLE sync_root_changes ENABLE TRIGGER catalog_guard_rows`;return rows;});
    expect(removedEvent).toHaveLength(1);await reject("complete overlay journal gap",()=>stage.step(gap.snapshotId,proof),"journal_gap");
    expect(await rdb.withSql(sql=>sql`SELECT to_jsonb(s) AS s FROM sync_snapshot_stage s WHERE id=${gap.snapshotId}`)).toEqual(gapBefore);
    const original=removedEvent[0];if(!original)throw new Error("Missing exact fault preimage");
    await db.transaction(async sql=>{await sql`ALTER TABLE sync_root_changes DISABLE TRIGGER catalog_guard_rows`;await sql`INSERT INTO sync_root_changes(root_id,epoch,seq,node_id,operation_id,document,committed_at) VALUES(${original.root_id},${original.epoch},${original.seq},${original.node_id},${original.operation_id},${JSON.stringify(original.document)}::text::jsonb,${original.committed_at}::timestamptz)`;await sql`ALTER TABLE sync_root_changes ENABLE TRIGGER catalog_guard_rows`;});
    expect((await stage.step(gap.snapshotId,proof)).cutSeq).toBe("3");
    checks.push("owner-only explicit missing-event fault rejects complete overlay atomically; restoring exact same immutable event allows original snapshot to seal, no invented sequence/history");
    await runtime.withSql(sql=>sql`UPDATE devices SET can_read=false WHERE id=${enrolled.device.id}`);
    await reject("current read permission required for start",()=>stage.start(proof),"authorization_changed");await reject("current read permission required for READY",()=>stage.step(first.snapshotId,proof),"authorization_changed");
    await runtime.withSql(sql=>sql`UPDATE devices SET can_read=true WHERE id=${enrolled.device.id}`);expect((await stage.step(first.snapshotId,proof)).state).toBe("READY");
    checks.push("write-only private proof cannot authorize snapshot; can_read=false rejects start/READY against current locked database authority");
    const pending=request("original-pending"),prepared=await coordinator.prepare(pending,proof,"stage-local");await coordinator.beginPhysical(prepared,proof);
    await reject("original physical pending blocks start",()=>stage.start(proof),"reconciliation_required");await reject("original physical pending blocks READY read",()=>stage.step(first.snapshotId,proof),"reconciliation_required");
    await storage.mkdir(prepared.storagePath);await coordinator.commit(prepared,proof);expect((await stage.start(proof)).state).toBe("BASE");
    await runtime.withSql(sql=>sql`UPDATE devices SET state='revoked' WHERE id=${enrolled.device.id}`);await reject("current authority revoked",()=>stage.step(first.snapshotId,proof),"authorization_changed");
    checks.push("reserve/claim NULL original result blocks both new builds and previously READY cut; completing original same key restores admission; current device revoke rejects historical read");
    const namespaceBeforeGc=await db.withSql(sql=>sql`SELECT count(*)::text AS rows FROM resources`),journalBeforeGc=await db.withSql(sql=>sql`SELECT to_jsonb(c) AS c FROM sync_root_clock c WHERE root_id=${rootId}`);
    await db.withSql(sql=>sql`UPDATE sync_snapshot_stage SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${first.snapshotId}`);
    const gc=[];for(let i=0;i<4;i++)gc.push(await stage.collectExpired());expect(gc.every(row=>row.snapshotId===first.snapshotId&&row.entriesRemoved<=500&&row.frontierRemoved<=500)).toBe(true);
    expect(gc.map(row=>row.entriesRemoved)).toEqual([500,500,500,3]);expect(gc[3]?.headerRemoved).toBe(true);
    expect(await db.withSql(sql=>sql`SELECT count(*)::text AS rows FROM resources`)).toEqual(namespaceBeforeGc);expect(await db.withSql(sql=>sql`SELECT to_jsonb(c) AS c FROM sync_root_clock c WHERE root_id=${rootId}`)).toEqual(journalBeforeGc);
    await fs.writeFile(path.join(directory,"bounded-gc.json"),JSON.stringify(gc,null,2));checks.push("expired READY1503entries collected in500/500/500/3 bounded transactions; exact accounting released,resources/rootclock/originaloperations untouched");
    // Wide-parent planning on100k rows is measured before guarded registration in a separate unguarded parent.
    await db.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status) SELECT gen_random_uuid(),'file',${planParent.id},'plan-'||n::text,'plan/'||n::text,'active' FROM generate_series(1,100000) n`);
    await db.withSql(sql=>sql`ANALYZE resources`);
    const plan=await rdb.withSql(sql=>sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT id,parent_id FROM resources WHERE parent_id='${planParent.id}' AND status='active' AND id>'80000000-0000-4000-8000-000000000000'::uuid ORDER BY id LIMIT 501`));
    const planJson=JSON.stringify(plan);expect(planJson).toContain("resources_active_parent_id_cursor");expect(planJson).not.toContain('"Node Type":"Sort"');expect(planJson).not.toContain('"Node Type":"Seq Scan"');await fs.writeFile(path.join(directory,"wide-parent-explain.json"),JSON.stringify(plan,null,2));
    checks.push("100k unrelated siblings actual ANALYZE keyset plan uses partial(parent_id,id) index with no full resource SeqScan/Sort; no wide-tree performance claim");
    passed=true;
  } finally {
    await storage.close();await writer?.close();await runtime?.close();await db?.close();await fs.writeFile(path.join(directory,"results.json"),JSON.stringify({passed,checks,refusals,scope:"inactive append-only folder-qualified snapshot; no public ACTIVE/CAS/allwriters/native/performance claim"},null,2));
    await admin.withSql(sql=>sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));for(const role of roles)await admin.withSql(sql=>sql.unsafe(`DROP ROLE IF EXISTS ${role}`));await admin.close();
  }
},180000);
