import {randomUUID} from "node:crypto";
import type {BrowserTreeAuthority} from "./browser-upload-tree-authority.js";
import type {BrowserTreeOriginalReference} from "./browser-upload-tree-executor.js";
import type {BrowserTreeJobStatus} from "./browser-upload-tree-database.js";
import type {PostgresBrowserTreeStreamDatabase,BrowserTreeStreamQueuedRequest,BrowserTreeStreamExecutionClaim,BrowserTreeStreamBlockedReason} from "./browser-upload-tree-stream-database.js";
import type {BrowserTreeStreamWorkerAuthority} from "./browser-upload-tree-stream-worker-authority.js";

interface Dependencies {
 /** Normal HTTP issuer's store. Admission commits before waking the worker. */
 readonly admission:Pick<PostgresBrowserTreeStreamDatabase,"requestExecution">;
 /** Separate fixed store using the worker authority's exact issuer. */
 readonly worker:Pick<PostgresBrowserTreeStreamDatabase,"listExecutionRequests"|"withExecutionLock"|"claimExecution"|"retainExecutionUnknown"|"settleExecution"|"blockQueuedExecution">;
 readonly authority:Pick<BrowserTreeStreamWorkerAuthority,"forQueuedRequest">;
 /** Qualified streaming executor only. Its promise must join every physical
  * effect/CLOSE even on abort. Its return value is never a completion receipt. */
 readonly executor:{execute(claim:BrowserTreeStreamExecutionClaim,proof:BrowserTreeAuthority,signal:AbortSignal):Promise<unknown>};
 /** Runtime-owned incarnation identity; never a PID or client supplied value. */
 readonly workerId:string;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const blocked=new Set<BrowserTreeStreamBlockedReason>(["browser_tree_authorization_changed","browser_tree_file_too_large","browser_tree_destination_unavailable","browser_tree_drop_original_changed"]);
const safeCodes=new Set<string>([...blocked,"browser_tree_reconciliation_required","browser_tree_execution_not_terminal","browser_tree_publication_receipt_invalid","browser_tree_backend_unavailable","browser_tree_runtime_draining","browser_tree_binding_changed","browser_tree_spool_custody_retained","browser_tree_execution_capacity"]);
function code(error:unknown):string{
 const candidate=error instanceof Error?("code"in error?String(error.code):error.message):"";
 return safeCodes.has(candidate)?candidate:"browser_tree_execution_failed";
}

/** Durable two-lane dispatcher. start() is explicit trusted lifecycle wiring;
 * construction/admission alone does not start physical work. Periodic bounded
 * discovery recovers queued requests even if the post-commit wake was lost.
 * Claimed/UNKNOWN rows are excluded and require qualified reconciliation.
 * No detached transfer, lease-expiry replay, generic cleanup or publication. */
export class BrowserTreeStreamWorker {
 readonly #workerId:string;
 readonly #active=new Map<string,Promise<void>>();
 readonly #requests=new Set<Promise<BrowserTreeJobStatus>>();
 readonly #stop=new AbortController();
 #closing=false;#poll:Promise<void>|undefined;#loop:Promise<void>|undefined;#close:Promise<void>|undefined;
 #wakeRequested=false;#wakeWait:(()=>void)|undefined;#lastFailure:string|null=null;
 constructor(private readonly dependencies:Dependencies){
  if(!uuid.test(dependencies.workerId))throw Error("browser_tree_configuration_invalid");this.#workerId=dependencies.workerId;
 }
 inspect(){return Object.freeze({started:this.#loop!==undefined,closing:this.#closing,active:this.#active.size,metadataRequests:this.#requests.size,lastFailure:this.#lastFailure});}
 #isClosing():boolean{return this.#closing;}
 async requestExecution(proof:BrowserTreeAuthority,reference:BrowserTreeOriginalReference):Promise<BrowserTreeJobStatus>{
  if(this.#closing)throw Error("browser_tree_runtime_draining");if(this.#requests.size>=8)throw Error("browser_tree_execution_capacity");
  const ref=Object.freeze({...reference}),work=Promise.resolve().then(()=>this.dependencies.admission.requestExecution(proof,ref));
  this.#requests.add(work);
  try{const status=await work;this.#wake();return status;}finally{this.#requests.delete(work);}
 }
 start():void{
  if(this.#closing)throw Error("browser_tree_runtime_draining");if(this.#loop)return;
  this.#loop=Promise.resolve().then(async()=>{
   while(!this.#closing){
    try{await this.tick();}catch(error){this.#lastFailure=code(error);}
    if(!this.#isClosing())await this.#wait();
   }
  });
 }
 #wake():void{if(this.#closing)return;this.#wakeRequested=true;this.#wakeWait?.();}
 async #wait():Promise<void>{
  if(this.#closing)return;if(this.#wakeRequested){this.#wakeRequested=false;return;}
  await new Promise<void>(resolve=>{
   const done=()=>{clearTimeout(timer);this.#wakeWait=undefined;this.#wakeRequested=false;resolve();};
   const timer=setTimeout(done,1000);this.#wakeWait=done;
  });
 }
 /** One bounded discovery, not a wait for transfer completion. Concurrent
  * ticks join discovery; finished lanes can refill independently. */
 tick():Promise<void>{
  if(this.#closing)return Promise.reject(Error("browser_tree_runtime_draining"));
  return this.#poll??=Promise.resolve().then(()=>this.#discover()).finally(()=>{this.#poll=undefined;});
 }
 async #discover():Promise<void>{
  if(this.#closing||this.#active.size>=2)return;
  const requests=await this.dependencies.worker.listExecutionRequests(2);if(this.#isClosing())return;
  if(requests.length>2)throw Error("browser_tree_execution_capacity");
  const seen=new Set<string>();
  for(const request of requests){
   const ref=request.reference;if(![ref.treeId,ref.jobId,ref.itemId,request.requestId].every(value=>uuid.test(value))||!Number.isSafeInteger(request.authorizationGeneration)||request.authorizationGeneration<1)throw Error("browser_tree_reconciliation_required");
   const key=[ref.treeId,ref.jobId,ref.itemId].join(':');if(seen.has(key))throw Error("browser_tree_reconciliation_required");seen.add(key);
  }
  for(const value of requests){
   if(this.#isClosing()||this.#active.size>=2)break;
   const request=Object.freeze({...value,reference:Object.freeze({...value.reference})}),key=[request.reference.treeId,request.reference.jobId,request.reference.itemId].join(':');
   if(this.#active.has(key))continue;
   // Register before invoking any callback, including synchronous test doubles.
   const work=Promise.resolve().then(()=>this.#dispatch(request)).then(rescan=>{
    this.#active.delete(key);if(rescan)this.#wake();
   },(error: unknown)=>{this.#lastFailure=code(error);this.#active.delete(key);});
   this.#active.set(key,work);
  }
 }
 async #dispatch(request:BrowserTreeStreamQueuedRequest):Promise<boolean>{
  const {worker,authority,executor}=this.dependencies,identity=Object.freeze({workerId:this.#workerId,claimId:randomUUID()});
  try{return await worker.withExecutionLock(request,async permit=>{
   let claimAttempted=false;
   try{
    this.#stop.signal.throwIfAborted();const proof=await authority.forQueuedRequest(request);this.#stop.signal.throwIfAborted();
    claimAttempted=true;const claim=await worker.claimExecution(proof,request,permit,identity);this.#stop.signal.throwIfAborted();
    await executor.execute(claim,proof,this.#stop.signal);
    // Completion is solely the fixed database's canonical terminal receipt.
    await worker.settleExecution(request,permit,identity);return true;
   }catch(error){
    const failure=code(error);this.#lastFailure=failure;
    if(claimAttempted){
     // A lost backend/publication/settlement reply may already be terminal.
     // Retry only this metadata observation, never the physical executor.
     try{await worker.settleExecution(request,permit,identity);return true;}catch{/* retain the same claim below */}
     try{
      const retained=await worker.retainExecutionUnknown(request,permit,identity);
      if(retained!=="not_claimed")return true;
     }catch(retentionError){this.#lastFailure=code(retentionError);return false;}
    }
    if(!this.#closing&&blocked.has(failure as BrowserTreeStreamBlockedReason)){
     try{return await worker.blockQueuedExecution(request,permit,failure as BrowserTreeStreamBlockedReason);}
     catch(blockError){this.#lastFailure=code(blockError);}
    }
    return false;
   }
  });}catch(error){this.#lastFailure=code(error);return false;}
 }
 close():Promise<void>{
  if(this.#close)return this.#close;
  this.#closing=true;this.#stop.abort(Error("browser_tree_runtime_draining"));this.#wakeWait?.();
  this.#close=(async()=>{
   // Discovery cannot start another effect after observing closing. Requests
   // admitted concurrently remain durable queued rows for the next incarnation.
   await Promise.allSettled([...this.#requests,...(this.#poll?[this.#poll]:[]),...(this.#loop?[this.#loop]:[])]);
   await Promise.allSettled([...this.#active.values()]);
  })();return this.#close;
 }
}
