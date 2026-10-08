import fs from "node:fs/promises";
import { Readable } from "node:stream";
import type { Resource } from "@saturn/file-core";
import { describe, expect, it, vi } from "vitest";
import type { ShareService } from "./share.service.js";
import { ShareThumbnailService } from "./thumbnail.service.js";
import type { ShareStorageGateway } from "./types.js";

function fixture(name = "photo.jpg", mimeType = "image/jpeg") {
  const now = new Date("2026-10-05T00:00:00.000Z");
  const resource: Resource = { id: "file", parentId: "root", type: "file", name, storagePath: "drive/photo.jpg", mimeType, sizeBytes: 8, sha256: "a".repeat(64), status: "active", createdAt: now, updatedAt: now };
  const opened = vi.fn(() => Promise.resolve(Readable.from(Buffer.from("original"))));
  const thumbnailSource = vi.fn(() => Promise.resolve({ resource, open: opened }));
  const shares = { thumbnailSource } as unknown as ShareService;
  const values = new Map<string, Buffer>();
  const directories = new Set(["_system"]);
  const storage = {
    exists: (storagePath: string) => Promise.resolve(values.has(storagePath) || directories.has(storagePath)),
    stat: (storagePath: string) => Promise.resolve({ size: values.get(storagePath)?.length ?? 0 }),
    openRead: (storagePath: string) => Promise.resolve(Readable.from(values.get(storagePath) ?? Buffer.alloc(0))),
    mkdir: (storagePath: string) => { directories.add(storagePath); return Promise.resolve(); },
    write: async (storagePath: string, source: Readable) => { const value = Buffer.concat(await source.toArray()); values.set(storagePath, value); return value.length; },
  } as unknown as ShareStorageGateway;
  const renderer = vi.fn(async (_kind: string, inputPath: string) => {
    expect(await fs.readFile(inputPath, "utf8")).toBe("original");
    return Buffer.from("webp-thumbnail");
  });
  return { service: new ShareThumbnailService({ shares, storage, renderer }), thumbnailSource, opened, renderer };
}

describe("ShareThumbnailService", () => {
  it("authorizes every request while generating and storing the derivative only once", async () => {
    const { service, thumbnailSource, opened, renderer } = fixture();
    const first = await service.open("token", "file", { sourceIp: "192.0.2.1", userAgent: "browser" });
    expect(Buffer.concat(await first.stream.toArray()).toString()).toBe("webp-thumbnail");
    const second = await service.open("token", "file", { sourceIp: "192.0.2.1", userAgent: "browser" });
    expect(Buffer.concat(await second.stream.toArray()).toString()).toBe("webp-thumbnail");
    expect(thumbnailSource).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(first.etag).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unsupported content without opening original bytes", async () => {
    const { service, opened } = fixture("notes.txt", "text/plain");
    await expect(service.open("token", "file", { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toMatchObject({ code: "unsupported" });
    expect(opened).not.toHaveBeenCalled();
  });
});
