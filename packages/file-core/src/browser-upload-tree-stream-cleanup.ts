import type {BrowserTreeOriginalReference} from "./browser-upload-tree-executor.js";
import type {BrowserTreeSpoolChunk,BrowserTreeSpoolRemoval} from "./browser-upload-tree-stream-spool.js";

export interface BrowserTreeStreamCleanupOriginal {
 readonly reference:BrowserTreeOriginalReference;readonly operationId:string;readonly spoolId:string;readonly cleanupTaskId:string;
 readonly state:"retained"|"released";
}
export interface BrowserTreeStreamCleanupJournal {
 withOriginalLock<T>(reference:BrowserTreeOriginalReference,action:()=>Promise<T>):Promise<T>;
 inspect(reference:BrowserTreeOriginalReference):Promise<BrowserTreeStreamCleanupOriginal>;
 nextChunk(original:BrowserTreeStreamCleanupOriginal):Promise<BrowserTreeSpoolChunk|null>;
 recordRemoval(original:BrowserTreeStreamCleanupOriginal,chunk:BrowserTreeSpoolChunk,removal:BrowserTreeSpoolRemoval):Promise<void>;
 release(original:BrowserTreeStreamCleanupOriginal):Promise<BrowserTreeStreamCleanupOriginal>;
}
/** Internal fixed maintenance operation, not a browser-controlled path/SQL
 * capability. The journal rechecks terminal publication/cancellation and exact
 * spool/original binding before every physical chunk. Receipt follows unlink,
 * directory sync where available and close; quota release follows ALL receipts.
 * No current session is needed to finish cleanup of an already terminal job. */
export class BrowserTreeStreamCleanup {
 readonly #running=new Set<string>();
 constructor(private readonly journal:BrowserTreeStreamCleanupJournal,private readonly spool:{removeChunk(chunk:BrowserTreeSpoolChunk,signal?:AbortSignal):Promise<BrowserTreeSpoolRemoval>}){}
 async run(reference:BrowserTreeOriginalReference,signal?:AbortSignal):Promise<BrowserTreeStreamCleanupOriginal>{
  const ref=Object.freeze({...reference}),key=ref.treeId+":"+ref.itemId;
  if(this.#running.has(key)||this.#running.size>=2)throw Error("browser_tree_cleanup_busy");this.#running.add(key);
  try{return await this.journal.withOriginalLock(ref,async()=>{
   signal?.throwIfAborted();const original=await this.journal.inspect(ref);if(original.state==="released")return original;
   for(;;){
    signal?.throwIfAborted();const chunk=await this.journal.nextChunk(original);signal?.throwIfAborted();
    if(chunk===null)return await this.journal.release(original);
    if(chunk.operationId!==original.operationId||chunk.spoolId!==original.spoolId)throw Error("browser_tree_cleanup_original_changed");
    const removal=await this.spool.removeChunk(chunk,signal);
    // Even if cancelled after unlink, finish its durable receipt before the
    // lock/lane is released. A failed ACK retains quota and is replayed exactly.
    await this.journal.recordRemoval(original,chunk,removal);
   }
  });}finally{this.#running.delete(key);}
 }
}
