// @vitest-environment node
import { requiredValue,withReceiptFields } from "./test-value.js";
import {createHash,randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {planUploadTree,plannedJobSources} from "./upload-tree-plan.js";
import {prepareUploadTreeJob} from "./upload-tree-batch.js";
import {validateTreeJobStatus,type DurableTreeJob,type TreeJobStatus} from "./upload-tree-durable.js";
import {validateBrowserTreeJob} from "../../../packages/file-core/src/browser-upload-tree-contract.js";
async function fixture(){
 const directory={kind:"directory" as const,itemId:randomUUID(),relativePath:"folder",name:"folder"},file=new File(["original"],"file",{lastModified:1});
 const source={kind:"file" as const,itemId:randomUUID(),parentItemId:directory.itemId,relativePath:"folder/file",name:"file",getFile:async()=>file};
 const {plan,sources}=await planUploadTree(randomUUID(),[directory,source]),job=requiredValue(plan.jobs[0]);
 const prepared=await prepareUploadTreeJob(job.jobId,plannedJobSources(plan,job.jobId,sources),{hasher:{hash:async(blob:Blob)=>createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex")}});
 const intentSha256=validateBrowserTreeJob(prepared.job).intentSha256;
 const record:DurableTreeJob={key:plan.treeId+":"+job.jobId,treeId:plan.treeId,jobId:job.jobId,scope:{kind:"owner",rootId:randomUUID()},job,items:plan.items,phase:"sending",createdAt:1,updatedAt:1,encoded:prepared.encoded,intentSha256,fingerprints:prepared.fingerprints};
 const status:TreeJobStatus={treeId:plan.treeId,jobId:job.jobId,intentSha256,state:"completed",items:plan.items.map(item=>({itemId:item.itemId,parentItemId:item.parentItemId,relativePath:item.relativePath,kind:item.kind,state:"published",receipt:{resourceId:randomUUID(),versionId:item.kind==="file"?randomUUID():null,kind:item.kind,sizeBytes:item.kind==="file"?item.sizeBytes:0,sha256:item.kind==="file"?requiredValue(prepared.fingerprints[0]).sha256:null,relativePath:item.relativePath}}))};
 return {record,status,prepared};
}
describe("durable browser tree receipt validation (physical IndexedDB proof separate)",()=>{
 it("matches the exact server canonical intent and validates every publication",async()=>{const f=await fixture();expect(createHash("sha256").update(f.prepared.encoded).digest("hex")).toBe(f.record.intentSha256);expect(validateTreeJobStatus(f.record,f.status)).toEqual(f.status);});
 it("rejects a foreign original or changed source hash before releasing local bytes",async()=>{const f=await fixture();expect(()=>validateTreeJobStatus(f.record,{...f.status,jobId:randomUUID()})).toThrow("original job");const changed=withReceiptFields(f.status,1,{sha256:"0".repeat(64)});expect(()=>validateTreeJobStatus(f.record,changed)).toThrow("source fingerprint");});
 it("does not accept job completion with a missing, duplicate or still pending final item",async()=>{const f=await fixture();expect(()=>validateTreeJobStatus(f.record,{...f.status,items:f.status.items.slice(0,1)})).toThrow();expect(()=>validateTreeJobStatus(f.record,{...f.status,items:[f.status.items[0],f.status.items[0]]})).toThrow();expect(()=>validateTreeJobStatus(f.record,{...f.status,items:[f.status.items[0],{...f.status.items[1],state:"reserved",receipt:null}]})).toThrow("not terminal");});
 it("retains confirmed partial publications when a later response attempts to regress them",async()=>{const f=await fixture(),record={...f.record,status:{...f.status,state:"running" as const}},stale={...f.status,state:"running",items:f.status.items.map(i=>({...i,state:"reserved",receipt:null}))};expect(()=>validateTreeJobStatus(record,stale)).toThrow("cannot change");});
 it("accepts confirmed receipts after payload cleanup and refuses a different version",async()=>{const f=await fixture(),{encoded,...rest}=f.record,record={...rest,phase:"completed" as const,status:f.status};void encoded;expect(validateTreeJobStatus(record,f.status)).toEqual(f.status);const altered=withReceiptFields(f.status,1,{versionId:randomUUID()});expect(()=>validateTreeJobStatus(record,altered)).toThrow("cannot change");});
});
