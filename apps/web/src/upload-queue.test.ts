import { requiredValue } from "./test-value.js";
import { describe, expect, it, vi } from "vitest";
import { runUploadQueue, type UploadQueueState } from "./upload-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe("bounded browser upload queue", () => {
  it("admits at most four sources from a 4096-item queue and keeps input result order", async () => {
    const first = Array.from({ length: 4 }, () => deferred<number>()), states: UploadQueueState[] = [];
    const transfer = vi.fn(async (item: number) => item < 4 ? requiredValue(first[item]).promise : item);
    const result = runUploadQueue(Array.from({ length: 4096 }, (_, index) => index), transfer, { onState: state => states.push(state) });
    expect(transfer).toHaveBeenCalledTimes(4);
    expect(states.at(-1)).toEqual({ total: 4096, queued: 4092, active: 4, completed: 0 });
    for (let index = 3; index >= 0; index--) requiredValue(first[index]).resolve(index);
    expect(await result).toEqual(Array.from({ length: 4096 }, (_, index) => index));
    expect(Math.max(...states.map(state => state.active))).toBe(4);
    expect(states.at(-1)).toEqual({ total: 4096, queued: 0, active: 0, completed: 4096 });
  });
  it("cancels queued sources before reading them and waits for active physical work", async () => {
    const controller = new AbortController(), running = Array.from({ length: 4 }, () => deferred<number>());
    const transfer = vi.fn(async (_item: number, index: number, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false); return requiredValue(running[index]).promise;
    });
    let settled = false;
    const result = runUploadQueue(Array.from({ length: 4096 }, (_, index) => index), transfer, { signal: controller.signal });
    const observed = result.then(() => { settled = true; }, (error: unknown) => { settled = true; if (!(error instanceof Error)) throw new Error("Expected an abort Error", { cause: error }); expect(error.name).toBe("AbortError"); });
    controller.abort(); await Promise.resolve();
    expect(settled).toBe(false);
    expect(transfer).toHaveBeenCalledTimes(4);
    running.forEach((item, index) => item.resolve(index));
    await observed;
    expect(transfer).toHaveBeenCalledTimes(4);
  });
  it("fails admission closed while an in-flight peer may still commit", async () => {
    const failed = deferred<number>(), committed = deferred<number>();
    const states: UploadQueueState[] = [];
    const transfer = vi.fn(async (_item: number, index: number) => index === 0 ? failed.promise : committed.promise);
    let settled = false;
    const result = runUploadQueue([0, 1, 2], transfer, { concurrency: 2, onState: state => states.push(state) });
    const observed = result.then(() => { throw new Error("unexpected success"); }, (error: unknown) => { settled = true; if (!(error instanceof Error)) throw new Error("Expected a transfer Error", { cause: error }); expect(error.message).toBe("revoked"); });
    failed.reject(new Error("revoked")); await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    committed.resolve(1); await observed;
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toEqual({ total: 3, queued: 1, active: 0, completed: 1 });
  });
});
