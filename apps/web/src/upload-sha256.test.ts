import { requiredValue } from "./test-value.js";
import { expect, it, vi } from "vitest";
import { UploadSourceHasher } from "./upload-sha256.js";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly postMessage = vi.fn<(message:{readonly id:number;readonly file:Blob})=>void>();
  readonly terminate = vi.fn();
  reply(value: unknown) { this.onmessage?.({ data: value } as MessageEvent); }
}
it("rejects a non-Error abort reason as an Error with its original cause before opening workers",async()=>{
  const create=vi.fn<()=>Worker>(),pool=new UploadSourceHasher(create),abort=new AbortController(),reason={scope:"cancelled fixture"};
  abort.abort(reason);
  await expect(pool.hash(new Blob(["unread"]),{signal:abort.signal})).rejects.toMatchObject({cause:reason});
  expect(create).not.toHaveBeenCalled();pool.dispose();
});
it("bounds hash workers, cancels an unread queued source and terminates an active worker before reuse", async () => {
  const workers: FakeWorker[] = [];
  const pool = new UploadSourceHasher(() => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; });
  const active = new AbortController(), queued = new AbortController();
  try {
    const first = pool.hash(new Blob(["one"]), { signal: active.signal }).catch((error: unknown) => error);
    const second = pool.hash(new Blob(["two"]));
    const third = pool.hash(new Blob(["three"]), { signal: queued.signal }).catch((error: unknown) => error);
    const fourth = pool.hash(new Blob(["four"]));
    expect(workers).toHaveLength(2);
    queued.abort(); expect(await third).toMatchObject({ name: "AbortError" });
    active.abort(); expect(await first).toMatchObject({ name: "AbortError" });
    expect(requiredValue(workers[0]).terminate).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(3);
    expect(requiredValue(requiredValue(workers[2]).postMessage.mock.calls[0])[0].file.size).toBe(4);
    requiredValue(workers[1]).reply({ id: 2, bytes: 3 }); requiredValue(workers[1]).reply({ id: 2, sha256: "b".repeat(64) });
    requiredValue(workers[2]).reply({ id: 4, bytes: 4 }); requiredValue(workers[2]).reply({ id: 4, sha256: "d".repeat(64) });
    expect(await second).toBe("b".repeat(64)); expect(await fourth).toBe("d".repeat(64));
  } finally { pool.dispose(); }
});
