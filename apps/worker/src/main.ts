import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnvironment, publicConfig } from "@saturn/config";
import { Database } from "@saturn/database";
import { AuditService } from "@saturn/audit";
import {
  PostgresPurgeRepository,
  PostgresReconciliationRepository,
  PurgeService,
  ReconciliationService,
} from "@saturn/protection";
import { SftpStorageAdapter } from "@saturn/storage";
import { SftpHealthProbe } from "@saturn/storage-health";
import {
  DatabaseMetadataExporter,
  PostgresCommandToolchain,
  PostgresRecoveryRepository,
  SaturnBackupService,
} from "@saturn/recovery";
import { buildWorker } from "./worker.js";
import { PostgresShareRepository } from "@saturn/shares";

const config = loadEnvironment();
const database = new Database(config.databaseUrl, { max: 5 });
const storage = new SftpStorageAdapter(config.storage);
const reconciliation = new ReconciliationService(
  new PostgresReconciliationRepository(database),
  storage,
  new AuditService(database),
);
const purge = new PurgeService(
  new PostgresPurgeRepository(database),
  storage,
  config.protection.purgeEnabled,
  new AuditService(database),
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
    maximumDumpBytes: config.recovery.limits.maxMemberBytes,
  }),
  metadata: new DatabaseMetadataExporter(database),
  knownSecrets,
  repository: new PostgresRecoveryRepository(database),
  storage,
});
const shareRepository = new PostgresShareRepository(database);
const runtime = buildWorker(config, database, new SftpHealthProbe(config.storage), {
  reconcile: async () => { await reconciliation.run("metadata"); },
  purge: async () => { await purge.run(); },
  backup: async () => {
    await fs.mkdir(config.recovery.archiveDirectory, { recursive: true, mode: 0o700 });
    const outputPath = path.join(config.recovery.archiveDirectory, `saturn-${new Date().toISOString().replaceAll(":", "-")}.zip`);
    const created = await recovery.createBackup({
      outputPath,
      publicConfiguration: publicConfig(config),
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
