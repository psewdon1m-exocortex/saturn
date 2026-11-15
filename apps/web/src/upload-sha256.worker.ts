import { createBlobSha256 } from "./upload-sha256-core.js";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ readonly id: number; readonly file: Blob }>) => void) | null;
  postMessage: (message: unknown) => void;
  reportError?: (error: unknown) => void;
};
let hash: ReturnType<typeof createBlobSha256> | undefined;
let busy = false;
function reportTerminalError(error: unknown): void {
  try {
    if (typeof scope.reportError === "function") { scope.reportError(error); return; }
  } catch { /* A broken reporter must not turn this catch into another rejected Promise. */ }
  const failure = error instanceof Error ? error : new Error("Upload hashing worker failed", { cause: error });
  // An uncaught timer exception is delivered through the parent Worker's onerror.
  setTimeout(() => { throw failure; }, 0);
}
async function handleMessage(event: MessageEvent<{ readonly id: number; readonly file: Blob }>): Promise<void> {
  const { id, file } = event.data;
  if (busy) { scope.postMessage({ id, error: "Hash worker already in use" }); return; }
  busy = true;
  try {
    const sha256 = await (await (hash ??= createBlobSha256()))(file, { onProgress: bytes => scope.postMessage({ id, bytes }) });
    scope.postMessage({ id, sha256 });
  } catch { scope.postMessage({ id, error: "Cannot hash upload source. Check file access and the upload worker security policy." }); }
  finally { busy = false; }
}
scope.onmessage = event => {
  // A failed terminal post cannot report through the same broken message channel.
  // Surface it as a worker error so UploadSourceHasher rejects and replaces the worker.
  void handleMessage(event).catch(reportTerminalError);
};
