import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { Injectable } from "@nestjs/common";

export type TransferDirection = "upload" | "download";
export type TransferTaskState = "queued" | "uploading" | "verifying" | "committing" | "waiting_retry" | "downloading" | "completed" | "failed";

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
  state: "downloading" | "completed" | "failed";
  terminalAt?: number;
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

  trackDownload(source: Readable, input: { readonly filename: string; readonly totalBytes: number }): Readable {
    const now = Date.now();
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
    };
    this.#downloads.set(task.id, task);

    const finish = (state: "completed" | "failed") => {
      if (task.state !== "downloading") return;
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
    source.once("error", (error) => { finish("failed"); meter.destroy(error); });
    meter.once("close", () => {
      if (task.state !== "downloading") return;
      finish("failed");
      if (!source.destroyed) source.destroy();
    });
    source.pipe(meter);
    return meter;
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
      const queued = row.status === "created" || row.status === "failed_retryable";
      if (queued) queuePosition += 1;
      const state: TransferTaskState = row.status === "created"
        ? "queued"
        : row.status === "failed_retryable"
          ? "waiting_retry"
          : row.status;
      return {
        id: row.id,
        direction: "upload",
        filename: row.filename,
        state,
        transferredBytes,
        totalBytes,
        percent: percent(transferredBytes, totalBytes),
        ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
        ...(queued ? { queuePosition } : {}),
        updatedAt: row.updatedAt.toISOString(),
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

  #prune(now: number): void {
    for (const [id, task] of this.#downloads) {
      if (task.terminalAt !== undefined && now - task.terminalAt > TERMINAL_RETENTION_MS) this.#downloads.delete(id);
    }
  }
}
