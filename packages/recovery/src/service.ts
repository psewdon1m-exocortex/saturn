import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { StorageAdapter } from "@saturn/storage";
import { ensureStorageDirectory } from "@saturn/storage";
import { v7 as uuidv7 } from "uuid";
import { BackupArchiveValidator, ManifestedZipBackupWriter } from "./archive.js";
import { RecoveryCommitUncertainError } from "./types.js";
import { assertUnregisteredRecovery, coherenceSchema } from "./consistent-snapshot.js";
import type { PostgresRecoveryRepository } from "./repository.js";
import type {
  BackupMember,
  BackupRunInput,
  CreatedBackup,
  LogicalDatabaseToolchain,
  MetadataExporter,
  RecoveryLimits,
  RestoreInput,
  RestoreResult,
} from "./types.js";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function copyPrivate(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  await fs.chmod(destination, 0o600);
}

async function assertAgeBundle(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!buffer.subarray(0, bytesRead).toString("utf8").startsWith("age-encryption.org/v1")) {
      throw new Error("Recovery bundle must already be encrypted in age format");
    }
  } finally {
    await handle.close();
  }
}

async function digestStream(stream: NodeJS.ReadableStream): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(data);
    bytes += data.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function ensureStorageTree(storage: StorageAdapter, storagePath: string): Promise<void> {
  let current = "";
  for (const segment of storagePath.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    await ensureStorageDirectory(storage, current);
  }
}

export class SaturnBackupService {
  readonly #spoolRoot: string;
  readonly #database: LogicalDatabaseToolchain;
  readonly #metadata: MetadataExporter;
  readonly #writer: ManifestedZipBackupWriter;
  readonly #validator: BackupArchiveValidator;
  readonly #repository: PostgresRecoveryRepository | undefined;
  readonly #storage: StorageAdapter | undefined;
  readonly #metadataBudget: { readonly totalBytes:number;readonly memberBytes:number };

  constructor(input: {
    readonly spoolRoot: string;
    readonly limits: RecoveryLimits;
    readonly database: LogicalDatabaseToolchain;
    readonly metadata: MetadataExporter;
    readonly knownSecrets?: readonly string[];
    readonly repository?: PostgresRecoveryRepository;
    readonly storage?: StorageAdapter;
  }) {
    this.#spoolRoot = path.resolve(input.spoolRoot);
    this.#database = input.database;
    this.#metadata = input.metadata;
    this.#writer = new ManifestedZipBackupWriter(input.limits, input.knownSecrets);
    this.#validator = new BackupArchiveValidator(input.limits);
    this.#repository = input.repository;
    this.#storage = input.storage;
    this.#metadataBudget = {totalBytes:input.limits.maxExtractedBytes,memberBytes:input.limits.maxMemberBytes};
  }

  async createBackup(input: BackupRunInput): Promise<CreatedBackup> {
    const backupId = uuidv7();
    const createdAt = new Date();
    const runDirectory = path.join(this.#spoolRoot, backupId);
    await fs.mkdir(this.#spoolRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(runDirectory, { recursive: false, mode: 0o700 });
    await this.#repository?.beginBackup(backupId, input.kind);
    try {
      const members: BackupMember[] = [];
      const databaseDumpPath = path.join(runDirectory, "database.dump");

      const configPath = path.join(runDirectory, "public-config.json");
      await writeJson(configPath, input.publicConfiguration);
      members.push({ path: "config/public.json", sourcePath: configPath, mediaType: "application/json" });

      const deploymentPath = path.join(runDirectory, "compose.yaml");
      await copyPrivate(input.deploymentManifestPath, deploymentPath);
      members.push({ path: "deployment/compose.yaml", sourcePath: deploymentPath, mediaType: "application/yaml" });

      const migrationNames = (await fs.readdir(input.migrationsDirectory))
        .filter((name) => /^\d+_[a-z0-9_-]+\.(up|down)\.sql$/i.test(name))
        .sort();
      if (migrationNames.length === 0) throw new Error("No database migrations are available for backup");
      for (const name of migrationNames) {
        const destination = path.join(runDirectory, "migrations", name);
        await copyPrivate(path.join(input.migrationsDirectory, name), destination);
        members.push({ path: `migrations/${name}`, sourcePath: destination, mediaType: "application/sql" });
      }
      if (input.encryptedRecoveryBundlePath !== undefined) {
        await assertAgeBundle(input.encryptedRecoveryBundlePath);
        const encryptedPath = path.join(runDirectory, "recovery.age");
        await copyPrivate(input.encryptedRecoveryBundlePath, encryptedPath);
        members.push({ path: "secrets/recovery.age", sourcePath: encryptedPath, mediaType: "application/age-encryption" });
      }

      const staticBytes = (await Promise.all(members.map(member => fs.stat(member.sourcePath)))).reduce((sum,entry)=>sum+entry.size,0);
      const remainingBytes = this.#metadataBudget.totalBytes-staticBytes;
      if(remainingBytes<1)throw new Error('Backup static members exceed the configured extracted byte budget');
      const coherentMembers = this.#database.createCoherentBackup === undefined ? undefined
        : await this.#database.createCoherentBackup(databaseDumpPath, path.join(runDirectory, "metadata"), this.#metadata, undefined,
          {...this.#metadataBudget,totalBytes:remainingBytes});
      if (coherentMembers === undefined) await this.#database.createDump(databaseDumpPath);
      members.push({ path: "database/database.dump", sourcePath: databaseDumpPath, mediaType: "application/vnd.postgresql.custom-dump" });
      members.push(...coherentMembers ?? await this.#metadata.exportTo(path.join(runDirectory, "metadata")));

      await this.#repository?.setBackupValidating(backupId);
      const result = await this.#writer.create({
        backupId,
        createdAt,
        outputPath: path.resolve(input.outputPath),
        members,
        validationDirectory: path.join(runDirectory, "validation"),
      });
      const dumpMember = result.manifest.members.find((member) => member.path === "database/database.dump");
      if (dumpMember === undefined) throw new Error("Backup manifest lost its database member");
      await this.#repository?.completeBackup({
        id: backupId,
        archivePath: result.archivePath,
        archiveSha256: result.archiveSha256,
        archiveBytes: result.archiveBytes,
        memberCount: result.manifest.members.length,
        databaseDumpSha256: dumpMember.sha256,
        evidence: { createdAt: result.manifest.createdAt, extractedBytes: result.extractedBytes },
      });
      return result;
    } catch (error) {
      await this.#repository?.failBackup(backupId, "backup_failed").catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(runDirectory, { recursive: true, force: true });
    }
  }

  async publishToStorage(created: CreatedBackup): Promise<{ readonly storagePath: string; readonly sha256: string; readonly bytes: number }> {
    if (this.#storage === undefined) throw new Error("Backup storage publication is not configured");
    const directory = "# sync inner services/gateway";
    await ensureStorageTree(this.#storage, directory);
    const filename = `${created.manifest.createdAt.replaceAll(":", "-")}_${created.manifest.backupId}.zip`;
    const target = `${directory}/${filename}`;
    const part = `${target}.part`;
    try {
      const written = await this.#storage.write(part, createReadStream(created.archivePath), {
        offset: 0,
        create: true,
        exclusive: true,
        truncate: true,
      });
      if (written !== created.archiveBytes) throw new Error("Published backup byte count differs from local archive");
      const remoteDigest = await digestStream(await this.#storage.openRead(part));
      if (remoteDigest.bytes !== created.archiveBytes || remoteDigest.sha256 !== created.archiveSha256) {
        throw new Error("Published backup checksum differs from local archive");
      }
      await this.#storage.rename(part, target);
      return { storagePath: target, sha256: remoteDigest.sha256, bytes: remoteDigest.bytes };
    } catch (error) {
      if (await this.#storage.exists(part).catch(() => false)) await this.#storage.delete(part).catch(() => undefined);
      throw error;
    }
  }

  async restore(
    input: RestoreInput,
    migrateTarget: () => Promise<unknown> = () => Promise.resolve(),
    withWriteBarrier: <T>(action: () => Promise<T>) => Promise<T> = (action) => action(),
  ): Promise<RestoreResult> {
    const started = new Date();
    const restoreId = uuidv7();
    const restoreDirectory = path.join(this.#spoolRoot, `restore-${restoreId}`);
    const extractionDirectory = path.join(restoreDirectory, "validated");
    await fs.mkdir(this.#spoolRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(restoreDirectory, { recursive: false, mode: 0o700 });
    let snapshot: CreatedBackup | undefined;
    try {
      const validated = await this.#validator.validate(path.resolve(input.archivePath), extractionDirectory);
      const dumpPath = path.join(extractionDirectory, "database", "database.dump");
      if (validated.manifest.members.some(member => member.path === "metadata/coherence.json")) {
        const coherencePath = path.join(extractionDirectory, "metadata", "coherence.json");
        if ((await fs.stat(coherencePath)).size > 65_536) throw new Error("Backup coherence manifest exceeds the size limit");
        const coherence = coherenceSchema.parse(JSON.parse(await fs.readFile(coherencePath, "utf8")) as unknown);
        if (coherence.databaseDumpSha256 !== validated.manifest.members.find(member => member.path === "database/database.dump")?.sha256) {
          throw new Error("Backup coherence manifest does not match its database dump");
        }
        assertUnregisteredRecovery(coherence.journal);
      }
      if (input.configuration !== undefined) {
        const publicPath = path.join(extractionDirectory, "config", "public.json");
        if ((await fs.stat(publicPath)).size > 65_536) throw new Error("Recovered configuration exceeds the size limit");
        await input.configuration.prepare(JSON.parse(await fs.readFile(publicPath, "utf8")) as unknown);
      }
      return await withWriteBarrier(async () => {
      let preserved = false;
      if (input.mode === "replace" && this.#database.beginReplacement === undefined) {
        if (input.snapshotOutputPath === undefined || input.snapshotInput === undefined) {
          throw new Error("Replacement restore requires a pre-restore snapshot destination and inputs");
        }
        snapshot = await this.createBackup({
          ...input.snapshotInput,
          outputPath: input.snapshotOutputPath,
          kind: "pre_restore",
        });
      }
        try {
          if (input.mode === "replace" && this.#database.beginReplacement !== undefined) {
            await this.#database.beginReplacement();
            preserved = true;
          }
          if (input.mode === "clean" && this.#database.beginCleanRestore !== undefined) {
            await this.#database.beginCleanRestore();
            preserved = true;
          }
          await this.#database.restoreDump(dumpPath, input.mode);
          await migrateTarget();
          const verification = await this.#database.verifyRestoredDatabase();
          await input.configuration?.apply();
          if (input.configuration?.verifyFiles !== undefined) await input.configuration.verifyFiles();
          else if (this.#database.verifyStorage !== undefined) {
            if (this.#storage === undefined && (verification.versions ?? 0) > 0) throw new Error("File storage verification is required before restoring a nonempty catalog");
            if (this.#storage !== undefined) await this.#database.verifyStorage(this.#storage);
          }
          if (preserved) await this.#database.commitReplacement?.();
          const finished = new Date();
          return {
            backupId: validated.manifest.backupId,
            mode: input.mode,
            startedAt: started.toISOString(),
            finishedAt: finished.toISOString(),
            measuredRpoMs: Math.max(0, started.getTime() - new Date(validated.manifest.createdAt).getTime()),
            measuredRtoMs: finished.getTime() - started.getTime(),
            verification,
            ...(snapshot === undefined ? {} : { snapshotPath: snapshot.archivePath }),
          };
        } catch (restoreError) {
          if (restoreError instanceof RecoveryCommitUncertainError) throw restoreError;
          if (preserved) {
            try {
              await input.configuration?.rollback();
              await this.#database.rollbackReplacement?.();
            } catch (rollbackError) {
              throw new AggregateError([restoreError, rollbackError], "Restore rollback failed; original database is preserved in the restore guard");
            }
            throw restoreError;
          }
          if (snapshot === undefined) {
            await input.configuration?.rollback();
            throw restoreError;
          }
          const rollbackDirectory = path.join(restoreDirectory, "rollback");
          try {
            await this.#validator.validate(snapshot.archivePath, rollbackDirectory);
            await this.#database.restoreDump(path.join(rollbackDirectory, "database", "database.dump"), "replace");
            await migrateTarget();
            await this.#database.verifyRestoredDatabase();
          } catch (rollbackError) {
            try { await input.configuration?.rollback(); }
            catch (configurationError) { throw new AggregateError([restoreError, rollbackError, configurationError], "Database and configuration rollback failed"); }
            throw new AggregateError([restoreError, rollbackError], "Restore and snapshot rollback both failed");
          }
          await input.configuration?.rollback();
          throw restoreError;
        }
      });
    } finally {
      await fs.rm(restoreDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
