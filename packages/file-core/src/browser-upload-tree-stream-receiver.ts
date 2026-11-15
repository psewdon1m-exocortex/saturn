import {createHash} from "node:crypto";
import type {BrowserTreeAuthority} from "./browser-upload-tree-authority.js";
import type {BrowserTreeOriginalReference} from "./browser-upload-tree-executor.js";
import {BROWSER_TREE_STREAM_LIMITS} from "./browser-upload-tree-stream-contract.js";
import type {PostgresBrowserTreeStreamJournal,BrowserTreeStreamOriginal} from "./browser-upload-tree-stream-journal.js";
import type {BrowserTreeStreamSpool} from "./browser-upload-tree-stream-spool.js";

/** Receives admitted originals only; a sealed local spool is NOT stored or
 * published. No backend effects, replacement upload or cleanup on ambiguity. */
export class BrowserTreeStreamReceiver {
 readonly #active=new Set<string>();
 constructor(private readonly journal:Pick<PostgresBrowserTreeStreamJournal,"withOriginalLock"|"inspect"|"reserveChunk"|"bindChunk"|"recordChunk"|"inspectChunk"|"recordSeal">,private readonly spool:Pick<BrowserTreeStreamSpool,"writeChunk"|"readChunk">){}
 async #work<T>(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,work:(ref:BrowserTreeOriginalReference)=>Promise<T>):Promise<T>{
  const ref=Object.freeze({...input}),key=ref.treeId+":"+ref.itemId;
  if(this.#active.has(key)||this.#active.size>=2)throw Error("browser_tree_stream_busy");this.#active.add(key);
  try{return await this.journal.withOriginalLock(proof,ref,()=>work(ref));}finally{this.#active.delete(key);}
 }
 async append(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,offset:number,sha256:string,body:Uint8Array,signal?:AbortSignal):Promise<BrowserTreeStreamOriginal>{
  signal?.throwIfAborted();if(body.byteLength<1||body.byteLength>BROWSER_TREE_STREAM_LIMITS.chunkBytes||createHash("sha256").update(body).digest("hex")!==sha256)throw Error("browser_tree_stream_chunk_mismatch");
  // The server's HTTP body and this immutable copy are each bounded4MiB.
  const bytes=Buffer.from(body);
  return this.#work(proof,input,async ref=>{
   signal?.throwIfAborted();const chunk=await this.journal.reserveChunk(proof,ref,{offset,length:bytes.length,sha256});
   if(chunk.state==="spooled")return this.journal.inspect(proof,ref);
   const receipt=await this.spool.writeChunk(chunk,bytes,identity=>this.journal.bindChunk(proof,ref,chunk.writeTaskId,identity),signal);
   signal?.throwIfAborted();return this.journal.recordChunk(proof,ref,chunk.writeTaskId,receipt);
  });
 }
 async seal(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,signal?:AbortSignal):Promise<BrowserTreeStreamOriginal>{
  return this.#work(proof,input,async ref=>{
   signal?.throwIfAborted();const original=await this.journal.inspect(proof,ref);
   if(original.state==="sealed")return original;
   if(original.receivedBytes!==original.sizeBytes)throw Error("browser_tree_stream_incomplete");
   const hash=createHash("sha256");let bytes=0;
   for(let offset=0;offset<original.sizeBytes;offset+=BROWSER_TREE_STREAM_LIMITS.chunkBytes){
    signal?.throwIfAborted();const chunk=await this.journal.inspectChunk(proof,ref,offset),content=await this.spool.readChunk(chunk,signal);
    hash.update(content);bytes+=content.length;
   }
   signal?.throwIfAborted();return this.journal.recordSeal(proof,ref,{sealId:original.sealId,bytes,sha256:hash.digest("hex")});
  });
 }
}
