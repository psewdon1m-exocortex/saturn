import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TransferMonitorService } from "./transfer-monitor.service.js";

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe("TransferMonitorService", () => {
  it("measures the real download stream and briefly exposes its terminal state", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));
      const monitor = new TransferMonitorService();
      const stream = monitor.trackDownload(Readable.from([Buffer.from("saturn")]), { filename: "archive.bin", totalBytes: 6 });
      expect((await collect(stream)).toString()).toBe("saturn");
      const snapshot = monitor.snapshot([], Date.now());
      expect(snapshot.tasks[0]).toMatchObject({ direction: "download", filename: "archive.bin", state: "completed", transferredBytes: 6, totalBytes: 6, percent: 100 });
      vi.advanceTimersByTime(10_001);
      expect(monitor.snapshot([], Date.now()).tasks).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it("classifies persisted uploads and calculates byte-delta throughput", () => {
    const monitor = new TransferMonitorService();
    const createdAt = new Date("2026-09-02T10:00:00.000Z");
    const rows = [
      { id: "active", filename: "active.bin", expectedBytes: 1_000, receivedBytes: 100, status: "uploading" as const, createdAt, updatedAt: createdAt },
      { id: "queued", filename: "queued.bin", expectedBytes: 500, receivedBytes: 0, status: "created" as const, createdAt, updatedAt: createdAt },
      { id: "retry", filename: "retry.bin", expectedBytes: 500, receivedBytes: 20, status: "failed_retryable" as const, createdAt, updatedAt: createdAt },
    ];
    const first = monitor.snapshot(rows, 1_000);
    expect(first).toMatchObject({ activeCount: 1, queuedCount: 2 });
    expect(first.uploadBytesPerSecond).toBeUndefined();
    const [active, queued, retry] = rows;
    if (active === undefined || queued === undefined || retry === undefined) throw new Error("Upload fixtures are incomplete");
    const second = monitor.snapshot([{ ...active, receivedBytes: 300, updatedAt: new Date("2026-09-02T10:00:01.000Z") }, queued, retry], 2_000);
    expect(second.uploadBytesPerSecond).toBe(200);
    expect(second.tasks.find((task) => task.id === "queued")).toMatchObject({ state: "queued", queuePosition: 1 });
    expect(second.tasks.find((task) => task.id === "retry")).toMatchObject({ state: "waiting_retry", queuePosition: 2 });
  });
});
