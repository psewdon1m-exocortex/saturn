import { createSHA256 } from "hash-wasm";
import { errorValue } from "./error-value.js";

export const UPLOAD_HASH_CHUNK_BYTES = 1024 * 1024;

async function readChunk(chunk: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (typeof chunk.arrayBuffer === "function") return chunk.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(errorValue(signal?.reason ?? new DOMException("Cancelled", "AbortError"))); };
    const cleanup = () => signal?.removeEventListener("abort", abort);
    reader.onload = () => { cleanup(); resolve(reader.result as ArrayBuffer); };
    reader.onerror = () => { cleanup(); reject(reader.error ?? new Error("Cannot read upload source")); };
    reader.onabort = () => { cleanup(); reject(errorValue(signal?.reason ?? new DOMException("Cancelled", "AbortError"))); };
    signal?.addEventListener("abort", abort, { once: true });
    reader.readAsArrayBuffer(chunk);
  });
}

/** One incremental state per sequential worker. Never materializes a whole file. */
export async function createBlobSha256() {
  const hash = await createSHA256();
  let busy = false;
  return async (file: Blob, options: { readonly signal?: AbortSignal; readonly onProgress?: (bytes: number) => void; readonly yieldToUi?: boolean } = {}): Promise<string> => {
    if (busy) throw new Error("Hash state is already in use");
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid upload source size");
    busy = true;
    try {
      hash.init();
      for (let offset = 0; offset < file.size; offset += UPLOAD_HASH_CHUNK_BYTES) {
        options.signal?.throwIfAborted();
        const chunk = await readChunk(file.slice(offset, Math.min(file.size, offset + UPLOAD_HASH_CHUNK_BYTES)), options.signal);
        options.signal?.throwIfAborted();
        if (chunk.byteLength !== Math.min(UPLOAD_HASH_CHUNK_BYTES, file.size - offset)) throw new Error("Upload source changed while hashing");
        hash.update(new Uint8Array(chunk));
        options.onProgress?.(offset + chunk.byteLength);
        if (options.yieldToUi) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      options.signal?.throwIfAborted();
      return hash.digest("hex");
    } finally { busy = false; }
  };
}
