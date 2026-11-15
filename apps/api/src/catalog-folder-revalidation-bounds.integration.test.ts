import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash,createHmac,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {expect,it} from "vitest";
import {Database} from "@saturn/database";
import {DeviceService,PostgresDeviceRepository} from "@saturn/sync";
import {FileService,PostgresFileRepository} from "@saturn/file-core";
import {LocalStorageAdapter} from "@saturn/storage";
import {CatalogFolderAuthorityIssuer} from "../../../packages/file-core/src/catalog-folder-authority.js";
import {CatalogFolderRevalidationOperator,FolderRevalidationEvidenceIssuer,folderRevalidationTreeSha256,parseFolderRevalidationIntent,type FolderRevalidationTreeEntry} from "../../../packages/file-core/src/catalog-folder-revalidation.js";
import {WindowsFolderRevalidationVerifier} from "../../../packages/file-core/src/catalog-folder-revalidation-windows.js";
import {CatalogUploadDatabaseCoordinator,type CatalogUploadExecution,type CatalogUploadTransfer} from "../../../packages/file-core/src/catalog-upload-database.js";
import type {CatalogUploadPrepareInput} from "../../../packages/file-core/src/catalog-upload-intent.js";

const fixture=process.env["SYNC_FOLDER_REVALIDATION_BOUNDS_FIXTURE"];
it.skipIf(!fixture||process.platform!=="win32")("qualifies the populated1024node successor with native custody, atomic rollback and durable downgrade refusal",async()=>{
  if(!fixture)throw Error("Private isolated clone required");
  const f=JSON.parse(await fs.readFile(fixture,"utf8")) as {
    containerId:string;created:string;runId:string;template:string;databaseUrl:string;writerUrl:string;fixtureDirectory:string;pepper:string;originalStorageDirectory:string;
    guard:{writer_owner:string;writer_login:string;runtime_role:string;guard_revision:string;backend_identity:string};client:{deviceId:string;token:string;binding:Record<string,string>};
  };
  const [container]=JSON.parse((await promisify(execFile)("docker",["inspect",f.containerId],{windowsHide:true})).stdout) as {Id:string;Created:string;State:{Running:boolean};Config:{Labels:Record<string,string>};HostConfig:{NanoCpus:number}}[];
  expect(container&&[container.Id,container.Created,container.Config.Labels["exocortex.sync-performance.run"],container.State.Running,container.HostConfig.NanoCpus]).toEqual([f.containerId,f.created,f.runId,true,1e9]);
  expect(f.template).toBe("revalidation_template");for(const role of [f.guard.writer_owner,f.guard.writer_login,f.guard.runtime_role])expect(role).toMatch(/^[a-z_][a-z0-9_]{0,62}$/);
  const dbname="bound_"+randomUUID().replaceAll("-",""),u=new URL(f.databaseUrl),wu=new URL(f.writerUrl),au=new URL(f.databaseUrl);au.pathname="/postgres";
  const admin=new Database(au.toString(),{max:1}),checks:string[]=[],directory=path.join(f.fixtureDirectory,"native-"+dbname);await fs.mkdir(directory);
  let db:Database|undefined,writer:Database|undefined;
  const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
  try{
    await admin.withSql(q=>q.unsafe(`CREATE DATABASE ${dbname} TEMPLATE ${f.template}`));u.pathname="/"+dbname;wu.pathname="/"+dbname;
    db=new Database(u.toString(),{max:1});writer=new Database(wu.toString(),{max:1});const adb=db,wdb=writer,root=f.client.binding["root_id"];if(!root)throw Error("Root missing");
    const readTree=()=>adb.withSql(q=>q<FolderRevalidationTreeEntry[]>`WITH RECURSIVE t AS(SELECT id FROM resources WHERE id=${root} UNION ALL SELECT r.id FROM resources r JOIN t ON r.parent_id=t.id) SELECT catalog_namespace_description(r,${root}::uuid) AS description,storage_path AS "storagePath" FROM resources r JOIN t ON t.id=r.id ORDER BY r.id`);
    const state=()=>adb.withSql(async q=>{const rows=[];for(const table of ["resources","file_versions","operation_journal","sync_root_changes","sync_root_clock","catalog_guard_roots"]){rows.push(await q.unsafe(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`));}return digest(rows);});
    const tree=await readTree();expect(tree.length).toBeGreaterThan(500);expect(tree.length).toBeLessThanOrEqual(1024);
    const folders=tree.filter(t=>t.description.availability==="UNKNOWN").map(t=>t.description.node_id);expect(folders).toHaveLength(16);
    const [clock]=await adb.withSql(q=>q<{seq:string}[]>`SELECT published_seq::text AS seq FROM sync_root_clock WHERE root_id=${root}`);if(!clock)throw Error("Clock missing");
    const make=()=>{const id=randomUUID(),now=Date.now();return {schema:"saturn.catalog-folder-revalidation-intent.v1",operationId:id,idempotencyKey:"folder-revalidate-"+id,binding:f.client.binding,deviceId:f.client.deviceId,guardRevision:f.guard.guard_revision,backendIdentity:f.guard.backend_identity,expectedSeq:clock.seq,observedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),custody:{backendGeneration:randomUUID(),bootstrapSha256:"a".repeat(64),drainSha256:"b".repeat(64),backupSha256:"c".repeat(64),treeSha256:folderRevalidationTreeSha256(tree)},tree,folders};};
    const valid=async(input:unknown)=>(await adb.withSql(q=>q<{ok:boolean}[]>`SELECT catalog_folder_revalidation_input(${JSON.stringify(input)}::text::jsonb) AS ok`))[0]?.ok;
    expect(await valid(make())).toBe(false);checks.push("old0059 refuses populated523node original without effects");
    const migrations=fileURLToPath(new URL("../../../packages/database/migrations/",import.meta.url)),up=await fs.readFile(path.join(migrations,"0060_offline_folder_revalidation_bounds.up.sql"),"utf8"),down=await fs.readFile(path.join(migrations,"0060_offline_folder_revalidation_bounds.down.sql"),"utf8"),before=await state();
    await adb.transaction(q=>q.unsafe(up));expect(await state()).toBe(before);expect(await valid(make()),"expanded original shape after up").toBe(true);
    await adb.transaction(q=>q.unsafe(down));expect(await state()).toBe(before);expect(await valid(make())).toBe(false);
    await adb.transaction(q=>q.unsafe(up));expect(await state()).toBe(before);checks.push("additive up/down/up preserves populated catalogue and previous small repair history");
    const sample=tree[0];if(!sample)throw Error("Tree missing");const wide=[...tree];
    while(wide.length<1024){const id=randomUUID();wide.push({storagePath:"synthetic/"+id,description:{...sample.description,node_id:id,parent_id:root,name:id,availability:"AVAILABLE"}});}
    expect(await valid({...make(),tree:wide}),"1024node SQL shape").toBe(true);expect(await valid({...make(),tree:[...wide,{...sample,description:{...sample.description,node_id:randomUUID()}}]})).toBe(false);checks.push("SQL1024 exact admission and1025 refusal");
    const backend=path.join(directory,"backend");await fs.mkdir(backend);
    let copied=0;for(const e of [...tree].sort((a,b)=>a.storagePath.length-b.storagePath.length)){
      const target=path.resolve(backend,e.storagePath),from=path.resolve(f.originalStorageDirectory,e.storagePath);if(!target.startsWith(path.resolve(backend)+path.sep)||!from.startsWith(path.resolve(f.originalStorageDirectory)+path.sep))throw Error("Clone path escape");
      const s=await fs.lstat(from);if(s.isSymbolicLink())throw Error("Reparse source");
      if(e.description.type==="folder")await fs.mkdir(target,{recursive:true});else{copied+=s.size;if(!s.isFile()||copied>128*1024*1024)throw Error("Clone physical bound");await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(from,target);}
    }
    // This test owns the synthetic physical copy. These digests are not original-server custody authority.
    const devices=new DeviceService({repository:new PostgresDeviceRepository(adb),files:new FileService(new PostgresFileRepository(adb),new LocalStorageAdapter(backend)),pepper:f.pepper,options:{enabled:true,publicOrigin:"https://fixture.invalid",uploadChunkMaxBytes:8388608,propfindMaxItems:100,deleteMaxItems:10,deleteWindowMs:10000}});
    const authority=new CatalogFolderAuthorityIssuer(adb,{authenticateDevice:a=>devices.authenticateSyncMetadata(a)}),proof=await authority.device("Bearer "+f.client.token,root);
    await adb.withSql(q=>q.unsafe(`ALTER FUNCTION public.catalog_folder_revalidation_command(text,jsonb,jsonb) OWNER TO ${f.guard.writer_owner};GRANT EXECUTE ON FUNCTION public.catalog_folder_revalidation_command(text,jsonb,jsonb) TO ${f.guard.writer_login}`));
    const helper=fileURLToPath(new URL("../../../scripts/folder-revalidation-handles.ps1",import.meta.url)),stat=await fs.stat(backend,{bigint:true});
    const verifier=new WindowsFolderRevalidationVerifier({powershell:path.join(process.env["SystemRoot"]??"C:/Windows","System32/WindowsPowerShell/v1.0/powershell.exe"),handleScript:helper,handleScriptSha256:createHash("sha256").update(await fs.readFile(helper)).digest("hex"),evidenceDirectory:directory,acquireCustody:async intent=>({backendRoot:backend,backendNativeIdentity:stat.dev.toString(16).padStart(8,"0")+":"+stat.ino.toString(16).padStart(16,"0"),custody:intent.custody,assertCurrent:async()=>{},close:async()=>{}})});
    const fresh=()=>{const intent=parseFolderRevalidationIntent(make()),operator=new CatalogFolderRevalidationOperator(wdb,authority,new FolderRevalidationEvidenceIssuer(verifier),intent.binding,intent.guardRevision,intent.backendIdentity);return {intent,operator};};
    const unresolved=fresh(),beforeUnresolved=await state();
    await expect(unresolved.operator.reconcile(unresolved.intent,proof)).rejects.toThrow("incomplete_history");expect(await state()).toBe(beforeUnresolved);checks.push("unresolved uploads still block expanded repair");
    // Only this copied database: create valid terminal NOT_PUBLISHED outcomes
    // through the existing fixed lifecycle so the positive repair gate can run.
    // Original-server recovery keeps its intents and completes their uploads.
    const uploads=new CatalogUploadDatabaseCoordinator(wdb,authority),pending=await adb.withSql(q=>q<{id:string;upload_intent:CatalogUploadPrepareInput["intent"];upload_execution:CatalogUploadExecution;upload_transfer:CatalogUploadTransfer|null}[]>`SELECT id,upload_intent,upload_execution,upload_transfer FROM operation_journal WHERE sync_root_id=${root} AND sync_result IS NULL`);
    expect(pending).toHaveLength(3);
    for(const row of pending){
      const e=row.upload_execution,input={epoch:e.epoch,bindingVersion:e.bindingVersion,backendIdentity:e.backendIdentity,intent:row.upload_intent};
      let prepared=await uploads.prepare(input,proof,row.id);
      if(row.upload_transfer){
        const bytes=await fs.readFile(path.join(f.originalStorageDirectory,e.tempPath));
        expect(String(bytes.length)).toBe(input.intent.sizeBytes);expect(createHash("sha256").update(bytes).digest("hex")).toBe(input.intent.sha256);
        prepared=await uploads.recordChunk(prepared,proof,row.upload_transfer);
      }
      expect((await uploads.cancel(prepared,proof)).status.result?.status).toBe("NOT_PUBLISHED");
    }
    checks.push("isolated clone-only fixed cancellation supplies terminal history without altering original-server outcomes");
    await adb.withSql(q=>q.unsafe("CREATE FUNCTION refuse_bound_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.document->>'reason'='availability.revalidated' THEN RAISE EXCEPTION 'injected expanded repair fault'; END IF; RETURN NEW; END $$;CREATE TRIGGER refuse_bound_event BEFORE INSERT ON sync_root_changes FOR EACH ROW EXECUTE FUNCTION refuse_bound_event()"));
    const fault=fresh(),beforeFault=await state();await expect(fault.operator.reconcile(fault.intent,proof)).rejects.toThrow("injected expanded repair fault");expect(await state()).toBe(beforeFault);
    await adb.withSql(q=>q.unsafe("DROP TRIGGER refuse_bound_event ON sync_root_changes;DROP FUNCTION refuse_bound_event()"));checks.push("held523node fault rollback retains every original row and clock");
    const originalRows=await adb.withSql(q=>q`SELECT id,to_jsonb(j) AS value FROM operation_journal j ORDER BY id`),peerClock=await adb.withSql(q=>q`SELECT to_jsonb(c) AS value FROM sync_root_clock c WHERE root_id<>${root} ORDER BY root_id`);
    const accepted=fresh(),result=await accepted.operator.reconcile(accepted.intent,proof);expect(result.replayed).toBe(false);expect(result.result.descriptions).toHaveLength(16);expect(result.result.firstSeq).toBe(String(BigInt(clock.seq)+1n));expect(result.result.lastSeq).toBe(String(BigInt(clock.seq)+16n));
    const after=await state();expect(await accepted.operator.reconcile(accepted.intent,proof)).toEqual({...result,replayed:true});expect(await state()).toBe(after);
    expect(await adb.withSql(q=>q`SELECT id,to_jsonb(j) AS value FROM operation_journal j WHERE id<>${accepted.intent.operationId}::uuid ORDER BY id`)).toEqual(originalRows);
    expect(await adb.withSql(q=>q`SELECT to_jsonb(c) AS value FROM sync_root_clock c WHERE root_id<>${root} ORDER BY root_id`)).toEqual(peerClock);
    const current=await readTree();expect(current).toHaveLength(tree.length);expect(current.every(e=>e.description.availability==="AVAILABLE")).toBe(true);expect(current.filter(e=>e.description.type==="file")).toEqual(tree.filter(e=>e.description.type==="file"));checks.push("native full523preimage repairs16folders with immutable originals/peer isolation/same-key replay");
    await expect(adb.transaction(q=>q.unsafe(down))).rejects.toThrow("Used expanded folder revalidation history cannot be narrowed");expect(await state()).toBe(after);checks.push("down refuses after expanded original without partial schema/data change");
    const credential={deviceId:f.client.deviceId,deviceKind:"windows_sync",tokenHash:createHmac("sha256",f.pepper).update("device-capability-token\0").update(f.client.token).digest("hex")};
    const stale={...accepted.intent,operationId:randomUUID()};stale.idempotencyKey="folder-revalidate-"+stale.operationId;
    await expect(wdb.transaction(q=>q`SELECT catalog_folder_revalidation_command('commit',${JSON.stringify(stale)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb)`)).rejects.toThrow("metadata_conflict");expect(await state()).toBe(after);checks.push("second operation with stale root CAS refuses without effects");
    await fs.writeFile(path.join(directory,"qualification.json"),JSON.stringify({passed:true,at:new Date().toISOString(),checks,nodes:tree.length,revalidated:folders.length,physicalBytes:copied,beforeSeq:clock.seq,afterSeq:result.result.lastSeq},null,2),{flag:"wx"});
  }finally{await writer?.close();await db?.close();try{await admin.withSql(q=>q.unsafe(`DROP DATABASE IF EXISTS ${dbname}`));}finally{await admin.close();}}
},60000);
