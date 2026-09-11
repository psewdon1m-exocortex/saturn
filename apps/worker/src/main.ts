import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvironment, publicConfig, watchRecoveredConfiguration } from "@saturn/config";
import { Database } from "@saturn/database";
import { AuditService } from "@saturn/audit";
import {
  PostgresPurgeRepository,
  PostgresReconciliationRepository,
  PurgeService,
  ReconciliationService,
} from "@saturn/protection";
import { RuntimeStorageManager } from "@saturn/storage";
import { AdapterStorageHealthProbe } from "@saturn/storage-health";
import {
  DatabaseMetadataExporter,
  PostgresCommandToolchain,
  PostgresRecoveryRepository,
  SaturnBackupService,
} from "@saturn/recovery";
import { buildWorker } from "./worker.js";
import { PostgresShareRepository } from "@saturn/shares";
import { DropBufferStore, DropDrainService, PostgresDropRepository } from "@saturn/drop";
import { FileService, PostgresFileRepository } from "@saturn/file-core";
import { ArchiveJobRunner, PostgresArchiveJobRepository } from "@saturn/archive";

const config = loadEnvironment();
const database = new Database(config.databaseUrl, { max: 5, maintenanceBarrier: true });
const storage = new RuntimeStorageManager(config.storage, config.storageRuntimeConfigDirectory);
await storage.initialize();
const audit = new AuditService(database);
const reconciliation = new ReconciliationService(
  new PostgresReconciliationRepository(database),
  storage,
  audit,
);
const purge = new PurgeService(
  new PostgresPurgeRepository(database),
  storage,
  config.protection.purgeEnabled,
  audit,
);
const knownSecrets = [
  await fs.readFile(config.ownerBootstrapTokenFile, "utf8").then((value) => value.trim()),
  new URL(config.databaseUrl).password ? decodeURIComponent(new URL(config.databaseUrl).password) : "",
  config.storage.passwordFile === undefined
    ? ""
    : await fs.readFile(config.storage.passwordFile, "utf8").then((value) => value.replace(/[\r\n]+$/, "")),
].filter((value) => value.length >= 8);
const recovery = new SaturnBackupService({
  spoolRoot: config.recovery.spoolDirectory,
  limits: config.recovery.limits,
  database: new PostgresCommandToolchain({
    databaseUrl: config.databaseUrl,
    database,
    pgDumpExecutable: config.recovery.pgDumpExecutable,
    pgRestoreExecutable: config.recovery.pgRestoreExecutable,
    pgDumpPrefixArgs: config.recovery.pgDumpPrefixArgs,
    pgRestorePrefixArgs: config.recovery.pgRestorePrefixArgs,
    ...(config.recovery.pgCommandConnectionArgs.length === 0 ? {} : { commandConnectionArgs: config.recovery.pgCommandConnectionArgs }),
    maximumDumpBytes: config.recovery.limits.maxMemberBytes,
  }),
  metadata: new DatabaseMetadataExporter(database),
  knownSecrets,
  repository: new PostgresRecoveryRepository(database),
  storage,
});
const shareRepository = new PostgresShareRepository(database);
const dropRepository = new PostgresDropRepository(database);
const fileService = new FileService(new PostgresFileRepository(database), storage, { ...config.limits, auditSink: audit });
const dropBuffer = new DropBufferStore({
  root: config.drop.bufferDirectory,
  maxBytes: async () => (await fileService.getUploadLimits()).bufferMaxBytes,
  minFreeBytes: config.drop.bufferMinFreeBytes,
  warningRatio: config.drop.bufferWarningRatio,
  criticalRatio: config.drop.bufferCriticalRatio,
  refusalRatio: config.drop.bufferRefusalRatio,
});
await dropBuffer.initialize();
const dropDrain = new DropDrainService({
  repository: dropRepository,
  buffer: dropBuffer,
  files: fileService,
  workers: config.drop.drainWorkers,
});
const archiveRunner = new ArchiveJobRunner(
  new PostgresArchiveJobRepository(database),
  fileService,
  config.archive,
  audit,
);
const runtime = buildWorker(config, database, new AdapterStorageHealthProbe(storage), {
  reconcile: async () => { await reconciliation.run("metadata"); },
  purge: async () => { await purge.run(); },
  backup: async () => {
    await fs.mkdir(config.recovery.archiveDirectory, { recursive: true, mode: 0o700 });
    const outputPath = path.join(config.recovery.archiveDirectory, `saturn-${new Date().toISOString().replaceAll(":", "-")}.zip`);
    const created = await recovery.createBackup({
      outputPath,
      publicConfiguration: publicConfig({ ...config, storage: storage.current().config }),
      deploymentManifestPath: path.resolve("compose.yaml"),
      migrationsDirectory: path.resolve("packages/database/migrations"),
      kind: "scheduled",
    });
    await recovery.publishToStorage(created);
  },
  maintain: async () => {
    const expired = await shareRepository.claimExpiredPackages(new Date(), 100);
    for (const item of expired) {
      if (await storage.exists(item.storagePath).catch(() => false)) await storage.delete(item.storagePath).catch(() => undefined);
      await shareRepository.markPackageExpired(item.id);
    }
  },
  drain: async () => dropDrain.drain(),
  archive: async () => archiveRunner.runNext(),
  close: async () => { await storage.close(); },
});
await runtime.startHeartbeat();
runtime.startBackgroundJobs();
await runtime.app.listen({ host: config.worker.host, port: config.worker.port });

const shutdown = async (): Promise<void> => {
  await runtime.app.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
watchRecoveredConfiguration(config, async () => { await shutdown(); process.exit(75); });
