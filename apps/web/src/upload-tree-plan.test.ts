// @vitest-environment node
import { requiredValue } from "./test-value.js";
import {randomUUID,createHash} from "node:crypto";
import {describe,it,expect,vi} from "vitest";
import {assertUploadTreePlan,planUploadTree,plannedJobSources,reselectUploadTree,type UploadTreePlan} from "./upload-tree-plan.js";
import {prepareUploadTreeJob} from "./upload-tree-batch.js";
import {validateBrowserTreeJob} from "../../../packages/file-core/src/browser-upload-tree-contract.js";
import type {UploadTreeItem} from "./upload-source-tree.js";
const directory=(name:string,parent?:UploadTreeItem):UploadTreeItem=>({kind:"directory",itemId:randomUUID(),name,relativePath:parent?parent.relativePath+"/"+name:name,...(parent?{parentItemId:parent.itemId}:{})});
function file(name:string,size:number,parent?:UploadTreeItem):UploadTreeItem{
 const blob=new File([new Uint8Array(size).fill(173)],name,{lastModified:12});
 return {kind:"file",itemId:randomUUID(),name,relativePath:parent?parent.relativePath+"/"+name:name,...(parent?{parentItemId:parent.itemId}:{}),getFile:async()=>blob};
}
const hasher={hash:async(blob:Blob)=>createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex")};
describe("immutable bounded upload tree plan",()=>{
 it.each([
  (plan:UploadTreePlan)=>({...plan,items:[{...requiredValue(plan.items[0]),name:null}]}),
  (plan:UploadTreePlan)=>({...plan,items:[{...requiredValue(plan.items[0]),kind:"unknown"}]}),
  (plan:UploadTreePlan)=>({...plan,jobs:[{...requiredValue(plan.jobs[0]),itemIds:[7]}]}),
  (plan:UploadTreePlan)=>({...plan,jobs:[{...requiredValue(plan.jobs[0]),dependencies:[null]}]}),
 ])("rejects malformed restored identities before they can become upload jobs",async corrupt=>{
  const {plan}=await planUploadTree(randomUUID(),[directory("root")]);
  expect(()=>assertUploadTreePlan(corrupt(plan))).toThrow();
  expect(()=>assertUploadTreePlan(null)).toThrow("durable tree plan");
 });
 it("keeps empty directories and partitions by actual encoded wire size before reading bytes",async()=>{
  const root=directory("root"),empty=directory("empty",root),files=Array.from({length:24},(_,i)=>file("file"+String(i),256*1024,root)),read=vi.spyOn(Blob.prototype,"arrayBuffer");
  const value=await planUploadTree(randomUUID(),[root,empty,...files]);expect(read).not.toHaveBeenCalled();read.mockRestore();
  expect(value.plan.jobs.length).toBeGreaterThan(2);expect(value.plan.jobs.every(job=>job.itemIds.length<=16)).toBe(true);
  for(const job of value.plan.jobs){const prepared=await prepareUploadTreeJob(job.jobId,plannedJobSources(value.plan,job.jobId,value.sources),{hasher});expect(validateBrowserTreeJob(prepared.job).value.jobId).toBe(job.jobId);}
  expect(requiredValue(value.plan.jobs[1]).dependencies).toContain(requiredValue(value.plan.jobs[0]).jobId);
 });
 it("preserves the256KiB boundary and every larger file as an explicit streaming job",async()=>{
  const root=directory("root"),value=await planUploadTree(randomUUID(),[root,file("small",256*1024,root),file("stream",256*1024+1,root),directory("after",root)]);
  expect(value.plan.jobs.map(job=>job.kind)).toEqual(["small","stream","small"]);expect(value.plan.jobs.flatMap(job=>job.itemIds)).toHaveLength(4);assertUploadTreePlan(JSON.parse(JSON.stringify(value.plan)));
 });
 it("restores exact job/item IDs and rejects lost, duplicated or reordered dependencies",async()=>{
  const root=directory("root"),value=await planUploadTree(randomUUID(),[root,...Array.from({length:33},(_,i)=>file("file"+String(i),1,root))]),saved=JSON.stringify(value.plan);
  const restored:unknown=JSON.parse(saved);assertUploadTreePlan(restored);expect(JSON.stringify(restored)).toBe(saved);
  expect(()=>assertUploadTreePlan({...restored,jobs:restored.jobs.slice(1)})).toThrow();
  expect(()=>assertUploadTreePlan({...restored,jobs:[restored.jobs[1],restored.jobs[0],...restored.jobs.slice(2)]})).toThrow();
  expect(()=>assertUploadTreePlan({...restored,jobs:[...restored.jobs,restored.jobs[0]]})).toThrow();
 });
 it("rejects a missing/mismatched parent and case collision before byte preparation",async()=>{
  const root=directory("root"),child=file("file",1,root);await expect(planUploadTree(randomUUID(),[child,root])).rejects.toThrow("parents");
  await expect(planUploadTree(randomUUID(),[directory("A"),directory("a")])).rejects.toThrow("identity or path");
 });
 it("reselects new handles using old item IDs and requires exact names, sizes and modification times",async()=>{
  const root=directory("root"),items=[root,file("file",3,root)],value=await planUploadTree(randomUUID(),items),replacement=directory("root");
  const selected=[replacement,file("file",3,replacement)],sources=await reselectUploadTree(value.plan,selected);expect([...sources.keys()]).toEqual([requiredValue(items[1]).itemId]);
  await expect(reselectUploadTree(value.plan,[replacement,file("file",4,replacement)])).rejects.toThrow("metadata changed");
  expect(JSON.stringify(value.plan)).not.toContain(requiredValue(selected[1]).itemId);
 });
 it("honours cancellation while obtaining metadata before any later source handle is opened",async()=>{
  const controller=new AbortController(),first=file("first",1),last=file("last",1),getLast=vi.fn(last.getFile);
  await expect(planUploadTree(randomUUID(),[{...first,getFile:async()=>{controller.abort();return requiredValue(first.getFile)();}},{...last,getFile:getLast}],controller.signal)).rejects.toMatchObject({name:"AbortError"});expect(getLast).not.toHaveBeenCalled();
 });
});
