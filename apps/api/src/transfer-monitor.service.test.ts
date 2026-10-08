import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TransferMonitorService } from "./transfer-monitor.service.js";

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

describe("TransferMonitorService", () => {
  it("rejects an already closed source without registering a hanging task", () => {
    const monitor = new TransferMonitorService(), source = new PassThrough(); source.destroy();
    expect(() => monitor.trackDownload(source, { filename: "valuable.bin", totalBytes: 6 })).toThrow("closed before streaming started");
    expect(monitor.snapshot([]).tasks).toHaveLength(0);
  });
  it("rejects retries of a cancelled download after its visible task is removed", () => {
    const monitor = new TransferMonitorService(), source = new PassThrough();
    const output = monitor.trackDownload(source, { id: "download-operation", filename: "valuable.bin", totalBytes: 100 });
    output.on("error", () => undefined);
    monitor.control("download-operation", "cancel");
    expect(monitor.snapshot([]).tasks).toHaveLength(0);
    expect(() => monitor.assertDownloadAvailable("download-operation")).toThrow("cancelled");
    const retry = new PassThrough();
    expect(() => monitor.trackDownload(retry, { id: "download-operation", filename: "valuable.bin", totalBytes: 50 })).toThrow("cancelled");
    expect(retry.destroyed).toBe(true);
    expect(() => monitor.assertDownloadAvailable("new-operation")).not.toThrow();
  });
  it("releases a duplicate download source instead of replacing an active operation", async () => {
    const monitor = new TransferMonitorService(), source = new PassThrough();
    const output = monitor.trackDownload(source, { id: "one-operation", filename: "valuable.bin", totalBytes: 6 });
    const duplicate = new PassThrough();
    expect(() => monitor.trackDownload(duplicate, { id: "one-operation", filename: "valuable.bin", totalBytes: 6 })).toThrow("already in progress");
    expect(duplicate.destroyed).toBe(true);
    source.end("saturn");
    expect((await collect(output)).toString()).toBe("saturn");
  });
  it("holds a download paused when pipe backpressure attempts to resume its source", async () => {
    const monitor = new TransferMonitorService(), source = new PassThrough();
    const chunk = Buffer.alloc(128 * 1024, 7), output = monitor.trackDownload(source, { filename: "slow.bin", totalBytes: chunk.length * 3 });
    source.write(chunk); source.write(chunk);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = monitor.snapshot([]).tasks[0];
    if (before === undefined) throw new Error("Task missing");
    monitor.control(before.id, "pause");
    const received: Buffer[] = [];
    const ended = new Promise<void>((resolve, reject) => { output.on("data", (value: Buffer) => received.push(value)); output.once("end", resolve); output.once("error", reject); });
    source.end(chunk);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(monitor.snapshot([]).tasks[0]).toMatchObject({ state: "paused", transferredBytes: before.transferredBytes, bytesPerSecond: 0 });
    monitor.control(before.id, "resume");
    await ended;
    expect(Buffer.concat(received)).toEqual(Buffer.concat([chunk, chunk, chunk]));
  });

  it("marks streaming archive size as unknown instead of inventing a percentage", async () => {
    const monitor = new TransferMonitorService(), source = new PassThrough(), output = monitor.trackDownload(source, { filename: "folder.zip" });
    expect(monitor.snapshot([]).tasks[0]).toMatchObject({ sizeKnown: false, percent: 0 });
    source.end("archive bytes");
    expect((await collect(output)).toString()).toBe("archive bytes");
  });
  it("counts every queued transfer while returning only 32 visible rows", () => {
    const monitor = new TransferMonitorService(), now = new Date();
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: `queued-${String(index)}`, filename: "queued.bin", expectedBytes: 100, receivedBytes: 0, status: "created" as const, createdAt: now, updatedAt: now }));
    expect(monitor.snapshot(rows)).toMatchObject({ queuedCount: 40, activeCount: 0 });
    expect(monitor.snapshot(rows).tasks).toHaveLength(32);
  });
  it("interrupts the active request body and keeps cancellation across dashboard polls", async () => {
    const monitor = new TransferMonitorService(), source = new PassThrough();
    const release = monitor.trackUploadBody("active", source);
    const closed = new Promise<void>((resolve) => source.once("close", resolve));
    expect(monitor.control("active", "cancel")).toBe("cancelled");
    await closed;
    expect(source.destroyed).toBe(true);
    const now = new Date();
    monitor.snapshot([{ id: "active", filename: "cancel.bin", expectedBytes: 100, receivedBytes: 0, status: "uploading", createdAt: now, updatedAt: now }]);
    await expect(monitor.awaitRunnable("active")).rejects.toMatchObject({ code: "cancelled" });
    release();
  });
  it("measures the real download stream and removes its terminal task immediately", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-02T10:00:00.000Z"));
      const monitor = new TransferMonitorService();
      const stream = monitor.trackDownload(Readable.from([Buffer.from("saturn")]), { filename: "archive.bin", totalBytes: 6 });
      expect((await collect(stream)).toString()).toBe("saturn");
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

  it("keeps externally managed Drop pipeline rows read-only", () => {
    const monitor = new TransferMonitorService();
    const now = new Date("2026-09-19T12:00:00.000Z");
    const snapshot = monitor.snapshot([{
      id: "drop:upload",
      filename: "large-video.mp4",
      expectedBytes: 400,
      receivedBytes: 400,
      status: "verifying",
      controllable: false,
      createdAt: now,
      updatedAt: now,
    }], now.getTime());

    expect(snapshot.tasks[0]).toMatchObject({ state: "verifying", canPause: false, canResume: false, canCancel: false });
  });

  it("pauses, resumes and cancels a persisted upload at request boundaries", async () => {
    const monitor = new TransferMonitorService();
    const now = new Date("2026-09-04T10:00:00.000Z");
    const row = { id: "active", filename: "active.bin", expectedBytes: 1_000, receivedBytes: 250, status: "uploading" as const, createdAt: now, updatedAt: now };

    expect(monitor.control("active", "pause")).toBe("paused");
    expect(monitor.snapshot([row], now.getTime()).tasks[0]).toMatchObject({ state: "paused", canPause: false, canResume: true, canCancel: true, bytesPerSecond: 0 });

    let released = false;
    const waiting = monitor.awaitRunnable("active").then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(monitor.control("active", "resume")).toBe("running");
    await waiting;
    expect(released).toBe(true);

    monitor.control("active", "pause");
    const cancelled = expect(monitor.awaitRunnable("active")).rejects.toMatchObject({ code: "cancelled" });
    expect(monitor.control("active", "cancel")).toBe("cancelled");
    await cancelled;
    expect(monitor.snapshot([row], now.getTime()).tasks[0]).toMatchObject({ state: "cancelled", canPause: false, canResume: false, canCancel: false });
  });

  it("detaches an aborted paused request without reviving it on resume", async () => {
    const monitor = new TransferMonitorService();
    const abort = new AbortController();
    monitor.control("active", "pause");
    const waiting = expect(monitor.awaitRunnable("active", abort.signal)).rejects.toMatchObject({ code: "client_disconnected" });

    abort.abort();
    await waiting;
    expect(monitor.control("active", "resume")).toBe("running");
  });

  it("pauses, resumes and cancels the actual download stream", () => {
    const monitor = new TransferMonitorService();
    const source = new PassThrough();
    const output = monitor.trackDownload(source, { filename: "archive.bin", totalBytes: 100 });
    output.on("error", () => undefined);
    output.resume();
    const id = monitor.snapshot([]).tasks[0]?.id;
    if (id === undefined) throw new Error("Download task was not registered");

    expect(monitor.control(id, "pause")).toBe("paused");
    expect(source.isPaused()).toBe(true);
    expect(monitor.snapshot([]).tasks[0]).toMatchObject({ state: "paused", canPause: false, canResume: true, canCancel: true });
    expect(monitor.control(id, "resume")).toBe("running");
    expect(monitor.snapshot([]).tasks[0]).toMatchObject({ state: "downloading", canPause: true, canResume: false, canCancel: true });
    expect(monitor.control(id, "cancel")).toBe("cancelled");
    expect(source.destroyed).toBe(true);
    expect(monitor.snapshot([]).tasks).toHaveLength(0);
  });
});
