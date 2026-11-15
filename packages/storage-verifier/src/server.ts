import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHTTP, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHTTPS } from "node:https";
import { StorageVerifyError, parseStorageVerifyRequest, STORAGE_VERIFY_MAX_BODY_BYTES, type StorageVerifyErrorCode } from "../../contracts/src/storage-verifier.js";
import { RegistryAuthority, type HostConfig } from "./authority.js";
import { HostVerifier } from "./verifier.js";
import { readProtected } from "./secure-files.js";

const status: Record<StorageVerifyErrorCode, number> = { unsupported: 501, unauthorized: 401, scope_denied: 403, identity_mismatch: 409, source_changed: 409, verification_failed: 409, capacity: 429, cancelled: 408, verifier_unavailable: 503, invalid_input: 400 };
export async function createVerifierServer(config: HostConfig) {
  const secret = (await readProtected(config.secretFile, 4096)).bytes.toString("utf8").trim();
  if (secret.length < 32 || /\s/.test(secret)) throw new StorageVerifyError("invalid_input");
  const expected = createHash("sha256").update("Bearer " + secret).digest();
  const verifier = new HostVerifier(new RegistryAuthority(config));
  const requests = new Set<AbortController>();
  const handlers = new Set<Promise<void>>();
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const cancel = new AbortController(); requests.add(cancel);
    // Abort must wake an incomplete request body, not merely set a flag that
    // would only be inspected after the peer sends another chunk.
    const abortBody = (): void => { if (!req.complete) req.destroy(); };
    cancel.signal.addEventListener("abort", abortBody, { once: true });
    const timer = setTimeout(() => cancel.abort(), 35000); timer.unref();
    req.on("aborted", () => cancel.abort());
    res.on("close", () => { if (!res.writableFinished) cancel.abort(); });
    try {
      const auth = createHash("sha256").update(req.headers.authorization ?? "").digest();
      if (!timingSafeEqual(auth, expected)) throw new StorageVerifyError("unauthorized");
      if (req.method !== "POST" || req.url !== "/v1/verify" || req.headers["content-type"]?.split(";")[0] !== "application/json" || req.headers["content-encoding"]) throw new StorageVerifyError("invalid_input");
      if (requests.size > config.maximumActive * 2) throw new StorageVerifyError("capacity");
      const chunks: Buffer[] = []; let size = 0;
      for await (const part of req) {
        if (cancel.signal.aborted) throw new StorageVerifyError("cancelled");
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
        size += bytes.length;
        if (size > STORAGE_VERIFY_MAX_BODY_BYTES) throw new StorageVerifyError("invalid_input");
        chunks.push(bytes);
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new StorageVerifyError("invalid_input"); }
      const result = await verifier.verify(parseStorageVerifyRequest(input), cancel.signal);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(result));
    } catch (error) {
      const code = error instanceof StorageVerifyError ? error.code : "verifier_unavailable";
      if (!res.destroyed) {
        res.writeHead(status[code], { "Content-Type": "application/json", "Cache-Control": "no-store", ...(code === "capacity" ? { "Retry-After": "1" } : {}) });
        res.end(JSON.stringify({ code }));
      }
    } finally { clearTimeout(timer); cancel.signal.removeEventListener("abort", abortBody); requests.delete(cancel); }
  };
  const options = { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 5000 };
  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    const work = handler(req, res); handlers.add(work);
    void work.finally(() => handlers.delete(work));
  };
  const server = config.tls ? createHTTPS({ ...options, minVersion: "TLSv1.2", cert: (await readProtected(config.tls.certificateFile)).bytes, key: (await readProtected(config.tls.keyFile)).bytes }, listener) : createHTTP(options, listener);
  const shutdown = async (): Promise<void> => {
    verifier.stopAdmission(); for (const request of requests) request.abort();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    // A closed socket does not prove its file IO has joined.
    await Promise.allSettled([...handlers]);
  };
  return { server, verifier, shutdown };
}
