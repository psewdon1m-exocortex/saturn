import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { activeFixture, barrier, evidence } from "./stage3-chat-a.fixture.js";
import { guardedSyncHttp } from "./guarded-sync-http.js";
import { PostgresSyncSnapshotStage } from "../../../packages/sync/src/sync-snapshot-stage.js";
import { PostgresSyncSnapshotReader } from "../../../packages/sync/src/sync-snapshot-read.js";
import { CatalogUploadDatabaseCoordinator } from "../../../packages/file-core/src/catalog-upload-database.js";

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE).each(["snapshots/start","snapshots/step","snapshots/ready","entries","changes"])("queues %s behind the actual same-root public writer, retaining SQL admission", async route => {
  const id="read-admission-"+route.replaceAll("/","-"),f=await activeFixture(id,"windows",69),app=Fastify();
  const entered=barrier(),release=barrier();let publication:Promise<unknown>|undefined;
  const rename=f.raw.rename.bind(f.raw);
  try {
    const guard={rootId:f.rootId,epoch:f.binding.epoch,bindingVersion:f.binding.bindingVersion,guardRevision:f.binding.guardRevision};
    const scope={wire:f.wireBinding,guard};
    const stage=new PostgresSyncSnapshotStage(f.runtime,f.issuer,scope);
    const reader=new PostgresSyncSnapshotReader(f.runtime,f.issuer,scope,"read-fair",[{id:"read-fair",secret:Buffer.alloc(32,86)}]);
    let snapshot=await stage.start(f.proof);for(let n=0;snapshot.state!=="READY"&&n<20;n++)snapshot=await stage.step(snapshot.snapshotId,f.proof);
    expect(snapshot.state).toBe("READY");const ready=await reader.ready(snapshot.snapshotId,f.proof);
    const root={binding:f.wireBinding,authority:f.issuer,stage,reader,admission:f.admission,ensureFolder:async():Promise<never>=>{throw Error("unused");}};
    await app.register(guardedSyncHttp,{root:async id=>id===f.rootId?root:undefined});await app.ready();
    const body=Buffer.from("real writer before snapshot");let prepared=await f.files.prepareCatalogUpload(f.uploadInput("pending",body),f.proof);
    prepared=await f.files.appendCatalogUpload(prepared,f.proof,"0",body);
    const spy=vi.spyOn(f.raw,"rename").mockImplementation(async(...args)=>{entered.release();await release.entered;return rename(...args);});
    const admission=vi.spyOn(f.admission,"run");
    publication=f.files.completeCatalogUpload(prepared,f.proof);await entered.entered;
    const before=admission.mock.calls.length;
    const payload=route.startsWith("snapshots/")?{binding:f.wireBinding,snapshot_id:route==="snapshots/start"?randomUUID():snapshot.snapshotId}:{binding:f.wireBinding,cursor:route==="entries"?ready.entries_cursor:ready.changes_cursor};
    let status:number|undefined;
    const response=app.inject({method:"POST",url:`/sync/v1/roots/${f.rootId}/${route}`,headers:{authorization:f.authorization},payload}).then(r=>{status=r.statusCode;return r;});
    try {
      await vi.waitFor(()=>expect(admission.mock.calls.length).toBeGreaterThan(before),{timeout:1500,interval:25});
      expect(status).toBeUndefined();
    } finally {release.release();await publication;spy.mockRestore();}
    const completed=await response;await evidence(id,"http",{status:completed.statusCode,body:completed.json<unknown>()});
    expect(completed.statusCode).toBe(200);
    const journal=await f.admin.withSql(sql=>sql<{sync_result:{status:string}}[]>`SELECT sync_result FROM operation_journal WHERE id=${prepared.status.session.uploadId}`);
    expect(journal[0]?.sync_result.status).toBe("PUBLISHED");
    await evidence(id,"result",{status:"PASS",queuedBehindPhysicalPublication:true,originalId:prepared.status.session.uploadId,sqlGuardUnchanged:true});
  } finally {release.release();await publication?.catch(()=>undefined);vi.restoreAllMocks();await app.close();await f.close();}
},60000);

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE).each([false,true])("retains SQL refusal for foreign public/UNKNOWN writer (unknown=%s)",async unknown=>{
  const id="read-foreign-"+String(unknown),f=await activeFixture(id,"windows",69),app=Fastify();
  try {
    const guard={rootId:f.rootId,epoch:f.binding.epoch,bindingVersion:f.binding.bindingVersion,guardRevision:f.binding.guardRevision},scope={wire:f.wireBinding,guard};
    const stage=new PostgresSyncSnapshotStage(f.runtime,f.issuer,scope),reader=new PostgresSyncSnapshotReader(f.runtime,f.issuer,scope,"read-fair",[{id:"read-fair",secret:Buffer.alloc(32,86)}]);
    await app.register(guardedSyncHttp,{root:async()=>({binding:f.wireBinding,authority:f.issuer,stage,reader,admission:f.admission,ensureFolder:async():Promise<never>=>{throw Error("unused");}})});
    const bytes=Buffer.from("foreign-original"),coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,"1073741824",true);
    const input=f.uploadInput("foreign",bytes);
    let prepared=await f.files.prepareCatalogUpload(input,f.proof);prepared=await f.files.appendCatalogUpload(prepared,f.proof,"0",bytes);
    // Reopen the same durable original through this coordinator's private proof
    // map; handles from FileService's different coordinator are not authority.
    prepared=await coordinator.prepare(input,f.proof);
    prepared=await coordinator.verify(prepared,f.proof,"application/octet-stream");prepared=await coordinator.claim(prepared,f.proof,randomUUID());if(unknown)await coordinator.markUnknown(prepared);
    const original=()=>f.admin.withSql(sql=>sql`SELECT id,idempotency_key,upload_intent,upload_execution,upload_claim_token,upload_effect_state,error_code,sync_result FROM operation_journal WHERE id=${prepared.status.session.uploadId}`);
    const before=await original();
    const response=await app.inject({method:"POST",url:`/sync/v1/roots/${f.rootId}/snapshots/start`,headers:{authorization:f.authorization},payload:{binding:f.wireBinding,snapshot_id:randomUUID()}});
    expect(response.statusCode).toBe(409);expect(response.json()).toEqual({code:"reconciliation_required"});expect(await original()).toEqual(before);
    await evidence(id,"result",{status:"PASS",refusal:409,unknown,originalUnchanged:true});
  } finally {await app.close();await f.close();}
},60000);
