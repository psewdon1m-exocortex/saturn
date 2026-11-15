import {describe,expect,it} from "vitest";
import {validateBrowserTreeJob} from "./browser-upload-tree-contract.js";
import {BROWSER_TREE_STREAM_LIMITS,validateBrowserTreeStreamChunk,validateBrowserTreeStreamJob} from "./browser-upload-tree-stream-contract.js";
const jobId="11111111-1111-4111-8111-111111111111",itemId="22222222-2222-4222-8222-222222222222",parentItemId="33333333-3333-4333-8333-333333333333",maximum=20*1024**3;
const body=()=>({schema:"saturn.browser-tree-stream-job.v1",jobId,item:{kind:"file",itemId,parentItemId,relativePath:"photos/large.bin",sizeBytes:2*1024**3,sha256:"a".repeat(64)}});
describe("separate bounded browser tree stream metadata",()=>{
 it("retains a full2GiB original without any inline payload and hashes canonical metadata",()=>{
  const value=body(),first=validateBrowserTreeStreamJob(value,maximum),reordered={item:{...value.item},jobId:value.jobId,schema:value.schema};
  expect(first.chunkCount).toBe(512);expect(first.metadataBytes).toBeLessThan(1024);expect(first.value).toEqual(value);
  expect(validateBrowserTreeStreamJob(reordered,maximum).intentSha256).toBe(first.intentSha256);
  expect(Object.isFrozen(first.value.item)).toBe(true);
  value.item.relativePath="changed.bin";expect(first.value.item.relativePath).toBe("photos/large.bin");
 });
 it.each(["contentBase64","backendTaskId","storagePath","resourceId"])("refuses caller-supplied %s before admission",field=>{
  const value=body();expect(()=>validateBrowserTreeStreamJob({...value,item:{...value.item,[field]:"untrusted"}},maximum)).toThrow("field");
 });
 it("keeps small inline and large metadata protocols distinct",()=>{
  const value=body();expect(()=>validateBrowserTreeJob(value)).toThrow();
  expect(()=>validateBrowserTreeStreamJob({...value,item:{...value.item,sizeBytes:262144}},maximum)).toThrow("bound");
  expect(validateBrowserTreeStreamJob({...value,item:{...value.item,sizeBytes:262145}},maximum).value.item.sizeBytes).toBe(262145);
  expect(()=>validateBrowserTreeStreamJob({...value,item:{...value.item,sizeBytes:maximum+1}},maximum)).toThrow("bound");
  expect(()=>validateBrowserTreeStreamJob(value,NaN)).toThrow("bound");
 });
 it.each(["../escape.bin","/absolute.bin","C:/drive.bin","folder/..%2fescape.bin","folder/file\\name","folder/CON.bin"])("refuses unsafe relative path %s",relativePath=>{
  const value=body();expect(()=>validateBrowserTreeStreamJob({...value,item:{...value.item,relativePath}},maximum)).toThrow();
 });
 it("binds full SHA, exact parent, filename and size into the immutable intent",()=>{
  const value=body(),original=validateBrowserTreeStreamJob(value,maximum).intentSha256;
  for(const mutation of [{sha256:"b".repeat(64)},{parentItemId:itemId},{relativePath:"elsewhere/large.bin"},{sizeBytes:value.item.sizeBytes+1}]){
   if(mutation.parentItemId)expect(()=>validateBrowserTreeStreamJob({...value,item:{...value.item,...mutation}},maximum)).toThrow("parent");
   else expect(validateBrowserTreeStreamJob({...value,item:{...value.item,...mutation}},maximum).intentSha256).not.toBe(original);
  }
  expect(()=>validateBrowserTreeStreamJob({...value,item:{...value.item,parentItemId:null}},maximum)).toThrow("parent");
  expect(()=>validateBrowserTreeStreamJob({...value,item:{...value.item,sha256:"sampled"}},maximum)).toThrow("SHA256");
 });
 it("bounds every chunk without unsafe offset addition or zero-progress writes",()=>{
  expect(()=>validateBrowserTreeStreamChunk(maximum,0,BROWSER_TREE_STREAM_LIMITS.chunkBytes)).not.toThrow();
  expect(()=>validateBrowserTreeStreamChunk(maximum+1,maximum,1)).not.toThrow();
  for(const [offset,length]of [[0,0],[0,1],[0,4194305],[-1,1],[maximum,1],[maximum-1,1],[maximum-1,2],[1.5,1],[Number.MAX_SAFE_INTEGER,2]] as const)expect(()=>validateBrowserTreeStreamChunk(maximum,offset,length)).toThrow("chunk");
  expect(()=>validateBrowserTreeStreamChunk(Number.MAX_SAFE_INTEGER+1,0,1)).toThrow("chunk");
 });
});
