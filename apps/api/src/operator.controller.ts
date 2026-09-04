import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Post, Put, UseGuards } from "@nestjs/common";
import type { AuditService } from "@saturn/audit";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import type { StorageAdapter } from "@saturn/storage";
import { z } from "zod";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { APP_CONFIG, AUDIT_SERVICE, DATABASE, STORAGE_ADAPTER } from "./tokens.js";
import { TransferMonitorService, type UploadTaskSample } from "./transfer-monitor.service.js";

interface CpuSample {
  readonly usage: NodeJS.CpuUsage;
  readonly time: bigint;
}

interface KernelRow {
  kernel_url: string | null;
  public_identity: string | null;
  revision: string;
}

interface UploadTaskRow {
  readonly id: string;
  readonly filename: string;
  readonly expected_size: string;
  readonly received_size: string;
  readonly status: UploadTaskSample["status"];
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface StorageUsageRow {
  readonly used_bytes: string;
  readonly file_count: string;
}

type DiskUsageMetric = {
  readonly state: "available";
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
} | {
  readonly state: "unavailable";
  readonly reason: string;
};

interface BackupUploadTaskRow {
  readonly id: string;
  readonly filename: string;
  readonly expected_size: string;
  readonly received_size: string;
  readonly state: "pending" | "uploading" | "appending" | "verifying";
  readonly created_at: Date;
  readonly updated_at: Date;
}

function databaseInteger(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function localDiskUsage(): Promise<DiskUsageMetric> {
  try {
    const statistics = await fs.statfs(process.cwd());
    const totalBytes = statistics.blocks * statistics.bsize;
    const freeBytes = statistics.bfree * statistics.bsize;
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) throw new Error("invalid_disk_sample");
    const usedBytes = Math.min(totalBytes, Math.max(0, totalBytes - freeBytes));
    return { state: "available", usedBytes, totalBytes, percent: usedBytes / totalBytes * 100 };
  } catch {
    return { state: "unavailable", reason: "Local service volume capacity telemetry is unavailable." };
  }
}

const kernelUrlSchema = z.object({ url: z.string().min(1).max(2048) }).strict();
const kernelTokenSchema = z.object({ token: z.string().min(32).max(4096) }).strict();

@Controller("operator")
@UseGuards(OwnerTokenGuard)
export class OperatorController {
  #cpuSample: CpuSample = { usage: process.cpuUsage(), time: process.hrtime.bigint() };
  readonly #database: Database;
  readonly #config: SaturnConfig;
  readonly #audit: AuditService;
  readonly #transfers: TransferMonitorService;
  readonly #storage: StorageAdapter;
  #kernelRotations: number[] = [];

  constructor(
    @Inject(DATABASE) database: Database,
    @Inject(APP_CONFIG) config: SaturnConfig,
    @Inject(AUDIT_SERVICE) audit: AuditService,
    @Inject(TransferMonitorService) transfers: TransferMonitorService,
    @Inject(STORAGE_ADAPTER) storage: StorageAdapter,
  ) {
    this.#database = database;
    this.#config = config;
    this.#audit = audit;
    this.#transfers = transfers;
    this.#storage = storage;
  }

  #normalizeKernelUrl(input: string): string {
    let url: URL;
    try { url = new URL(input); }
    catch { throw new BadRequestException({ code: "invalid_kernel_url" }); }
    if (url.username || url.password || url.hash || url.search
      || !["https:", ...(this.#config.environment === "production" ? [] : ["http:"])].includes(url.protocol)) {
      throw new BadRequestException({ code: "invalid_kernel_url" });
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  }

  async #kernelRow(): Promise<KernelRow> {
    const seed = this.#config.kernel.urlSeed === undefined ? null : this.#normalizeKernelUrl(this.#config.kernel.urlSeed);
    return this.#database.transaction(async (sql) => {
      await sql`
        INSERT INTO kernel_settings (singleton, kernel_url)
        VALUES (true, ${seed})
        ON CONFLICT (singleton) DO UPDATE SET
          kernel_url = coalesce(kernel_settings.kernel_url, EXCLUDED.kernel_url)
      `;
      const rows = await sql<KernelRow[]>`SELECT kernel_url, public_identity, revision::text FROM kernel_settings WHERE singleton = true`;
      const row = rows[0];
      if (row === undefined) throw new Error("Kernel settings are missing");
      return row;
    });
  }

  async #readKernelToken(): Promise<string | undefined> {
    if (this.#config.kernel.tokenFile === undefined) return undefined;
    try {
      const value = (await fs.readFile(this.#config.kernel.tokenFile, "utf8")).replace(/[\r\n]+$/, "");
      return value.length >= 32 ? value : undefined;
    } catch { return undefined; }
  }

  async #validateKernel(url: string, token: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.kernel.timeoutMs);
    try {
      const endpoint = `${url.replace(/\/$/, "")}/health/ready`;
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      const length = Number(response.headers.get("content-length") ?? "0");
      if (!response.ok || (Number.isFinite(length) && length > 65_536)) throw new Error("kernel_validation_failed");
      const chunks: Uint8Array[] = []; let bytes = 0;
      if (response.body !== null) {
        for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
          bytes += part.byteLength;
          if (bytes > 65_536) { await response.body.cancel(); throw new Error("kernel_validation_failed"); }
          chunks.push(part);
        }
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (typeof body !== "object" || body === null) throw new Error("kernel_validation_failed");
      const record = body as Record<string, unknown>;
      if (record.status !== "ok") throw new Error("kernel_validation_failed");
      for (const key of ["identity", "role", "service"] as const) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 160) return candidate;
      }
      return "Kernel";
    } finally { clearTimeout(timer); }
  }

  async #auditKernel(action: string, outcome: "success" | "failure", details: Record<string, unknown>): Promise<void> {
    await this.#audit.write({ actorType: "owner", actorId: "owner", action, outcome, correlationId: `${action}:${randomUUID()}`, details }).catch(() => undefined);
  }

  @Get("overview")
  async overview() {
    const sampledAt = Date.now();
    const [uploadRows, backupRows, storageRows, disk, storageCapacity] = await Promise.all([
      this.#database.withSql((sql) => sql<UploadTaskRow[]>`
        SELECT id::text, filename, expected_size::text, received_size::text, status, created_at, updated_at
        FROM upload_sessions
        WHERE status IN ('created', 'uploading', 'verifying', 'committing', 'failed_retryable')
        ORDER BY
          CASE status
            WHEN 'uploading' THEN 0
            WHEN 'verifying' THEN 1
            WHEN 'committing' THEN 2
            WHEN 'created' THEN 3
            ELSE 4
          END,
          updated_at DESC
        LIMIT 32
      `),
      this.#database.withSql((sql) => sql<BackupUploadTaskRow[]>`
        SELECT id::text, filename, expected_size::text, received_size::text, state, created_at, updated_at
        FROM service_backup_runs
        WHERE state IN ('pending', 'uploading', 'appending', 'verifying')
        ORDER BY
          CASE state
            WHEN 'uploading' THEN 0
            WHEN 'appending' THEN 0
            WHEN 'verifying' THEN 1
            ELSE 2
          END,
          updated_at DESC
        LIMIT 32
      `),
      this.#database.withSql((sql) => sql<StorageUsageRow[]>`
        SELECT coalesce(sum(size_bytes), 0)::text AS used_bytes, count(*)::text AS file_count
        FROM resources
        WHERE type = 'file' AND status = 'active'
      `),
      localDiskUsage(),
      this.#storage.statFs().catch(() => undefined),
    ]);
    const now = process.hrtime.bigint();
    const elapsedMicros = Number(now - this.#cpuSample.time) / 1_000;
    const usage = process.cpuUsage(this.#cpuSample.usage);
    this.#cpuSample = { usage: process.cpuUsage(), time: now };
    const cpuMicros = usage.user + usage.system;
    const cpuPercent = elapsedMicros > 0 ? Math.min(100, Math.max(0, cpuMicros / elapsedMicros * 100)) : undefined;
    const memory = process.memoryUsage();
    const totalMemory = os.totalmem();
    const systemUsedMemory = Math.max(0, totalMemory - os.freemem());
    const storage = storageRows[0] ?? { used_bytes: "0", file_count: "0" };
    const transfers = this.#transfers.snapshot([...uploadRows.map((row): UploadTaskSample => ({
      id: row.id,
      filename: row.filename,
      expectedBytes: databaseInteger(row.expected_size),
      receivedBytes: databaseInteger(row.received_size),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })), ...backupRows.map((row): UploadTaskSample => ({
      id: `backup:${row.id}`,
      filename: row.filename,
      expectedBytes: databaseInteger(row.expected_size),
      receivedBytes: databaseInteger(row.received_size),
      status: row.state === "pending" ? "created" : row.state === "verifying" ? "verifying" : "uploading",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))], sampledAt);
    return {
      sampledAt: new Date(sampledAt).toISOString(),
      cpu: cpuPercent === undefined ? { state: "unavailable" } : { state: "available", percent: cpuPercent, logicalCores: os.cpus().length },
      ram: totalMemory <= 0
        ? { state: "unavailable" }
        : { state: "available", usedBytes: systemUsedMemory, totalBytes: totalMemory, percent: systemUsedMemory / totalMemory * 100, processBytes: memory.rss },
      disk,
      uptime: { state: "available", seconds: process.uptime() },
      storage: {
        state: "available",
        indexedBytes: databaseInteger(storage.used_bytes),
        fileCount: databaseInteger(storage.file_count),
        capacity: storageCapacity === undefined
          ? { state: "unavailable", reason: "Storage capacity telemetry is unavailable for the active profile." }
          : { state: "available", totalBytes: storageCapacity.totalBytes, availableBytes: storageCapacity.availableBytes, usedBytes: Math.max(0, storageCapacity.totalBytes - storageCapacity.availableBytes) },
      },
      transfers,
    };
  }

  @Get("updates")
  updates() {
    return {
      installedVersion: process.env.VAULT_RELEASE_VERSION ?? "0.1.0",
      updater: { state: "unavailable", reason: "A privileged local updater is not configured." },
      registry: { state: "unavailable", reason: "An approved Kernel release registry is not configured." },
      discoveryEnabled: false,
    };
  }

  @Get("kernel")
  async kernel() {
    const row = await this.#kernelRow();
    const token = await this.#readKernelToken();
    if (row.kernel_url === null || token === undefined) {
      return { url: row.kernel_url ?? undefined, identity: row.public_identity ?? undefined, revision: Number(row.revision), configured: false, reachability: "unavailable" as const };
    }
    try {
      const identity = await this.#validateKernel(row.kernel_url, token);
      await this.#database.withSql(async (sql) => { await sql`UPDATE kernel_settings SET public_identity = ${identity} WHERE singleton = true`; });
      return { url: row.kernel_url, identity, revision: Number(row.revision), configured: true, reachability: "ready" as const };
    } catch {
      return { url: row.kernel_url, identity: row.public_identity ?? undefined, revision: Number(row.revision), configured: true, reachability: "unavailable" as const };
    }
  }

  @Put("kernel/url")
  @RequireRecentReauthentication()
  async changeKernelUrl(@Body() body: unknown) {
    const parsed = kernelUrlSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "invalid_kernel_url" });
    const candidate = this.#normalizeKernelUrl(parsed.data.url);
    const token = await this.#readKernelToken();
    if (token === undefined) throw new ConflictException({ code: "kernel_token_not_configured" });
    try {
      const identity = await this.#validateKernel(candidate, token);
      const result = await this.#database.withSql(async (sql) => {
        const rows = await sql<KernelRow[]>`
          UPDATE kernel_settings SET kernel_url = ${candidate}, public_identity = ${identity},
            revision = revision + 1, updated_at = now()
          WHERE singleton = true
          RETURNING kernel_url, public_identity, revision::text
        `;
        return rows[0];
      });
      await this.#auditKernel("kernel.url.changed", "success", { revision: Number(result?.revision ?? 0), identity });
      return { url: candidate, identity, revision: Number(result?.revision ?? 0), configured: true, reachability: "ready" as const };
    } catch (error) {
      await this.#auditKernel("kernel.url.changed", "failure", { reason: "validation_failed" });
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      throw new BadRequestException({ code: "kernel_validation_failed" });
    }
  }

  @Post("kernel/token")
  @RequireRecentReauthentication()
  async rotateKernelToken(@Body() body: unknown) {
    const parsed = kernelTokenSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "invalid_kernel_token" });
    const now = Date.now();
    this.#kernelRotations = this.#kernelRotations.filter((value) => value >= now - 15 * 60_000);
    if (this.#kernelRotations.length >= 5) throw new ConflictException({ code: "kernel_rotation_rate_limited" });
    this.#kernelRotations.push(now);
    const row = await this.#kernelRow();
    const target = this.#config.kernel.tokenFile;
    if (row.kernel_url === null || target === undefined) throw new ConflictException({ code: "kernel_not_configured" });
    try {
      const identity = await this.#validateKernel(row.kernel_url, parsed.data.token);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${parsed.data.token}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      try { await fs.rename(temporary, target); }
      catch (error) { await fs.rm(temporary, { force: true }); throw error; }
      await this.#database.withSql(async (sql) => {
        await sql`UPDATE kernel_settings SET public_identity = ${identity}, revision = revision + 1, updated_at = now() WHERE singleton = true`;
      });
      await this.#auditKernel("kernel.token.rotated", "success", { identity });
      const current = await this.#kernelRow();
      return { configured: true, reachability: "ready" as const, identity, revision: Number(current.revision) };
    } catch {
      await this.#auditKernel("kernel.token.rotated", "failure", { reason: "validation_failed" });
      throw new BadRequestException({ code: "kernel_validation_failed" });
    }
  }
}
