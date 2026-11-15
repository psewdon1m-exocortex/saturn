// @vitest-environment node
import { requiredValue,withReceiptFields } from "./test-value.js";
import {createHash,randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import {ApiError} from "./api.js";
import {planUploadTree,plannedJobSources} from "./upload-tree-plan.js";
import {UploadTreeStreamSource} from "./upload-tree-stream.js";
import {UploadTreeStreamTransport} from "./upload-tree-stream-transport.js";
import {validateTreeJobStatus,type DurableTreeJob,type TreeJobStatus} from "./upload-tree-durable.js";
import {applyUploadTreeStreamStatus,beginUploadTreeStreamChunk,beginUploadTreeStreamSeal,type UploadTreeStreamChunkIntent,type UploadTreeStreamStatus} from "./upload-tree-stream-progress.js";

const capability={schema:"saturn.browser-tree-stream-capability.v1",available:true,limits:{metadataBytes:65536,chunkBytes:4194304,maximumFileBytes:8*1024**2,activeClientJobs:2}};
const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
function deferred<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function fixture(length=262145){
 const bytes=new Uint8Array(length).fill(83),file=new File([bytes],"stream.bin",{lastModified:11});
 const {plan,sources}=await planUploadTree(randomUUID(),[{kind:"file",itemId:randomUUID(),relativePath:file.name,name:file.name,getFile:async()=>file}]);
 const job=requiredValue(plan.jobs[0]),source=await UploadTreeStreamSource.prepare(job.jobId,plannedJobSources(plan,job.jobId,sources),{hasher:{hash:async(blob:Blob)=>sha(new Uint8Array(await blob.arrayBuffer()))}}),prepared=source.prepared;
 let record:DurableTreeJob={key:plan.treeId+":"+job.jobId,treeId:plan.treeId,jobId:job.jobId,scope:{kind:"owner",rootId:randomUUID()},job,items:plan.items,phase:"ready",createdAt:1,updatedAt:1,encoded:prepared.encoded,intentSha256:sha(prepared.encoded),fingerprints:prepared.fingerprints};
 const original={treeId:plan.treeId,jobId:job.jobId,itemId:requiredValue(plan.items[0]).itemId,intentSha256:requiredValue(record.intentSha256),sizeBytes:length,sha256:sha(bytes)};
 let progress:UploadTreeStreamStatus={schema:"saturn.browser-tree-stream-status.v1",...original,sealId:randomUUID(),confirmedOffset:0,state:"receiving",sealSha256:null,lastChunk:null};
 const accepted:TreeJobStatus={treeId:original.treeId,jobId:original.jobId,intentSha256:original.intentSha256,state:"accepted",items:plan.items.map(item=>({itemId:item.itemId,parentItemId:item.parentItemId,relativePath:item.relativePath,kind:item.kind,state:"reserved",receipt:null}))};
 const completed:TreeJobStatus={...accepted,state:"completed",items:accepted.items.map(item=>({...item,state:"published",receipt:{resourceId:randomUUID(),versionId:randomUUID(),kind:"file",sizeBytes:length,sha256:original.sha256,relativePath:file.name}}))};
 // Protocol fixture only. Production validators run; this in-memory store
 // does NOT prove IndexedDB commit/crash persistence or server durability.
 const store={
  loadJob:vi.fn(async()=>structuredClone(record)),markSending:vi.fn(async()=>record={...record,phase:"sending"}),retryMissingAdmission:vi.fn(async()=>record={...record,phase:"sending"}),
  markUnknown:vi.fn(async()=>record=["completed","cancelled"].includes(record.phase)?record:{...record,phase:"unknown"}),cancelUnsent:vi.fn(async()=>record={...record,phase:"cancelled"}),
  recordStatus:vi.fn(async(_tree:string,_job:string,value:unknown)=>{const status=validateTreeJobStatus(record,value);return record={...record,status,phase:status.state==="completed"?"completed":status.state==="cancelled"?"cancelled":status.state==="unknown"||record.stream?.pending!=null||record.stream?.sealPending?"unknown":"accepted"};}),
  recordStreamProgress:vi.fn(async(_tree:string,_job:string,value:unknown)=>{const stream=applyUploadTreeStreamStatus(original,record.stream,value);return record={...record,stream,phase:stream.pending!==null||stream.sealPending?"unknown":"accepted"};}),
  markStreamChunkPending:vi.fn(async(_tree:string,_job:string,intent:UploadTreeStreamChunkIntent)=>record={...record,stream:beginUploadTreeStreamChunk(original,requiredValue(record.stream),intent),phase:"unknown"}),
  markStreamSealPending:vi.fn(async()=>record={...record,stream:beginUploadTreeStreamSeal(original,requiredValue(record.stream)),phase:"unknown"}),
 };
 const http={
  capability:vi.fn(async()=>capability),admit:vi.fn(async()=>({status:accepted,progress})),inspect:vi.fn(async()=>({status:accepted,progress})),
  append:vi.fn(async(_scope:unknown,_tree:string,_job:string,chunk:UploadTreeStreamChunkIntent)=>{progress={...progress,confirmedOffset:chunk.offset+chunk.length,lastChunk:{offset:chunk.offset,length:chunk.length,sha256:chunk.sha256}};return structuredClone(progress);}),
  seal:vi.fn(async()=>{progress={...progress,state:"sealed",sealSha256:original.sha256};return structuredClone(progress);}),
  execute:vi.fn(async()=>({status:completed})),cancel:vi.fn(async():Promise<TreeJobStatus>=>({...accepted,state:"cancelled",items:accepted.items.map(item=>({...item,state:"cancelled"}))})),
 };
 const transport=new UploadTreeStreamTransport(store,http);
 return {treeId:original.treeId,jobId:original.jobId,source,prepared,original,store,http,transport,accepted,completed,get record(){return record;},get progress(){return progress;},setRecord:(value:DurableTreeJob)=>{record=value;}};
}
describe("same-original stream transport and uncertain outcomes",()=>{
 it("streams fixed chunks in order and resumes a lost intermediate ACK without rereading confirmed bytes",async()=>{
  const f=await fixture(4194304+17),append=requiredValue(f.http.append.getMockImplementation()),read=vi.spyOn(f.source,"chunk"),reports:number[]=[];
  f.http.append.mockImplementationOnce(async(...args)=>{await append(...args);throw Error("first chunk ACK lost");});
  await expect(f.transport.advance(f.treeId,f.jobId,{source:f.source})).rejects.toThrow("first chunk ACK lost");expect(read.mock.calls.map(c=>c[0])).toEqual([0]);
  expect((await f.transport.advance(f.treeId,f.jobId,{source:f.source,onProgress:offset=>reports.push(offset)})).outcome).toBe("completed");
  expect(read.mock.calls.map(c=>c[0])).toEqual([0,4194304]);expect(f.http.append.mock.calls.map(c=>[c[3].offset,c[3].length])).toEqual([[0,4194304],[4194304,17]]);expect(reports).toEqual([4194304,4194321]);
 });
 it("waits for strict send, chunk and seal intents before their dependent requests",async()=>{
  const f=await fixture(),sending=deferred(),pending=deferred(),sealing=deferred();
  const send=requiredValue(f.store.markSending.getMockImplementation()),chunk=requiredValue(f.store.markStreamChunkPending.getMockImplementation()),seal=requiredValue(f.store.markStreamSealPending.getMockImplementation());
  f.store.markSending.mockImplementationOnce(async()=>{await sending.promise;return send();});
  f.store.markStreamChunkPending.mockImplementationOnce(async(...args)=>{await pending.promise;return chunk(...args);});
  f.store.markStreamSealPending.mockImplementationOnce(async()=>{await sealing.promise;return seal();});
  const operation=f.transport.advance(f.treeId,f.jobId,{source:f.source});
  await vi.waitFor(()=>expect(f.store.markSending).toHaveBeenCalledOnce());expect(f.http.admit).not.toHaveBeenCalled();sending.resolve();
  await vi.waitFor(()=>expect(f.store.markStreamChunkPending).toHaveBeenCalledOnce());expect(f.http.append).not.toHaveBeenCalled();pending.resolve();
  await vi.waitFor(()=>expect(f.store.markStreamSealPending).toHaveBeenCalledOnce());expect(f.http.seal).not.toHaveBeenCalled();expect(f.http.execute).not.toHaveBeenCalled();sealing.resolve();
  expect((await operation).outcome).toBe("completed");expect(f.http.admit.mock.calls).toHaveLength(1);expect(requiredValue(f.http.append.mock.calls[0])[3]).toMatchObject({offset:0,length:262145,sha256:f.original.sha256});
 });
 it("does not send when a strict chunk commit fails and retains the admitted original",async()=>{
  const f=await fixture();f.store.markStreamChunkPending.mockRejectedValueOnce(Error("IDB full"));await expect(f.transport.advance(f.treeId,f.jobId,{source:f.source})).rejects.toThrow("IDB full");
  expect(f.http.append).not.toHaveBeenCalled();expect(f.http.seal).not.toHaveBeenCalled();expect(f.record.phase).toBe("unknown");expect(f.record.jobId).toBe(f.jobId);
 });
 it.each(["unavailable","maximum","slots"])("refuses %s capability before admission without repartitioning",async kind=>{
  const f=await fixture(),value={...capability,limits:{...capability.limits}};if(kind==="unavailable")value.available=false;else if(kind==="maximum")value.limits.maximumFileBytes=262144;else value.limits.activeClientJobs=1;
  f.http.capability.mockResolvedValueOnce(value);await expect(f.transport.advance(f.treeId,f.jobId,{source:f.source})).rejects.toThrow();expect(f.store.markSending).not.toHaveBeenCalled();expect(f.http.admit).not.toHaveBeenCalled();
 });
 it("asks for the same source after admission and refuses a different prepared original",async()=>{
  const f=await fixture();expect((await f.transport.advance(f.treeId,f.jobId)).outcome).toBe("source_required");expect(f.http.append).not.toHaveBeenCalled();
  const other=await fixture();await expect(f.transport.advance(f.treeId,f.jobId,{source:other.source})).rejects.toThrow("Reselected stream differs");expect(f.http.append).not.toHaveBeenCalled();expect(f.record.phase).toBe("unknown");
 });
 it("validates progress before saving a generic accepted reply that could clear uncertainty",async()=>{
  const f=await fixture();f.setRecord({...f.record,phase:"unknown"});f.http.inspect.mockResolvedValueOnce({status:f.accepted,progress:{...f.progress,treeId:randomUUID()}});
  await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toThrow("differs from its original");expect(f.store.recordStatus).not.toHaveBeenCalled();expect(f.store.recordStreamProgress).not.toHaveBeenCalled();expect(f.record.phase).toBe("unknown");
 });
 it("finishes after a lost last chunk ACK by inspecting its exact receipt without a File or second append",async()=>{
  const f=await fixture(),append=requiredValue(f.http.append.getMockImplementation());
  f.http.append.mockImplementationOnce(async(...args)=>{await append(...args);throw Error("lost chunk ACK");});
  await expect(f.transport.advance(f.treeId,f.jobId,{source:f.source})).rejects.toThrow("lost chunk ACK");expect(f.record.stream?.pending).toMatchObject({offset:0,length:262145});
  expect((await f.transport.advance(f.treeId,f.jobId)).outcome).toBe("completed");expect(f.http.append).toHaveBeenCalledOnce();expect(f.http.admit).toHaveBeenCalledOnce();expect(f.http.inspect).toHaveBeenCalledOnce();
 });
 it("retains an old ACK and replays only the identical pending bytes on explicit resume",async()=>{
  const f=await fixture();f.http.append.mockResolvedValueOnce(f.progress);
  expect((await f.transport.advance(f.treeId,f.jobId,{source:f.source})).outcome).toBe("pending");expect(f.record.stream?.pending).not.toBeNull();expect(f.http.seal).not.toHaveBeenCalled();
  expect((await f.transport.advance(f.treeId,f.jobId,{source:f.source})).outcome).toBe("completed");const calls=f.http.append.mock.calls;
  expect(calls).toHaveLength(2);expect(requiredValue(calls[0])[3].sha256).toBe(requiredValue(calls[1])[3].sha256);expect(requiredValue(calls[0])[3].offset).toBe(requiredValue(calls[1])[3].offset);
 });
 it("rejects a chunk receipt with the wrong SHA before clearing uncertainty or sealing",async()=>{
  const f=await fixture(),append=requiredValue(f.http.append.getMockImplementation());
  f.http.append.mockImplementationOnce(async(...args)=>{const receipt=await append(...args);return {...receipt,lastChunk:{...requiredValue(receipt.lastChunk),sha256:"0".repeat(64)}};});
  await expect(f.transport.advance(f.treeId,f.jobId,{source:f.source})).rejects.toThrow("exact durable chunk");expect(f.record.stream?.confirmedOffset).toBe(0);expect(f.record.stream?.pending).not.toBeNull();expect(f.http.seal).not.toHaveBeenCalled();
 });
 it("recovers a lost seal ACK without resending bytes or minting a seal",async()=>{
  const f=await fixture(),seal=requiredValue(f.http.seal.getMockImplementation());f.http.seal.mockImplementationOnce(async()=>{await seal();throw Error("lost seal ACK");});
  await expect(f.transport.advance(f.treeId,f.jobId,{source:f.source})).rejects.toThrow("lost seal ACK");const sealId=requiredValue(f.record.stream).sealId;expect(requiredValue(f.record.stream).sealPending).toBe(true);expect(f.http.execute).not.toHaveBeenCalled();
  expect((await f.transport.advance(f.treeId,f.jobId)).outcome).toBe("completed");expect(f.http.append).toHaveBeenCalledOnce();expect(f.http.seal).toHaveBeenCalledOnce();expect(requiredValue(f.record.stream).sealId).toBe(sealId);
 });
 it("recovers a lost publication response from the full original receipt",async()=>{
  const f=await fixture();f.http.execute.mockRejectedValueOnce(Error("lost stored ACK"));await expect(f.transport.advance(f.treeId,f.jobId,{source:f.source})).rejects.toThrow("lost stored ACK");
  f.http.inspect.mockResolvedValueOnce({status:f.completed,progress:f.progress});expect((await f.transport.advance(f.treeId,f.jobId)).outcome).toBe("completed");expect(f.http.execute).toHaveBeenCalledOnce();expect(f.http.append).toHaveBeenCalledOnce();
 });
 it.each(["materializing","verified","publishing","unknown"])("keeps %s server truth without a replacement execution",async state=>{
  const f=await fixture();f.setRecord({...f.record,phase:"unknown"});const status:TreeJobStatus={...f.accepted,state:"running",items:f.accepted.items.map(item=>({...item,state}))};
  f.http.inspect.mockResolvedValueOnce({status,progress:f.progress});const result=await f.transport.advance(f.treeId,f.jobId);
  expect(result.outcome).toBe(state==="unknown"?"reconciliation_required":"pending");expect(f.record.status).toEqual(status);expect(f.http.execute).not.toHaveBeenCalled();expect(f.http.admit).not.toHaveBeenCalled();
 });
 it("replays the exact admission body only after an authenticated original miss before any admission was observed",async()=>{
  const f=await fixture();f.http.admit.mockRejectedValueOnce(Error("lost admission"));await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toThrow("lost admission");
  f.http.inspect.mockRejectedValueOnce(new ApiError(404,{code:"browser_tree_not_found"}));expect((await f.transport.advance(f.treeId,f.jobId)).outcome).toBe("source_required");
  expect(f.http.admit.mock.calls[0]).toEqual(f.http.admit.mock.calls[1]);expect(f.store.retryMissingAdmission).toHaveBeenCalledOnce();
  f.http.inspect.mockRejectedValueOnce(new ApiError(404,{code:"browser_tree_not_found"}));await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toMatchObject({status:404});expect(f.http.admit).toHaveBeenCalledTimes(2);expect(f.store.retryMissingAdmission).toHaveBeenCalledOnce();
 });
 it.each([new ApiError(403,{code:"revoked"}),new ApiError(404,{code:"other_route"}),Error("network")])("does not turn %s into new admission",async error=>{
  const f=await fixture();f.setRecord({...f.record,phase:"unknown"});f.http.inspect.mockRejectedValueOnce(error);await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toBe(error);expect(f.http.admit).not.toHaveBeenCalled();
 });
 it("does not accept a forged final hash as stored and retains the local seal",async()=>{
  const f=await fixture(),bad=withReceiptFields(f.completed,0,{sha256:"0".repeat(64)});f.http.execute.mockResolvedValueOnce({status:bad});
  await expect(f.transport.advance(f.treeId,f.jobId,{source:f.source})).rejects.toThrow("source fingerprint");expect(requiredValue(f.record.stream).state).toBe("sealed");expect(f.record.phase).toBe("unknown");
 });
 it("joins aborted HTTP and UNKNOWN persistence before releasing the original or cancelling",async()=>{
  const f=await fixture(),network=deferred<UploadTreeStreamStatus>(),retention=deferred(),abort=new AbortController(),mark=requiredValue(f.store.markUnknown.getMockImplementation());
  f.http.append.mockImplementationOnce(async()=>network.promise);f.store.markUnknown.mockImplementationOnce(async()=>{await retention.promise;return mark();});
  const operation=f.transport.advance(f.treeId,f.jobId,{source:f.source,signal:abort.signal}).catch((error: unknown) =>error);await vi.waitFor(()=>expect(f.http.append).toHaveBeenCalledOnce());abort.abort(Error("stopped"));
  await expect(f.transport.cancel(f.treeId,f.jobId)).rejects.toThrow("busy");network.reject(abort.signal.reason);await vi.waitFor(()=>expect(f.store.markUnknown).toHaveBeenCalledOnce());
  await expect(f.transport.advance(f.treeId,f.jobId)).rejects.toThrow("busy");retention.resolve();expect(await operation).toMatchObject({message:"stopped"});expect(f.http.seal).not.toHaveBeenCalled();expect(f.record.phase).toBe("unknown");
 });
 it("allows at most two active originals and holds both slots until inspection settles",async()=>{
  const fixtures=await Promise.all([fixture(),fixture(),fixture()]),gates=[deferred<unknown>(),deferred<unknown>()];
  for(const f of fixtures)f.setRecord({...f.record,phase:"unknown"});
  const store={...fixtures[0].store,loadJob:vi.fn(async(_tree:string,job:string)=>requiredValue(fixtures.find(f=>f.jobId===job)).record)},inspect=vi.fn(async(_scope:unknown,_tree:string,job:string)=>requiredValue(gates[fixtures.findIndex(f=>f.jobId===job)]).promise);
  const transport=new UploadTreeStreamTransport(store,{...fixtures[0].http,inspect}),first=transport.advance(fixtures[0].treeId,fixtures[0].jobId).catch((error: unknown) =>error),second=transport.advance(fixtures[1].treeId,fixtures[1].jobId).catch((error: unknown) =>error);
  await vi.waitFor(()=>expect(inspect).toHaveBeenCalledTimes(2));await expect(transport.advance(fixtures[2].treeId,fixtures[2].jobId)).rejects.toThrow("busy");
  requiredValue(gates[0]).reject(Error("pending original one"));requiredValue(gates[1]).reject(Error("pending original two"));expect(await first).toBeInstanceOf(Error);expect(await second).toBeInstanceOf(Error);expect(inspect).toHaveBeenCalledTimes(2);
 });
 it("cancels unsent work locally and preserves a publication that won the server cancellation race",async()=>{
  const f=await fixture();expect((await f.transport.cancel(f.treeId,f.jobId)).outcome).toBe("cancelled");expect(f.http.cancel).not.toHaveBeenCalled();
  f.setRecord({...f.record,phase:"unknown"});f.http.cancel.mockResolvedValueOnce(f.completed);expect((await f.transport.cancel(f.treeId,f.jobId)).outcome).toBe("completed");
 });
});
