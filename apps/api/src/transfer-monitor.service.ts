import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { Injectable } from "@nestjs/common";

export type TransferDirection = "upload" | "download";
export type TransferTaskState = "queued" | "uploading" | "verifying" | "committing" | "waiting_retry" | "downloading" | "paused" | "cancelled" | "completed" | "failed";
export type TransferTaskAction = "pause" | "resume" | "cancel";
export type TransferTaskControlState = "running" | "paused" | "cancelled";

export class TransferTaskControlError extends Error {
  constructor(readonly code: "not_paused" | "cancelled" | "client_disconnected") {
    super(code === "cancelled" ? "Transfer task was cancelled" : code === "client_disconnected" ? "Transfer client disconnected" : "Transfer task is not paused");
  }
}

export interface UploadTaskSample {
  readonly id: string;
  readonly filename: string;
  readonly expectedBytes: number;
  readonly receivedBytes: number;
  readonly status: "created" | "uploading" | "verifying" | "committing" | "failed_retryable";
  readonly controllable?: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TransferTaskSnapshot {
  readonly id: string;
  readonly direction: TransferDirection;
  readonly filename: string;
  readonly state: TransferTaskState;
  readonly transferredBytes: number;
  readonly totalBytes: number;
  readonly sizeKnown?: boolean;
  readonly percent: number;
  readonly bytesPerSecond?: number;
  readonly queuePosition?: number;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canCancel: boolean;
  readonly updatedAt: string;
}

export interface TransferSnapshot {
  readonly uploadBytesPerSecond?: number;
  readonly downloadBytesPerSecond?: number;
  readonly activeCount: number;
  readonly queuedCount: number;
  readonly tasks: readonly TransferTaskSnapshot[];
}

interface UploadRateSample {
  readonly bytes: number;
  readonly sampledAt: number;
}

interface DownloadTask {
  readonly id: string;
  readonly filename: string;
  readonly totalBytes: number;
  readonly sizeKnown: boolean;
  readonly startedAt: number;
  transferredBytes: number;
  bytesPerSecond?: number;
  lastRateBytes: number;
  lastRateAt: number;
  updatedAt: number;
  state: "downloading" | "paused" | "cancelled" | "completed" | "failed";
  source: Readable;
  meter: Transform;
  pausedChunk?: () => void;
  terminalAt?: number;
}

interface TaskControl {
  state: "paused" | "cancelled";
  updatedAt: number;
  terminalAt?: number;
  readonly waiters: Set<{ readonly resolve: () => void; readonly reject: (error: Error) => void }>;
}

const RATE_SAMPLE_INTERVAL_MS = 250;

function boundedBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function percent(transferredBytes: number, totalBytes: number): number {
  if (totalBytes === 0) return 100;
  return Math.min(100, Math.max(0, transferredBytes / totalBytes * 100));
}

@Injectable()
export class TransferMonitorService {
  readonly #downloads = new Map<string, DownloadTask>();
  readonly #uploadRates = new Map<string, UploadRateSample>();
  readonly #controls = new Map<string, TaskControl>();
  readonly #uploadBodies = new Map<string, Set<Readable>>();

  trackUploadBody(id: string, source: Readable): () => void {
    const bodies = this.#uploadBodies.get(id) ?? new Set<Readable>();
    this.#uploadBodies.set(id, bodies);
    bodies.add(source);
    // Cancellation can arrive while the file repository is acquiring its lock.
    const handleError = () => undefined;
    source.on("error", handleError);
    if (this.controlState(id) === "cancelled") source.destroy(new TransferTaskControlError("cancelled"));
    return () => {
      bodies.delete(source);
      if (bodies.size === 0) this.#uploadBodies.delete(id);
      source.off("error", handleError);
    };
  }

  assertDownloadAvailable(id?: string): void {
    this.#prune(Date.now());
    if (id === undefined) return;
    const control = this.#controls.get(id);
    if (control?.state === "cancelled") throw new TransferTaskControlError("cancelled");
    const existing = this.#downloads.get(id);
    if (control !== undefined || existing?.state === "downloading" || existing?.state === "paused") {
      throw new Error("Download operation already in progress");
    }
  }

  trackDownload(source: Readable, input: { readonly id?: string; readonly filename: string; readonly totalBytes?: number }): Readable {
    try { this.assertDownloadAvailable(input.id); }
    catch (error) { source.destroy(); throw error; }
    if (source.destroyed) throw source.errored ?? new Error("Download source closed before streaming started");
    const now = Date.now();

    const finish = (state: "completed" | "failed") => {
      if (task.state !== "downloading" && task.state !== "paused") return;
      const finishedAt = Date.now();
      this.#refreshDownloadRate(task, finishedAt, true);
      task.state = state;
      task.updatedAt = finishedAt;
      task.terminalAt = finishedAt;
    };
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        const forward = () => {
          task.transferredBytes = boundedBytes(task.transferredBytes + chunk.byteLength);
          task.updatedAt = Date.now();
          this.#refreshDownloadRate(task, task.updatedAt, false);
          callback(null, chunk);
        };
        if (task.state === "paused") task.pausedChunk = forward;
        else forward();
      },
      final: (callback) => { finish("completed"); callback(); },
    });
    const task: DownloadTask = {
      id: input.id ?? randomUUID(),
      filename: input.filename,
      totalBytes: boundedBytes(input.totalBytes ?? 0),
      sizeKnown: input.totalBytes !== undefined,
      startedAt: now,
      transferredBytes: 0,
      lastRateBytes: 0,
      lastRateAt: now,
      updatedAt: now,
      state: "downloading",
      source,
      meter,
    };
    this.#downloads.set(task.id, task);
    source.once("error", (error) => { finish("failed"); meter.destroy(error); });
    source.once("close", () => {
      if ((task.state === "downloading" || task.state === "paused") && !source.readableEnded) {
        finish("failed"); meter.destroy(new Error("Download source closed before completion"));
      }
    });
    meter.once("close", () => {
      if (task.state !== "downloading" && task.state !== "paused") return;
      finish("failed");
      if (!source.destroyed) source.destroy();
    });
    source.pipe(meter);
    return meter;
  }

  hasDownload(id: string): boolean {
    return this.#downloads.has(id);
  }

  downloadState(id: string): TransferTaskState | undefined {
    return this.#downloads.get(id)?.state;
  }

  controlState(id: string): TransferTaskControlState {
    const download = this.#downloads.get(id);
    if (download !== undefined) return download.state === "paused" ? "paused" : download.state === "cancelled" ? "cancelled" : "running";
    return this.#controls.get(id)?.state ?? "running";
  }

  control(id: string, action: TransferTaskAction): TransferTaskControlState {
    const download = this.#downloads.get(id);
    if (download !== undefined) return this.#controlDownload(download, action);
    const current = this.#controls.get(id);
    if (action === "pause") {
      if (current?.state === "cancelled") throw new TransferTaskControlError("cancelled");
      if (current?.state !== "paused") this.#controls.set(id, { state: "paused", updatedAt: Date.now(), waiters: new Set() });
      return "paused";
    }
    if (action === "resume") {
      if (current?.state === "cancelled") throw new TransferTaskControlError("cancelled");
      if (current?.state !== "paused") throw new TransferTaskControlError("not_paused");
      this.#controls.delete(id);
      for (const waiter of current.waiters) waiter.resolve();
      return "running";
    }
    if (current?.state === "cancelled") return "cancelled";
    const cancelled: TaskControl = { state: "cancelled", updatedAt: Date.now(), terminalAt: Date.now(), waiters: current?.waiters ?? new Set() };
    this.#controls.set(id, cancelled);
    for (const body of this.#uploadBodies.get(id) ?? []) body.destroy(new TransferTaskControlError("cancelled"));
    for (const waiter of cancelled.waiters) waiter.reject(new TransferTaskControlError("cancelled"));
    cancelled.waiters.clear();
    return "cancelled";
  }

  clearControl(id: string): void {
    const current = this.#controls.get(id);
    if (current === undefined) return;
    this.#controls.delete(id);
    for (const waiter of current.waiters) waiter.resolve();
  }

  async awaitRunnable(id: string, signal?: AbortSignal): Promise<void> {
    const current = this.#controls.get(id);
    if (current?.state === "cancelled") throw new TransferTaskControlError("cancelled");
    if (current?.state !== "paused") return;
    if (signal?.aborted === true) throw new TransferTaskControlError("client_disconnected");
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        current.waiters.delete(waiter);
        reject(new TransferTaskControlError("client_disconnected"));
      };
      const waiter = {
        resolve: () => { signal?.removeEventListener("abort", aborted); resolve(); },
        reject: (error: Error) => { signal?.removeEventListener("abort", aborted); reject(error); },
      };
      current.waiters.add(waiter);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  snapshot(uploadRows: readonly UploadTaskSample[], sampledAt = Date.now()): TransferSnapshot {
    this.#prune(sampledAt);
    const uploadIds = new Set(uploadRows.map((row) => row.id));
    for (const id of this.#uploadRates.keys()) if (!uploadIds.has(id)) this.#uploadRates.delete(id);

    let queuePosition = 0;
    const uploadTasks = uploadRows.map((row): TransferTaskSnapshot => {
      const transferredBytes = boundedBytes(row.receivedBytes);
      const totalBytes = boundedBytes(row.expectedBytes);
      const previous = this.#uploadRates.get(row.id);
      let bytesPerSecond: number | undefined;
      if (previous !== undefined && sampledAt > previous.sampledAt && transferredBytes >= previous.bytes) {
        bytesPerSecond = (transferredBytes - previous.bytes) / ((sampledAt - previous.sampledAt) / 1_000);
      }
      this.#uploadRates.set(row.id, { bytes: transferredBytes, sampledAt });
      const control = this.#controls.get(row.id);
      const queued = control === undefined && (row.status === "created" || row.status === "failed_retryable");
      if (queued) queuePosition += 1;
      const state: TransferTaskState = control?.state === "paused"
        ? "paused"
        : control?.state === "cancelled"
          ? "cancelled"
          : row.status === "created"
            ? "queued"
            : row.status === "failed_retryable"
              ? "waiting_retry"
              : row.status;
      const mutable = row.controllable !== false && ["created", "uploading", "failed_retryable"].includes(row.status);
      return {
        id: row.id,
        direction: "upload",
        filename: row.filename,
        state,
        transferredBytes,
        totalBytes,
        percent: percent(transferredBytes, totalBytes),
        ...(control?.state === "paused" ? { bytesPerSecond: 0 } : bytesPerSecond === undefined ? {} : { bytesPerSecond }),
        ...(queued ? { queuePosition } : {}),
        canPause: mutable && control === undefined,
        canResume: mutable && control?.state === "paused",
        canCancel: mutable && control?.state !== "cancelled",
        updatedAt: new Date(Math.max(row.updatedAt.getTime(), control?.updatedAt ?? 0)).toISOString(),
      };
    });

    const downloadTasks = [...this.#downloads.values()].map((task): TransferTaskSnapshot => {
      if (task.state === "downloading") this.#refreshDownloadRate(task, sampledAt, false);
      return {
        id: task.id,
        direction: "download",
        filename: task.filename,
        state: task.state,
        transferredBytes: task.transferredBytes,
        totalBytes: task.totalBytes,
        sizeKnown: task.sizeKnown,
        percent: task.sizeKnown ? percent(task.transferredBytes, task.totalBytes) : 0,
        ...(task.bytesPerSecond === undefined ? {} : { bytesPerSecond: task.bytesPerSecond }),
        canPause: task.state === "downloading",
        canResume: task.state === "paused",
        canCancel: task.state === "downloading" || task.state === "paused",
        updatedAt: new Date(task.updatedAt).toISOString(),
      };
    });
    const allTasks = [...downloadTasks, ...uploadTasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const tasks = allTasks.slice(0, 32);
    const activeStates = new Set<TransferTaskState>(["uploading", "verifying", "committing", "downloading"]);
    const queuedStates = new Set<TransferTaskState>(["queued", "waiting_retry"]);
    const uploadRates = allTasks.filter((task) => task.direction === "upload" && activeStates.has(task.state)).map((task) => task.bytesPerSecond).filter((value): value is number => value !== undefined);
    const downloadRates = allTasks.filter((task) => task.direction === "download" && task.state === "downloading").map((task) => task.bytesPerSecond).filter((value): value is number => value !== undefined);
    const activeUploadCount = allTasks.filter((task) => task.direction === "upload" && activeStates.has(task.state)).length;
    const activeDownloadCount = allTasks.filter((task) => task.direction === "download" && task.state === "downloading").length;
    const activeCount = activeUploadCount + activeDownloadCount;
    const queuedCount = allTasks.filter((task) => queuedStates.has(task.state)).length;
    return {
      ...(activeUploadCount === 0 || uploadRates.length > 0 ? { uploadBytesPerSecond: uploadRates.reduce((sum, value) => sum + value, 0) } : {}),
      ...(activeDownloadCount === 0 || downloadRates.length > 0 ? { downloadBytesPerSecond: downloadRates.reduce((sum, value) => sum + value, 0) } : {}),
      activeCount,
      queuedCount,
      tasks,
    };
  }

  #refreshDownloadRate(task: DownloadTask, now: number, force: boolean): void {
    const elapsed = now - task.lastRateAt;
    if (elapsed <= 0 || (!force && elapsed < RATE_SAMPLE_INTERVAL_MS)) return;
    task.bytesPerSecond = Math.max(0, (task.transferredBytes - task.lastRateBytes) / (elapsed / 1_000));
    task.lastRateBytes = task.transferredBytes;
    task.lastRateAt = now;
  }

  #controlDownload(task: DownloadTask, action: TransferTaskAction): TransferTaskControlState {
    if (action === "pause") {
      if (task.state === "cancelled") throw new TransferTaskControlError("cancelled");
      if (task.state === "downloading") {
        task.source.pause();
        task.state = "paused";
        task.bytesPerSecond = 0;
        task.updatedAt = Date.now();
      }
      return task.state === "paused" ? "paused" : "running";
    }
    if (action === "resume") {
      if (task.state === "cancelled") throw new TransferTaskControlError("cancelled");
      if (task.state !== "paused") throw new TransferTaskControlError("not_paused");
      task.state = "downloading";
      task.updatedAt = Date.now();
      task.lastRateAt = task.updatedAt;
      task.lastRateBytes = task.transferredBytes;
      const pending = task.pausedChunk;
      delete task.pausedChunk;
      pending?.();
      task.source.resume();
      return "running";
    }
    if (task.state === "cancelled") return "cancelled";
    if (task.state !== "downloading" && task.state !== "paused") return "running";
    task.state = "cancelled";
    task.updatedAt = Date.now();
    task.terminalAt = task.updatedAt;
    // A browser can automatically retry a truncated download using the same URL.
    // Retain its operation ID after the visible task is removed.
    this.#controls.set(task.id, { state: "cancelled", updatedAt: task.updatedAt, terminalAt: task.updatedAt, waiters: new Set() });
    task.source.unpipe(task.meter);
    task.source.destroy();
    delete task.pausedChunk;
    task.meter.destroy(new TransferTaskControlError("cancelled"));
    return "cancelled";
  }

  #prune(now: number): void {
    for (const [id, task] of this.#downloads) {
      if (task.terminalAt !== undefined && now >= task.terminalAt) this.#downloads.delete(id);
    }
    for (const [id, control] of this.#controls) {
      // Keep a cancellation barrier while in-flight requests unwind and abandonment obtains its lock.
      if (control.terminalAt !== undefined && now >= control.terminalAt + 60_000) this.#controls.delete(id);
    }
  }
}
