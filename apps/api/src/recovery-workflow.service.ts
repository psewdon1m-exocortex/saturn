import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { AuditService } from "@saturn/audit";
import { publicConfig, type SaturnConfig } from "@saturn/config";
import { Database, migrate } from "@saturn/database";
import { createStorageRecoveryParticipant, type RuntimeStorageManager } from "@saturn/storage";
import {
  BackupArchiveValidator,
  DatabaseMetadataExporter,
  PostgresCommandToolchain,
  PostgresRecoveryRepository,
  SaturnBackupService,
  type CreatedBackup,
  type RestoreResult,
} from "@saturn/recovery";
import { v7 as uuidv7 } from "uuid";
import { APP_CONFIG, AUDIT_SERVICE, DATABASE, STORAGE_RUNTIME } from "./tokens.js";

const RESTORE_UPLOAD_TTL_MS = 60 * 60 * 1_000;

type RestoreUploadState = "uploading" | "validating" | "ready" | "applying" | "complete" | "failed" | "cancelled";

export interface RecoveryCapabilityStatus {
  readonly exportEnabled: boolean;
  readonly restoreEnabled: boolean;
  readonly busy: boolean;
  readonly maxArchiveBytes: number;
  readonly maxChunkBytes: number;
  readonly reason?: string;
}

export interface RecoveryRestoreCandidate {
  readonly id: string;
  readonly filename: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly schema: string;
  readonly backupId: string;
  readonly createdAt: string;
  readonly memberCount: number;
  readonly state: RestoreUploadState;
}

interface RestoreUploadRecord {
  readonly id: string;
  readonly filename: string;
  readonly archivePath: string;
  readonly expectedBytes: number;
  receivedBytes: number;
  state: RestoreUploadState;
  createdAt: string;
  expiresAt: string;
  candidate?: RecoveryRestoreCandidate;
}

interface RecoveryInputs {
  readonly publicConfiguration: Readonly<Record<string, unknown>>;
  readonly deploymentManifestPath: string;
  readonly migrationsDirectory: string;
}

function timestampFilename(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replaceAll(":", "-")}-${uuidv7()}.zip`;
}

function safeFilename(value: string): string {
  const basename = path.basename(value.normalize("NFC"));
  let candidate = "";
  for (let index = 0; index < basename.length; index += 1) {
    const code = basename.charCodeAt(index);
    if (code >= 32 && code !== 127) candidate += basename.charAt(index);
  }
  candidate = candidate.trim();
  if (!candidate || candidate.length > 255 || !candidate.toLowerCase().endsWith(".zip")) throw new Error("Recovery filename is invalid");
  return candidate;
}

class ExactByteLimit extends Transform {
  readonly #expected: number;
  #received = 0;

  constructor(expected: number) {
    super();
    this.#expected = expected;
  }

  get received(): number { return this.#received; }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.#received += chunk.length;
    if (this.#received > this.#expected) callback(new Error("Recovery chunk exceeds Content-Length"));
    else callback(null, chunk);
  }
}

@Injectable()
export class RecoveryWorkflowService implements OnModuleInit, OnApplicationShutdown {
  readonly #config: SaturnConfig;
  readonly #database: Database;
  readonly #audit: AuditService;
  readonly #storage: RuntimeStorageManager;
  readonly #uploads = new Map<string, RestoreUploadRecord>();
  readonly #uploadLocks = new Map<string, Promise<unknown>>();
  #recoveryDatabase: Database | undefined;
  #toolchain: PostgresCommandToolchain | undefined;
  #backup: SaturnBackupService | undefined;
  #validator: BackupArchiveValidator | undefined;
  #inputs: RecoveryInputs | undefined;
  #running = false;
  #capabilityCache: { readonly checkedAt: number; readonly reason?: string } | undefined;

  constructor(
    @Inject(APP_CONFIG) config: SaturnConfig,
    @Inject(DATABASE) database: Database,
    @Inject(AUDIT_SERVICE) audit: AuditService,
    @Inject(STORAGE_RUNTIME) storage: RuntimeStorageManager,
  ) {
    this.#config = config;
    this.#database = database;
    this.#audit = audit;
    this.#storage = storage;
  }

  async onModuleInit(): Promise<void> {
    const runtimeRoot = process.env.VAULT_RUNTIME_ROOT;
    const sourceRoot = runtimeRoot === undefined
      ? path.resolve(path.dirname(this.#config.ownerBootstrapTokenFile), "..")
      : path.join(runtimeRoot, "recovery");
    this.#inputs = {
      publicConfiguration: publicConfig(this.#config),
      deploymentManifestPath: path.join(sourceRoot, runtimeRoot === undefined ? "compose.yaml" : "compose.yaml"),
      migrationsDirectory: path.join(sourceRoot, runtimeRoot === undefined ? "packages/database/migrations" : "migrations"),
    };
    await Promise.all([
      fs.mkdir(this.#config.recovery.spoolDirectory, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.#config.recovery.archiveDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await this.#cleanupInterruptedUploads();
    this.#recoveryDatabase = new Database(this.#config.databaseUrl, { max: 3 });
    this.#toolchain = new PostgresCommandToolchain({
      databaseUrl: this.#config.databaseUrl,
      database: this.#recoveryDatabase,
      pgDumpExecutable: this.#config.recovery.pgDumpExecutable,
      pgRestoreExecutable: this.#config.recovery.pgRestoreExecutable,
      pgDumpPrefixArgs: this.#config.recovery.pgDumpPrefixArgs,
      pgRestorePrefixArgs: this.#config.recovery.pgRestorePrefixArgs,
      ...(this.#config.recovery.pgCommandConnectionArgs.length === 0 ? {} : { commandConnectionArgs: this.#config.recovery.pgCommandConnectionArgs }),
      maximumDumpBytes: this.#config.recovery.limits.maxMemberBytes,
    });
    const knownSecrets = [
      await fs.readFile(this.#config.ownerBootstrapTokenFile, "utf8").then((value) => value.trim()),
      new URL(this.#config.databaseUrl).password ? decodeURIComponent(new URL(this.#config.databaseUrl).password) : "",
      this.#config.storage.passwordFile === undefined
        ? ""
        : await fs.readFile(this.#config.storage.passwordFile, "utf8").then((value) => value.replace(/[\r\n]+$/, "")),
    ].filter((value) => value.length >= 8);
    this.#backup = new SaturnBackupService({
      spoolRoot: this.#config.recovery.spoolDirectory,
      limits: this.#config.recovery.limits,
      database: this.#toolchain,
      metadata: new DatabaseMetadataExporter(this.#database),
      knownSecrets,
      repository: new PostgresRecoveryRepository(this.#database),
    });
    this.#validator = new BackupArchiveValidator(this.#config.recovery.limits);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#recoveryDatabase?.close().catch(() => undefined);
  }

  async status(): Promise<RecoveryCapabilityStatus> {
    const cached = this.#capabilityCache;
    if (cached === undefined || Date.now() - cached.checkedAt > 15_000) {
      let reason: string | undefined;
      try {
        const toolchain = this.#requireToolchain();
        const inputs = this.#requireInputs();
        await Promise.all([
          toolchain.checkReady(),
          fs.access(inputs.deploymentManifestPath),
          fs.access(inputs.migrationsDirectory),
        ]);
      } catch {
        reason = "PostgreSQL recovery tools or packaged recovery inputs are unavailable.";
      }
      this.#capabilityCache = { checkedAt: Date.now(), ...(reason === undefined ? {} : { reason }) };
    }
    const unavailable = this.#capabilityCache?.reason;
    const reason = unavailable ?? (this.#running ? "Another Saturn backup or restore operation is in progress." : undefined);
    return {
      exportEnabled: reason === undefined,
      restoreEnabled: reason === undefined,
      busy: this.#running,
      maxArchiveBytes: this.#config.recovery.limits.maxArchiveBytes,
      maxChunkBytes: this.#config.limits.uploadChunkMaxBytes,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  async createSnapshot(): Promise<{ readonly filename: string; readonly created: CreatedBackup; readonly stream: ReadStream }> {
    await this.#claimOperation();
    const filename = timestampFilename("saturn-snapshot");
    const outputPath = path.join(this.#config.recovery.archiveDirectory, filename);
    try {
      const created = await this.#requireBackup().createBackup({
        ...this.#requireInputs(),
        outputPath,
        kind: "manual",
      });
      await this.#audit.write({
        actorType: "owner",
        actorId: "owner",
        action: "recovery.snapshot.create",
        outcome: "success",
        correlationId: `recovery.snapshot.create:${created.manifest.backupId}`,
        details: { backupId: created.manifest.backupId, archiveBytes: created.archiveBytes, archiveSha256: created.archiveSha256 },
      }).catch(() => undefined);
      const stream = createReadStream(created.archivePath);
      const cleanup = () => { void fs.rm(created.archivePath, { force: true }); };
      stream.once("close", cleanup);
      stream.once("error", cleanup);
      return { filename, created, stream };
    } catch (error) {
      await fs.rm(outputPath, { force: true });
      await this.#auditFailure("recovery.snapshot.create", error);
      throw error;
    } finally {
      this.#running = false;
    }
  }

  async beginRestore(filename: string, expectedBytes: number): Promise<RecoveryRestoreCandidate | Omit<RecoveryRestoreCandidate, "archiveSha256" | "schema" | "backupId" | "createdAt" | "memberCount">> {
    await this.#requireAvailable();
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > this.#config.recovery.limits.maxArchiveBytes) {
      throw new Error("Recovery archive size is invalid");
    }
    const id = uuidv7();
    const record: RestoreUploadRecord = {
      id,
      filename: safeFilename(filename),
      archivePath: path.join(this.#config.recovery.spoolDirectory, `web-restore-${id}.zip`),
      expectedBytes,
      receivedBytes: 0,
      state: "uploading",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + RESTORE_UPLOAD_TTL_MS).toISOString(),
    };
    const handle = await fs.open(record.archivePath, "wx", 0o600);
    await handle.close();
    this.#uploads.set(id, record);
    await this.#writeJournal(record);
    return { id, filename: record.filename, archiveBytes: record.expectedBytes, state: record.state };
  }

  async appendRestore(id: string, offset: number, contentLength: number, source: Readable): Promise<number> {
    return this.#withUploadLock(id, async (record) => {
      if (record.state !== "uploading") throw new Error("Recovery upload is not active");
      if (!Number.isSafeInteger(offset) || offset !== record.receivedBytes) throw new Error("Recovery upload offset mismatch");
      const remaining = record.expectedBytes - record.receivedBytes;
      if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > this.#config.limits.uploadChunkMaxBytes || contentLength > remaining) {
        throw new Error("Recovery Content-Length is invalid");
      }
      const limiter = new ExactByteLimit(contentLength);
      try {
        await pipeline(source, limiter, createWriteStream(record.archivePath, { flags: "r+", start: offset, mode: 0o600 }));
        if (limiter.received !== contentLength) throw new Error("Recovery chunk differs from Content-Length");
      } catch (error) {
        await fs.truncate(record.archivePath, offset).catch(() => undefined);
        throw error;
      }
      record.receivedBytes += contentLength;
      await this.#writeJournal(record);
      return record.receivedBytes;
    });
  }

  async validateRestore(id: string): Promise<RecoveryRestoreCandidate> {
    return this.#withUploadLock(id, async (record) => {
      if (record.state !== "uploading") throw new Error("Recovery upload is not active");
      if (record.receivedBytes !== record.expectedBytes) throw new Error("Recovery upload is incomplete");
      record.state = "validating";
      await this.#writeJournal(record);
      const extractionDirectory = path.join(this.#config.recovery.spoolDirectory, `web-validation-${record.id}`);
      await fs.rm(extractionDirectory, { recursive: true, force: true });
      try {
        const validated = await this.#requireValidator().validate(record.archivePath, extractionDirectory);
        record.candidate = {
          id: record.id,
          filename: record.filename,
          archiveBytes: validated.archiveBytes,
          archiveSha256: validated.archiveSha256,
          schema: validated.manifest.schema,
          backupId: validated.manifest.backupId,
          createdAt: validated.manifest.createdAt,
          memberCount: validated.manifest.members.length,
          state: "ready",
        };
        record.state = "ready";
        await this.#writeJournal(record);
        return record.candidate;
      } catch (error) {
        record.state = "failed";
        await this.#writeJournal(record);
        await this.#auditFailure("recovery.snapshot.validate", error);
        throw error;
      } finally {
        await fs.rm(extractionDirectory, { recursive: true, force: true });
      }
    });
  }

  async applyRestore(id: string): Promise<RestoreResult> {
    const record = this.#uploads.get(id);
    if (record === undefined) throw new Error("Recovery upload was not found");
    if (record.state !== "ready" || record.candidate === undefined) throw new Error("Recovery upload is not ready");
    await this.#claimOperation();
    const snapshotFilename = timestampFilename("pre-restore");
    const snapshotOutputPath = path.join(this.#config.recovery.archiveDirectory, snapshotFilename);
    try {
      record.state = "applying";
      await this.#writeJournal(record);
      const result = await this.#requireBackup().restore({
        archivePath: record.archivePath,
        mode: "replace",
        snapshotOutputPath,
        snapshotInput: this.#requireInputs(),
        configuration: await createStorageRecoveryParticipant(this.#config, this.#storage),
      }, () => migrate(this.#config.databaseUrl, this.#requireInputs().migrationsDirectory), (action) => this.#database.withExclusiveMaintenance(action));
      record.state = "complete";
      await this.#writeJournal(record);
      await this.#recordRecovery(result, record, "complete");
      await this.#audit.write({
        actorType: "owner",
        actorId: "owner",
        action: "recovery.snapshot.restore",
        outcome: "success",
        correlationId: `recovery.snapshot.restore:${id}`,
        details: { backupId: result.backupId, archiveSha256: record.candidate.archiveSha256, measuredRpoMs: result.measuredRpoMs, measuredRtoMs: result.measuredRtoMs, snapshotFilename },
      }).catch(() => undefined);
      return result;
    } catch (error) {
      record.state = "failed";
      await this.#writeJournal(record);
      await this.#recordRecovery(undefined, record, error instanceof AggregateError ? "failed" : "rolled_back").catch(() => undefined);
      await this.#auditFailure("recovery.snapshot.restore", error, { archiveSha256: record.candidate.archiveSha256, rollback: error instanceof AggregateError ? "failed" : "complete" });
      throw error;
    } finally {
      this.#running = false;
      this.#uploads.delete(id);
      await Promise.all([
        fs.rm(record.archivePath, { force: true }),
        fs.rm(this.#journalPath(id), { force: true }),
      ]);
    }
  }

  async cancelRestore(id: string): Promise<void> {
    await this.#withUploadLock(id, async (record) => {
      if (record.state === "applying") throw new Error("Recovery restore is already in progress");
      record.state = "cancelled";
      await this.#writeJournal(record);
      this.#uploads.delete(id);
      await Promise.all([
        fs.rm(record.archivePath, { force: true }),
        fs.rm(this.#journalPath(id), { force: true }),
      ]);
    });
  }

  async #requireAvailable(): Promise<void> {
    const status = await this.status();
    if (!status.exportEnabled || !status.restoreEnabled) throw new Error(status.reason ?? "Recovery workflow is unavailable");
  }

  async #claimOperation(): Promise<void> {
    const status = await this.status();
    if ((!status.exportEnabled || !status.restoreEnabled) && !status.busy) {
      throw new Error(status.reason ?? "Recovery workflow is unavailable");
    }
    // Recheck after the asynchronous capability probe. This is the atomic
    // hand-off that prevents two callers which observed the same idle status
    // from starting concurrent database operations.
    if (this.#running) throw new Error("Another Saturn backup or restore operation is in progress.");
    this.#running = true;
  }

  #requireToolchain(): PostgresCommandToolchain {
    if (this.#toolchain === undefined) throw new Error("Recovery toolchain is not initialized");
    return this.#toolchain;
  }

  #requireBackup(): SaturnBackupService {
    if (this.#backup === undefined) throw new Error("Recovery service is not initialized");
    return this.#backup;
  }

  #requireValidator(): BackupArchiveValidator {
    if (this.#validator === undefined) throw new Error("Recovery validator is not initialized");
    return this.#validator;
  }

  #requireInputs(): RecoveryInputs {
    if (this.#inputs === undefined) throw new Error("Recovery inputs are not initialized");
    return { ...this.#inputs, publicConfiguration: publicConfig({ ...this.#config, storage: this.#storage.current().config }) };
  }

  async #withUploadLock<T>(id: string, action: (record: RestoreUploadRecord) => Promise<T>): Promise<T> {
    const previous = this.#uploadLocks.get(id) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#uploadLocks.set(id, queued);
    await previous;
    try {
      const record = this.#uploads.get(id);
      if (record === undefined || new Date(record.expiresAt).getTime() <= Date.now()) throw new Error("Recovery upload was not found");
      return await action(record);
    } finally {
      release?.();
      if (this.#uploadLocks.get(id) === queued) this.#uploadLocks.delete(id);
    }
  }

  async #writeJournal(record: RestoreUploadRecord): Promise<void> {
    await fs.writeFile(this.#journalPath(record.id), `${JSON.stringify({
      id: record.id,
      filename: record.filename,
      expectedBytes: record.expectedBytes,
      receivedBytes: record.receivedBytes,
      state: record.state,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ...(record.candidate === undefined ? {} : { candidate: record.candidate }),
    })}\n`, { encoding: "utf8", mode: 0o600 });
  }

  #journalPath(id: string): string {
    return path.join(this.#config.recovery.spoolDirectory, `web-restore-${id}.json`);
  }

  async #cleanupInterruptedUploads(): Promise<void> {
    const entries = await fs.readdir(this.#config.recovery.spoolDirectory).catch(() => [] as string[]);
    await Promise.all(entries
      .filter((name) => /^web-(restore|validation)-[0-9a-f-]+\.(zip|json)$/.test(name) || /^web-validation-[0-9a-f-]+$/.test(name))
      .map((name) => fs.rm(path.join(this.#config.recovery.spoolDirectory, name), { recursive: true, force: true })));
  }

  async #recordRecovery(result: RestoreResult | undefined, record: RestoreUploadRecord, state: "complete" | "rolled_back" | "failed"): Promise<void> {
    await this.#database.withSql(async (sql) => {
      await sql`
        INSERT INTO recovery_runs (
          id, mode, state, finished_at, measured_rpo_ms, measured_rto_ms, error_code, evidence
        ) VALUES (
          ${uuidv7()}, 'replace', ${state}, now(),
          ${result?.measuredRpoMs ?? null}, ${result?.measuredRtoMs ?? null},
          ${state === "complete" ? null : state === "rolled_back" ? "restore_failed_rolled_back" : "restore_and_rollback_failed"},
          ${sql.json({
            sourceBackupId: record.candidate?.backupId,
            archiveSha256: record.candidate?.archiveSha256,
            sourceCreatedAt: record.candidate?.createdAt,
            verification: result?.verification,
          })}
        )
      `;
    });
  }

  async #auditFailure(action: string, error: unknown, details: Record<string, unknown> = {}): Promise<void> {
    await this.#audit.write({
      actorType: "owner",
      actorId: "owner",
      action,
      outcome: "failure",
      correlationId: `${action}:${uuidv7()}`,
      details: { ...details, errorCode: error instanceof AggregateError ? "rollback_failed" : "operation_failed" },
    }).catch(() => undefined);
  }
}
