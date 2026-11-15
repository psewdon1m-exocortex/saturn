import {createHash} from "node:crypto";
import {BROWSER_TREE_LIMITS, BrowserTreeInputError, validateBrowserTreePath} from "./browser-upload-tree-contract.js";

export const BROWSER_TREE_STREAM_LIMITS = Object.freeze({metadataBytes:64 * 1024, chunkBytes:4 * 1024 * 1024});
export interface BrowserTreeStreamJob {
 readonly schema:"saturn.browser-tree-stream-job.v1";
 readonly jobId:string;
 readonly item:{readonly kind:"file";readonly itemId:string;readonly parentItemId:string|null;readonly relativePath:string;readonly sizeBytes:number;readonly sha256:string};
}
export interface ValidatedBrowserTreeStreamJob {
 readonly value:BrowserTreeStreamJob;
 readonly intentSha256:string;
 readonly metadataBytes:number;
 readonly chunkCount:number;
}
const fail=(message:string):never=>{throw new BrowserTreeInputError(message);};
function closed(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=="object"||Array.isArray(value))return fail("Expected closed stream metadata");
 const row=value as Record<string,unknown>;
 if(Object.keys(row).length!==keys.length||!keys.every(key=>Object.hasOwn(row,key)))return fail("Unexpected or missing stream field");
 return row;
}
function uuid(value:unknown):string{
 if(typeof value!=="string"||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))return fail("Invalid stream identity");
 return value;
}

/** Pure metadata validation. This is not admission, quota, parent authorization
 * or permission to write a backend path. The separate stream route must remain
 * unavailable until its durable chunk/namespace/publication protocol exists. */
export function validateBrowserTreeStreamJob(input:unknown,maximumFileBytes:number):ValidatedBrowserTreeStreamJob{
 if(!Number.isSafeInteger(maximumFileBytes)||maximumFileBytes<=BROWSER_TREE_LIMITS.smallFileBytes)return fail("Invalid current streaming file bound");
 const body=closed(input,["schema","jobId","item"]);
 if(body.schema!=="saturn.browser-tree-stream-job.v1")return fail("Invalid streaming schema");
 const jobId=uuid(body.jobId),row=closed(body.item,["kind","itemId","parentItemId","relativePath","sizeBytes","sha256"]);
 if(row.kind!=="file")return fail("A streaming job contains exactly one file");
 const itemId=uuid(row.itemId),parentItemId=row.parentItemId===null?null:uuid(row.parentItemId),relativePath=validateBrowserTreePath(row.relativePath);
 if(itemId===parentItemId||(parentItemId===null)!==!relativePath.includes("/"))return fail("Stream parent/path mismatch");
 if(typeof row.sizeBytes!=="number"||!Number.isSafeInteger(row.sizeBytes)||row.sizeBytes<=BROWSER_TREE_LIMITS.smallFileBytes||row.sizeBytes>maximumFileBytes)return fail("Stream size exceeds its current bound");
 if(typeof row.sha256!=="string"||!/^[a-f0-9]{64}$/.test(row.sha256))return fail("Invalid full stream SHA256");
 const item=Object.freeze({kind:"file" as const,itemId,parentItemId,relativePath,sizeBytes:row.sizeBytes,sha256:row.sha256});
 const value=Object.freeze({schema:"saturn.browser-tree-stream-job.v1" as const,jobId,item}),canonical=JSON.stringify(value);
 const metadataBytes=Buffer.byteLength(JSON.stringify(input));
 if(metadataBytes>BROWSER_TREE_STREAM_LIMITS.metadataBytes)return fail("Streaming metadata bound exceeded");
 return Object.freeze({value,intentSha256:createHash("sha256").update(canonical).digest("hex"),metadataBytes,chunkCount:Math.ceil(item.sizeBytes/BROWSER_TREE_STREAM_LIMITS.chunkBytes)});
}

/** Validates a bounded chunk against an already admitted immutable size. The
 * journal, not this arithmetic check, establishes the confirmed offset. */
export function validateBrowserTreeStreamChunk(sizeBytes:number,offset:number,length:number):void{
 if(!Number.isSafeInteger(sizeBytes)||sizeBytes<=BROWSER_TREE_LIMITS.smallFileBytes||!Number.isSafeInteger(offset)||offset<0||offset>=sizeBytes
  ||offset%BROWSER_TREE_STREAM_LIMITS.chunkBytes!==0||!Number.isSafeInteger(length)||length!==Math.min(BROWSER_TREE_STREAM_LIMITS.chunkBytes,sizeBytes-offset))return fail("Invalid bounded streaming chunk");
}
