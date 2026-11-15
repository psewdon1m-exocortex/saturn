import type { Readable } from "node:stream";
import type { StorageReadStream } from "./types.js";

/** Fulfil only on a backend's positive handle-close acknowledgement. Errors,
 * transport loss and elapsed deadlines never establish successful closure. */
export function createStorageClosureProof() {
  let confirm!: () => void, reject!: (error: Error) => void;
  const closed = new Promise<void>((resolve, fail) => { confirm = resolve; reject = fail; });
  // Existing callers may not observe this optional capability. Preserve the
  // original rejection for custody-aware consumers without an unhandled error.
  void closed.catch(() => undefined);
  return { closed, confirm, reject };
}

export function bindStorageReadClosure<T extends Readable>(stream: T, closed: Promise<void>): T & StorageReadStream {
  Object.defineProperty(stream, "storageClosed", { value: closed, writable: false, configurable: false, enumerable: false });
  return stream;
}
