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
  StorageCatalogService,
  IntegrityScrubService,
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
import { PostgresShareRepository, ShareService } from "@saturn/shares";
import { DropBufferStore, DropDrainService, PostgresDropRepository } from "@saturn/drop";
import { GuardedRuntime } from "../../../packages/sync/src/guarded-runtime.js";
import { backendOwnerProcessReporter } from "../../../packages/recovery/src/backend-owner-ipc.js";
import { ArchiveJobRunner, PostgresArchiveJobRepository } from "@saturn/archive";

const config = loadEnvironment();
const database = new Database(config.databaseUrl, { max: 5, maintenanceBarrier: true });
const storageRuntime = new RuntimeStorageManager(config.storage, config.storageRuntimeConfigDirectory);
await storageRuntime.initialize();
const audit = new AuditService(database);
const ownerReporter = backendOwnerProcessReporter();
const guarded = await GuardedRuntime.create({ database, storage: storageRuntime,
  ...(ownerReporter === undefined ? {} : { onBackendOwner: ownerReporter }),
  ...(process.env.SATURN_GUARDED_RUNTIME_MANIFEST === undefined ? {} : { manifestFile: process.env.SATURN_GUARDED_RUNTIME_MANIFEST }),
  files: { ...config.limits, auditSink: audit },
  device: { pepper: (await fs.readFile(config.device.pepperFile, "utf8")).replace(/[\r\n]+$/, ""), options: {
    enabled: config.device.enabled, publicOrigin: config.publicOrigin, uploadChunkMaxBytes: config.limits.uploadChunkMaxBytes,
    propfindMaxItems: config.device.propfindMaxItems, deleteMaxItems: config.device.deleteMaxItems, deleteWindowMs: config.device.deleteWindowMs,
  } },
});
const storage = guarded.legacyStorage;
const storageCatalog = new StorageCatalogService(database, guarded.catalogStorage, audit);
const reconciliation = new ReconciliationService(
  new PostgresReconciliationRepository(database),
  storage,
  audit,
);
const integrityScrub = new IntegrityScrubService(database, storage,guarded.scrubOptions);
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
const fileService = guarded.legacyFiles;
const shares = new ShareService({ repository: shareRepository, files: fileService, storage, audit,
  pepper: (await fs.readFile(config.share.pepperFile, "utf8")).replace(/[\r\n]+$/, ""), options: { ...config.share, publicOrigin: config.publicOrigin } });
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
  chunkBytes: config.limits.uploadChunkMaxBytes,
});
const archiveRunner = new ArchiveJobRunner(
  new PostgresArchiveJobRepository(database),
  fileService,
  config.archive,
  audit,
);
const runtime = buildWorker(config, database, new AdapterStorageHealthProbe(storage), {
  ready: async () => guarded.assertReady(),
  storageCatalog: async () => storageCatalog.runNext(),
  reconcile: async (signal) => { await reconciliation.run("metadata", signal === undefined ? {} : { signal }); },
  scrub: async () => { await integrityScrub.run(); },
  purge: async () => { await purge.run(); },
  backup: async () => {
    await fs.mkdir(config.recovery.archiveDirectory, { recursive: true, mode: 0o700 });
    const outputPath = path.join(config.recovery.archiveDirectory, `saturn-${new Date().toISOString().replaceAll(":", "-")}.zip`);
    const created = await recovery.createBackup({
      outputPath,
      publicConfiguration: publicConfig({ ...config, storage: storageRuntime.current().config }),
      deploymentManifestPath: process.env.VAULT_RUNTIME_ROOT === undefined ? path.resolve("compose.yaml") : path.join(process.env.VAULT_RUNTIME_ROOT, "recovery/compose.yaml"),
      migrationsDirectory: process.env.VAULT_RUNTIME_ROOT === undefined ? path.resolve("packages/database/migrations") : path.join(process.env.VAULT_RUNTIME_ROOT, "recovery/migrations"),
      kind: "scheduled",
    });
    try { await recovery.publishToStorage(created); }
    finally { await fs.rm(outputPath, { force: true }); }
  },
  maintain: async () => { await shares.cleanupExpiredPackages(); },
  retention: async () => guarded.maintainRetention(),
  snapshots: async () => guarded.maintainSnapshots(),
  drain: async () => { await fileService.cleanupAbandonedUploads(); await fileService.recoverInterruptedUploads(); return dropDrain.drain(); },
  archive: async () => archiveRunner.runNext(),
  sharePackage: async () => shares.runNextPackage(),
  close: async () => { await guarded.close(); },
});
await database.reconcileInactiveFileLocks();
await runtime.startHeartbeat();
runtime.startBackgroundJobs();
await runtime.app.listen({ host: config.worker.host, port: config.worker.port });

const shutdown = async (): Promise<void> => {
  await runtime.app.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
watchRecoveredConfiguration(config, async () => { await shutdown(); process.exit(75); });
