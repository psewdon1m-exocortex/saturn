import { errorValue } from "./error-value.js";

interface HashJob {
  readonly id: number;
  readonly file: Blob;
  readonly signal?: AbortSignal;
  readonly onProgress?: (bytes: number) => void;
  readonly resolve: (sha256: string) => void;
  readonly reject: (error: unknown) => void;
  abort?: () => void;
}
interface HashSlot { worker?: Worker; job?: HashJob; timer?: ReturnType<typeof setTimeout> }

/** Two streaming workers and at most sixteen waiting File handles. */
export class UploadSourceHasher {
  readonly #slots: HashSlot[] = [{}, {}];
  readonly #pending: HashJob[] = [];
  #sequence = 0;
  constructor(private readonly createWorker: () => Worker = () => new Worker(new URL("./upload-sha256.worker.ts", import.meta.url), { type: "module" })) {}

  hash(file: Blob, options: { readonly signal?: AbortSignal; readonly onProgress?: (bytes: number) => void } = {}): Promise<string> {
    if (options.signal?.aborted) return Promise.reject(errorValue(options.signal.reason));
    if (this.#pending.length >= 16) return Promise.reject(new Error("Upload source hashing queue is full"));
    return new Promise((resolve, reject) => {
      const job: HashJob = { id: ++this.#sequence, file, ...options, resolve, reject };
      job.abort = () => {
        const index = this.#pending.indexOf(job);
        if (index >= 0) { this.#pending.splice(index, 1); if (job.abort) job.signal?.removeEventListener("abort", job.abort); reject(errorValue(job.signal?.reason)); return; }
        const slot = this.#slots.find(candidate => candidate.job === job);
        if (slot) this.#finish(slot, job.signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      };
      job.signal?.addEventListener("abort", job.abort, { once: true });
      this.#pending.push(job);
      this.#pump();
    });
  }

  dispose(): void {
    const error = new DOMException("Upload hashing stopped", "AbortError");
    for (const job of this.#pending.splice(0)) { if (job.abort) job.signal?.removeEventListener("abort", job.abort); job.reject(error); }
    for (const slot of this.#slots) {
      if (slot.job !== undefined) this.#finish(slot, error);
      clearTimeout(slot.timer); slot.worker?.terminate(); delete slot.worker;
    }
  }

  #arm(slot: HashSlot): void {
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this.#finish(slot, new Error("Upload source hashing stopped making progress")), 30_000);
  }
  #pump(): void {
    for (const slot of this.#slots) {
      if (slot.job !== undefined || this.#pending.length === 0) continue;
      const job = this.#pending.shift();
      if (job === undefined) continue;
      slot.job = job;
      try {
        job.signal?.throwIfAborted();
        slot.worker ??= this.createWorker();
        const worker = slot.worker;
        let bytesRead = 0;
        worker.onmessage = (event: MessageEvent<unknown>) => {
          if (slot.job !== job || slot.worker !== worker) return;
          const result = event.data as { id?: unknown; bytes?: unknown; sha256?: unknown; error?: unknown } | null;
          if (!result || result.id !== job.id) return;
          if (typeof result.error === "string") { this.#finish(slot, new Error(result.error)); return; }
          if (typeof result.sha256 === "string" && /^[a-f0-9]{64}$/.test(result.sha256)) {
            if (bytesRead !== job.file.size) this.#finish(slot, new Error("Upload hash completed before all source bytes were read"));
            else this.#finish(slot, undefined, result.sha256);
            return;
          }
          if (typeof result.bytes !== "number" || !Number.isSafeInteger(result.bytes) || result.bytes < bytesRead || result.bytes > job.file.size) { this.#finish(slot, new Error("Invalid upload hash progress")); return; }
          bytesRead = result.bytes;
          this.#arm(slot);
          try { job.onProgress?.(bytesRead); } catch (error) { this.#finish(slot, error); }
        };
        worker.onerror = () => { if (slot.job === job && slot.worker === worker) this.#finish(slot, new Error("Cannot start the upload hashing worker; check file access and security policy")); };
        worker.onmessageerror = () => { if (slot.job === job && slot.worker === worker) this.#finish(slot, new Error("Cannot read the selected upload source in its worker")); };
        this.#arm(slot);
        worker.postMessage({ id: job.id, file: job.file });
      } catch (error) { this.#finish(slot, error); }
    }
  }
  #finish(slot: HashSlot, error?: unknown, sha256?: string): void {
    const job = slot.job;
    if (job === undefined) return;
    delete slot.job;
    clearTimeout(slot.timer);
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
    if (sha256 === undefined) { slot.worker?.terminate(); delete slot.worker; job.reject(error); }
    else {
      job.resolve(sha256);
      slot.timer = setTimeout(() => { if (slot.job === undefined) { slot.worker?.terminate(); delete slot.worker; } }, 30_000);
    }
    this.#pump();
  }
}

export const uploadSourceHasher = new UploadSourceHasher();
