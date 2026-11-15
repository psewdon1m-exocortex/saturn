import { parseSyncJson } from "../../contracts/src/sync-protocol.js";
import { parseStorageVerifyRequest, parseStorageVerifyResult, STORAGE_VERIFY_MAX_BODY_BYTES, StorageVerifyError,
  type StorageVerifyRequest, type StorageVerifyResult, type StorageVerifyErrorCode } from "../../contracts/src/storage-verifier.js";

export interface StorageVerifierClientOptions { readonly url: string; readonly token: string; readonly fetch?: typeof fetch }
export class StorageVerifierClient {
  readonly #url: string;
  constructor(private readonly options: StorageVerifierClientOptions) {
    const url = new URL(options.url);
    if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
      || options.token.length < 32 || options.token.length > 4096 || /\s/.test(options.token)) throw new StorageVerifyError("invalid_input");
    this.#url = new URL("/v1/verify", url).href;
  }
  async verify(value: StorageVerifyRequest, signal?: AbortSignal): Promise<StorageVerifyResult> {
    const request = parseStorageVerifyRequest(value), controller = new AbortController();
    const stop = () => controller.abort(), timeout = setTimeout(stop, request.timeoutMs);
    signal?.addEventListener("abort", stop, { once: true }); if (signal?.aborted) stop();
    try {
      const response = await (this.options.fetch ?? fetch)(this.#url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.token}` }, body: JSON.stringify(request) });
      if (!response.body) throw new StorageVerifyError("verifier_unavailable");
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0;
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break;
          const value: unknown = chunk.value;
          if (!(value instanceof Uint8Array)) throw new StorageVerifyError("invalid_input");
          length += value.length;
          if (length > STORAGE_VERIFY_MAX_BODY_BYTES) throw new StorageVerifyError("invalid_input"); parts.push(value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const data = parseSyncJson(Buffer.concat(parts), STORAGE_VERIFY_MAX_BODY_BYTES);
      if (!response.ok) {
        const code = data && typeof data === "object" && "code" in data ? String(data.code) : "verifier_unavailable";
        const allowed = ["unsupported", "unauthorized", "scope_denied", "identity_mismatch", "source_changed", "verification_failed", "capacity", "cancelled", "verifier_unavailable", "invalid_input"];
        throw new StorageVerifyError(allowed.includes(code) ? code as StorageVerifyErrorCode : "verifier_unavailable");
      }
      return parseStorageVerifyResult(data, request);
    } catch (error) {
      if (error instanceof StorageVerifyError) throw error;
      throw new StorageVerifyError(signal?.aborted ? "cancelled" : "verifier_unavailable", { cause: error });
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", stop); }
  }
}
