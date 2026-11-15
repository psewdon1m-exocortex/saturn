import {Readable} from "node:stream";
import {BrowserTreeInputError} from "../../../packages/file-core/src/browser-upload-tree-contract.js";
import {BROWSER_TREE_STREAM_LIMITS} from "../../../packages/file-core/src/browser-upload-tree-stream-contract.js";

export interface BrowserTreeStreamChunkHeaders {
 readonly contentType:unknown;readonly contentEncoding:unknown;readonly contentLength:unknown;
 readonly offset:unknown;readonly sha256:unknown;
}
function invalid():never{throw new BrowserTreeInputError("Invalid bounded stream request");}
export function parseBrowserTreeStreamChunkHeaders(input:BrowserTreeStreamChunkHeaders):{readonly offset:number;readonly sha256:string;readonly length:number|undefined}{
 if(input.contentType!=="application/offset+octet-stream"||input.contentEncoding!==undefined&&input.contentEncoding!=="identity")invalid();
 if(typeof input.offset!=="string"||!/^(0|[1-9][0-9]*)$/.test(input.offset)||!Number.isSafeInteger(Number(input.offset)))invalid();
 if(typeof input.sha256!=="string"||!/^[a-f0-9]{64}$/.test(input.sha256))invalid();
 let length:number|undefined;
 if(input.contentLength!==undefined){
  if(typeof input.contentLength!=="string"||!/^[1-9][0-9]*$/.test(input.contentLength))invalid();
  length=Number(input.contentLength);if(!Number.isSafeInteger(length)||length>BROWSER_TREE_STREAM_LIMITS.chunkBytes)invalid();
 }
 return Object.freeze({offset:Number(input.offset),sha256:input.sha256,length});
}

/** The existing raw Fastify parser hands us its paused Readable. Acquire a
 * service lane BEFORE calling this function. Never collect an array of chunks
 * or drain an oversized source: one fixed buffer, then close on refusal/abort.
 * A declared length is validated, but it is never trusted as the actual size. */
export async function readBrowserTreeStreamChunk(body:unknown,length:number|undefined,signal?:AbortSignal):Promise<Buffer>{
 if(!(body instanceof Readable)||body.readableObjectMode||body.readableEncoding!==null)invalid();
 if(length!==undefined&&(!Number.isSafeInteger(length)||length<1||length>BROWSER_TREE_STREAM_LIMITS.chunkBytes))invalid();
 const maximum=length??BROWSER_TREE_STREAM_LIMITS.chunkBytes,bytes=Buffer.allocUnsafe(maximum);let used=0;
 const abort=()=>body.destroy(signal?.reason instanceof Error?signal.reason:Error("browser_tree_request_aborted"));
 signal?.addEventListener("abort",abort,{once:true});
 try{
  signal?.throwIfAborted();
  for await(const part of body){
   signal?.throwIfAborted();if(!(part instanceof Uint8Array)||part.byteLength>maximum-used)invalid();
   bytes.set(part,used);used+=part.byteLength;
  }
  signal?.throwIfAborted();if(used===0||length!==undefined&&used!==length)invalid();return bytes.subarray(0,used);
 }finally{signal?.removeEventListener("abort",abort);if(!body.readableEnded)body.destroy();}
}
