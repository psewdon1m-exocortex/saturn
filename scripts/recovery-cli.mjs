import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, archiveArgument, confirmation] = process.argv.slice(2);
const validCommands = new Set(["backup", "validate", "restore-clean", "restore-replace"]);
if (command === undefined || !validCommands.has(command)) {
  throw new Error("Usage: recovery-cli.mjs backup | validate <archive> | restore-clean <archive> | restore-replace <archive> --confirm-replace");
}

const runtimeRoot = process.env.VAULT_RUNTIME_ROOT;
const runtimeRequire = runtimeRoot === undefined ? undefined : createRequire(path.join(runtimeRoot, "api/package.json"));
const moduleUrl = name => pathToFileURL(runtimeRequire === undefined ? path.join(vaultRoot, "packages", name, "dist/index.js") : runtimeRequire.resolve(`@saturn/${name}`));
const recovery = await import(moduleUrl("recovery"));
const configModule = await import(moduleUrl("config"));
const databaseModule = await import(moduleUrl("database"));
const storageModule = await import(moduleUrl("storage"));
const config = configModule.loadEnvironment(process.env, vaultRoot);

if (command === "validate") {
  if (archiveArgument === undefined) throw new Error("validate requires an archive path");
  await fs.mkdir(config.recovery.spoolDirectory, { recursive: true, mode: 0o700 });
  const extractionDirectory = await fs.mkdtemp(path.join(config.recovery.spoolDirectory, "validation-"));
  await fs.rm(extractionDirectory, { recursive: true, force: true });
  try {
    const result = await new recovery.BackupArchiveValidator(config.recovery.limits).validate(
      path.resolve(archiveArgument),
      extractionDirectory,
    );
    process.stdout.write(`${JSON.stringify({
      state: "valid",
      backupId: result.manifest.backupId,
      createdAt: result.manifest.createdAt,
      archiveBytes: result.archiveBytes,
      extractedBytes: result.extractedBytes,
      members: result.manifest.members.length,
      sha256: result.archiveSha256,
    })}\n`);
  } finally {
    await fs.rm(extractionDirectory, { recursive: true, force: true });
  }
  process.exit(0);
}

const database = new databaseModule.Database(config.databaseUrl, { max: 3 });
const storage = new storageModule.RuntimeStorageManager(config.storage, config.storageRuntimeConfigDirectory);
await storage.initialize();
try {
  const databaseUrl = new URL(config.databaseUrl);
  const knownSecrets = [
    await fs.readFile(config.ownerBootstrapTokenFile, "utf8").then((value) => value.trim()),
    databaseUrl.password ? decodeURIComponent(databaseUrl.password) : "",
    config.storage.passwordFile === undefined
      ? ""
      : await fs.readFile(config.storage.passwordFile, "utf8").then((value) => value.replace(/[\r\n]+$/, "")),
  ].filter((value) => value.length >= 8);
  const service = new recovery.SaturnBackupService({
    spoolRoot: config.recovery.spoolDirectory,
    limits: config.recovery.limits,
    database: new recovery.PostgresCommandToolchain({
      databaseUrl: config.databaseUrl,
      database,
      pgDumpExecutable: config.recovery.pgDumpExecutable,
      pgRestoreExecutable: config.recovery.pgRestoreExecutable,
      pgDumpPrefixArgs: config.recovery.pgDumpPrefixArgs,
      pgRestorePrefixArgs: config.recovery.pgRestorePrefixArgs,
      ...(config.recovery.pgCommandConnectionArgs.length === 0 ? {} : { commandConnectionArgs: config.recovery.pgCommandConnectionArgs }),
      maximumDumpBytes: config.recovery.limits.maxMemberBytes,
    }),
    metadata: new recovery.DatabaseMetadataExporter(database),
    knownSecrets,
    repository: new recovery.PostgresRecoveryRepository(database),
    ...(storage === undefined ? {} : { storage }),
  });
  const safeInputs = {
    publicConfiguration: configModule.publicConfig({ ...config, storage: storage.current().config }),
    deploymentManifestPath: runtimeRoot === undefined ? path.join(vaultRoot, "compose.yaml") : path.join(runtimeRoot, "recovery/compose.yaml"),
    migrationsDirectory: runtimeRoot === undefined ? path.join(vaultRoot, "packages", "database", "migrations") : path.join(runtimeRoot, "recovery/migrations"),
  };

  if (command === "backup") {
    await fs.mkdir(config.recovery.archiveDirectory, { recursive: true, mode: 0o700 });
    const localPath = path.join(config.recovery.archiveDirectory, `saturn-${new Date().toISOString().replaceAll(":", "-")}.zip`);
    const created = await service.createBackup({ ...safeInputs, outputPath: localPath, kind: "manual" });
    const published = await service.publishToStorage(created);
    await fs.rm(localPath, { force: true });
    process.stdout.write(`${JSON.stringify({ state: "complete", backupId: created.manifest.backupId, ...published })}\n`);
  } else {
    if (archiveArgument === undefined) throw new Error(`${command} requires an archive path`);
    if (command === "restore-replace" && confirmation !== "--confirm-replace") {
      throw new Error("Replacement restore requires --confirm-replace");
    }
    await fs.mkdir(config.recovery.archiveDirectory, { recursive: true, mode: 0o700 });
    const snapshotOutputPath = path.join(config.recovery.archiveDirectory, `pre-restore-${new Date().toISOString().replaceAll(":", "-")}.zip`);
    const mode = command === "restore-clean" ? "clean" : "replace";
    const result = await service.restore({
      archivePath: path.resolve(archiveArgument),
      mode,
      configuration: await storageModule.createStorageRecoveryParticipant(config, storage),
      ...(mode === "clean" ? {} : { snapshotOutputPath, snapshotInput: safeInputs }),
    }, () => databaseModule.migrate(config.databaseUrl, safeInputs.migrationsDirectory), action => database.withExclusiveMaintenance(action));
    process.stdout.write(`${JSON.stringify({ state: "complete", ...result })}\n`);
  }
} finally {
  await storage?.close().catch(() => undefined);
  await database.close().catch(() => undefined);
}
