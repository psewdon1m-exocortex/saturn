import { uploadSourceHasher, type UploadSourceHasher } from "./upload-sha256.js";
import { validateUploadTreeName, type UploadTreeItem } from "./upload-source-tree.js";

const limits=Object.freeze({items:16,wireBytes:4*1024*1024,metadataBytes:64*1024,fileBytes:256*1024});
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
interface Identity {readonly itemId:string;readonly parentItemId:string|null;readonly relativePath:string}
export type UploadTreeWireItem=Identity&({readonly kind:"directory"}|{readonly kind:"file";readonly sizeBytes:number;readonly sha256:string;readonly contentBase64:string});
export interface UploadTreeWireJob {readonly schema:"saturn.browser-tree-job.v1";readonly jobId:string;readonly items:readonly UploadTreeWireItem[]}
export interface UploadTreeSourceFingerprint {readonly itemId:string;readonly relativePath:string;readonly filename:string;readonly sizeBytes:number;readonly lastModified:number;readonly sha256:string}
export interface PreparedUploadTreeJob {readonly job:UploadTreeWireJob;readonly encoded:string;readonly fingerprints:readonly UploadTreeSourceFingerprint[];readonly payloadBytes:number}
export class UploadTreeNeedsStreamingError extends Error {
  constructor(readonly itemId:string,readonly sizeBytes:number){super("This tree item requires the streaming upload path");this.name="UploadTreeNeedsStreamingError";}
}
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
function base64(value:Uint8Array):string {
  let binary="";for(let offset=0;offset<value.length;offset+=32768)binary+=String.fromCharCode(...value.subarray(offset,offset+32768));
  return btoa(binary);
}

/** Prepare only an admitted client job (at most two concurrently). The caller
 * must commit job ID + immutable fingerprints durably before its first POST.
 * Enumeration, hashing and serialization remain inside the upload timer.
 * Large items explicitly select streaming; they are never truncated or omitted. */
export async function prepareUploadTreeJob(jobId:string,items:readonly UploadTreeItem[],options:{
  readonly signal?:AbortSignal;readonly hasher?:Pick<UploadSourceHasher,"hash">;
}={}):Promise<PreparedUploadTreeJob>{
  options.signal?.throwIfAborted();
  if(!uuid.test(jobId)||items.length<1||items.length>limits.items)throw Error("Invalid bounded tree job");
  const ids=new Set<string>(),paths=new Set<string>();
  const headers:UploadTreeWireItem[]=[],sources=new Map<string,File>();
  // Resolve only this bounded job's handles, then validate all metadata/size
  // bounds before opening any source bytes or starting a hash worker.
  for(const item of items){
    options.signal?.throwIfAborted();
    const segments=item.relativePath.split("/");segments.forEach(validateUploadTreeName);
    if(!uuid.test(item.itemId)||ids.has(item.itemId)||paths.has(item.relativePath.toLowerCase())||segments.length>64
      ||new TextEncoder().encode(item.relativePath).length>4096||segments.at(-1)!==item.name
      ||(item.parentItemId===undefined)!==(segments.length===1)||item.parentItemId!==undefined&&(!uuid.test(item.parentItemId)||item.parentItemId===item.itemId))throw Error("Invalid tree item identity or parent path");
    ids.add(item.itemId);paths.add(item.relativePath.toLowerCase());
    const identity={itemId:item.itemId,parentItemId:item.parentItemId??null,relativePath:item.relativePath};
    if(item.kind==="directory"){headers.push({kind:"directory",...identity});continue;}
    if((item.kind as unknown)!=="file"||!item.getFile)throw Error("Tree source file is unavailable");
    const file=await item.getFile();options.signal?.throwIfAborted();
    if(file.name!==item.name||!Number.isSafeInteger(file.size)||file.size<0||!Number.isSafeInteger(file.lastModified)||file.lastModified<0)throw Error("Tree source identity changed");
    if(file.size>limits.fileBytes)throw new UploadTreeNeedsStreamingError(item.itemId,file.size);
    sources.set(item.itemId,file);headers.push({kind:"file",...identity,sizeBytes:file.size,sha256:"0".repeat(64),contentBase64:""});
  }
  const byId=new Map(headers.map(item=>[item.itemId,item]));
  for(const item of headers){const parent=item.parentItemId===null?undefined:byId.get(item.parentItemId);if(parent&&(parent.kind!=="directory"||item.relativePath.slice(0,item.relativePath.lastIndexOf("/"))!==parent.relativePath))throw Error("Tree parent is not the exact declared directory");}
  const emptyJob:UploadTreeWireJob={schema:"saturn.browser-tree-job.v1",jobId,items:headers};
  const metadataBytes=bytes(emptyJob),encodedPayloadBytes=headers.reduce((sum,item)=>sum+(item.kind==="file"?4*Math.ceil(item.sizeBytes/3):0),0);
  if(metadataBytes>limits.metadataBytes||metadataBytes+encodedPayloadBytes>limits.wireBytes)throw Error("Tree job exceeds wire or metadata bound");
  const prepared:UploadTreeWireItem[]=[],fingerprints:UploadTreeSourceFingerprint[]=[];
  const hasher=options.hasher??uploadSourceHasher;let payloadBytes=0;
  for(const item of headers){
    options.signal?.throwIfAborted();
    if(item.kind==="directory"){prepared.push(Object.freeze(item));continue;}
    const file=sources.get(item.itemId);if(!file)throw Error("Original tree source is unavailable");
    const sha256=await hasher.hash(file,options.signal===undefined?{}:{signal:options.signal});
    options.signal?.throwIfAborted();if(!/^[a-f0-9]{64}$/.test(sha256))throw Error("Invalid full source hash");
    const data=new Uint8Array(await file.arrayBuffer());options.signal?.throwIfAborted();
    if(data.length!==item.sizeBytes)throw Error("Tree source size changed");
    prepared.push(Object.freeze({...item,sha256,contentBase64:base64(data)}));payloadBytes+=data.length;
    fingerprints.push(Object.freeze({itemId:item.itemId,relativePath:item.relativePath,filename:file.name,sizeBytes:file.size,lastModified:file.lastModified,sha256}));
    // Keep preparation interruptible even for a job of many zero/small files.
    await new Promise<void>(resolve=>setTimeout(resolve,0));
  }
  options.signal?.throwIfAborted();
  const job:UploadTreeWireJob=Object.freeze({...emptyJob,items:Object.freeze(prepared)}),encoded=JSON.stringify(job);
  if(new TextEncoder().encode(encoded).length>limits.wireBytes)throw Error("Tree job exceeds wire bound");
  return Object.freeze({job,encoded,fingerprints:Object.freeze(fingerprints),payloadBytes});
}
