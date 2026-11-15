import {validateUploadTreeName,type UploadTreeItem} from "./upload-source-tree.js";

export type UploadTreePlanItem={readonly itemId:string;readonly parentItemId:string|null;readonly relativePath:string;readonly name:string}
 &({readonly kind:"directory"}|{readonly kind:"file";readonly sizeBytes:number;readonly lastModified:number});
export interface UploadTreePlanJob {readonly jobId:string;readonly kind:"small"|"stream";readonly itemIds:readonly string[];readonly dependencies:readonly string[]}
export interface UploadTreePlan {readonly schema:"saturn.browser-tree-plan.v1";readonly treeId:string;readonly items:readonly UploadTreePlanItem[];readonly jobs:readonly UploadTreePlanJob[]}
export interface PreparedUploadTreePlan {readonly plan:UploadTreePlan;readonly sources:ReadonlyMap<string,File>}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const limits={items:20000,directories:10000,metadataBytes:16*1024*1024,jobItems:16,jobWireBytes:4*1024*1024,jobMetadataBytes:64*1024,fileBytes:256*1024};
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
function wireHeader(item:UploadTreePlanItem){const identity={itemId:item.itemId,parentItemId:item.parentItemId,relativePath:item.relativePath};return item.kind==="directory"?{kind:item.kind,...identity}:{kind:item.kind,...identity,sizeBytes:item.sizeBytes,sha256:"0".repeat(64),contentBase64:""};}
function fits(items:readonly UploadTreePlanItem[]):boolean{
 const metadata=bytes({schema:"saturn.browser-tree-job.v1",jobId:"0".repeat(36),items:items.map(wireHeader)});
 return items.length<=limits.jobItems&&metadata<=limits.jobMetadataBytes&&metadata+items.reduce((sum,item)=>sum+(item.kind==="file"?4*Math.ceil(item.sizeBytes/3):0),0)<=limits.jobWireBytes;
}
function validateItems(items:readonly unknown[]):asserts items is readonly UploadTreePlanItem[]{
 if(items.length<1||items.length>limits.items)throw Error("Upload tree exceeds its item limit");
 const byId=new Map<string,UploadTreePlanItem>(),paths=new Set<string>();let directories=0;
 for(const value of items){
  if(!value||typeof value!=="object"||!("itemId"in value)||typeof value.itemId!=="string"||!("name"in value)||typeof value.name!=="string"
   ||!("relativePath"in value)||typeof value.relativePath!=="string"||!("parentItemId"in value)||value.parentItemId!==null&&typeof value.parentItemId!=="string"
   ||!("kind"in value)||value.kind!=="directory"&&value.kind!=="file")throw Error("Invalid tree plan item");
  if(value.kind==="file"&&(!("sizeBytes"in value)||typeof value.sizeBytes!=="number"||!("lastModified"in value)||typeof value.lastModified!=="number"
   ||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<0||!Number.isSafeInteger(value.lastModified)||value.lastModified<0))throw Error("Invalid tree source metadata");
  const item=value as UploadTreePlanItem;
  const segments=item.relativePath.split("/");segments.forEach(validateUploadTreeName);
  if(!uuid.test(item.itemId)||byId.has(item.itemId)||paths.has(item.relativePath.toLowerCase())||segments.length>64||new TextEncoder().encode(item.relativePath).length>4096||segments.at(-1)!==item.name)throw Error("Invalid tree plan identity or path");
  if(item.parentItemId===null){if(segments.length!==1)throw Error("Tree plan is missing its parent");}
  else{const parent=byId.get(item.parentItemId);if(!parent||parent.kind!=="directory"||parent.relativePath!==segments.slice(0,-1).join("/"))throw Error("Tree parents must precede their exact children");}
  if(item.kind==="directory"){if(++directories>limits.directories)throw Error("Upload tree exceeds its directory limit");}
  byId.set(item.itemId,item);paths.add(item.relativePath.toLowerCase());
 }
 if(bytes(items)>limits.metadataBytes)throw Error("Upload tree metadata exceeds its limit");
}

/** Metadata-only planning: no arrayBuffer/stream/hash is opened. Job identities
 * are minted ONCE here and must be strictly committed with the plan before any
 * network admission. Preparing/retrying a job reuses this exact partition. */
export async function planUploadTree(treeId:string,items:readonly UploadTreeItem[],signal?:AbortSignal):Promise<PreparedUploadTreePlan>{
 signal?.throwIfAborted();if(!uuid.test(treeId)||items.length<1||items.length>limits.items)throw Error("Invalid bounded upload tree");
 const headers:UploadTreePlanItem[]=[],sources=new Map<string,File>();
 for(const item of items){
  signal?.throwIfAborted();const identity={itemId:item.itemId,parentItemId:item.parentItemId??null,relativePath:item.relativePath,name:item.name};
  if(item.kind==="directory")headers.push(Object.freeze({...identity,kind:"directory"}));
  else{
   if(!item.getFile)throw Error("Tree source is unavailable");const source=await item.getFile();signal?.throwIfAborted();
   if(source.name!==item.name)throw Error("Tree source name changed");sources.set(item.itemId,source);
   headers.push(Object.freeze({...identity,kind:"file",sizeBytes:source.size,lastModified:source.lastModified}));
  }
  if(headers.length%128===0)await new Promise<void>(resolve=>setTimeout(resolve,0));
 }
 validateItems(headers);
 const jobs:UploadTreePlanJob[]=[],membership=new Map<string,string>();let pending:UploadTreePlanItem[]=[];
 const flush=(kind:"small"|"stream")=>{
  if(!pending.length)return;const jobId=crypto.randomUUID(),ownIds=new Set(pending.map(item=>item.itemId)),dependencies=new Set<string>();
  for(const item of pending)if(item.parentItemId!==null&&!ownIds.has(item.parentItemId)){const parentJob=membership.get(item.parentItemId);if(!parentJob)throw Error("Tree parent job is missing");dependencies.add(parentJob);}
  for(const item of pending)membership.set(item.itemId,jobId);
  jobs.push(Object.freeze({jobId,kind,itemIds:Object.freeze(pending.map(item=>item.itemId)),dependencies:Object.freeze([...dependencies])}));pending=[];
 };
 for(const item of headers){
  signal?.throwIfAborted();
  if(item.kind==="file"&&item.sizeBytes>limits.fileBytes){flush("small");pending=[item];flush("stream");}
  else{if(!fits([...pending,item]))flush("small");pending.push(item);if(!fits(pending))throw Error("A tree item exceeds the job metadata limit");}
 }
 flush("small");const plan:UploadTreePlan=Object.freeze({schema:"saturn.browser-tree-plan.v1",treeId,items:Object.freeze(headers),jobs:Object.freeze(jobs)});
 assertUploadTreePlan(plan);return Object.freeze({plan,sources});
}

/** Validate a restored plan without inventing new IDs, silently normalizing
 * paths, merging jobs or treating an invalid durable record as an empty tree. */
export function assertUploadTreePlan(value:unknown):asserts value is UploadTreePlan{
 if(!value||typeof value!=="object"||!("schema"in value)||value.schema!=="saturn.browser-tree-plan.v1"||!("treeId"in value)||typeof value.treeId!=="string"
  ||!uuid.test(value.treeId)||!("items"in value)||!Array.isArray(value.items)||!("jobs"in value)||!Array.isArray(value.jobs)||value.jobs.length<1||value.jobs.length>limits.items)throw Error("Invalid durable tree plan");
 const planItems:readonly unknown[]=value.items,jobs:readonly unknown[]=value.jobs;
 validateItems(planItems);const items=new Map(planItems.map(item=>[item.itemId,item])),membership=new Map<string,string>(),knownJobs=new Set<string>();
 for(const job of jobs){
  if(!job||typeof job!=="object"||!("jobId"in job)||typeof job.jobId!=="string"||!uuid.test(job.jobId)||knownJobs.has(job.jobId)
   ||!("itemIds"in job)||!Array.isArray(job.itemIds)||job.itemIds.length<1||job.itemIds.length>limits.jobItems||job.itemIds.some((id:unknown)=>typeof id!=="string")
   ||!("dependencies"in job)||!Array.isArray(job.dependencies)||job.dependencies.some((id:unknown)=>typeof id!=="string")||!("kind"in job)||job.kind!=="small"&&job.kind!=="stream")throw Error("Invalid durable tree job identity");
  const itemIds=job.itemIds as string[],dependencies=job.dependencies as string[];
  const members:UploadTreePlanItem[]=itemIds.map(id=>{const item=items.get(id);if(!item||membership.has(id))throw Error("Tree item is missing or belongs to multiple jobs");return item;});
  if(new Set(itemIds).size!==members.length)throw Error("Tree item is duplicated in a job");
  if(job.kind==="stream"){const member=members[0];if(members.length!==1||!member||member.kind!=="file"||member.sizeBytes<=limits.fileBytes)throw Error("Invalid streaming tree job");}
  else if(members.some(item=>item.kind==="file"&&item.sizeBytes>limits.fileBytes)||!fits(members))throw Error("Invalid bounded small tree job");
  const ids=new Set(itemIds),expected=new Set<string>();
  for(const item of members)if(item.parentItemId!==null&&!ids.has(item.parentItemId)){const parentJob=membership.get(item.parentItemId);if(!parentJob)throw Error("Tree parent job must precede its child");expected.add(parentJob);}
  if(new Set(dependencies).size!==dependencies.length||expected.size!==dependencies.length||dependencies.some(id=>!knownJobs.has(id)||!expected.has(id)))throw Error("Tree job dependencies changed");
  knownJobs.add(job.jobId);for(const item of members)membership.set(item.itemId,job.jobId);
 }
 if(membership.size!==planItems.length||bytes(value)>limits.metadataBytes)throw Error("Durable tree plan is incomplete or exceeds its limit");
}

/** Rebind selected handles by exact paths and metadata. This is not byte
 * authentication: retained fingerprints still require full SHA before sends. */
export async function reselectUploadTree(plan:UploadTreePlan,selected:readonly UploadTreeItem[],signal?:AbortSignal):Promise<ReadonlyMap<string,File>>{
 assertUploadTreePlan(plan);if(selected.length!==plan.items.length)throw Error("Select the same complete upload tree");
 const byPath=new Map(selected.map(item=>[item.relativePath,item]));if(byPath.size!==selected.length)throw Error("Duplicate selected tree path");const sources=new Map<string,File>();let inspected=0;
 for(const original of plan.items){
  signal?.throwIfAborted();const item=byPath.get(original.relativePath);
  if(!item||item.kind!==original.kind||item.name!==original.name)throw Error("Selected upload tree changed");
  if(original.kind==="file"){
   if(!item.getFile)throw Error("Tree source is unavailable");const file=await item.getFile();signal?.throwIfAborted();
   if(file.name!==original.name||file.size!==original.sizeBytes||file.lastModified!==original.lastModified)throw Error("Selected tree source metadata changed");sources.set(original.itemId,file);
  }
  if(++inspected%128===0)await new Promise<void>(resolve=>setTimeout(resolve,0));
 }
 return sources;
}

export function plannedJobSources(plan:UploadTreePlan,jobId:string,sources:ReadonlyMap<string,File>):readonly UploadTreeItem[]{
 const job=plan.jobs.find(job=>job.jobId===jobId);if(!job)throw Error("Unknown original tree job");const byId=new Map(plan.items.map(item=>[item.itemId,item]));
 return job.itemIds.map(id=>{const item=byId.get(id);if(!item)throw Error("Original tree item is unavailable");const base={itemId:item.itemId,...(item.parentItemId===null?{}:{parentItemId:item.parentItemId}),relativePath:item.relativePath,name:item.name,kind:item.kind};
  if(item.kind==="directory")return base;const file=sources.get(id);if(!file||file.name!==item.name||file.size!==item.sizeBytes||file.lastModified!==item.lastModified)throw Error("Original tree source is unavailable");return {...base,getFile:()=>Promise.resolve(file)};});
}
