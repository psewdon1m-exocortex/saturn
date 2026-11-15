import {uploadSourceHasher,type UploadSourceHasher} from "./upload-sha256.js";
import {validateUploadTreeName,type UploadTreeItem} from "./upload-source-tree.js";
import type {UploadTreeSourceFingerprint} from "./upload-tree-batch.js";

export const UPLOAD_TREE_STREAM_CHUNK_BYTES=4*1024*1024;
export interface UploadTreeStreamWireJob {
 readonly schema:"saturn.browser-tree-stream-job.v1";readonly jobId:string;
 readonly item:{readonly kind:"file";readonly itemId:string;readonly parentItemId:string|null;readonly relativePath:string;readonly sizeBytes:number;readonly sha256:string};
}
export interface PreparedUploadTreeStreamJob {
 readonly job:UploadTreeStreamWireJob;readonly encoded:string;readonly fingerprints:readonly UploadTreeSourceFingerprint[];readonly payloadBytes:0;
}
type Options={readonly signal?:AbortSignal;readonly onProgress?:(bytes:number)=>void;readonly hasher?:Pick<UploadSourceHasher,"hash">};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,sha=/^[a-f0-9]{64}$/;
const size=(value:string)=>new TextEncoder().encode(value).length;
function closed(value:unknown,keys:readonly string[]):void{
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw Error("Invalid streaming tree metadata");
}
function pathIdentity(item:{readonly itemId:string;readonly parentItemId:string|null;readonly relativePath:string}):string{
 const segments=item.relativePath.split("/");segments.forEach(validateUploadTreeName);
 if(!uuid.test(item.itemId)||segments.length>64||size(item.relativePath)>4096||(item.parentItemId===null)!==(segments.length===1)
  ||item.parentItemId!==null&&(!uuid.test(item.parentItemId)||item.parentItemId===item.itemId))throw Error("Invalid streaming tree parent or path");
 const name=segments.at(-1);if(name===undefined)throw Error("Streaming tree path is empty");return name;
}
/** Validates the exact persisted metadata without needing source File handles. */
export function assertPreparedUploadTreeStream(value:PreparedUploadTreeStreamJob):void{
 closed(value,["job","encoded","fingerprints","payloadBytes"]);closed(value.job,["schema","jobId","item"]);
 closed(value.job.item,["kind","itemId","parentItemId","relativePath","sizeBytes","sha256"]);
 const {job}=value,item=job.item,name=pathIdentity(item),fingerprints:unknown=value.fingerprints;
 if((job.schema as unknown)!=="saturn.browser-tree-stream-job.v1"||!uuid.test(job.jobId)||(item.kind as unknown)!=="file"||!Number.isSafeInteger(item.sizeBytes)||item.sizeBytes<=262144
  ||!sha.test(item.sha256)||typeof value.encoded!=="string"||size(value.encoded)>65536||value.encoded!==JSON.stringify(job)||(value.payloadBytes as unknown)!==0
  ||!Array.isArray(fingerprints)||fingerprints.length!==1)throw Error("Invalid streaming tree original");
 const fingerprint=value.fingerprints[0];if(fingerprint===undefined)throw Error("Streaming source fingerprint is missing");
 closed(fingerprint,["itemId","relativePath","filename","sizeBytes","lastModified","sha256"]);
 if(fingerprint.itemId!==item.itemId||fingerprint.relativePath!==item.relativePath||fingerprint.filename!==name||fingerprint.sizeBytes!==item.sizeBytes||fingerprint.sha256!==item.sha256
  ||!Number.isSafeInteger(fingerprint.lastModified)||fingerprint.lastModified<0)throw Error("Streaming source fingerprint changed");
}
function checkFile(file:File,name:string,expected?:UploadTreeSourceFingerprint):void{
 if(file.name!==name||!Number.isSafeInteger(file.size)||file.size<=262144||!Number.isSafeInteger(file.lastModified)||file.lastModified<0
  ||expected&&(file.size!==expected.sizeBytes||file.lastModified!==expected.lastModified))throw Error("Selected streaming source identity differs from the original");
}
async function fullHash(file:File,options:Options):Promise<string>{
 const value=await (options.hasher??uploadSourceHasher).hash(file,{...(options.signal===undefined?{}:{signal:options.signal}),...(options.onProgress===undefined?{}:{onProgress:options.onProgress})});
 options.signal?.throwIfAborted();if(!sha.test(value))throw Error("Invalid full streaming source hash");return value;
}

/** Ephemeral access to one verified File. Only metadata is persisted. Callers
 * reserve the existing strict journal slot BEFORE preparation/reselection;
 * the queue holds that slot until all reads, hashes and sends have settled. */
export class UploadTreeStreamSource {
 #reading=false;
 private constructor(private readonly file:File,readonly prepared:PreparedUploadTreeStreamJob){}
 static async prepare(jobId:string,items:readonly UploadTreeItem[],options:Options={}):Promise<UploadTreeStreamSource>{
  options.signal?.throwIfAborted();if(!uuid.test(jobId)||items.length!==1||items[0]?.kind!=="file"||!items[0].getFile)throw Error("A streaming job requires exactly one file");
  const source=items[0],identity=Object.freeze({itemId:source.itemId,parentItemId:source.parentItemId??null,relativePath:source.relativePath}),name=pathIdentity(identity);
  if(name!==source.name)throw Error("Streaming source filename changed");
  if(source.getFile===undefined)throw Error("Streaming source file is unavailable");const file=await source.getFile();options.signal?.throwIfAborted();checkFile(file,name);const sha256=await fullHash(file,options);
  const job:UploadTreeStreamWireJob=Object.freeze({schema:"saturn.browser-tree-stream-job.v1",jobId,item:Object.freeze({kind:"file",...identity,sizeBytes:file.size,sha256})});
  const fingerprint=Object.freeze({itemId:identity.itemId,relativePath:identity.relativePath,filename:name,sizeBytes:file.size,lastModified:file.lastModified,sha256});
  const prepared:PreparedUploadTreeStreamJob=Object.freeze({job,encoded:JSON.stringify(job),fingerprints:Object.freeze([fingerprint]),payloadBytes:0});assertPreparedUploadTreeStream(prepared);
  return new UploadTreeStreamSource(file,prepared);
 }
 static async reselect(prepared:PreparedUploadTreeStreamJob,file:File,options:Options={}):Promise<UploadTreeStreamSource>{
  options.signal?.throwIfAborted();const saved=structuredClone(prepared);assertPreparedUploadTreeStream(saved);
  const fingerprint=saved.fingerprints[0];if(fingerprint===undefined)throw Error("Streaming source fingerprint is missing");checkFile(file,fingerprint.filename,fingerprint);
  if(await fullHash(file,options)!==fingerprint.sha256)throw Error("Selected streaming source SHA-256 differs from the original");
  // Retain no caller-owned mutable metadata after an asynchronous hash.
  const frozen:PreparedUploadTreeStreamJob=Object.freeze({...saved,job:Object.freeze({...saved.job,item:Object.freeze(saved.job.item)}),fingerprints:Object.freeze([Object.freeze(fingerprint)])});
  return new UploadTreeStreamSource(file,frozen);
 }
 async chunk(offset:number,signal?:AbortSignal):Promise<{readonly offset:number;readonly length:number;readonly sha256:string;readonly bytes:Uint8Array<ArrayBuffer>}>{
  signal?.throwIfAborted();if(!Number.isSafeInteger(offset)||offset<0||offset>=this.file.size||offset%UPLOAD_TREE_STREAM_CHUNK_BYTES!==0)throw Error("Invalid streaming source offset");
  if(this.#reading)throw Error("A streaming source chunk is already being read");this.#reading=true;
  try{
   const length=Math.min(UPLOAD_TREE_STREAM_CHUNK_BYTES,this.file.size-offset),body=await this.file.slice(offset,offset+length).arrayBuffer();signal?.throwIfAborted();
   if(body.byteLength!==length)throw Error("Streaming source changed while reading");
   const digest=await crypto.subtle.digest("SHA-256",body);signal?.throwIfAborted();
   return Object.freeze({offset,length,sha256:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,"0")).join(""),bytes:new Uint8Array(body)});
  }finally{this.#reading=false;}
 }
}
