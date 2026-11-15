import { fixtureValue } from './test-values.fixture.js';
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Resource } from "@saturn/file-core";
import { FileController } from "./file.controller.js";

function fixture(staleMetadata = false) {
  const current = { id: "file", type: "file", status: "active", storagePath: "fixture/file.bin", name: "new.bin", sizeBytes: 6,
    sha256: "b".repeat(64), currentVersionId: "version-b", mimeType: "application/octet-stream" } as Resource;
  const metadata = staleMetadata ? { ...current, name: "old.bin", sizeBytes: 4, sha256: "a".repeat(64), currentVersionId: "version-a" } : current;
  const files = {
    getResource: vi.fn().mockResolvedValue(metadata),
    openDownload: vi.fn(async (_id: string, range: number | ((value: Resource) => { offset: number; length?: number }) = 0, length?: number) => {
      const selected = typeof range === "function" ? range(current) : { offset: range, length };
      const bytes = Buffer.from("abcdef");
      return { resource: current, stream: Readable.from([bytes.subarray(selected.offset, selected.length === undefined ? undefined : selected.offset + selected.length)]) };
    }),
  };
  const headers = new Map<string, unknown>();
  const reply = { header: vi.fn((name: string, value: unknown) => { headers.set(name, value); return reply; }), status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
  const transfers = { trackDownload: vi.fn((stream: Readable) => stream), assertDownloadAvailable: vi.fn() };
  const controller = new FileController(files as never, {} as never, transfers as never);
  return { files, reply, headers, controller, current };
}

describe("owner download representation validators", () => {
  it("clamps a satisfiable requested end to the current representation length", async () => {
    const f = fixture();
    await f.controller.download("file", "bytes=2-999", { headers: {} } as never, f.reply as never);
    expect(f.reply.status).toHaveBeenCalledWith(206);
    expect(f.headers.get("Content-Length")).toBe(4);
    expect(f.headers.get("Content-Range")).toBe("bytes 2-5/6");
  });

  it("HEAD advertises the same representation without reading or tracking a transfer", async () => {
    const f = fixture();
    await f.controller.downloadHead("file", "bytes=-2", { headers: {} } as never, f.reply as never);
    expect(f.files.openDownload).not.toHaveBeenCalled();
    expect(f.headers.get("ETag")).toBe(`"sha256-${fixtureValue(f.current.sha256)}"`);
    expect(f.headers.get("Content-Length")).toBe(2);
    expect(f.headers.get("Content-Range")).toBe("bytes 4-5/6");
    expect(f.reply.send).toHaveBeenCalledWith();
  });

  it("restarts with a full response when If-Range differs, instead of splicing versions", async () => {
    const f = fixture();
    await f.controller.download("file", "bytes=2-", { headers: { "if-range": '"sha256-old"' } } as never, f.reply as never);
    expect(f.reply.status).not.toHaveBeenCalledWith(206);
    expect(f.headers.get("Content-Length")).toBe(6);
    expect(f.headers.has("Content-Range")).toBe(false);
    const chunks = []; for await (const chunk of fixtureValue(f.reply.send.mock.calls[0])[0] as Readable) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("abcdef");
  });

  it("retains a partial response for the same strong content validator", async () => {
    const f = fixture();
    await f.controller.download("file", "bytes=2-", { headers: { "if-range": `"sha256-${fixtureValue(f.current.sha256)}"` } } as never, f.reply as never);
    expect(f.reply.status).toHaveBeenCalledWith(206);
    expect(f.headers.get("Content-Range")).toBe("bytes 2-5/6");
  });

  it("selects Range and headers from the representation acquired under the resource lock", async () => {
    const f = fixture(true);
    await f.controller.download("file", "bytes=2-", { headers: {} } as never, f.reply as never);
    expect(f.headers.get("Content-Length")).toBe(4);
    expect(f.headers.get("Content-Range")).toBe("bytes 2-5/6");
    expect(f.headers.get("ETag")).toBe(`"sha256-${fixtureValue(f.current.sha256)}"`);
    expect(f.headers.get("Content-Disposition")).toContain("new.bin");
  });

  it.each(['W/"sha256-current"', "Mon, 19 Oct 2026 12:00:00 GMT"])("does not accept unsupported If-Range validator %s", async validator => {
    const f = fixture();
    await f.controller.download("file", "bytes=2-", { headers: { "if-range": validator } } as never, f.reply as never);
    expect(f.reply.status).not.toHaveBeenCalledWith(206);
    expect(f.headers.get("Content-Length")).toBe(6);
  });
});
