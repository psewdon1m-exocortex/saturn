import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { DropBufferStore } from "./buffer-store.js";
import { DropDrainService } from "./drop-drain.service.js";
import type { DropFileGateway, DropRepository, DropUpload } from "./types.js";

function fixture(count: number, beforeCommit: () => Promise<void> = async () => undefined) {
  const queue = Array.from({ length: count }, (_, index) => ({
    id: `upload-${String(index)}`, channelId: "channel", sessionId: "session", clientKeyHash: `key-${String(index)}`,
    filename: `file-${String(index)}`, expectedSize: 1, receivedSize: 1, state: "buffered",
    localPath: `buffer-${String(index)}`, createdAt: new Date(),
  } satisfies DropUpload));
  const stored = new Set<string>();
  let active = 0, peak = 0;
  const repository = {
    claimBufferedUpload: async () => queue.shift(),
    getDropUpload: async (_channel: string, id: string) => ({ id, channelId: "channel", filename: id, expectedSize: 1, localPath: id, state: "transferring" }),
    withUploadLock: async (_id: string, action: () => Promise<void>) => {
      active += 1; peak = Math.max(active, peak);
      try { return await action(); } finally { active -= 1; }
    },
    markUploadVerifying: async () => undefined,
    markUploadStored: async (id: string) => { stored.add(id); },
  } as unknown as DropRepository;
  const files = {
    createUpload: async ({ filename }: { filename: string }) => ({ id: filename }),
    getUpload: async () => ({ receivedSize: 0 }),
    appendUpload: async (_id: string, _offset: number, _length: number, source: Readable) => { for await (const _chunk of source) {void _chunk; /* Consume the actual stream. */ } },
    completeUpload: async (id: string) => { await beforeCommit(); return { resource: { id } }; },
  } as unknown as DropFileGateway;
  const buffer = { openRead: () => Readable.from([Buffer.from("x")]), delete: async () => undefined } as unknown as DropBufferStore;
  const drain = new DropDrainService({ repository, files, buffer, workers: 4, chunkBytes: 8 });
  return { drain, queue, stored, repository, active: () => active, peak: () => peak };
}

describe("Drop drain bounded throughput", () => {
  it("drains a short ready backlog without one scheduler interval per worker wave", async () => {
    const f = fixture(40);
    expect(await f.drain.drain()).toBe(40);
    expect(f.stored.size).toBe(40);
    expect(f.queue).toHaveLength(0);
    expect(f.peak()).toBeLessThanOrEqual(4);
  });

  it("shares physical slots across overlapping drain calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(40, () => gate);
    const first = f.drain.drain(), second = f.drain.drain();
    await new Promise(resolve => setTimeout(resolve, 20));
    const peakBeforeRelease = f.peak();
    release();
    await Promise.all([first, second]);
    expect(peakBeforeRelease).toBe(4);
    expect(f.stored.size).toBe(40);
    expect(f.active()).toBe(0);
  });

  it("yields a long backlog to other scheduled work instead of draining indefinitely", async () => {
    const f = fixture(10_000);
    const attempted = await f.drain.drain();
    expect(attempted).toBeGreaterThan(4);
    expect(attempted).toBeLessThanOrEqual(256);
    expect(f.stored.size).toBe(attempted);
    expect(f.queue.length).toBe(10_000 - attempted);
    expect(f.active()).toBe(0);
  });
});
