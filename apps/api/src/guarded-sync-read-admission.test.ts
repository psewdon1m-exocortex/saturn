import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { expect,it,vi } from "vitest";
import { CatalogRootAdmission } from "../../../packages/file-core/src/catalog-root-admission.js";
import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { guardedSyncHttp,type GuardedSyncHttpRoot } from "./guarded-sync-http.js";
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return{promise,resolve};}
async function fixture(){
  const app=Fastify(),admission=new CatalogRootAdmission({maximumQueuedPerRoot:1,maximumWaitMs:2000});
  const binding:SyncRootBinding={protocol:"neptune-sync/1",descriptor_schema:"saturn.current-namespace.v1",server_identity:"read-admission",root_id:randomUUID(),server_epoch:randomUUID(),policy_version:"1",binding_version:randomUUID()};
  const state={revoked:false,changed:false};
  const start=vi.fn(async()=>({state:"BASE"})),device=vi.fn(async()=>{if(state.revoked)throw Object.assign(Error("revoked"),{code:"authorization_changed"});return{};});
  const root={binding,admission,authority:{device},stage:{start},reader:{changesAvailable:async()=>state.changed,changes:async()=>Buffer.from("{}")},extensions:["changes-wait-v1"]} as unknown as GuardedSyncHttpRoot;
  await app.register(guardedSyncHttp,{root:async()=>root});await app.ready();
  const post=()=>app.inject({method:"POST",url:`/sync/v1/roots/${binding.root_id}/snapshots/start`,payload:{binding,snapshot_id:randomUUID()}});
  return{app,admission,binding,state,root,start,device,post};
}
it.each(["revoked","binding","composition"])("rechecks %s after queue admission without using stale authority",async kind=>{
  const f=await fixture(),release=barrier();const held=f.admission.run(f.binding.root_id,()=>release.promise);const calls=vi.spyOn(f.admission,"run");
  try{
    const response=f.post();await vi.waitFor(()=>expect(calls).toHaveBeenCalledTimes(1));
    if(kind==="revoked")f.state.revoked=true;
    else if(kind==="binding")Object.assign(f.root,{binding:{...f.binding,binding_version:randomUUID()}});
    else Object.assign(f.root,{admission:new CatalogRootAdmission()});
    release.resolve();await held;const result=await response;
    expect(result.statusCode).toBe(kind==="revoked"?403:kind==="binding"?409:410);expect(f.start).not.toHaveBeenCalled();
  }finally{release.resolve();await held;await f.app.close();}
});
it("bounds pending readers and admits the next read after the queue drains",async()=>{
  const f=await fixture(),release=barrier();const held=f.admission.run(f.binding.root_id,()=>release.promise),calls=vi.spyOn(f.admission,"run");
  try{const waiting=f.post();await vi.waitFor(()=>expect(calls).toHaveBeenCalledTimes(1));const denied=await f.post();expect(denied.statusCode).toBe(429);expect(denied.headers["retry-after"]).toBe("1");release.resolve();await held;expect((await waiting).statusCode).toBe(200);expect((await f.post()).statusCode).toBe(200);}
  finally{release.resolve();await held;await f.app.close();}
});
it("does not hold the writer queue while a long poll sleeps",async()=>{
  const f=await fixture(),observed=barrier();const available=vi.spyOn(f.root.reader,"changesAvailable").mockImplementation(async()=>{observed.resolve();return f.state.changed;});
  try{const response=f.app.inject({method:"POST",url:`/sync/v1/roots/${f.binding.root_id}/changes`,payload:{binding:f.binding,cursor:"opaque",wait_ms:1000}});await observed.promise;
    const write=f.admission.run(f.binding.root_id,async()=>{f.state.changed=true;});
    await Promise.race([write,new Promise((_,reject)=>setTimeout(()=>reject(Error("poll retained writer slot")),200))]);expect((await response).statusCode).toBe(200);expect(available).toHaveBeenCalled();
  }finally{await f.app.close();}
});
it("releases a disconnected queued reader without releasing the active writer",async()=>{
  const f=await fixture(),release=barrier(),abort=new AbortController();const held=f.admission.run(f.binding.root_id,()=>release.promise),calls=vi.spyOn(f.admission,"run");
  try{const origin=await f.app.listen({host:"127.0.0.1",port:0});
    const disconnected=fetch(`${origin}/sync/v1/roots/${f.binding.root_id}/snapshots/start`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({binding:f.binding,snapshot_id:randomUUID()}),signal:abort.signal}).catch(()=>undefined);
    await vi.waitFor(()=>expect(calls).toHaveBeenCalledTimes(1));abort.abort();await disconnected;await new Promise(r=>setTimeout(r,40));
    const next=f.post();await vi.waitFor(()=>expect(calls).toHaveBeenCalledTimes(2));expect(f.start).not.toHaveBeenCalled();release.resolve();await held;expect((await next).statusCode).toBe(200);
  }finally{abort.abort();release.resolve();await held;await f.app.close();}
});
