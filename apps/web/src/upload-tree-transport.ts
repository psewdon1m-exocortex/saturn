import {ApiError,request,dropRequest} from "./api.js";
import {durableUploadTrees,type DurableUploadTreeStore,type DurableTreeJob,type TreeJobStatus,type UploadTreeScope} from "./upload-tree-durable.js";

export interface UploadTreeHttp {
 capability(scope:UploadTreeScope,signal?:AbortSignal):Promise<unknown>;
 admit(scope:UploadTreeScope,treeId:string,encoded:string,signal?:AbortSignal):Promise<unknown>;
 inspect(scope:UploadTreeScope,treeId:string,jobId:string,signal?:AbortSignal):Promise<unknown>;
 execute(scope:UploadTreeScope,treeId:string,jobId:string,signal?:AbortSignal):Promise<unknown>;
 cancel(scope:UploadTreeScope,treeId:string,jobId:string,signal?:AbortSignal):Promise<unknown>;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function scopePath(scope:UploadTreeScope,treeId?:string,jobId?:string):string{
 if(scope.kind==="owner"?!uuid.test(scope.rootId):(scope.kind as unknown)!=="drop"||!uuid.test(scope.channelId))throw Error("Invalid original upload scope");
 if(treeId===undefined)return "/upload-trees/capabilities";
 if(!uuid.test(treeId)||jobId!==undefined&&!uuid.test(jobId))throw Error("Invalid original tree/job identity");
 return "/upload-trees/"+(scope.kind==="owner"?scope.rootId+"/":"")+treeId+"/jobs"+(jobId===undefined?"":"/"+jobId);
}
async function send(scope:UploadTreeScope,path:string,method:string,body:string|undefined,signal?:AbortSignal):Promise<unknown>{
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason),timer=setTimeout(()=>controller.abort(Error("Tree request timed out; inspect the same original before retrying")),30000);
 signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
 try{
  const options:RequestInit={method,signal:controller.signal,...(body===undefined?{}:{headers:{"Content-Type":"application/json"},body})};
  return await (scope.kind==="owner"?request<unknown>(path,options):dropRequest<unknown>(path,options,true,scope.channelId));
 }finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
export const uploadTreeHttp:UploadTreeHttp={
 capability:(scope,signal)=>send(scope,scopePath(scope),"GET",undefined,signal),
 admit:(scope,treeId,encoded,signal)=>send(scope,scopePath(scope,treeId),"POST",encoded,signal),
 inspect:(scope,treeId,jobId,signal)=>send(scope,scopePath(scope,treeId,jobId),"GET",undefined,signal),
 execute:(scope,treeId,jobId,signal)=>send(scope,scopePath(scope,treeId,jobId)+"/execute","POST","{}",signal),
 cancel:(scope,treeId,jobId,signal)=>send(scope,scopePath(scope,treeId,jobId),"DELETE",undefined,signal),
};
export interface UploadTreeCapability {readonly schema:"saturn.browser-tree-capability.v1";readonly available:true;readonly limits:{readonly items:number;readonly wireBytes:number;readonly metadataBytes:number;readonly smallFileBytes:number;readonly activeClientJobs:number}}
export function parseUploadTreeCapability(value:unknown):UploadTreeCapability|undefined{
 if(!value||typeof value!=="object"||!("schema"in value)||value.schema!=="saturn.browser-tree-capability.v1"||!("available"in value))throw Error("Invalid tree capability response");
 if(value.available===false)return undefined;
 const limits="limits"in value?value.limits:undefined;
 if(value.available!==true||!limits||typeof limits!=="object")throw Error("Invalid bounded tree capability");
 const fields=limits as Record<string,unknown>;
 if(["items","wireBytes","metadataBytes","smallFileBytes","activeClientJobs"].some(name=>{const n=fields[name];return typeof n!=="number"||!Number.isSafeInteger(n)||n<1;}))throw Error("Invalid bounded tree capability");
 return value as UploadTreeCapability;
}
function requireBodyWithinCapability(record:DurableTreeJob,capability:UploadTreeCapability):void{
 if(record.encoded===undefined)throw Error("Original prepared tree bytes are unavailable");
 const body=JSON.parse(record.encoded) as {items:{kind:string;sizeBytes?:number;contentBase64?:string}[]};
 if(!Array.isArray(body.items)||body.items.length>Math.min(16,capability.limits.items)
  ||new TextEncoder().encode(record.encoded).length>Math.min(4194304,capability.limits.wireBytes)
  ||body.items.some(item=>item.kind==="file"&&(item.sizeBytes===undefined||item.sizeBytes>Math.min(262144,capability.limits.smallFileBytes))))throw Error("Prepared tree job exceeds current server limits; retain its original");
 const metadata={...body,items:body.items.map(item=>item.kind==="file"?{...item,contentBase64:""}:item)};
 if(new TextEncoder().encode(JSON.stringify(metadata)).length>Math.min(65536,capability.limits.metadataBytes))throw Error("Prepared tree metadata exceeds current server limits");
}
function encodedOriginal(record:DurableTreeJob):string{const encoded=record.encoded;if(encoded===undefined)throw Error("Original prepared tree bytes are unavailable");return encoded;}
type Store=Pick<DurableUploadTreeStore,"loadJob"|"markSending"|"retryMissingAdmission"|"markUnknown"|"recordStatus"|"cancelUnsent">;
export interface UploadTreeAdvance {readonly record:DurableTreeJob;readonly outcome:"completed"|"cancelled"|"pending"|"reconciliation_required"}
const uncertain=(status:TreeJobStatus|undefined)=>status?.state==="unknown"||status?.items.some(item=>["materializing","verified","publishing","unknown"].includes(item.state))===true;
function result(record:DurableTreeJob):UploadTreeAdvance{
 return {record,outcome:record.phase==="completed"?"completed":record.phase==="cancelled"?"cancelled":record.phase==="unknown"||uncertain(record.status)?"reconciliation_required":"pending"};
}

/** Carries only persisted original bytes/identities. GET is read-only; no
 * timer/reload can allocate replacement operations after an ambiguous answer. */
export class UploadTreeTransport {
 readonly #running=new Set<string>();
 constructor(private readonly store:Store=durableUploadTrees,private readonly http:UploadTreeHttp=uploadTreeHttp){}
 async #retain(treeId:string,jobId:string,error:unknown):Promise<never>{
  try{const record=await this.store.loadJob(treeId,jobId);if(["sending","accepted","unknown"].includes(record.phase))await this.store.markUnknown(treeId,jobId);}
  catch(persistenceError){throw new AggregateError([error,persistenceError],"The original tree outcome could not be durably recorded");}
  throw error;
 }
 async advance(treeId:string,jobId:string,signal?:AbortSignal):Promise<UploadTreeAdvance>{
  const key=treeId+":"+jobId;if(this.#running.has(key))throw Error("This original tree job is already active");
  this.#running.add(key);
  try{
   signal?.throwIfAborted();let record=await this.store.loadJob(treeId,jobId);
   if(["completed","cancelled"].includes(record.phase))return result(record);
   if(["planned","preparing"].includes(record.phase))throw Error("Prepare and durably save this original job before sending");
   if(record.phase==="ready"){
    const capability=parseUploadTreeCapability(await this.http.capability(record.scope,signal));if(!capability)throw Error("Tree upload is unavailable on this server");
    requireBodyWithinCapability(record,capability);
    record=await this.store.markSending(treeId,jobId);signal?.throwIfAborted();
    record=await this.store.recordStatus(treeId,jobId,await this.http.admit(record.scope,treeId,encodedOriginal(record),signal));
   }else{
    let status:unknown;
    try{status=await this.http.inspect(record.scope,treeId,jobId,signal);}
    catch(error){
     if(!(error instanceof ApiError)||error.status!==404||error.code!=="browser_tree_not_found")throw error;
     // An authenticated miss permits ONLY exact idempotent replay. A late old
     // admission races this same body/id; neither side can reserve a new item.
     record=await this.store.retryMissingAdmission(treeId,jobId);signal?.throwIfAborted();
     status=await this.http.admit(record.scope,treeId,encodedOriginal(record),signal);
    }
    record=await this.store.recordStatus(treeId,jobId,status);
   }
   if(["completed","cancelled"].includes(record.phase))return result(record);
   if(uncertain(record.status)){record=await this.store.markUnknown(treeId,jobId);return result(record);}
   signal?.throwIfAborted();
   const executed=await this.http.execute(record.scope,treeId,jobId,signal);
   if(!executed||typeof executed!=="object"||!("status"in executed))throw Error("Invalid tree execution response; retain the original");
   record=await this.store.recordStatus(treeId,jobId,executed.status);
   if(uncertain(record.status))record=await this.store.markUnknown(treeId,jobId);
   return result(record);
  }catch(error){return await this.#retain(treeId,jobId,error);}finally{this.#running.delete(key);}
 }
 async cancel(treeId:string,jobId:string,signal?:AbortSignal):Promise<UploadTreeAdvance>{
  const key=treeId+":"+jobId;if(this.#running.has(key))throw Error("Stop and join the active original before cancelling");
  this.#running.add(key);
  try{
   signal?.throwIfAborted();const record=await this.store.loadJob(treeId,jobId);
   if(["completed","cancelled"].includes(record.phase))return result(record);
   if(["planned","preparing","ready"].includes(record.phase))return result(await this.store.cancelUnsent(treeId,jobId));
   // A404 after a lost request is not a cancellation receipt; preserve it.
   return result(await this.store.recordStatus(treeId,jobId,await this.http.cancel(record.scope,treeId,jobId,signal)));
  }catch(error){return await this.#retain(treeId,jobId,error);}finally{this.#running.delete(key);}
 }
}
export const uploadTreeTransport=new UploadTreeTransport();
