// @vitest-environment node
import { errorValue } from "./error-value.js";
import { requiredValue,withReceiptFields } from "./test-value.js";
import {createHash,randomUUID} from "node:crypto";
import {afterEach,describe,expect,it,vi} from "vitest";
import {ApiError} from "./api.js";
import {planUploadTree,plannedJobSources} from "./upload-tree-plan.js";
import {prepareUploadTreeJob} from "./upload-tree-batch.js";
import {validateTreeJobStatus,type DurableTreeJob,type TreeJobStatus,type UploadTreeScope} from "./upload-tree-durable.js";
import {UploadTreeTransport,uploadTreeHttp} from "./upload-tree-transport.js";

const capability={schema:"saturn.browser-tree-capability.v1",available:true,limits:{items:16,wireBytes:4194304,metadataBytes:65536,smallFileBytes:262144,activeClientJobs:2}};
function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function fixture(){
 const file=new File(["exact retained original bytes"],"file.txt",{lastModified:1});
 const {plan,sources}=await planUploadTree(randomUUID(),[{kind:"file",itemId:randomUUID(),relativePath:file.name,name:file.name,getFile:async()=>file}]);
 const job=requiredValue(plan.jobs[0]),prepared=await prepareUploadTreeJob(job.jobId,plannedJobSources(plan,job.jobId,sources),{hasher:{hash:async(blob:Blob)=>createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex")}});
 let record:DurableTreeJob={key:plan.treeId+":"+job.jobId,treeId:plan.treeId,jobId:job.jobId,scope:{kind:"owner",rootId:randomUUID()},job,items:plan.items,phase:"ready",createdAt:1,updatedAt:1,encoded:prepared.encoded,intentSha256:createHash("sha256").update(prepared.encoded).digest("hex"),fingerprints:prepared.fingerprints};
 const accepted:TreeJobStatus={treeId:plan.treeId,jobId:job.jobId,intentSha256:requiredValue(record.intentSha256),state:"accepted",items:plan.items.map(item=>({itemId:item.itemId,parentItemId:item.parentItemId,relativePath:item.relativePath,kind:item.kind,state:"reserved",receipt:null}))};
 const completed:TreeJobStatus={...accepted,state:"completed",items:accepted.items.map(item=>({...item,state:"published",receipt:{resourceId:randomUUID(),versionId:randomUUID(),kind:"file",sizeBytes:file.size,sha256:requiredValue(prepared.fingerprints[0]).sha256,relativePath:file.name}}))};
 // Protocol-only fixture: the real validator runs, but this store is NOT disk
 // durability evidence. Native strict IndexedDB/crash proof is a separate gate.
 const store={
  loadJob:vi.fn(async()=>structuredClone(record)),
  markSending:vi.fn(async()=>record={...record,phase:"sending"}),
  retryMissingAdmission:vi.fn(async()=>record={...record,phase:"sending"}),
  markUnknown:vi.fn(async()=>record={...record,phase:"unknown"}),
  recordStatus:vi.fn(async(_tree:string,_job:string,value:unknown)=>{const status=validateTreeJobStatus(record,value);return record={...record,status,phase:status.state==="completed"?"completed":status.state==="cancelled"?"cancelled":status.state==="unknown"?"unknown":"accepted"};}),
  cancelUnsent:vi.fn(async()=>record={...record,phase:"cancelled"}),
 };
 const http={capability:vi.fn(async()=>capability),admit:vi.fn(async()=>accepted),inspect:vi.fn(async()=>accepted),execute:vi.fn(async()=>({status:completed})),cancel:vi.fn(async():Promise<TreeJobStatus>=>({...accepted,state:"cancelled",items:accepted.items.map(item=>({...item,state:"cancelled"}))}))};
 const transport=new UploadTreeTransport(store,http);
 return {treeId:plan.treeId,jobId:job.jobId,store,http,transport,accepted,completed,prepared,get record(){return record;},setRecord:(next:DurableTreeJob)=>{record=next;}};
}
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
describe("persisted original tree transport",()=>{
 it("awaits durable send and receipt commits before their dependent HTTP effects",async()=>{
  const f=await fixture(),sending=deferred(),receipt=deferred();
  const send=requiredValue(f.store.markSending.getMockImplementation()),save=requiredValue(f.store.recordStatus.getMockImplementation());
  f.store.markSending.mockImplementationOnce(async()=>{await sending.promise;return send();});
  f.store.recordStatus.mockImplementationOnce(async(...args)=>{await receipt.promise;return save(...args);});
  const operation=f.transport.advance(f.treeId,f.jobId);
  await vi.waitFor(()=>expect(f.store.markSending).toHaveBeenCalledOnce());expect(f.http.admit).not.toHaveBeenCalled();sending.resolve();
  await vi.waitFor(()=>expect(f.store.recordStatus).toHaveBeenCalledOnce());expect(f.http.execute).not.toHaveBeenCalled();receipt.resolve();
  expect((await operation).outcome).toBe("completed");expect(f.http.admit).toHaveBeenCalledWith(f.record.scope,f.treeId,f.prepared.encoded,undefined);
 });
 it("never sends if the durable boundary fails or the server capability is unavailable",async()=>{
  const f=await fixture();f.store.markSending.mockRejectedValueOnce(Error("disk quota"));
  await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toThrow("disk quota");expect(f.http.admit).not.toHaveBeenCalled();expect(f.record.phase).toBe("ready");
  f.http.capability.mockResolvedValueOnce({...capability,available:false});
  await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toThrow("unavailable");expect(f.http.admit).not.toHaveBeenCalled();
 });
 it("refuses a smaller live capability without repartitioning the saved original",async()=>{
  const f=await fixture();f.http.capability.mockResolvedValueOnce({...capability,limits:{...capability.limits,smallFileBytes:1}});
  await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toThrow("exceeds");expect(f.store.markSending).not.toHaveBeenCalled();expect(f.record.encoded).toBe(f.prepared.encoded);
 });
 it("recovers a lost admission reply by exact same-body replay only after an authenticated exact-original miss",async()=>{
  const f=await fixture();f.http.admit.mockRejectedValueOnce(Error("lost ACK"));
  await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toThrow("lost ACK");expect(f.record.phase).toBe("unknown");
  f.http.inspect.mockRejectedValueOnce(new ApiError(404,{code:"browser_tree_not_found"}));
  expect((await f.transport.advance(f.treeId,f.jobId)).outcome).toBe("completed");
  expect(f.store.retryMissingAdmission).toHaveBeenCalledOnce();expect(f.http.admit.mock.calls).toHaveLength(2);
  expect(f.http.admit.mock.calls[0]).toEqual(f.http.admit.mock.calls[1]);expect(f.record.jobId).toBe(f.jobId);
 });
 it.each([new ApiError(401,{code:"browser_tree_authorization_changed"}),new ApiError(404,{code:"other_route"}),Error("connection lost")])("does not reinterpret an inspection failure as proof of missing admission: %s",async error=>{
  const f=await fixture();f.setRecord({...f.record,phase:"unknown"});f.http.inspect.mockRejectedValueOnce(error);
  await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toBe(error);expect(f.http.admit).not.toHaveBeenCalled();expect(f.http.execute).not.toHaveBeenCalled();expect(f.record.phase).toBe("unknown");
 });
 it("recovers a lost final reply from its exact receipt without a second execution",async()=>{
  const f=await fixture();f.http.execute.mockRejectedValueOnce(Error("lost final ACK"));
  await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toThrow("lost final ACK");
  f.http.inspect.mockResolvedValueOnce(f.completed);
  expect((await f.transport.advance(f.treeId,f.jobId)).outcome).toBe("completed");expect(f.http.execute).toHaveBeenCalledOnce();expect(f.http.admit).toHaveBeenCalledOnce();
 });
 it.each(["materializing","verified","publishing","unknown"])("retains %s without starting replacement execution",async state=>{
  const f=await fixture();f.setRecord({...f.record,phase:"unknown"});f.http.inspect.mockResolvedValueOnce({...f.accepted,state:"running",items:f.accepted.items.map(item=>({...item,state}))});
  expect((await f.transport.advance(f.treeId,f.jobId)).outcome).toBe("reconciliation_required");expect(f.http.execute).not.toHaveBeenCalled();expect(f.record.encoded).toBe(f.prepared.encoded);
 });
 it("rejects a forged final version/hash and preserves original bytes",async()=>{
  const f=await fixture(),invalid=withReceiptFields(f.completed,0,{sha256:"0".repeat(64)});f.http.execute.mockResolvedValueOnce({status:invalid});
  await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toThrow("source fingerprint");expect(f.record.phase).toBe("unknown");expect(f.record.encoded).toBe(f.prepared.encoded);
 });
 it("keeps the original busy until uncertain persistence finishes",async()=>{
  const f=await fixture(),saved=deferred(),mark=requiredValue(f.store.markUnknown.getMockImplementation());
  f.http.admit.mockRejectedValueOnce(Error("lost ACK"));f.store.markUnknown.mockImplementationOnce(async()=>{await saved.promise;return mark();});
  const first=f.transport.advance(f.treeId,f.jobId).catch((error: unknown) =>error);
  await vi.waitFor(()=>expect(f.store.markUnknown).toHaveBeenCalledOnce());
  const concurrent=f.transport.advance(f.treeId,f.jobId).catch((error: unknown) =>error);
  saved.resolve();expect(await first).toBeInstanceOf(Error);expect(await concurrent).toMatchObject({message:"This original tree job is already active"});expect(f.http.inspect).not.toHaveBeenCalled();
 });
 it("aborts sends, joins persistence and requires inspection of the original",async()=>{
  const f=await fixture(),abort=new AbortController();
  f.http.admit.mockImplementationOnce(async(...args:unknown[])=>{const signal=args[3] as AbortSignal;return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(errorValue(signal.reason)),{once:true}));});
  const operation=f.transport.advance(f.treeId,f.jobId,abort.signal).catch((error: unknown) =>error);
  await vi.waitFor(()=>expect(f.http.admit).toHaveBeenCalledOnce());await expect(f.transport.cancel(f.treeId,f.jobId)).rejects.toThrow("join");abort.abort(Error("user stopped"));
  expect(await operation).toMatchObject({message:"user stopped"});expect(f.record.phase).toBe("unknown");expect(f.http.execute).not.toHaveBeenCalled();
 });
 it("cancels unsent work locally but cannot turn a sent404 or a committed receipt into cancellation",async()=>{
  const f=await fixture();expect((await f.transport.cancel(f.treeId,f.jobId)).outcome).toBe("cancelled");expect(f.http.cancel).not.toHaveBeenCalled();
  f.setRecord({...f.record,phase:"unknown"});f.http.cancel.mockRejectedValueOnce(new ApiError(404,{code:"browser_tree_not_found"}));
  await expect(f.transport.cancel(f.treeId,f.jobId)).rejects.toMatchObject({status:404});expect(f.record.phase).toBe("unknown");
  f.http.cancel.mockResolvedValueOnce(f.completed);expect((await f.transport.cancel(f.treeId,f.jobId)).outcome).toBe("completed");
 });
});
describe("real tree HTTP adapter request construction",()=>{
 it("uses normal cookies/CSRF and the persisted Drop channel rather than a different current history channel",async()=>{
  vi.stubGlobal("document",{cookie:"vault_csrf_dev=owner-token; vault_drop_csrf_dev=drop-token"});vi.stubGlobal("window",{history:{state:{saturnDropChannelId:randomUUID()}}});
  const fetch=vi.fn(async()=>new Response(JSON.stringify({ok:true}),{headers:{"content-type":"application/json"}}));vi.stubGlobal("fetch",fetch);
  const tree=randomUUID(),job=randomUUID(),owner:UploadTreeScope={kind:"owner",rootId:randomUUID()},drop:UploadTreeScope={kind:"drop",channelId:randomUUID()};
  await uploadTreeHttp.admit(owner,tree,"{\"original\":true}");await uploadTreeHttp.execute(drop,tree,job);await uploadTreeHttp.inspect(drop,tree,job);
  const calls=fetch.mock.calls as unknown as [string,RequestInit][];
  expect(requiredValue(calls[0])[0]).toBe(`/api/v1/upload-trees/${owner.rootId}/${tree}/jobs`);expect(requiredValue(calls[0])[1].credentials).toBe("same-origin");expect(new Headers(requiredValue(calls[0])[1].headers).get("X-Vault-CSRF")).toBe("owner-token");
  expect(requiredValue(calls[1])[0]).toBe(`/api/v1/drop/upload-trees/${tree}/jobs/${job}/execute`);expect(new Headers(requiredValue(calls[1])[1].headers).get("X-Saturn-Drop-Channel")).toBe(drop.channelId);expect(new Headers(requiredValue(calls[1])[1].headers).get("X-Vault-CSRF")).toBe("drop-token");
  expect(requiredValue(calls[2])[1].method).toBe("GET");expect(new Headers(requiredValue(calls[2])[1].headers).has("X-Vault-CSRF")).toBe(false);
 });
 it("bounds a stalled response and preserves an HTTP error code for exact-original decisions",async()=>{
  vi.useFakeTimers();vi.stubGlobal("document",{cookie:""});
  vi.stubGlobal("fetch",vi.fn(async(_url:string,options:RequestInit)=>new Promise((_resolve,reject)=>requiredValue(options.signal).addEventListener("abort",()=>reject(errorValue(requiredValue(options.signal).reason)),{once:true}))));
  const scope:UploadTreeScope={kind:"owner",rootId:randomUUID()},operation=uploadTreeHttp.capability(scope).catch((error: unknown) =>error);
  await vi.advanceTimersByTimeAsync(30000);expect(await operation).toMatchObject({message:expect.stringContaining("timed out") as unknown});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({code:"browser_tree_not_found"}),{status:404,headers:{"content-type":"application/json"}})));
  await expect(uploadTreeHttp.inspect(scope,randomUUID(),randomUUID())).rejects.toMatchObject({status:404,code:"browser_tree_not_found"});
 });
});
