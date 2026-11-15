import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import { expect, it } from "vitest";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Database } from "@saturn/database";
import { LocalStorageAdapter } from "@saturn/storage";
import { DurableBackendExecutor, type BackendCommand } from "../../../packages/storage/src/durable-backend-executor.js";
import { CatalogRootAdmission } from "../../../packages/file-core/src/catalog-root-admission.js";
import { CatalogPlutoRetention } from "../../../packages/file-core/src/catalog-pluto-retention.js";
import { fixtureManifest, evidence, sha } from "./stage3-chat-a.fixture.js";

it.runIf(process.env.ENDURANCE_RETAINED_RETENTION === "f3f55c75-dcd4-4354-adae-7e781f98cf54")("drains the retained cycle9 retention original without migration or identity reset", async () => {
  const fixture=await fixtureManifest(), database="stage3_bb64fc2455af492081318f83fe592996", root="01a13d2b-9a4c-737b-93bb-1469f9e90d68", history="1978f4aa-3078-46b5-a485-e96cae58122b";
  const url=new URL(fixture.databaseUrl);url.pathname="/"+database;
  const admin=new Database(url.toString(),{max:2});
  let writer:Database|undefined,executor:DurableBackendExecutor|undefined;
  try {
    const before=await admin.withSql(sql=>sql`SELECT backend_identity,generation,writer_login,state FROM sync_backend_executor`);
    expect(before).toHaveLength(1);expect(requireDefined(before[0]).state).toBe("STOPPED");
    expect(requireDefined(before[0]).backend_identity).toBe("backend-bb64fc2455af492081318f83fe592996");
    expect(await admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks WHERE state IN('QUEUED','RUNNING','UNKNOWN')`)).toHaveLength(0);
    const guard=await admin.withSql(sql=>sql`SELECT * FROM catalog_guard_roots WHERE root_id=${root}`);
    const receipts=await admin.withSql(sql=>sql`SELECT id,sync_result FROM operation_journal ORDER BY id`);
    const initialVersions=await admin.withSql(sql=>sql`SELECT id,state,storage_path,size_bytes,sha256 FROM file_versions WHERE resource_id=${history} ORDER BY created_at,id`);
    expect(initialVersions).toHaveLength(13);
    const raw=new LocalStorageAdapter(path.join(fixture.fixtureDirectory,database,"storage"));await raw.initialize();
    async function readVersions(){
      const rows=await admin.withSql(sql=>sql<{id:string;state:string;storage_path:string;size_bytes:string;sha256:string}[]>`SELECT id,state,storage_path,size_bytes,sha256 FROM file_versions WHERE resource_id=${history} ORDER BY created_at,id`);
      const result=[];
      for(const v of rows){const exists=await raw.exists(v.storage_path);let actual:string|null=null;
        if(exists){const chunks=[];for await(const b of await raw.openRead(v.storage_path))chunks.push(Buffer.from(b));actual=sha(Buffer.concat(chunks));expect(actual).toBe(v.sha256);}
        expect(exists).toBe(v.state==="active");result.push({...v,exists,actual});}
      return result;
    }
    const beforeReadback=await readVersions();await evidence("original-retention","before",{database,root,history,before,versions:beforeReadback});
    url.username=String(requireDefined(before[0]).writer_login);writer=new Database(url.toString(),{max:3});
    const command:BackendCommand=async(command,identity,payload)=>requireDefined((await requireDefined(writer).withSql(sql=>sql<{value:unknown}[]>`SELECT sync_backend_command(${command},${JSON.stringify(identity)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`))[0]).value;
    executor=new DurableBackendExecutor(raw,command,String(requireDefined(before[0]).backend_identity),String(requireDefined(before[0]).generation));await executor.start();
    const retention=new CatalogPlutoRetention(writer,new CatalogRootAdmission(),executor.identity),progress=[];
    // Faster diagnostic cadence on the old approved function. This proves recovery
    // of these originals, not throughput of the new production scheduler.
    for(let n=0;n<1000;n++){
      const p=await retention.tick(root);if(p.planned||p.completed)progress.push({tick:n,...p});
      const remaining=await admin.withSql(sql=>sql`SELECT version_id FROM sync_retention_originals WHERE root_id=${root} AND state='DELETED'`);
      if(remaining.length===3)break;
      if(n%50===0)console.log("retained retention tick",n);
      await delay(20);
    }
    const versions=await readVersions();expect(versions.filter(v=>v.state==="active")).toHaveLength(10);
    for(let i=0;i<13;i++){expect(requireDefined(versions[i]).sha256).toBe(sha("revision-"+String(i+1).padStart(2,"0")));expect(requireDefined(versions[i]).state).toBe(i<3?"expired":"active");}
    expect(await admin.withSql(sql=>sql`SELECT * FROM catalog_guard_roots WHERE root_id=${root}`)).toEqual(guard);
    expect(await admin.withSql(sql=>sql`SELECT id,sync_result FROM operation_journal ORDER BY id`)).toEqual(receipts);
    const originals=await admin.withSql(sql=>sql`SELECT version_id,state,receipt FROM sync_retention_originals WHERE root_id=${root}`);
    expect(originals).toHaveLength(3);expect(originals.every(o=>o.state==="DELETED"&&o.receipt)).toBe(true);
    await evidence("original-retention","result",{status:"PASS",database,root,history,progress,versions,originals,scope:"original server queue recovery on old SQL; diagnostic cadence; native inode state unavailable"});
  }finally{await executor?.close();await writer?.close();await admin.close();}
},120000);
