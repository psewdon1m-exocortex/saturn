export interface UploadQueueState {
  readonly total: number;
  readonly queued: number;
  readonly active: number;
  readonly completed: number;
}

/** Holds a slot until its actual transfer promise settles, even after abort.
 * File contents are read only by admitted work, never by the pending queue. */
export async function runUploadQueue<T, R>(items: readonly T[], transfer: (item: T, index: number, signal: AbortSignal) => Promise<R>, options: {
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly onState?: (state: UploadQueueState) => void;
} = {}): Promise<readonly R[]> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Upload queue concurrency must be between one and four");
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
  const results: R[] = new Array<R>(items.length);
  let next = 0, active = 0, completed = 0;
  const failure: { present: boolean; value: unknown } = { present: false, value: undefined };
  const stop = (error: unknown) => { if (!failure.present) { failure.present = true; failure.value = error; } controller.abort(error); };
  const report = () => {
    try { options.onState?.({ total: items.length, queued: Math.max(0, items.length - next), active, completed }); }
    catch (error) { stop(error); }
  };
  report();
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!signal.aborted && next < items.length) {
      const index = next++, item = items[index] as T;
      active += 1;
      try {
        report();
        signal.throwIfAborted();
        results[index] = await transfer(item, index, signal);
        completed += 1;
      } catch (error) {
        stop(error);
      } finally {
        active -= 1;
        report();
      }
    }
  }));
  // A callback failure must also wait for all physical work before propagating.
  const rejected = workers.find((worker): worker is PromiseRejectedResult => worker.status === "rejected");
  if (rejected) throw rejected.reason;
  if (failure.present) throw failure.value;
  signal.throwIfAborted();
  return results;
}
