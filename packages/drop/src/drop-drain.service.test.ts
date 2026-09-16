import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DropBufferStore } from "./buffer-store.js";
import { DropDrainService } from "./drop-drain.service.js";
import type { DropFileGateway, DropRepository, DropUpload } from "./types.js";

describe("DropDrainService", () => {
  it("keeps the original filename so file-core can apply the override policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-drop-drain-"));
    const payload = Buffer.alloc(700 * 1024, 0x5a);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const item: DropUpload = {
      id: "019cbb75-6352-7000-8000-000000000001",
      sessionId: "019cbb75-6352-7000-8000-000000000002",
      channelId: "019cbb75-6352-7000-8000-000000000003",
      clientKeyHash: "client-key",
      filename: "same-name.txt",
      expectedSize: payload.length,
      receivedSize: payload.length,
      actualSha256: sha256,
      state: "transferring",
      localPath: "019cbb75-6352-7000-8000-000000000001.part",
      createdAt: new Date(),
    };
    const buffer = new DropBufferStore({
      root,
      maxBytes: 1024 * 1024,
      minFreeBytes: 0,
      warningRatio: 0.7,
      criticalRatio: 0.85,
      refusalRatio: 0.95,
    });
    let claimed = false;
    let stored = false;
    let failed = false;
    let createdFilename: string | undefined;
    let received = Buffer.alloc(0);
    let appendCalls = 0;
    const repository = {
      claimBufferedUpload: async () => {
        if (claimed) return undefined;
        claimed = true;
        return item;
      },
      markUploadVerifying: async () => item,
      markUploadStored: async () => { stored = true; return { ...item, state: "stored" as const }; },
      markUploadFailed: async () => { failed = true; return { ...item, state: "failed" as const }; },
    } as unknown as DropRepository;
    const files = {
      createUpload: async (input: { readonly filename: string }) => { createdFilename = input.filename; return { id: "core-upload" }; },
      getUpload: async () => ({ receivedSize: 0, expectedSize: payload.length, expiresAt: new Date(Date.now() + 60_000), status: "created" }),
      appendUpload: async (_id: string, _offset: number, _length: number, source: Readable) => {
        appendCalls += 1;
        const chunks: Buffer[] = [];
        for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array));
        received = Buffer.concat([received, ...chunks]);
        return { receivedSize: received.length };
      },
      completeUpload: async () => ({
        resource: { id: "existing-resource", name: "same-name.txt", sizeBytes: payload.length, sha256 },
        upload: { receivedSize: payload.length, expectedSize: payload.length, expiresAt: new Date(Date.now() + 60_000), status: "active" },
      }),
    } as unknown as DropFileGateway;
    try {
      await buffer.create(item.localPath ?? "");
      await buffer.append(item.localPath ?? "", 0, payload.length, Readable.from(payload));
      const drain = new DropDrainService({ repository, buffer, files, workers: 1, chunkBytes: 256 * 1024 });

      expect(await drain.drain()).toBe(1);
      expect(createdFilename).toBe("same-name.txt");
      expect(received).toEqual(payload);
      expect(appendCalls).toBe(3);
      expect(stored).toBe(true);
      expect(failed).toBe(false);
      await expect(fs.stat(path.join(root, item.localPath ?? ""))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("drains a file larger than 400 MiB in bounded upload chunks", async () => {
    const expectedSize = 401 * 1024 * 1024;
    const chunkBytes = 8 * 1024 * 1024;
    const item = {
      id: "019cbb75-6352-7000-8000-000000000011",
      sessionId: "019cbb75-6352-7000-8000-000000000012",
      channelId: "019cbb75-6352-7000-8000-000000000013",
      clientKeyHash: "client-key",
      filename: "large-drop.bin",
      expectedSize,
      receivedSize: expectedSize,
      state: "transferring" as const,
      localPath: "019cbb75-6352-7000-8000-000000000011.part",
      createdAt: new Date(),
    } satisfies DropUpload;
    let claimed = false;
    let appendedBytes = 0;
    let appendCalls = 0;
    let stored = false;
    const repository = {
      claimBufferedUpload: async () => { if (claimed) return undefined; claimed = true; return item; },
      markUploadVerifying: async () => item,
      markUploadStored: async () => { stored = true; return { ...item, state: "stored" as const }; },
      markUploadFailed: async () => ({ ...item, state: "failed" as const }),
    } as unknown as DropRepository;
    const buffer = {
      openRead: (_path: string, requestedChunkBytes?: number) => {
        expect(requestedChunkBytes).toBe(chunkBytes);
        return Readable.from((async function* () {
          const full = Buffer.alloc(chunkBytes);
          for (let offset = 0; offset + chunkBytes <= expectedSize; offset += chunkBytes) yield full;
          const remainder = expectedSize % chunkBytes;
          if (remainder > 0) yield Buffer.alloc(remainder);
        })());
      },
      delete: async () => undefined,
    } as unknown as DropBufferStore;
    const files = {
      createUpload: async () => ({ id: "large-core-upload" }),
      getUpload: async () => ({ receivedSize: 0, expectedSize, expiresAt: new Date(Date.now() + 60_000), status: "created" }),
      appendUpload: async (_id: string, offset: number, length: number, source: Readable) => {
        expect(offset).toBe(appendedBytes);
        let actual = 0;
        for await (const chunk of source) actual += Buffer.byteLength(chunk as Uint8Array);
        expect(actual).toBe(length);
        appendedBytes += actual;
        appendCalls += 1;
        return { receivedSize: appendedBytes };
      },
      completeUpload: async () => ({
        resource: { id: "large-resource", name: item.filename, sizeBytes: expectedSize },
        upload: { receivedSize: expectedSize, expectedSize, expiresAt: new Date(Date.now() + 60_000), status: "active" },
      }),
    } as unknown as DropFileGateway;

    const drain = new DropDrainService({ repository, buffer, files, workers: 1, chunkBytes });
    expect(await drain.drain()).toBe(1);
    expect(appendedBytes).toBe(expectedSize);
    expect(appendCalls).toBe(51);
    expect(stored).toBe(true);
  });
});
