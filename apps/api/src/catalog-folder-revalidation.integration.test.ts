import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash,createHmac,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {Database} from "@saturn/database";
import {expect,it} from "vitest";
import {inspectJournal} from "../../../packages/recovery/src/consistent-snapshot.js";
import {CatalogFolderAuthorityIssuer} from "../../../packages/file-core/src/catalog-folder-authority.js";
import {CatalogFolderRevalidationOperator,FolderRevalidationEvidenceIssuer,folderRevalidationTreeSha256,parseFolderRevalidationIntent,type FolderRevalidationTreeEntry} from "../../../packages/file-core/src/catalog-folder-revalidation.js";
import {WindowsFolderRevalidationVerifier} from "../../../packages/file-core/src/catalog-folder-revalidation-windows.js";
import {DeviceService,PostgresDeviceRepository} from "@saturn/sync";
import {FileService,PostgresFileRepository} from "@saturn/file-core";
import {LocalStorageAdapter} from "@saturn/storage";
import Fastify from "fastify";
import {guardedSyncHttp} from "./guarded-sync-http.js";
import {PostgresSyncSnapshotStage} from "../../../packages/sync/src/sync-snapshot-stage.js";
import {PostgresSyncSnapshotReader} from "../../../packages/sync/src/sync-snapshot-read.js";
import type {SyncFeedPage,SyncNodeDescriptor,SyncSnapshotReady} from "../../../packages/contracts/src/sync-protocol.js";

const fixture=process.env.SYNC_FOLDER_REVALIDATION_FIXTURE;
// This fixture is a logical copy of the retained 0057 failure, never the original
// server. Every mutation occurs in a new database on an identity-pinned container.
it.skipIf(!fixture)("repairs the retained aggregate UNKNOWN defect atomically with original-key replay and strict offline refusals",async()=>{
  if(!fixture)throw Error("Isolated clone fixture required");
  const f=JSON.parse(await fs.readFile(fixture,"utf8")) as {
    containerId:string;created:string;runId:string;template:string;databaseUrl:string;writerUrl:string;fixtureDirectory:string;pepper:string;originalStorageDirectory:string;
    guard:{writer_owner:string;writer_login:string;runtime_role:string;guard_revision:string;backend_identity:string};
    client:{deviceId:string;token:string;binding:Record<string,string>};
  };
  const containers=JSON.parse((await promisify(execFile)("docker",["inspect",f.containerId],{windowsHide:true})).stdout) as {
    Id:string;Created:string;State:{Running:boolean};Config:{Labels:Record<string,string>};HostConfig:{NanoCpus:number};NetworkSettings:{Ports:Record<string,{HostIp:string;HostPort:string}[]>};
  }[];
  const container=containers[0];if(!container)throw Error("Container missing");
  expect([container.Id,container.Created,container.Config.Labels["exocortex.sync-performance.run"],container.State.Running,container.HostConfig.NanoCpus]).toEqual([f.containerId,f.created,f.runId,true,1e9]);
  const url=new URL(f.databaseUrl),writerUrl=new URL(f.writerUrl),port=container.NetworkSettings.Ports["5432/tcp"]?.[0];
  expect([url.hostname,url.port,writerUrl.hostname,writerUrl.port,port?.HostIp,port?.HostPort,f.template]).toEqual(["127.0.0.1",port?.HostPort,"127.0.0.1",port?.HostPort,"127.0.0.1",url.port,"revalidation_template"]);
  for(const role of [f.guard.writer_owner,f.guard.writer_login,f.guard.runtime_role])expect(role).toMatch(/^[a-z_][a-z0-9_]{0,62}$/);
  const name="rq_"+randomUUID().replaceAll("-",""),adminUrl=new URL(url);adminUrl.pathname="/postgres";
  const admin=new Database(adminUrl.toString(),{max:1}),checks:string[]=[];
  let db:Database|undefined,writer:Database|undefined;
  const app=Fastify({logger:false});
  const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
  try{
    await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${name} TEMPLATE ${f.template}`));url.pathname="/"+name;writerUrl.pathname="/"+name;
    db=new Database(url.toString(),{max:1});writer=new Database(writerUrl.toString(),{max:1});const adb=db,wdb=writer,root=f.client.binding["root_id"];
    if(!root)throw Error("Root missing");
    const migrations=fileURLToPath(new URL("../../../packages/database/migrations/",import.meta.url));
    const up=await fs.readFile(path.join(migrations,"0059_offline_folder_revalidation.up.sql"),"utf8"),down=await fs.readFile(path.join(migrations,"0059_offline_folder_revalidation.down.sql"),"utf8");
    const state=async()=>adb.withSql(async sql=>{
      const values=[];
      for(const table of ["resources","file_versions","devices","operation_journal","sync_root_changes","sync_root_clock","catalog_guard_roots"]){
        values.push(await sql.unsafe(`SELECT to_jsonb(r) AS value FROM ${table} r ORDER BY to_jsonb(r)::text`));
      }
      return hash(values);
    });
    const clocks=()=>adb.withSql(sql=>sql`SELECT to_jsonb(c) AS value FROM sync_root_clock c ORDER BY root_id`);
    const beforeClocks=await clocks();
    const up58=await fs.readFile(path.join(migrations,"0058_guarded_runtime_activation.up.sql"),"utf8");
    await adb.transaction(sql=>sql.unsafe(up58));
    expect(await clocks()).toEqual(beforeClocks);checks.push("0058 preserves populated clocks");
    const before59=await state();await adb.transaction(sql=>sql.unsafe(up));expect(await state()).toBe(before59);
    await adb.transaction(sql=>sql.unsafe(down));expect(await state()).toBe(before59);await adb.transaction(sql=>sql.unsafe(up));checks.push("0059 additive unused up/down/up preserves all data");
    await adb.withSql(sql=>sql.unsafe(`ALTER FUNCTION public.catalog_folder_revalidation_command(text,jsonb,jsonb) OWNER TO ${f.guard.writer_owner};GRANT EXECUTE ON FUNCTION public.catalog_folder_revalidation_command(text,jsonb,jsonb) TO ${f.guard.writer_login}`));
    const tree=await adb.withSql(sql=>sql<{description:Record<string,unknown>;storagePath:string}[]>`WITH RECURSIVE t AS (
      SELECT id FROM resources WHERE id=${root} UNION ALL SELECT r.id FROM resources r JOIN t ON r.parent_id=t.id)
      SELECT catalog_namespace_description(r,${root}::uuid) AS description,storage_path AS "storagePath" FROM resources r JOIN t ON t.id=r.id ORDER BY r.id`);
    const folders=tree.filter(t=>t.description["availability"]==="UNKNOWN").map(t=>String(t.description["node_id"]));expect(tree).toHaveLength(58);expect(folders).toHaveLength(4);
    const operationId=randomUUID(),now=Date.now(),intent={schema:"saturn.catalog-folder-revalidation-intent.v1",operationId,idempotencyKey:"folder-revalidate-"+operationId,
      binding:f.client.binding,guardRevision:f.guard.guard_revision,backendIdentity:f.guard.backend_identity,deviceId:f.client.deviceId,expectedSeq:"73",
      observedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),
      custody:{backendGeneration:randomUUID(),bootstrapSha256:"a".repeat(64),drainSha256:"b".repeat(64),backupSha256:"c".repeat(64),treeSha256:folderRevalidationTreeSha256(tree as unknown as FolderRevalidationTreeEntry[])},tree,folders};
    // Synthetic custody digests test the fixed SQL only; they cannot mint the
    // opaque physical proof required by the private operator adapter.
    const credential={deviceId:f.client.deviceId,deviceKind:"pluto",tokenHash:createHmac("sha256",f.pepper).update("device-capability-token\0").update(f.client.token).digest("hex")};
    const run=async(command:string,value:unknown=intent,auth:unknown=credential,timeout="2s")=>wdb.transaction(async sql=>{
      await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
      await sql`SELECT set_config('statement_timeout',${timeout},true)`;
      const result=(await sql<{value:{replayed:boolean;result:null|{firstSeq:string;lastSeq:string;descriptions:Record<string,unknown>[]}}}[]>`
        SELECT catalog_folder_revalidation_command(${command},${JSON.stringify(value)}::text::jsonb,${JSON.stringify(auth)}::text::jsonb) AS value`)[0]?.value;
      if(!result)throw Error("Result absent");return result;
    });
    const nativeDirectory=path.join(path.dirname(fixture),"native-composition-"+operationId),backend=path.join(nativeDirectory,"backend");await fs.mkdir(backend,{recursive:true});
    for(const entry of [...tree].sort((a,b)=>a.storagePath.length-b.storagePath.length)){
      const target=path.resolve(backend,entry.storagePath);if(!target.startsWith(path.resolve(backend)+path.sep))throw Error("Clone path escape");
      if(entry.description["type"]==="folder")await fs.mkdir(target,{recursive:true});else await fs.copyFile(path.join(f.originalStorageDirectory,entry.storagePath),target);
    }
    const devices=new DeviceService({repository:new PostgresDeviceRepository(adb),files:new FileService(new PostgresFileRepository(adb),new LocalStorageAdapter(backend)),pepper:f.pepper,
      options:{enabled:true,publicOrigin:"https://fixture.invalid",uploadChunkMaxBytes:8388608,propfindMaxItems:100,deleteMaxItems:10,deleteWindowMs:10000}});
    const authority=new CatalogFolderAuthorityIssuer(adb,{authenticateDevice:a=>devices.authenticateSyncMetadata(a)}),proof=await authority.device("Bearer "+f.client.token,root);
    const stat=await fs.stat(backend,{bigint:true}),helper=fileURLToPath(new URL("../../../scripts/folder-revalidation-handles.ps1",import.meta.url));
    const verifier=new WindowsFolderRevalidationVerifier({powershell:path.join(process.env["SystemRoot"]??"C:/Windows","System32/WindowsPowerShell/v1.0/powershell.exe"),handleScript:helper,handleScriptSha256:createHash("sha256").update(await fs.readFile(helper)).digest("hex"),evidenceDirectory:nativeDirectory,
      acquireCustody:async parsed=>({backendRoot:backend,backendNativeIdentity:stat.dev.toString(16).padStart(8,"0")+":"+stat.ino.toString(16).padStart(16,"0"),custody:parsed.custody,assertCurrent:async()=>{},close:async()=>{}})});
    const parsed=parseFolderRevalidationIntent(intent),operator=new CatalogFolderRevalidationOperator(wdb,authority,new FolderRevalidationEvidenceIssuer(verifier),parsed.binding,parsed.guardRevision,parsed.backendIdentity);
    const scope={wire:parsed.binding,guard:{rootId:root,epoch:parsed.binding.server_epoch,bindingVersion:parsed.binding.binding_version,guardRevision:parsed.guardRevision}};
    const reader=new PostgresSyncSnapshotReader(adb,authority,scope,"repair-test",[{id:"repair-test",secret:Buffer.alloc(32,71)}]);
    await app.register(guardedSyncHttp,{root:async id=>id===root?{binding:parsed.binding,authority,stage:new PostgresSyncSnapshotStage(adb,authority,scope),reader,ensureFolder:async()=>{throw Error("Excluded");}}:undefined});
    const origin=await app.listen({host:"127.0.0.1",port:0});
    const http=async<T>(route:string,body:Record<string,unknown>):Promise<T>=>{
      const response=await fetch(origin+"/sync/v1/roots/"+root+"/"+route,{method:"POST",headers:{authorization:"Bearer "+f.client.token,"content-type":"application/json"},body:JSON.stringify({binding:parsed.binding,...body}),signal:AbortSignal.timeout(5000)});
      const text=await response.text();expect(response.status,text).toBe(200);return JSON.parse(text) as T;
    };
    const snapshot=async()=>{
      const snapshot_id=randomUUID();let stage=await http<{state:string}>("snapshots/start",{snapshot_id});
      for(let step=0;stage.state!=="READY"&&step<128;step++)stage=await http<{state:string}>("snapshots/step",{snapshot_id});
      expect(stage.state).toBe("READY");return http<SyncSnapshotReady>("snapshots/ready",{snapshot_id});
    };
    const entries=async(ready:SyncSnapshotReady)=>{
      const page=await http<{items:SyncNodeDescriptor[];has_more:boolean}>("entries",{cursor:ready.entries_cursor});
      expect(page.has_more).toBe(false);expect(page.items).toHaveLength(58);return page.items;
    };
    const oldReady=await snapshot(),oldEntries=await entries(oldReady);expect(oldReady.cut_seq).toBe("73");expect(oldEntries.filter(e=>e.availability==="UNKNOWN")).toHaveLength(4);
    const baseline=await state();expect(await run("inspect")).toEqual({replayed:false,result:null});expect(await state()).toBe(baseline);
    const badInputs:[string,unknown,string][]=[
      ["unknown field",{...intent,extra:true},"invalid_input"],
      ["missing custody",{...intent,custody:undefined},"invalid_input"],
      ["duplicate folder",{...intent,folders:[...folders,folders[0]]},"invalid_input"],
      ["oversized tree",{...intent,tree:Array(501).fill(tree[0])},"invalid_input"],
      ["unsafe path",{...intent,tree:tree.map((t,n)=>n===0?{...t,storagePath:"../escape"}:t)},"invalid_input"],
      ["missing node ID",{...intent,tree:tree.map((t,n)=>n===0?{...t,description:{}}:t)},"invalid_input"],
      ["metadata preimage",{...intent,tree:tree.map((t,n)=>n===0?{...t,description:{...t.description,version:randomUUID()}}:t)},"metadata_conflict"],
      ["storage path preimage",{...intent,tree:tree.map((t,n)=>n===0?{...t,storagePath:t.storagePath+"-other"}:t)},"metadata_conflict"],
      ["missing child",{...intent,tree:tree.filter(t=>t.description["type"]!=="file")},"membership_changed"],
      ["unselected UNKNOWN",{...intent,folders:folders.slice(1)},"metadata_conflict"],
      ["stale sequence",{...intent,expectedSeq:"72"},"metadata_conflict"],
      ["exact bigint above 2^53",{...intent,expectedSeq:"9007199254740993"},"metadata_conflict"],
      ["bigint overflow",{...intent,expectedSeq:"9223372036854775808"},"invalid_input"],
      ["expired evidence",{...intent,observedAt:"2020-01-01T00:00:00.000Z",expiresAt:"2020-01-01T00:00:01.000Z"},"evidence_expired"],
      ["epoch",{...intent,binding:{...intent.binding,server_epoch:randomUUID()}},"binding_invalid"],
      ["binding",{...intent,binding:{...intent.binding,binding_version:randomUUID()}},"binding_invalid"],
      ["backend",{...intent,backendIdentity:"other-backend"},"binding_invalid"],
      ["guard",{...intent,guardRevision:randomUUID()},"binding_invalid"],
    ];
    for(const [label,value,error] of badInputs){await expect(run("commit",value)).rejects.toThrow(error);expect(await state()).toBe(baseline);checks.push("no effects: "+label);}
    for(const [label,auth] of [["token",{...credential,tokenHash:"d".repeat(64)}],["kind",{...credential,deviceKind:"windows_sync"}],["peer",{...credential,deviceId:randomUUID()}]] as const){await expect(run("commit",intent,auth)).rejects.toThrow();expect(await state()).toBe(baseline);checks.push("authority refused: "+label);}
    // A fixed test-only definer introduces a bad preimage inside a transaction
    // which must roll back. No arbitrary DML hook enters product composition.
    for(const [label,mutation,reason] of [
      ["unsupported UNKNOWN reason",`UPDATE public.sync_root_changes SET document=jsonb_set(document,'{reason}','"unqualified.stat"'::jsonb) WHERE root_id='${root}' AND seq=73`,"unsupported_unknown_cause"],
      ["missing retained prefix",`UPDATE public.sync_root_changes SET seq=100 WHERE root_id='${root}' AND seq=55`,"incomplete_history"],
      ["trimmed prefix",`UPDATE public.sync_root_clock SET retained_after_seq=1 WHERE root_id='${root}'`,"history_outside_repair_bound"],
      ["revoked current principal",`UPDATE public.devices SET state='revoked' WHERE id='${f.client.deviceId}'`,"authorization_changed"],
      ["expired current principal",`UPDATE public.devices SET expires_at=now()-interval '1 second' WHERE id='${f.client.deviceId}'`,"authorization_changed"],
    ] as const){
      expect(root).toMatch(/^[a-f0-9-]{36}$/);expect(f.client.deviceId).toMatch(/^[a-f0-9-]{36}$/);
      await adb.withSql(sql=>sql.unsafe(`CREATE FUNCTION rq_source_fault() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ ${mutation} $$;ALTER FUNCTION rq_source_fault() OWNER TO ${f.guard.writer_owner};GRANT EXECUTE ON FUNCTION rq_source_fault() TO ${f.guard.writer_login}`));
      try{await expect(wdb.transaction(async sql=>{
        await sql`SET LOCAL statement_timeout='2s'`;await sql`SELECT rq_source_fault()`;
        await sql`SELECT catalog_folder_revalidation_command('commit',${JSON.stringify(intent)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb)`;
        throw Error("Unexpected acceptance; fixture rollback");
      })).rejects.toThrow(reason);expect(await state()).toBe(baseline);checks.push("actual database preimage refused: "+label);}
      finally{await adb.withSql(sql=>sql`DROP FUNCTION rq_source_fault()`);}
    }
    // Real PostgreSQL faults at each atomic boundary. No product fault hook/GUC.
    for(const [table,event,when,body,timeout] of [
      ["resources","UPDATE","NEW.sync_availability='AVAILABLE'","RAISE EXCEPTION 'rq_fault';","2s"],
      ["sync_root_changes","INSERT","NEW.seq=75","RAISE EXCEPTION 'rq_fault';","2s"],
      ["operation_journal","UPDATE","NEW.operation_type='folder_revalidate' AND NEW.state='active'","RAISE EXCEPTION 'rq_fault';","2s"],
      ["sync_root_clock","UPDATE","NEW.published_seq=77","RAISE EXCEPTION 'rq_fault';","2s"],
      ["sync_root_clock","UPDATE","NEW.published_seq=77","PERFORM pg_sleep(3);","100ms"],
    ] as const){
      await adb.withSql(sql=>sql.unsafe(`CREATE FUNCTION rq_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$;CREATE TRIGGER rq_fault BEFORE ${event} ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION rq_fault()`));
      try{await expect(run("commit",intent,credential,timeout)).rejects.toThrow(timeout==="100ms"?"statement timeout":"rq_fault");expect(await state()).toBe(baseline);}
      finally{await adb.withSql(sql=>sql.unsafe(`DROP TRIGGER rq_fault ON ${table};DROP FUNCTION rq_fault()`));}
      checks.push("atomic rollback: "+table+" "+timeout);
    }
    const other=new Database(writerUrl.toString(),{max:1});
    try{await other.withSql(sql=>sql`SELECT 1`);await expect(run("commit")).rejects.toThrow("writers_not_drained");expect(await state()).toBe(baseline);checks.push("actual second writer refuses");}finally{await other.close();}
    const protectedBefore=await adb.withSql(async sql=>({operations:await sql`SELECT to_jsonb(j) AS value FROM operation_journal j ORDER BY id`,versions:await sql`SELECT to_jsonb(v) AS value FROM file_versions v ORDER BY id`,events:await sql`SELECT to_jsonb(c) AS value FROM sync_root_changes c ORDER BY root_id,seq`}));
    const result=await operator.reconcile(parsed,proof);expect(result.replayed).toBe(false);expect(result.result.firstSeq).toBe("74");expect(result.result.lastSeq).toBe("77");expect(result.result.descriptions).toHaveLength(4);
    for(const description of result.result.descriptions){const original=tree.find(t=>t.description["node_id"]===description["node_id"])?.description;expect(original).toBeDefined();expect(description["version"]).not.toBe(original?.["version"]);expect({...description,version:original?.["version"],availability:"UNKNOWN"}).toEqual(original);}
    const protectedAfter=await adb.withSql(async sql=>({operations:await sql`SELECT to_jsonb(j) AS value FROM operation_journal j WHERE id<>${operationId} ORDER BY id`,versions:await sql`SELECT to_jsonb(v) AS value FROM file_versions v ORDER BY id`,events:await sql`SELECT to_jsonb(c) AS value FROM sync_root_changes c WHERE operation_id<>${operationId} ORDER BY root_id,seq`}));
    expect(protectedAfter).toEqual(protectedBefore);checks.push("four fresh descriptors, 73 to 77, all original operations/versions/events exact");
    const accepted=await state();expect(await run("commit")).toEqual({...result,replayed:true});expect(await operator.reconcile(parsed,proof)).toEqual({...result,replayed:true});expect(await run("inspect")).toEqual({...result,replayed:true});expect(await state()).toBe(accepted);checks.push("typed operator + Windows held handles + actual SQL and same-key lost ACK replay");
    await expect(run("commit",{...intent,expectedSeq:"77"})).rejects.toThrow("operation_reused");
    await expect(adb.transaction(sql=>sql.unsafe(down))).rejects.toThrow("cannot be rolled back");
    await expect(adb.withSql(sql=>sql`DELETE FROM operation_journal WHERE id=${operationId}`)).rejects.toThrow();
    await expect(adb.withSql(sql=>sql`UPDATE operation_journal SET updated_at=now() WHERE id=${operationId}`)).rejects.toThrow();
    await expect(adb.withSql(sql=>sql`TRUNCATE operation_journal CASCADE`)).rejects.toThrow();expect(await state()).toBe(accepted);checks.push("used down/mutation/delete/truncate refuse");
    for(const changed of [{...result.result,firstSeq:74},{...result.result,descriptions:[result.result.descriptions[0],result.result.descriptions[0],result.result.descriptions[0],result.result.descriptions[0]]},
      {...result.result,descriptions:result.result.descriptions.map(d=>({...d,availability:"UNKNOWN"}))}]){
      expect((await adb.withSql(sql=>sql<{valid:boolean}[]>`SELECT catalog_folder_revalidation_shape(jsonb_populate_record(NULL::operation_journal,to_jsonb(j)||jsonb_build_object('sync_result',${JSON.stringify(changed)}::text::jsonb))) AS valid FROM operation_journal j WHERE id=${operationId}`))[0]?.valid).toBe(false);
    }checks.push("receipt shape rejects numeric sequence, duplicate nodes and unavailable results");
    const journal=await adb.transaction(sql=>inspectJournal(sql));expect(journal.folderRevalidationShape).toBe("saturn.catalog-folder-revalidation-intent.v1");expect(journal.folderRevalidationOperations).toBe("1");expect(journal.dumpPolicy).toBe("durable-journal-with-upload-dependencies");
    await adb.withSql(sql=>sql`ALTER TABLE operation_journal DISABLE TRIGGER operation_folder_revalidation_guard`);
    try{await expect(adb.transaction(sql=>inspectJournal(sql))).rejects.toThrow("revalidation constraints/history");}
    finally{await adb.withSql(sql=>sql`ALTER TABLE operation_journal ENABLE TRIGGER operation_folder_revalidation_guard`);}
    expect(await state()).toBe(accepted);checks.push("coherent journal counts exact; incomplete receipt protection blocks export");
    expect(await entries(oldReady)).toEqual(oldEntries);
    const freshReady=await snapshot(),freshEntries=await entries(freshReady);expect(freshReady.cut_seq).toBe("77");expect(freshEntries.every(e=>e.availability==="AVAILABLE")).toBe(true);
    for(const descriptor of result.result.descriptions)expect(freshEntries.find(e=>e.node_id===descriptor["node_id"])).toEqual(descriptor);
    const feed=await http<SyncFeedPage>("changes",{cursor:oldReady.changes_cursor});expect([feed.from_exclusive,feed.to_inclusive,feed.has_more]).toEqual(["73","77",false]);expect(feed.items.map(e=>e.seq)).toEqual(["74","75","76","77"]);
    for(const item of feed.items){expect(item.operation_id).toBe(operationId);expect(item.availability).toBe("AVAILABLE");expect(item.version).toBe(freshEntries.find(e=>e.node_id===item.node_id)?.version);}
    checks.push("actual HTTP old snapshot retains UNKNOWN; fresh cut77 and contiguous feed expose four new AVAILABLE versions");
    const plans=await adb.transaction(async sql=>{
      // Tiny clones legitimately choose sequential scans; disabling that choice
      // proves the available index paths without claiming a production timing.
      await sql`SET LOCAL enable_seqscan=off`;
      return {children:await sql`EXPLAIN (FORMAT JSON) SELECT id FROM resources WHERE parent_id=${root} ORDER BY id LIMIT 501`,
        descriptor:await sql`EXPLAIN (FORMAT JSON) SELECT * FROM resources WHERE id=${root}`,
        events:await sql`EXPLAIN (FORMAT JSON) SELECT seq FROM sync_root_changes WHERE root_id=${root} AND epoch=${parsed.binding.server_epoch} AND seq<=77`};
    });
    for(const plan of Object.values(plans))expect(JSON.stringify(plan)).toMatch(/Index (?:Only )?Scan|Bitmap Index Scan/);
    await fs.writeFile(path.join(f.fixtureDirectory,"revalidation-query-plans.json"),JSON.stringify(plans,null,2)+"\n");checks.push("actual EXPLAIN confirms child/descriptor/event index paths; no performance claim for tiny clone");
    await fs.writeFile(path.join(f.fixtureDirectory,"revalidation-sql-result.json"),JSON.stringify({at:new Date().toISOString(),checks,nativePhysicalComposition:true,syntheticCustody:true,originalTouched:false},null,2)+"\n");
  }finally{await app.close();await writer?.close();await db?.close();await admin.withSql(sql=>sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));await admin.close();}
},60000);
