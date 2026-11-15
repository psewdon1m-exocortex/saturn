// @vitest-environment node
import { requiredValue,withReceiptFields } from "./test-value.js";
import {createHash,randomUUID} from "node:crypto";
import {describe,it,expect,vi} from "vitest";
import {createBlobSha256} from "./upload-sha256-core.js";
import {planUploadTree,plannedJobSources} from "./upload-tree-plan.js";
import {UploadTreeStreamSource,assertPreparedUploadTreeStream} from "./upload-tree-stream.js";
import {validatePreparedTreeStream,validateTreeJobStatus,type DurableTreeJob,type TreeJobStatus} from "./upload-tree-durable.js";
import {validateBrowserTreeStreamJob,validateBrowserTreeStreamChunk} from "../../../packages/file-core/src/browser-upload-tree-stream-contract.js";
const sha=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
async function fixture(length=262145){
 const bytes=new Uint8Array(length);for(let i=0;i<length;i++)bytes[i]=(i*193+71)%251;
 const file=new File([bytes],"large.bin",{lastModified:123}),item={kind:"file" as const,itemId:randomUUID(),name:file.name,relativePath:file.name,getFile:async()=>file};
 const {plan,sources}=await planUploadTree(randomUUID(),[item]),job=requiredValue(plan.jobs[0]),hasher={hash:await createBlobSha256()};
 const record:DurableTreeJob={key:plan.treeId+":"+job.jobId,treeId:plan.treeId,jobId:job.jobId,scope:{kind:"owner",rootId:randomUUID()},job,items:plan.items,phase:"preparing",createdAt:1,updatedAt:1};
 return {bytes,file,item,plan,sources,job,hasher,record};
}
describe("streaming browser tree source and durable metadata",()=>{
 it("uses incremental full SHA and server-compatible metadata without opening the whole File",async()=>{
  const f=await fixture(4194304+17),whole=vi.spyOn(f.file,"arrayBuffer").mockRejectedValue(Error("Whole-file read forbidden")),slice=vi.spyOn(f.file,"slice");
  const source=await UploadTreeStreamSource.prepare(f.job.jobId,plannedJobSources(f.plan,f.job.jobId,f.sources),{hasher:f.hasher});
  expect(whole).not.toHaveBeenCalled();expect(slice.mock.calls.every(c=>Number(c[1])-Number(c[0])<=1048576)).toBe(true);
  const parsed=validateBrowserTreeStreamJob(JSON.parse(source.prepared.encoded),8*1024**2);expect(parsed.value.item.sha256).toBe(sha(f.bytes));expect(parsed.intentSha256).toBe(sha(source.prepared.encoded));
  expect(source.prepared.encoded.length).toBeLessThan(1024);expect(source.prepared.encoded).not.toContain("contentBase64");validatePreparedTreeStream(f.record,source.prepared);
  const first=await source.chunk(0),last=await source.chunk(4194304);for(const chunk of [first,last]){validateBrowserTreeStreamChunk(f.bytes.length,chunk.offset,chunk.length);expect(chunk.sha256).toBe(sha(chunk.bytes));}
  expect(first.length).toBe(4194304);expect(last.length).toBe(17);expect(Buffer.compare(first.bytes,f.bytes.subarray(0,4194304))).toBe(0);expect(Buffer.compare(last.bytes,f.bytes.subarray(4194304))).toBe(0);expect(whole).not.toHaveBeenCalled();
 });
 it("requires exact size name mtime and full SHA when a source is reselected",async()=>{
  const f=await fixture(),source=await UploadTreeStreamSource.prepare(f.job.jobId,[f.item],{hasher:f.hasher}),saved=structuredClone(source.prepared);
  const recovered=await UploadTreeStreamSource.reselect(saved,new File([f.bytes],f.file.name,{lastModified:123}),{hasher:f.hasher});expect(recovered.prepared).toEqual(saved);expect(Buffer.compare((await recovered.chunk(0)).bytes,f.bytes)).toBe(0);
  const wrong=new Uint8Array(f.bytes);wrong[0]=(wrong[0]??0)^1;await expect(UploadTreeStreamSource.reselect(saved,new File([wrong],f.file.name,{lastModified:123}),{hasher:f.hasher})).rejects.toThrow("SHA-256");
  for(const file of [new File([f.bytes],"other",{lastModified:123}),new File([f.bytes],f.file.name,{lastModified:124}),new File([f.bytes.subarray(1)],f.file.name,{lastModified:123})]){
   const hash=vi.fn();await expect(UploadTreeStreamSource.reselect(saved,file,{hasher:{hash}})).rejects.toThrow("identity");expect(hash).not.toHaveBeenCalled();
  }
 });
 it("rejects malformed source paths and small files before hashing",async()=>{
  const f=await fixture(),hash=vi.fn();for(const item of [{...f.item,relativePath:"../large.bin"},{...f.item,parentItemId:f.item.itemId},{...f.item,name:"different"}])await expect(UploadTreeStreamSource.prepare(f.job.jobId,[item],{hasher:{hash}})).rejects.toThrow();
  await expect(UploadTreeStreamSource.prepare(f.job.jobId,[{...f.item,getFile:async()=>new File([new Uint8Array(262144)],f.file.name,{lastModified:123})}],{hasher:{hash}})).rejects.toThrow("identity");expect(hash).not.toHaveBeenCalled();
 });
 it("retains its read slot until an aborted in-progress read settles",async()=>{
  const f=await fixture(),source=await UploadTreeStreamSource.prepare(f.job.jobId,[f.item],{hasher:f.hasher}),abort=new AbortController();
  const pending=source.chunk(0,abort.signal),rejection=expect(pending).rejects.toThrow("cancelled");abort.abort(Error("cancelled"));await expect(source.chunk(0)).rejects.toThrow("already being read");await rejection;
  expect((await source.chunk(0)).sha256).toBe(sha(f.bytes));for(const offset of [-1,1,0.5,f.bytes.length,Number.MAX_SAFE_INTEGER+1])await expect(source.chunk(offset)).rejects.toThrow("offset");
 });
 it("does not produce a prepared original after cancellation during the full hash",async()=>{
  const f=await fixture(),abort=new AbortController();await expect(UploadTreeStreamSource.prepare(f.job.jobId,[f.item],{signal:abort.signal,hasher:{hash:async()=>{abort.abort(Error("cancelled"));return sha(f.bytes);}}})).rejects.toThrow("cancelled");
 });
 it("keeps the originally selected identity while asynchronous source resolution runs",async()=>{
  const f=await fixture(),source=UploadTreeStreamSource.prepare(f.job.jobId,[f.item],{hasher:f.hasher});f.item.relativePath="replacement";f.item.itemId=randomUUID();
  const result=await source;expect(result.prepared.job.item.relativePath).toBe("large.bin");expect(result.prepared.job.item.itemId).toBe(requiredValue(f.record.items[0]).itemId);
 });
 it("rejects changed persisted intent and source metadata before a strict journal transition",async()=>{
  const f=await fixture(),source=await UploadTreeStreamSource.prepare(f.job.jobId,[f.item],{hasher:f.hasher});
  const wrong={...f.record,items:[{...requiredValue(f.record.items[0]),parentItemId:randomUUID()}]};expect(()=>validatePreparedTreeStream(wrong,source.prepared)).toThrow("original plan");
  const changedJob={...source.prepared.job,item:{...source.prepared.job.item,sizeBytes:source.prepared.job.item.sizeBytes+1}},changed={...source.prepared,job:changedJob,encoded:JSON.stringify(changedJob)};expect(()=>assertPreparedUploadTreeStream(changed)).toThrow("fingerprint");
  const injectedJob={...source.prepared.job,item:{...source.prepared.job.item,backendPath:"unsafe"}},injected={...source.prepared,job:injectedJob,encoded:JSON.stringify(injectedJob)};expect(()=>assertPreparedUploadTreeStream(injected)).toThrow("metadata");
  expect(()=>assertPreparedUploadTreeStream({...source.prepared,encoded:source.prepared.encoded+" "})).toThrow("original");
 });
 it("requires the exact full publication receipt and does not accept a local seal as stored",async()=>{
  const f=await fixture(),source=await UploadTreeStreamSource.prepare(f.job.jobId,[f.item],{hasher:f.hasher}),record:DurableTreeJob={...f.record,phase:"sending",encoded:source.prepared.encoded,intentSha256:sha(source.prepared.encoded),fingerprints:source.prepared.fingerprints};
  const item=requiredValue(record.items[0]),status:TreeJobStatus={treeId:record.treeId,jobId:record.jobId,intentSha256:requiredValue(record.intentSha256),state:"completed",items:[{itemId:item.itemId,parentItemId:item.parentItemId,relativePath:item.relativePath,kind:"file",state:"published",receipt:{resourceId:randomUUID(),versionId:randomUUID(),kind:"file",sizeBytes:f.bytes.length,sha256:sha(f.bytes),relativePath:item.relativePath}}]};
  expect(validateTreeJobStatus(record,status)).toEqual(status);
  expect(()=>validateTreeJobStatus(record,{...status,items:[{...requiredValue(status.items[0]),state:"sealed",receipt:null}]})).toThrow();
  const wrong=withReceiptFields(status,0,{sha256:"0".repeat(64)});expect(()=>validateTreeJobStatus(record,wrong)).toThrow("source fingerprint");
  const {encoded,...terminal}=record;void encoded;expect(validateTreeJobStatus({...terminal,phase:"completed",status},status)).toEqual(status);
 });
});
