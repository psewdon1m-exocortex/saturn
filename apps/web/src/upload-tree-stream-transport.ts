import {ApiError} from "./api.js";
import {durableUploadTrees,validateTreeJobStatus,type DurableUploadTreeStore,type DurableTreeJob} from "./upload-tree-durable.js";
import {assertPreparedUploadTreeStream,UPLOAD_TREE_STREAM_CHUNK_BYTES,type UploadTreeStreamSource,type UploadTreeStreamWireJob} from "./upload-tree-stream.js";
import {applyUploadTreeStreamStatus,type UploadTreeStreamIdentity} from "./upload-tree-stream-progress.js";
import {uploadTreeStreamHttp,type UploadTreeStreamHttp} from "./upload-tree-stream-http.js";

type Store=Pick<DurableUploadTreeStore,"loadJob"|"markSending"|"retryMissingAdmission"|"markUnknown"|"recordStatus"|"recordStreamProgress"|"markStreamChunkPending"|"markStreamSealPending"|"cancelUnsent">;
export interface UploadTreeStreamAdvance {readonly record:DurableTreeJob;readonly outcome:"completed"|"cancelled"|"source_required"|"pending"|"reconciliation_required"}
function identity(row:DurableTreeJob):UploadTreeStreamIdentity{
 const item=row.items[0],fingerprint=row.fingerprints?.[0];if(row.job.kind!=="stream"||row.items.length!==1||!item||item.kind!=="file"||!fingerprint||!row.intentSha256)throw Error("Original stream metadata is unavailable");
 return {treeId:row.treeId,jobId:row.jobId,itemId:item.itemId,intentSha256:row.intentSha256,sizeBytes:item.sizeBytes,sha256:fingerprint.sha256};
}
function terminal(row:DurableTreeJob):boolean{return row.phase==="completed"||row.phase==="cancelled";}
function encodedOriginal(row:DurableTreeJob):string{const encoded=row.encoded;if(encoded===undefined)throw Error("Original streaming metadata is unavailable");return encoded;}
function progress(row:DurableTreeJob){const value=row.stream;if(value===undefined)throw Error("Original stream progress is unavailable");return value;}
function receiving(row:DurableTreeJob):boolean{return row.status?.state==="accepted"&&row.status.items.every(item=>item.state==="reserved");}
function sealed(row:DurableTreeJob):boolean{return row.stream?.state==="sealed";}
function uncertain(row:DurableTreeJob):boolean{return row.status?.state==="unknown"||row.status?.items.some(item=>item.state==="unknown")===true;}
function result(row:DurableTreeJob):UploadTreeStreamAdvance{return {record:row,outcome:row.phase==="completed"?"completed":row.phase==="cancelled"?"cancelled":uncertain(row)?"reconciliation_required":"pending"};}
export interface UploadTreeStreamLimits {readonly metadataBytes:number;readonly chunkBytes:number;readonly maximumFileBytes:number;readonly activeClientJobs:number}
export function parseUploadTreeStreamCapability(value:unknown):UploadTreeStreamLimits|undefined{
 if(!value||typeof value!=="object"||!("schema"in value)||value.schema!=="saturn.browser-tree-stream-capability.v1"||!("available"in value))throw Error("Invalid streaming capability");
 if(value.available===false)return undefined;
 const capability=value as {available:unknown;limits?:UploadTreeStreamLimits},limits=capability.limits;
 if(capability.available!==true||!limits||[limits.metadataBytes,limits.chunkBytes,limits.maximumFileBytes,limits.activeClientJobs].some(n=>!Number.isSafeInteger(n)||n<1)
  ||limits.chunkBytes!==UPLOAD_TREE_STREAM_CHUNK_BYTES||limits.activeClientJobs<2||limits.maximumFileBytes<=262144)throw Error("Unsupported bounded streaming capability");
 return Object.freeze({...limits});
}
function requireCapability(row:DurableTreeJob,value:unknown):void{
 const limits=parseUploadTreeStreamCapability(value);if(!limits)throw Error("Streaming tree upload is unavailable on this server");
 if(row.encoded===undefined)throw Error("Original streaming metadata is unavailable");
 const prepared={job:JSON.parse(row.encoded) as UploadTreeStreamWireJob,encoded:row.encoded,fingerprints:row.fingerprints??[],payloadBytes:0 as const};assertPreparedUploadTreeStream(prepared);
 if(new TextEncoder().encode(row.encoded).length>Math.min(65536,limits.metadataBytes)||prepared.job.item.sizeBytes>limits.maximumFileBytes)throw Error("Original stream exceeds current server limits");
}
/** Recovery always inspects the original first. One pending chunk and its exact
 * hash are committed before send; no status/timeout allocates a new operation.
 * Local seal is only a prerequisite for explicit verified publication. */
export class UploadTreeStreamTransport {
 readonly #running=new Set<string>();
 constructor(private readonly store:Store=durableUploadTrees,private readonly http:UploadTreeStreamHttp=uploadTreeStreamHttp){}
 #enter(tree:string,job:string):string{const key=tree+":"+job;if(this.#running.has(key)||this.#running.size>=2)throw Error("Streaming transport is busy; join its active originals");this.#running.add(key);return key;}
 async #retain(tree:string,job:string,error:unknown):Promise<never>{
  try{const row=await this.store.loadJob(tree,job);if(["sending","accepted","unknown"].includes(row.phase))await this.store.markUnknown(tree,job);}
  catch(persistenceError){throw new AggregateError([error,persistenceError],"Original stream outcome could not be durably retained");}throw error;
 }
 async #envelope(row:DurableTreeJob,value:unknown):Promise<DurableTreeJob>{
  if(!value||typeof value!=="object"||Object.keys(value).length!==2||!("status"in value)||!("progress"in value))throw Error("Invalid original stream response");
  const status=validateTreeJobStatus(row,value.status);
  if(status.state==="completed"||status.state==="cancelled")return this.store.recordStatus(row.treeId,row.jobId,status);
  if(status.state!=="accepted"||status.items.some(item=>item.state!=="reserved")){const saved=await this.store.recordStatus(row.treeId,row.jobId,status);return uncertain(saved)?this.store.markUnknown(row.treeId,row.jobId):saved;}
  // Validate BOTH replies before clearing any uncertain capacity or saving a
  // generic accepted receipt. The store repeats validation in its transaction.
  applyUploadTreeStreamStatus(identity(row),row.stream,value.progress);
  await this.store.recordStatus(row.treeId,row.jobId,status);return this.store.recordStreamProgress(row.treeId,row.jobId,value.progress);
 }
 async advance(treeId:string,jobId:string,options:{readonly source?:UploadTreeStreamSource;readonly signal?:AbortSignal;readonly onProgress?:(confirmedBytes:number,totalBytes:number)=>void}={}):Promise<UploadTreeStreamAdvance>{
  const key=this.#enter(treeId,jobId),{signal,source}=options;
  try{
   signal?.throwIfAborted();let row=await this.store.loadJob(treeId,jobId);if(row.job.kind!=="stream")throw Error("This is not a streaming tree original");if(terminal(row))return result(row);
   if(["planned","preparing"].includes(row.phase))throw Error("Prepare and strictly save the original stream metadata before sending");
   if(row.phase==="ready"){
    requireCapability(row,await this.http.capability(row.scope,signal));row=await this.store.markSending(treeId,jobId);signal?.throwIfAborted();
    row=await this.#envelope(row,await this.http.admit(row.scope,treeId,encodedOriginal(row),signal));
   }else{
    let response:unknown;
    try{response=await this.http.inspect(row.scope,treeId,jobId,signal);}
    catch(error){
     if(!(error instanceof ApiError)||error.status!==404||error.code!=="browser_tree_not_found"||row.status!==undefined||row.stream!==undefined)throw error;
     row=await this.store.retryMissingAdmission(treeId,jobId);signal?.throwIfAborted();response=await this.http.admit(row.scope,treeId,encodedOriginal(row),signal);
    }
    row=await this.#envelope(row,response);
   }
   if(terminal(row)||!receiving(row))return result(row);
   const original=identity(row);options.onProgress?.(progress(row).confirmedOffset,original.sizeBytes);
   if(progress(row).confirmedOffset<original.sizeBytes&&source===undefined)return {record:row,outcome:"source_required"};
   if(progress(row).confirmedOffset<original.sizeBytes&&source&&(source.prepared.encoded!==row.encoded||JSON.stringify(source.prepared.fingerprints)!==JSON.stringify(row.fingerprints)))throw Error("Reselected stream differs from the saved original");
   while(progress(row).confirmedOffset<original.sizeBytes){
    if(source===undefined)throw Error("Original streaming source is unavailable");signal?.throwIfAborted();const offset=progress(row).confirmedOffset,chunk=await source.chunk(offset,signal);signal?.throwIfAborted();
    row=await this.store.markStreamChunkPending(treeId,jobId,{offset:chunk.offset,length:chunk.length,sha256:chunk.sha256});signal?.throwIfAborted();
    const receipt=await this.http.append(row.scope,treeId,jobId,chunk,signal);row=await this.store.recordStreamProgress(treeId,jobId,receipt);
    options.onProgress?.(progress(row).confirmedOffset,original.sizeBytes);if(progress(row).confirmedOffset===offset)return result(row);
   }
   if(!sealed(row)){
    signal?.throwIfAborted();row=await this.store.markStreamSealPending(treeId,jobId);signal?.throwIfAborted();
    row=await this.store.recordStreamProgress(treeId,jobId,await this.http.seal(row.scope,treeId,jobId,progress(row).sealId,signal));
    if(!sealed(row))return result(row);
   }
   signal?.throwIfAborted();const publication=await this.http.execute(row.scope,treeId,jobId,signal);
   if(!publication||typeof publication!=="object"||!("status"in publication))throw Error("Invalid stream publication response");
   row=await this.store.recordStatus(treeId,jobId,publication.status);if(!terminal(row)&&uncertain(row))row=await this.store.markUnknown(treeId,jobId);return result(row);
  }catch(error){return await this.#retain(treeId,jobId,error);}finally{this.#running.delete(key);}
 }
 async cancel(treeId:string,jobId:string,signal?:AbortSignal):Promise<UploadTreeStreamAdvance>{
  const key=this.#enter(treeId,jobId);try{
   signal?.throwIfAborted();const row=await this.store.loadJob(treeId,jobId);if(row.job.kind!=="stream")throw Error("This is not a streaming tree original");if(terminal(row))return result(row);
   if(["planned","preparing","ready"].includes(row.phase))return result(await this.store.cancelUnsent(treeId,jobId));
   return result(await this.store.recordStatus(treeId,jobId,await this.http.cancel(row.scope,treeId,jobId,signal)));
  }catch(error){return await this.#retain(treeId,jobId,error);}finally{this.#running.delete(key);}
 }
}
export const uploadTreeStreamTransport=new UploadTreeStreamTransport();
