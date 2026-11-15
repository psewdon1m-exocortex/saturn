import type {BrowserTreeAuthority,BrowserTreeAuthorityIssuer} from "../../../packages/file-core/src/browser-upload-tree-authority.js";
import type {PostgresBrowserTreeStreamDatabase} from "../../../packages/file-core/src/browser-upload-tree-stream-database.js";
import type {PostgresBrowserTreeStreamJournal} from "../../../packages/file-core/src/browser-upload-tree-stream-journal.js";
import type {BrowserTreeStreamReceiver} from "../../../packages/file-core/src/browser-upload-tree-stream-receiver.js";
import type {BrowserTreeOriginalReference} from "../../../packages/file-core/src/browser-upload-tree-executor.js";
import type {BrowserTreeJobStatus} from "../../../packages/file-core/src/browser-upload-tree-database.js";
import {BrowserTreeInputError} from "../../../packages/file-core/src/browser-upload-tree-contract.js";
import {BROWSER_TREE_STREAM_LIMITS,validateBrowserTreeStreamChunk} from "../../../packages/file-core/src/browser-upload-tree-stream-contract.js";
import type {AuthenticatedOwnerRequest} from "./owner-token.guard.js";
import type {AuthenticatedDropRequest} from "./drop-session.guard.js";
import {parseBrowserTreeStreamChunkHeaders,readBrowserTreeStreamChunk,type BrowserTreeStreamChunkHeaders} from "./browser-upload-tree-stream-body.js";

export const BROWSER_TREE_STREAM_HTTP_SERVICE=Symbol("BROWSER_TREE_STREAM_HTTP_SERVICE");
export const browserTreeStreamUnavailable=Object.freeze({schema:"saturn.browser-tree-stream-capability.v1",available:false});
/** A qualified implementation MUST commit an execution request for this same
 * original and return bounded status, without waiting for backend transfer.
 * Recovery must discover it after process death. A detached Promise is not a
 * durable executor. No such runtime is composed by this HTTP source alone. */
export interface BrowserTreeStreamExecutionRequests {
 requestExecution(proof:BrowserTreeAuthority,reference:BrowserTreeOriginalReference):Promise<BrowserTreeJobStatus>;
 close():Promise<void>;
}

/** Trusted composition only: use the SAME normal-cookie/CSRF authority issuer
 * in this service, its fixed DB/journal and the durable execution adapter.
 * Default application wiring stays unavailable pending runtime qualification. */
export class BrowserTreeStreamHttpService {
 readonly #active=new Map<string,Promise<unknown>>();#closed=false;
 readonly #maximumFileBytes:number;
 constructor(private readonly dependencies:{
  readonly authority:BrowserTreeAuthorityIssuer;
  readonly database:Pick<PostgresBrowserTreeStreamDatabase,"admit"|"inspect"|"cancelBeforeExecution">;
  readonly journal:Pick<PostgresBrowserTreeStreamJournal,"inspectProgress">;
  readonly receiver:Pick<BrowserTreeStreamReceiver,"append"|"seal">;
  readonly execution:BrowserTreeStreamExecutionRequests;readonly maximumFileBytes:number;
 }){
  if(!Number.isSafeInteger(dependencies.maximumFileBytes)||dependencies.maximumFileBytes<=262144)throw Error("browser_tree_configuration_invalid");
  this.#maximumFileBytes=dependencies.maximumFileBytes;
 }
 capability(){return this.#closed?browserTreeStreamUnavailable:{schema:"saturn.browser-tree-stream-capability.v1",available:true,limits:{...BROWSER_TREE_STREAM_LIMITS,maximumFileBytes:this.#maximumFileBytes,activeClientJobs:2}};}
 owner(request:AuthenticatedOwnerRequest,rootId:string){return this.dependencies.authority.ownerSession(request,rootId);}
 drop(request:AuthenticatedDropRequest){return this.dependencies.authority.dropSession(request);}
 #open():void{if(this.#closed)throw Error("browser_tree_runtime_draining");}
 async #work<T>(treeId:string,jobId:string,action:()=>Promise<T>):Promise<T>{
  this.#open();const key=treeId+":"+jobId;
  if(this.#active.has(key)||this.#active.size>=2)throw Error("browser_tree_stream_busy");
  // Defer invocation until registration so even synchronously reentrant work
  // cannot read a third request body before its physical lane exists.
  const work=Promise.resolve().then(action);this.#active.set(key,work);
  try{return await work;}finally{this.#active.delete(key);}
 }
 async admit(proof:BrowserTreeAuthority,treeId:string,body:unknown){
  this.#open();const original=await this.dependencies.database.admit(proof,treeId,body);
  return {status:original.status,progress:await this.dependencies.journal.inspectProgress(proof,original.reference)};
 }
 async inspect(proof:BrowserTreeAuthority,treeId:string,jobId:string){
  const original=await this.dependencies.database.inspect(proof,treeId,jobId);
  return {status:original.status,progress:await this.dependencies.journal.inspectProgress(proof,original.reference)};
 }
 async append(proof:BrowserTreeAuthority,treeId:string,jobId:string,headers:BrowserTreeStreamChunkHeaders,body:unknown,signal?:AbortSignal){
  const chunk=parseBrowserTreeStreamChunkHeaders(headers);
  return this.#work(treeId,jobId,async()=>{
   signal?.throwIfAborted();const original=await this.dependencies.database.inspect(proof,treeId,jobId),progress=await this.dependencies.journal.inspectProgress(proof,original.reference);
   // Validate a supplied size and exact original offset before consuming bytes.
   if(chunk.length!==undefined)validateBrowserTreeStreamChunk(progress.sizeBytes,chunk.offset,chunk.length);
   else validateBrowserTreeStreamChunk(progress.sizeBytes,chunk.offset,Math.min(BROWSER_TREE_STREAM_LIMITS.chunkBytes,progress.sizeBytes-chunk.offset));
   const bytes=await readBrowserTreeStreamChunk(body,Math.min(BROWSER_TREE_STREAM_LIMITS.chunkBytes,progress.sizeBytes-chunk.offset),signal);
   validateBrowserTreeStreamChunk(progress.sizeBytes,chunk.offset,bytes.length);
   await this.dependencies.receiver.append(proof,original.reference,chunk.offset,chunk.sha256,bytes,signal);
   return this.dependencies.journal.inspectProgress(proof,original.reference);
  });
 }
 async seal(proof:BrowserTreeAuthority,treeId:string,jobId:string,body:unknown,signal?:AbortSignal){
  if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==1||!("sealId"in body)||typeof body.sealId!=="string")throw new BrowserTreeInputError("Expected the original seal identity");
  const sealId=body.sealId;
  return this.#work(treeId,jobId,async()=>{
   signal?.throwIfAborted();const original=await this.dependencies.database.inspect(proof,treeId,jobId),progress=await this.dependencies.journal.inspectProgress(proof,original.reference);
   if(progress.sealId!==sealId)throw Error("browser_tree_stream_seal_reused");
   signal?.throwIfAborted();
   // Once the full local verification begins, join it even if the metadata
   // HTTP deadline disconnects the caller. Repeated30s cancellations must not
   // prevent a large original from ever reaching its fixed seal receipt.
   // The lane and shutdown join remain held; every journal read still checks
   // current authority. Process death retains the same original for recovery.
   await this.dependencies.receiver.seal(proof,original.reference);
   return this.dependencies.journal.inspectProgress(proof,original.reference);
  });
 }
 async execute(proof:BrowserTreeAuthority,treeId:string,jobId:string,body:unknown){
  this.#open();if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==0)throw new BrowserTreeInputError("Expected an empty execution request");
  const original=await this.dependencies.database.inspect(proof,treeId,jobId);
  if(original.status.state!=="accepted")return {status:original.status};
  const progress=await this.dependencies.journal.inspectProgress(proof,original.reference);
  if(progress.state!=="sealed"||progress.confirmedOffset!==progress.sizeBytes||progress.sealSha256!==progress.sha256)throw Error("browser_tree_stream_incomplete");
  return {status:await this.dependencies.execution.requestExecution(proof,original.reference)};
 }
 async cancel(proof:BrowserTreeAuthority,treeId:string,jobId:string){return this.dependencies.database.cancelBeforeExecution(proof,treeId,jobId);}
 async onModuleDestroy():Promise<void>{
  this.#closed=true;await Promise.allSettled([...this.#active.values()]);await this.dependencies.execution.close();
 }
}
