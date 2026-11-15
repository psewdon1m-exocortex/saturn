import { requiredValue } from "./required-value.js";
export class CatalogRootAdmissionError extends Error {
  constructor(readonly code: "admission_full" | "cancelled" | "invalid_input") { super(code); }
}
interface Waiter { readonly grant: () => void; readonly reject: (error: CatalogRootAdmissionError) => void; cleanup: () => void }
interface RootQueue { active: boolean; readonly waiting: Waiter[] }
interface SqlRequest {action:()=>Promise<unknown>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}
export interface CatalogRootAdmissionOptions {
  readonly maximumRoots?: number;
  readonly maximumQueuedPerRoot?: number;
  readonly maximumQueuedTotal?: number;
  readonly maximumWaitMs?: number;
}
/** Process-local FIFO admission for the installed SQL conflict scope (sync_root_id).
 * It coordinates healthy promises, never declares a durable operation resolved.
 * Once admitted, a physical effect keeps its slot until the original outcome or
 * UNKNOWN handling finishes. Queue timeout/abort cannot release an active writer.
 * Cross-process/UNKNOWN blockers remain protected by the unchanged SQL guard. */
export class CatalogRootAdmission {
  readonly #roots = new Map<string, RootQueue>();
  readonly #maximumRoots: number;
  readonly #maximumQueuedPerRoot: number;
  readonly #maximumQueuedTotal: number;
  readonly #maximumWaitMs: number;
  #waiting = 0;
  #closed = false;
  readonly #drainWaiters = new Set<() => void>();
  readonly #sqlBatches=new Map<string,SqlRequest[]>();
  readonly #sqlWaitingRoots=new Map<string,number>();#sqlWaiting=0;
  constructor(options: CatalogRootAdmissionOptions = {}) {
    this.#maximumRoots = options.maximumRoots ?? 16;
    this.#maximumQueuedPerRoot = options.maximumQueuedPerRoot ?? 16;
    this.#maximumQueuedTotal = options.maximumQueuedTotal ?? 64;
    this.#maximumWaitMs = options.maximumWaitMs ?? 10000;
    for (const [value, ceiling] of [[this.#maximumRoots, 16], [this.#maximumQueuedPerRoot, 64], [this.#maximumQueuedTotal, 128], [this.#maximumWaitMs, 30000]]) {
      if (!Number.isInteger(value) || value === undefined || ceiling === undefined || value < 1 || value > ceiling) throw new CatalogRootAdmissionError("invalid_input");
    }
  }
  async run<T>(rootId: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(rootId)) throw new CatalogRootAdmissionError("invalid_input");
    if (this.#closed || signal?.aborted) throw new CatalogRootAdmissionError("cancelled");
    let queue = this.#roots.get(rootId);
    if (!queue) {
      if (this.#roots.size >= this.#maximumRoots) throw new CatalogRootAdmissionError("admission_full");
      queue = { active: false, waiting: [] }; this.#roots.set(rootId, queue);
    }
    const root = queue;
    if (root.active) {
      if (root.waiting.length >= this.#maximumQueuedPerRoot || this.#waiting >= this.#maximumQueuedTotal) throw new CatalogRootAdmissionError("admission_full");
      await new Promise<void>((resolve, reject) => {
        const remove = (error: CatalogRootAdmissionError) => {
          const n = root.waiting.indexOf(waiter); if (n < 0) return;
          root.waiting.splice(n, 1); this.#waiting--; waiter.cleanup(); reject(error);
        };
        const abort = () => remove(new CatalogRootAdmissionError("cancelled"));
        const timer = setTimeout(() => remove(new CatalogRootAdmissionError("admission_full")), this.#maximumWaitMs);
        const waiter: Waiter = { grant: resolve, reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
        root.waiting.push(waiter); this.#waiting++; signal?.addEventListener("abort", abort, { once: true });
      });
    } else root.active = true;
    try { return await action(); }
    finally {
      const next = root.waiting.shift();
      if (next) { this.#waiting--; next.cleanup(); next.grant(); }
      else { root.active = false; this.#roots.delete(rootId); if (this.#roots.size === 0) { for (const done of this.#drainWaiters) done(); this.#drainWaiters.clear(); } }
    }
  }
  /** Up to four fixed private SQL commands share one exclusive FIFO slot.
   * Callbacks must not perform storage I/O or acquire root admission again.
   * The slot remains held until every callback settles, including on failure. */
  runSqlBatch<T>(rootId:string,action:()=>Promise<T>):Promise<T>{
    if(!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(rootId))return Promise.reject(new CatalogRootAdmissionError('invalid_input'));
    if(this.#closed)return Promise.reject(new CatalogRootAdmissionError('cancelled'));
    if(this.#sqlWaiting+this.#waiting>=this.#maximumQueuedTotal||(this.#sqlWaitingRoots.get(rootId)??0)>=this.#maximumQueuedPerRoot)return Promise.reject(new CatalogRootAdmissionError('admission_full'));
    this.#sqlWaiting++;this.#sqlWaitingRoots.set(rootId,(this.#sqlWaitingRoots.get(rootId)??0)+1);
    return new Promise<T>((resolve,reject)=>{
      let batch=this.#sqlBatches.get(rootId);const first=!batch;
      if(!batch){batch=[];this.#sqlBatches.set(rootId,batch);}
      batch.push({action,resolve:value=>resolve(value as T),reject});
      if(batch.length===4)this.#sqlBatches.delete(rootId);
      if(!first)return;
      const original=batch;let queued=true;
      const admitted=()=>{
        if(!queued)return;queued=false;this.#sqlWaiting-=original.length;
        const left=(this.#sqlWaitingRoots.get(rootId)??0)-original.length;
        if(left)this.#sqlWaitingRoots.set(rootId,left);else this.#sqlWaitingRoots.delete(rootId);
        if(this.#sqlBatches.get(rootId)===original)this.#sqlBatches.delete(rootId);
      };
      void this.run(rootId,async()=>{
        // Finish consuming already available request parts before flushing.
        await new Promise<void>(done=>setImmediate(done));admitted();
        const settled=await Promise.allSettled(original.map(r=>Promise.resolve().then(r.action)));
        for(const [n,r]of original.entries()){const result=requiredValue(settled[n]);if(result.status==='fulfilled')r.resolve(result.value);else r.reject(result.reason);}
      }).catch((error:unknown)=>{admitted();for(const r of original)r.reject(error);});
    });
  }
  /** Reject queued callers only. An admitted physical writer is not interrupted. */
  close(): void {
    this.#closed = true;
    for (const root of this.#roots.values()) {
      for (const waiter of root.waiting.splice(0)) { this.#waiting--; waiter.cleanup(); waiter.reject(new CatalogRootAdmissionError("cancelled")); }
    }
  }
  /** Join admitted effects; never turn a shutdown timeout into permission to take over. */
  drain(): Promise<void> { return this.#roots.size === 0 ? Promise.resolve() : new Promise(resolve => this.#drainWaiters.add(resolve)); }
}
