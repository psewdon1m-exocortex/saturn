import { fixtureValue } from './test-values.fixture.js';
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { PublicShareController } from "./share.controller.js";

function fixture() {
  const resource = { id: "file", type: "file", status: "active", name: "current.bin", sizeBytes: 6, sha256: "b".repeat(64) };
  const share = { mode: "download", locked: false, resourceSize: 6, resourceName: "Folder" };
  const prepared = { id: "package-b", state: "ready", sizeBytes: 6, sha256: resource.sha256 };
  const open = async (_token: string, selected: { offset: number; length?: number } | ((value: typeof resource) => { offset: number; length?: number })) => {
    const range = typeof selected === "function" ? selected(resource) : selected;
    return { resource, share, package: prepared, stream: Readable.from([Buffer.from("abcdef").subarray(range.offset, range.length === undefined ? undefined : range.offset + range.length)]) };
  };
  const shares = { metadata: vi.fn(async () => ({ share })), contentMetadata: vi.fn(async () => ({ share, resource })),
    childMetadata: vi.fn(async () => ({ share: { ...share, mode: "download_folder" }, resource })),
    packageMetadata: vi.fn(async () => ({ share, package: prepared })), openContent: vi.fn(open), openPackage: vi.fn(open),
    openChildContent: vi.fn(async (token: string, _id: string, selected: Parameters<typeof open>[1]) => open(token, selected)) };
  const headers = new Map<string, unknown>();
  const reply = { header: vi.fn((name: string, value: unknown) => { headers.set(name, value); return reply; }), status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
  const controller = new PublicShareController({ environment: "test" } as never, shares as never, {} as never, { trackDownload: (stream: Readable) => stream } as never);
  const request = { ip: "192.0.2.1", headers: { "user-agent": "browser", "if-range": '"sha256-old"' } };
  return { controller, reply, headers, request, shares, resource };
}

describe("public download representation validators", () => {
  it.each(["content", "childContent", "packageContent"] as const)("%s clamps an oversized last byte for a satisfiable range", async method => {
    const f = fixture();
    const request = { ...f.request, headers: { "user-agent": "browser" } };
    if (method === "childContent") await f.controller.childContent("token", "file", "bytes=2-999", request as never, f.reply as never);
    else await f.controller[method]("token", "bytes=2-999", request as never, f.reply as never);
    expect(f.reply.status).toHaveBeenCalledWith(206);
    expect(f.headers.get("Content-Length")).toBe(4);
    expect(f.headers.get("Content-Range")).toBe("bytes 2-5/6");
  });

  it.each(["content", "childContent", "packageContent"] as const)("%s safely restarts on If-Range mismatch", async method => {
    const f = fixture();
    if (method === "childContent") await f.controller.childContent("token", "file", "bytes=2-", f.request as never, f.reply as never);
    else await f.controller[method]("token", "bytes=2-", f.request as never, f.reply as never);
    expect(f.reply.status).not.toHaveBeenCalledWith(206);
    expect(f.headers.get("Content-Length")).toBe(6);
    expect(f.headers.get("ETag")).toBe(`"sha256-${f.resource.sha256}"`);
    const chunks = []; for await (const chunk of fixtureValue(f.reply.send.mock.calls[0])[0] as Readable) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("abcdef");
  });

  it.each(["contentHead", "childContentHead", "packageHead"] as const)("%s advertises a validator without opening bytes", async method => {
    const f = fixture();
    if (method === "childContentHead") await f.controller.childContentHead("token", "file", undefined, f.request as never, f.reply as never);
    else await f.controller[method]("token", undefined, f.request as never, f.reply as never);
    expect(f.headers.get("ETag")).toBe(`"sha256-${f.resource.sha256}"`);
    expect(f.shares.openContent).not.toHaveBeenCalled(); expect(f.shares.openChildContent).not.toHaveBeenCalled(); expect(f.shares.openPackage).not.toHaveBeenCalled();
  });
});
