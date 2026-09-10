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
  readonly startedAt: number;
  transferredBytes: number;
  bytesPerSecond?: number;
  lastRateBytes: number;
  lastRateAt: number;
  updatedAt: number;
  state: "downloading" | "paused" | "cancelled" | "completed" | "failed";
  source: Readable;
  meter: Transform;
  terminalAt?: number;
}

interface TaskControl {
  state: "paused" | "cancelled";
  updatedAt: number;
  terminalAt?: number;
  readonly waiters: Set<{ readonly resolve: () => void; readonly reject: (error: Error) => void }>;
}

const TERMINAL_RETENTION_MS = 10_000;
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

  trackDownload(source: Readable, input: { readonly filename: string; readonly totalBytes: number }): Readable {
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
        task.transferredBytes = boundedBytes(task.transferredBytes + chunk.byteLength);
        task.updatedAt = Date.now();
        this.#refreshDownloadRate(task, task.updatedAt, false);
        callback(null, chunk);
      },
      final: (callback) => { finish("completed"); callback(); },
    });
    const task: DownloadTask = {
      id: randomUUID(),
      filename: input.filename,
      totalBytes: boundedBytes(input.totalBytes),
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
      const mutable = ["created", "uploading", "failed_retryable"].includes(row.status);
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
        percent: percent(task.transferredBytes, task.totalBytes),
        ...(task.bytesPerSecond === undefined ? {} : { bytesPerSecond: task.bytesPerSecond }),
        canPause: task.state === "downloading",
        canResume: task.state === "paused",
        canCancel: task.state === "downloading" || task.state === "paused",
        updatedAt: new Date(task.updatedAt).toISOString(),
      };
    });
    const tasks = [...downloadTasks, ...uploadTasks]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 32);
    const activeStates = new Set<TransferTaskState>(["uploading", "verifying", "committing", "downloading"]);
    const queuedStates = new Set<TransferTaskState>(["queued", "waiting_retry"]);
    const uploadRates = tasks.filter((task) => task.direction === "upload" && activeStates.has(task.state)).map((task) => task.bytesPerSecond).filter((value): value is number => value !== undefined);
    const downloadRates = tasks.filter((task) => task.direction === "download" && task.state === "downloading").map((task) => task.bytesPerSecond).filter((value): value is number => value !== undefined);
    const activeUploadCount = tasks.filter((task) => task.direction === "upload" && activeStates.has(task.state)).length;
    const activeDownloadCount = tasks.filter((task) => task.direction === "download" && task.state === "downloading").length;
    const activeCount = activeUploadCount + activeDownloadCount;
    const queuedCount = tasks.filter((task) => queuedStates.has(task.state)).length;
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
      task.source.resume();
      return "running";
    }
    if (task.state === "cancelled") return "cancelled";
    if (task.state !== "downloading" && task.state !== "paused") return "running";
    task.state = "cancelled";
    task.updatedAt = Date.now();
    task.terminalAt = task.updatedAt;
    task.source.unpipe(task.meter);
    task.source.destroy();
    task.meter.destroy();
    return "cancelled";
  }

  #prune(now: number): void {
    for (const [id, task] of this.#downloads) {
      if (task.terminalAt !== undefined && now - task.terminalAt > TERMINAL_RETENTION_MS) this.#downloads.delete(id);
    }
    for (const [id, control] of this.#controls) {
      if (control.terminalAt !== undefined && now - control.terminalAt > TERMINAL_RETENTION_MS) this.#controls.delete(id);
    }
  }
}
