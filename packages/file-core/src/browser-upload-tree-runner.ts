import { requiredValue } from "./required-value.js";
import type {BrowserTreeAuthority} from "./browser-upload-tree-authority.js";
import type {BrowserTreeJobStatus,PostgresBrowserTreeDatabase} from "./browser-upload-tree-database.js";
import type {BrowserTreeDirectoryExecutor,BrowserTreeFileExecutor} from "./browser-upload-tree-executor.js";

export interface BrowserTreeRunResult {
 readonly status:BrowserTreeJobStatus;
 readonly outcome:"completed"|"cancelled"|"pending"|"interrupted"|"reconciliation_required";
 readonly failures:readonly {readonly itemId:string;readonly code:string}[];
}
const safeCodes=new Set(["browser_tree_parent_pending","browser_tree_reconciliation_required","browser_tree_authorization_changed",
 "browser_tree_destination_unavailable","browser_tree_binding_changed","browser_tree_physical_target_exists","browser_tree_verification_failed",
 "browser_tree_directory_runtime_unsupported","browser_tree_file_runtime_unsupported","browser_tree_read_closure_unavailable",
 "namespace_original_exists","namespace_conflict","namespace_permit_closed","backend_draining","reconciliation_required","capacity"]);
function errorCode(error:unknown):string {
 const value=error instanceof Error?("code"in error?String(error.code):error.message):"";
 return safeCodes.has(value)?value:"browser_tree_execution_failed";
}
interface ActiveJob {readonly promise:Promise<BrowserTreeRunResult>;readonly controller:AbortController}
interface Waiter {readonly resolve:()=>void;readonly reject:(error:unknown)=>void;readonly signal:AbortSignal;readonly abort:()=>void}

/** Request-driven bounded runner: admission and status never start effects.
 * No fire-and-forget callbacks or in-memory replacement originals. All physical
 * work is joined before its response/shutdown; crash recovery uses DB originals.
 * These local four lanes complement the shared backend's cross-process limit. */
export class BrowserTreeJobRunner {
 readonly #jobs=new Map<string,ActiveJob>();
 readonly #waiters:Waiter[]=[];
 #lanes=0;#closing=false;#closePromise:Promise<void>|undefined;
 constructor(private readonly dependencies:{
  readonly database:Pick<PostgresBrowserTreeDatabase,"inspect">;
  readonly directories:Pick<BrowserTreeDirectoryExecutor,"execute">;
  readonly files:Pick<BrowserTreeFileExecutor,"execute">;
 }){}
 async run(proof:BrowserTreeAuthority,treeId:string,jobId:string,signal?:AbortSignal):Promise<BrowserTreeRunResult>{
  signal?.throwIfAborted();
  // Always authenticate before looking up an active execution, including
  // callers attempting to join another request's already-running promise.
  const status=await this.dependencies.database.inspect(proof,treeId,jobId);
  if(this.#closing)throw Error("browser_tree_runtime_draining");
  const key=treeId+":"+jobId,existing=this.#jobs.get(key);
  if(existing){await existing.promise;const latest=await this.dependencies.database.inspect(proof,treeId,jobId);return this.#result(latest,[],signal?.aborted===true);}
  if(this.#jobs.size>=8)throw Error("browser_tree_execution_capacity");
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
  signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  const promise=this.#execute(proof,status,controller.signal);
  this.#jobs.set(key,{promise,controller});
  try{return await promise;}finally{signal?.removeEventListener("abort",abort);this.#jobs.delete(key);}
 }
 async #acquire(signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();
  if(this.#lanes<4){this.#lanes++;return;}
  await new Promise<void>((resolve,reject)=>{
   const abort=()=>{const at=this.#waiters.indexOf(waiter);if(at>=0)this.#waiters.splice(at,1);const reason:unknown=signal.reason;reject(reason instanceof Error?reason:new Error("browser_tree_execution_cancelled"));};
   const waiter:Waiter={resolve,reject,signal,abort};this.#waiters.push(waiter);signal.addEventListener("abort",abort,{once:true});
   if(signal.aborted)abort();
  });
 }
 #release():void {
  const waiter=this.#waiters.shift();
  if(waiter){waiter.signal.removeEventListener("abort",waiter.abort);waiter.resolve();}else this.#lanes--;
 }
 #result(status:BrowserTreeJobStatus,failures:BrowserTreeRunResult["failures"],interrupted:boolean):BrowserTreeRunResult {
  const outcome=status.state==="completed"?"completed":status.state==="cancelled"?"cancelled":
   status.items.some(item=>["materializing","verified","publishing","unknown"].includes(item.state))?"reconciliation_required":
   interrupted?"interrupted":"pending";
  return {status,outcome,failures};
 }
 async #execute(proof:BrowserTreeAuthority,initial:BrowserTreeJobStatus,signal:AbortSignal):Promise<BrowserTreeRunResult>{
  let status=initial;const attempted=new Set<string>(),failures:{itemId:string;code:string}[]=[];
  for(;;){
   if(status.treeId!==initial.treeId||status.jobId!==initial.jobId||status.items.length<1||status.items.length>16)throw Error("browser_tree_original_invalid");
   if(signal.aborted||this.#closing||["completed","cancelled"].includes(status.state))break;
   const items=new Map(status.items.map(item=>[item.itemId,item]));
   const ready=status.items.filter(item=>item.state==="reserved"&&!attempted.has(item.itemId)
    &&(item.parentItemId===null||!items.has(item.parentItemId)||requiredValue(items.get(item.parentItemId)).state==="published")).slice(0,4);
   if(ready.length===0)break;
   await Promise.all(ready.map(async item=>{
    attempted.add(item.itemId);let acquired=false;
    try{
     await this.#acquire(signal);acquired=true;signal.throwIfAborted();
     const executor=item.kind==="directory"?this.dependencies.directories:this.dependencies.files;
     await executor.execute({treeId:status.treeId,jobId:status.jobId,itemId:item.itemId},proof,signal);
    }catch(error){if(!signal.aborted)failures.push({itemId:item.itemId,code:errorCode(error)});}
    finally{if(acquired)this.#release();}
   }));
   // Current authority and DB publication decide every following DAG wave.
   status=await this.dependencies.database.inspect(proof,initial.treeId,initial.jobId);
  }
  return this.#result(status,failures,signal.aborted||this.#closing);
 }
 close():Promise<void>{
  this.#closing=true;
  for(const job of this.#jobs.values())job.controller.abort(Error("browser_tree_runtime_draining"));
  return this.#closePromise??=Promise.allSettled([...this.#jobs.values()].map(job=>job.promise)).then(()=>undefined);
 }
}
