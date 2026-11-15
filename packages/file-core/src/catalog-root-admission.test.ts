import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CatalogRootAdmission } from "./catalog-root-admission.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
it("keeps FIFO publication order despite a continuing folder stream", async () => {
  const gate = new CatalogRootAdmission({ maximumQueuedPerRoot: 64 }), root = randomUUID(), held = deferred(), started = deferred(), order: string[] = [];
  const first = gate.run(root, async () => { started.resolve(); await held.promise; order.push("initial-folder"); }); await started.promise;
  const file = gate.run(root, async () => { order.push("original-file"); });
  const folders = Array.from({ length: 50 }, (_, n) => gate.run(root, async () => { order.push("folder-" + String(n)); }));
  held.resolve(); await Promise.all([first, file, ...folders]);
  expect(order).toEqual(["initial-folder", "original-file", ...Array.from({ length: 50 }, (_, n) => "folder-" + String(n))]);
});
it("allows independent roots and does not serialize their shared control ancestors", async () => {
  const gate = new CatalogRootAdmission(), a = randomUUID(), b = randomUUID(), held = deferred(), started = deferred();
  const first = gate.run(a, async () => { started.resolve(); await held.promise; }); await started.promise;
  await expect(gate.run(b, async () => "other-root")).resolves.toBe("other-root"); held.resolve(); await first;
});
it("bounds queue size before executing a rejected callback and reclaims idle roots", async () => {
  const gate = new CatalogRootAdmission({ maximumRoots: 1, maximumQueuedPerRoot: 1 }), root = randomUUID(), held = deferred(), started = deferred(), callback = vi.fn(async () => undefined);
  const first = gate.run(root, async () => { started.resolve(); await held.promise; }); await started.promise;
  const queued = gate.run(root, async () => undefined);
  await expect(gate.run(root, callback)).rejects.toMatchObject({ code: "admission_full" });
  await expect(gate.run(randomUUID(), callback)).rejects.toMatchObject({ code: "admission_full" }); expect(callback).not.toHaveBeenCalled();
  held.resolve(); await Promise.all([first, queued]); await gate.run(randomUUID(), callback); expect(callback).toHaveBeenCalledOnce();
});
it("bounds the total waiters across roots", async () => {
  const gate = new CatalogRootAdmission({ maximumQueuedTotal: 1 }), a = randomUUID(), b = randomUUID(), held = deferred(), starts = [deferred(), deferred()];
  const active = [a, b].map((r, n) => gate.run(r, async () => { starts[n]?.resolve(); await held.promise; })); await Promise.all(starts.map(s => s.promise));
  const queued = gate.run(a, async () => undefined); await expect(gate.run(b, async () => undefined)).rejects.toMatchObject({ code: "admission_full" });
  held.resolve(); await Promise.all([...active, queued]);
});
it("expires a waiter without releasing the admitted physical writer", async () => {
  vi.useFakeTimers();
  try {
    const gate = new CatalogRootAdmission({ maximumWaitMs: 25 }), root = randomUUID(), held = deferred(), started = deferred(), callback = vi.fn(async () => undefined);
    const first = gate.run(root, async () => { started.resolve(); await held.promise; }); await started.promise;
    const rejected = expect(gate.run(root, callback)).rejects.toMatchObject({ code: "admission_full" }); await vi.advanceTimersByTimeAsync(25); await rejected; expect(callback).not.toHaveBeenCalled();
    const next = gate.run(root, callback); await Promise.resolve(); expect(callback).not.toHaveBeenCalled(); held.resolve(); await Promise.all([first, next]); expect(callback).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
it("cancels queued work and preserves the next waiter's order", async () => {
  const gate = new CatalogRootAdmission(), root = randomUUID(), held = deferred(), started = deferred(), abort = new AbortController(), callback = vi.fn(async () => undefined);
  const first = gate.run(root, async () => { started.resolve(); await held.promise; }); await started.promise;
  const rejected = expect(gate.run(root, callback, abort.signal)).rejects.toMatchObject({ code: "cancelled" }); const next = gate.run(root, async () => "next"); abort.abort(); await rejected;
  held.resolve(); await first; expect(await next).toBe("next"); expect(callback).not.toHaveBeenCalled();
});
it("abort after admission cannot transfer the physical slot to another writer", async () => {
  const gate = new CatalogRootAdmission(), root = randomUUID(), held = deferred(), started = deferred(), abort = new AbortController(), callback = vi.fn(async () => undefined);
  const first = gate.run(root, async () => { started.resolve(); await held.promise; }, abort.signal); await started.promise; abort.abort();
  const next = gate.run(root, callback); await Promise.resolve(); expect(callback).not.toHaveBeenCalled(); held.resolve(); await Promise.all([first, next]);
});
it("releases on a terminal action error without concealing that error", async () => {
  const gate = new CatalogRootAdmission(), root = randomUUID(), original = new Error("UNKNOWN"); await expect(gate.run(root, () => Promise.reject(original))).rejects.toBe(original);
  await expect(gate.run(root, async () => "next")).resolves.toBe("next");
});
it("close rejects waiting/new callers while the admitted writer finishes normally", async () => {
  const gate = new CatalogRootAdmission(), root = randomUUID(), held = deferred(), started = deferred(), callback = vi.fn(async () => undefined);
  const first = gate.run(root, async () => { started.resolve(); await held.promise; return "original"; }); await started.promise;
  const queued = expect(gate.run(root, callback)).rejects.toMatchObject({ code: "cancelled" }); gate.close(); await queued;
  await expect(gate.run(root, callback)).rejects.toMatchObject({ code: "cancelled" }); held.resolve(); expect(await first).toBe("original"); expect(callback).not.toHaveBeenCalled();
});
it.each([0, -1, 30001, Number.NaN, 1.5])("rejects unbounded/invalid wait %s", maximumWaitMs => expect(() => new CatalogRootAdmission({ maximumWaitMs })).toThrow("invalid_input"));
it("rejects a malformed scope and an already cancelled waiter without invoking it", async () => {
  const gate = new CatalogRootAdmission(), callback = vi.fn(async () => undefined), abort = new AbortController(); abort.abort();
  await expect(gate.run("not-root", callback)).rejects.toMatchObject({ code: "invalid_input" }); await expect(gate.run(randomUUID(), callback, abort.signal)).rejects.toMatchObject({ code: "cancelled" }); expect(callback).not.toHaveBeenCalled();
});
