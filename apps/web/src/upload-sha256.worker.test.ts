import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadSourceHasher } from "./upload-sha256.js";

interface Request { readonly id: number; readonly file: Blob }
type Reply = { readonly id: number; readonly bytes: number } | { readonly id: number; readonly sha256: string } | { readonly id: number; readonly error: string };
type Handler = (event: MessageEvent<Request>) => void;
const engine = vi.hoisted(() => ({ hash: vi.fn<(file: Blob, options: { readonly onProgress: (bytes: number) => void }) => Promise<string>>() }));
vi.mock("./upload-sha256-core.js", () => ({ createBlobSha256: async () => engine.hash }));
const digest = "a".repeat(64);
const source = () => new Blob(["abc"]);
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred is not initialized"); };
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function install(postMessage: (message: Reply) => void, reportError?: (error: unknown) => void): Promise<Handler> {
  vi.stubGlobal("onmessage", null);
  vi.stubGlobal("postMessage", postMessage);
  vi.stubGlobal("reportError", reportError);
  // Execute the production event boundary, with only the hash engine fault-injected.
  await import("./upload-sha256.worker.js");
  const handler = (globalThis as unknown as { onmessage: Handler | null }).onmessage;
  if (handler === null) throw new Error("Production hash worker did not install its handler");
  return handler;
}
const dispatch = (handler: Handler, id: number) => handler({ data: { id, file: source() } } as MessageEvent<Request>);
beforeEach(() => {
  vi.resetModules();
  engine.hash.mockReset();
  engine.hash.mockImplementation(async (file, { onProgress }) => { onProgress(file.size); return digest; });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("production upload hash worker event ownership", () => {
  it("returns void and preserves progress, final digest and sequential reuse", async () => {
    const first = deferred<Reply>(), second = deferred<Reply>(), messages: Reply[] = [];
    const reportError = vi.fn();
    const handler = await install(message => {
      messages.push(message);
      if ("sha256" in message) (message.id === 1 ? first : second).resolve(message);
    }, reportError);
    expect(dispatch(handler, 1)).toBeUndefined();
    expect(await first.promise).toEqual({ id: 1, sha256: digest });
    expect(dispatch(handler, 2)).toBeUndefined();
    expect(await second.promise).toEqual({ id: 2, sha256: digest });
    expect(messages).toEqual([{ id: 1, bytes: 3 }, { id: 1, sha256: digest }, { id: 2, bytes: 3 }, { id: 2, sha256: digest }]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("owns a throwing busy response without releasing the first job's busy flag", async () => {
    const started = deferred<undefined>(), release = deferred<undefined>(), firstDone = deferred<Reply>(), busyReply = deferred<Reply>();
    const terminal = deferred<unknown>(), failure = new Error("busy post failed"), messages: Reply[] = [];
    engine.hash.mockImplementationOnce(async (file, { onProgress }) => {
      started.resolve(undefined); await release.promise; onProgress(file.size); return digest;
    });
    const reportError = vi.fn((error: unknown) => { terminal.resolve(error); });
    const handler = await install(message => {
      messages.push(message);
      if (message.id === 2) throw failure;
      if (message.id === 3) busyReply.resolve(message);
      if (message.id === 1 && "sha256" in message) firstDone.resolve(message);
    }, reportError);
    try {
      dispatch(handler, 1); await started.promise;
      expect(dispatch(handler, 2)).toBeUndefined();
      expect(await terminal.promise).toBe(failure);
      dispatch(handler, 3);
      expect(await busyReply.promise).toEqual({ id: 3, error: "Hash worker already in use" });
      expect(engine.hash).toHaveBeenCalledTimes(1);
      release.resolve(undefined);
      expect(await firstDone.promise).toEqual({ id: 1, sha256: digest });
      expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(messages.filter(message => message.id === 2)).toHaveLength(1);
    } finally { release.resolve(undefined); }
  });

  it("owns a throwing error response exactly once and resets for another job", async () => {
    const terminal = deferred<unknown>(), reused = deferred<Reply>(), failure = new Error("error post failed");
    engine.hash.mockRejectedValueOnce(new Error("source read failed"));
    const reportError = vi.fn((error: unknown) => { terminal.resolve(error); });
    const handler = await install(message => {
      if (message.id === 1 && "error" in message) throw failure;
      if (message.id === 2 && "sha256" in message) reused.resolve(message);
    }, reportError);
    expect(dispatch(handler, 1)).toBeUndefined();
    expect(await terminal.promise).toBe(failure);
    dispatch(handler, 2);
    expect(await reused.promise).toEqual({ id: 2, sha256: digest });
    expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(engine.hash).toHaveBeenCalledTimes(2);
  });

  it.each(["progress", "final"] as const)("reports a throwing %s post once through the normal error message and resets", async stage => {
    const failed = deferred<Reply>(), reused = deferred<Reply>(), messages: Reply[] = [];
    const reportError = vi.fn();
    const handler = await install(message => {
      messages.push(message);
      if (message.id === 1 && (stage === "progress" ? "bytes" in message : "sha256" in message)) throw new Error("post failed");
      if (message.id === 1 && "error" in message) failed.resolve(message);
      if (message.id === 2 && "sha256" in message) reused.resolve(message);
    }, reportError);
    dispatch(handler, 1);
    expect(await failed.promise).toEqual({ id: 1, error: "Cannot hash upload source. Check file access and the upload worker security policy." });
    dispatch(handler, 2);
    expect(await reused.promise).toEqual({ id: 2, sha256: digest });
    expect(messages.filter(message => message.id === 1 && "error" in message)).toHaveLength(1);
    expect(reportError).not.toHaveBeenCalled();
    expect(engine.hash).toHaveBeenCalledTimes(2);
  });

  it.each(["progress", "final"] as const)("owns a failed %s post plus failed terminal post as one worker error", async stage => {
    const terminal = deferred<unknown>(), failure = new Error("terminal post failed");
    const reportError = vi.fn((error: unknown) => { terminal.resolve(error); });
    const messages: Reply[] = [];
    const handler = await install(message => {
      messages.push(message);
      if ("error" in message) throw failure;
      if (stage === "progress" ? "bytes" in message : "sha256" in message) throw new Error("first post failed");
    }, reportError);
    expect(dispatch(handler, 1)).toBeUndefined();
    expect(await terminal.promise).toBe(failure);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(messages.filter(message => "error" in message)).toHaveLength(1);
    expect(engine.hash).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "throwing"] as const)("schedules the original terminal exception when the worker error reporter is %s", async mode => {
    const checked = deferred<undefined>(), failure = new Error("terminal channel failed");
    const reporter = mode === "missing" ? undefined : vi.fn(() => { throw new Error("reporter failed"); });
    engine.hash.mockRejectedValueOnce(new Error("source read failed"));
    const handler = await install(message => { if ("error" in message) throw failure; }, reporter);
    // Observe the feature check without advancing the fatal timer prematurely.
    Object.defineProperty(globalThis, "reportError", { configurable: true, get() { checked.resolve(undefined); return reporter; } });
    vi.useFakeTimers();
    try {
      expect(dispatch(handler, 1)).toBeUndefined();
      await checked.promise;
      expect(vi.getTimerCount()).toBe(1);
      await expect(vi.runAllTimersAsync()).rejects.toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("delivers terminal failure to the production client's onerror, rejecting once and replacing the worker", async () => {
    // The bridge models browser reportError -> parent Worker.onerror delivery;
    // both worker handler and UploadSourceHasher reaction are production code.
    const bridge: { active: HandlerWorker | undefined } = { active: undefined };
    const workers: HandlerWorker[] = [], failures: unknown[] = [];
    class HandlerWorker {
      onmessage: ((event: MessageEvent<Reply>) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      readonly terminate = vi.fn();
      postMessage(request: Request): void {
        bridge.active = this; handler({ data: request } as MessageEvent<Request>);
      }
    }
    engine.hash.mockRejectedValueOnce(new Error("source read failed"));
    const handler = await install(message => {
      if (message.id === 1 && "error" in message) throw new Error("terminal channel failed");
      bridge.active?.onmessage?.({ data: message } as MessageEvent<Reply>);
    }, error => { failures.push(error); bridge.active?.onerror?.(); });
    const pool = new UploadSourceHasher(() => {
      const worker = new HandlerWorker(); workers.push(worker); return worker as unknown as Worker;
    });
    try {
      await expect(pool.hash(source())).rejects.toThrow("Cannot start the upload hashing worker; check file access and security policy");
      expect(failures).toHaveLength(1);
      const first = workers[0];
      if (first === undefined) throw new Error("First worker was not created");
      expect(first.terminate).toHaveBeenCalledTimes(1);
      expect(await pool.hash(source())).toBe(digest);
      expect(workers).toHaveLength(2);
      expect(failures).toHaveLength(1);
    } finally { pool.dispose(); }
  });
});
