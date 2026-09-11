import { Readable } from "node:stream";
import type { SaturnConfig } from "@saturn/config";
import type { DeviceService } from "@saturn/sync";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerWebDav } from "./webdav.js";
import type { TransferMonitorService } from "./transfer-monitor.service.js";

describe("WebDAV download snapshot", () => {
  it("uses the opened version for length, ETag and ranges without a preceding stat", async () => {
    const app = Fastify();
    for (const method of ["PROPFIND", "MKCOL", "MOVE", "COPY"]) app.addHttpMethod(method);
    const resource = { type: "file", name: "test.txt", sizeBytes: 9, sha256: "a".repeat(64), updatedAt: new Date() };
    const devices = {
      authenticate: vi.fn().mockResolvedValue({}),
      propfind: vi.fn().mockRejectedValue(new Error("A second metadata read races with overwrite")),
      openRead: vi.fn().mockImplementation(async (_context, _path, select: (size: number) => { offset: number; length: number } | undefined) => {
        const chosen = select(resource.sizeBytes);
        const offset = chosen?.offset ?? 0, length = chosen?.length ?? 9;
        return { resource, stream: Readable.from(Buffer.from("timer-run").subarray(offset, offset + length)), offset, length, partial: chosen !== undefined };
      }),
    };
    registerWebDav(app, devices as unknown as DeviceService, {} as SaturnConfig, { trackDownload: (stream: Readable) => stream } as unknown as TransferMonitorService);
    try {
      for (const [range, body] of [[undefined, "timer-run"], ["bytes=-3", "run"]] as const) {
        const response = await app.inject({ method: "GET", url: "/dav/sync/test.txt", headers: range === undefined ? {} : { range } });
        expect(response.statusCode).toBe(range === undefined ? 200 : 206);
        expect(response.body).toBe(body);
        expect(response.headers["content-length"]).toBe(String(body.length));
        expect(response.headers.etag).toBe(`"sha256-${resource.sha256}"`);
      }
      const invalid = await app.inject({ method: "GET", url: "/dav/sync/test.txt", headers: { range: "bytes=12-15" } });
      expect(invalid.statusCode).toBe(416);
      expect(invalid.headers["content-range"]).toBe("bytes */9");
      expect(devices.propfind).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
