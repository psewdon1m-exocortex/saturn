import fs from "node:fs/promises";
import { ServiceUnavailableException } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";

export async function resolveKernelOrigin(kernelUrl: string, token: string, service: "saturn" | "gryphon", timeoutMs: number, fetchImpl = fetch): Promise<string> {
  try {
    const kernel = new URL(kernelUrl);
    if (kernel.username || kernel.password || kernel.search || kernel.hash ||
      (kernel.protocol !== "https:" && !(kernel.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(kernel.hostname)))) throw new Error("Invalid Kernel address");
    const hostKey = `services.${service}.sni`, portKey = `services.${service}.port`;
    const keys = [hostKey, portKey];
    const response = await fetchImpl(new URL("/api/v1/register/resolve", kernel), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ keys }),
    });
    if (!response.ok) throw new Error("Kernel discovery failed");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Kernel discovery returned no body");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new Error("Invalid Kernel response chunk");
        size += value.byteLength; if (size > 16384) throw new Error("Kernel discovery response exceeds limit");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof data !== "object" || data === null) throw new Error("Invalid Kernel response");
    const result = data as { schema?: string; values?: Record<string, { value?: unknown }> };
    if (result.schema !== "exocortex.register.resolution.v1") throw new Error("Invalid Kernel response schema");
    const host = result.values?.[hostKey]?.value;
    const rawPort = result.values?.[portKey]?.value;
    if (typeof rawPort !== "string" && typeof rawPort !== "number") throw new Error("Invalid registered port");
    const port = String(rawPort);
    if (typeof host !== "string" || host.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
      throw new Error("Invalid registered origin");
    return new URL(`https://${host}:${port}`).origin;
  } catch { throw new ServiceUnavailableException({ code: "kernel_discovery_unavailable" }); }
}

export function registeredOrigin(database: Database, config: SaturnConfig, service: "saturn" | "gryphon") {
  return async (): Promise<string> => {
    const rows = await database.withSql(sql => sql<{ kernel_url: string | null }[]>`SELECT kernel_url FROM kernel_settings WHERE singleton = true`);
    const kernel = rows[0]?.kernel_url ?? config.kernel.urlSeed;
    const tokenFile = config.kernel.tokenFile;
    if (!kernel || !tokenFile || (await fs.stat(tokenFile)).size > 8192) throw new ServiceUnavailableException({ code: "kernel_not_configured" });
    return resolveKernelOrigin(kernel, (await fs.readFile(tokenFile, "utf8")).trim(), service, config.kernel.timeoutMs);
  };
}
