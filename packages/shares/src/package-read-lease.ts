import { performance } from "node:perf_hooks";
import type { Readable} from "node:stream";
import { Transform } from "node:stream";

/** startedAt is captured BEFORE the database lease request, including its
 * round trip and backend open in the conservative monotonic deadline. */
export function createLeasedPackageStream(source: Readable, lease: {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly renew: () => Promise<boolean>;
  readonly release: () => Promise<void>;
}): Readable {
  let deadline = lease.startedAt + lease.durationMs;
  let timer: ReturnType<typeof setTimeout> | undefined, released = false;
  const expired = () => new Error("Package read lease expired");
  const assertActive = () => { if (output.destroyed || performance.now() >= deadline) throw expired(); };
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (performance.now() >= deadline) output.destroy(expired()); else arm();
    }, Math.max(1, Math.ceil(deadline - performance.now())));
    timer.unref();
  };
  const output = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      void (async () => {
        assertActive();
        if (deadline - performance.now() <= lease.durationMs / 2) {
          const started = performance.now();
          const renewed = await lease.renew();
          // A delayed response cannot revive the previous local lease.
          assertActive();
          if (!renewed) throw expired();
          deadline = started + lease.durationMs; arm();
        }
        assertActive(); callback(null, chunk);
      })().catch((error: unknown) => callback(error instanceof Error ? error : new Error("Package read lease failed")));
    },
    flush(callback) { try { assertActive(); callback(); } catch (error) { callback(error as Error); } },
  });
  // Access logging may still be awaited before HTTP attaches its error handler.
  output.on("error", () => undefined);
  const release = () => {
    if (released) return;
    released = true;
    // A failed release retains the durable row and blocks cleanup safely.
    void lease.release().catch(() => undefined);
  };
  source.once("error", error => output.destroy(error));
  source.once("close", () => {
    if (!source.readableEnded && !output.destroyed) output.destroy(new Error("Package source closed before completion"));
    release();
  });
  output.once("close", () => {
    if (timer !== undefined) clearTimeout(timer);
    source.destroy();
    if (source.closed) release();
  });
  arm(); source.pipe(output);
  return output;
}
