import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(vaultRoot, "artifacts", "verification", "stage-05-vault-backup-recovery.json");
const pnpmScript = path.join(vaultRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const project = "vault-stage5";
const container = `${project}-postgres-1`;
const report = { schema: "vault.stage-verification.v1", stage: 5, startedAt: new Date().toISOString(), success: false, checks: [] };
let environment = process.env;
let stageDirectory;
const databasesToClose = [];

function pass(name, detail = {}) {
  report.checks.push({ name, status: "pass", detail });
  process.stdout.write(`PASS ${name}\n`);
}

function run(command, args, selectedEnvironment = environment, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd: vaultRoot,
    env: selectedEnvironment,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(" ")} failed: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-3_000)}`);
  }
  return result;
}

function databaseUrl(base, name) {
  const parsed = new URL(base);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function recreateDatabase(name) {
  if (!/^vault_stage5_[a-z]+$/.test(name)) throw new Error("Refusing an unexpected database target");
  run(docker, ["exec", container, "dropdb", "--if-exists", "--force", "-U", "vault", name]);
  run(docker, ["exec", container, "createdb", "-U", "vault", "-O", "vault", "-T", "template0", name]);
}

async function scanFilesForSecrets(root, secrets) {
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else {
        const bytes = await fs.readFile(target);
        for (const secret of secrets) if (bytes.includes(Buffer.from(secret))) throw new Error("Known secret found in extracted backup material");
      }
    }
  };
  await visit(root);
}

try {
  run(process.execPath, [pnpmScript, "install", "--frozen-lockfile"]);
  run(process.execPath, [pnpmScript, "lint"]);
  run(process.execPath, [pnpmScript, "typecheck"]);
  run(process.execPath, [pnpmScript, "test"]);
  run(process.execPath, [pnpmScript, "build"]);
  pass("workspace quality gates", { install: "frozen", lint: "pass", typecheck: "pass", tests: "pass", build: "pass" });

  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  const prepared = await prepareDevelopmentEnvironment();
  environment = { ...process.env, ...prepared.environment };
  run(docker, ["compose", "-p", project, "up", "-d", "--wait"]);
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  const rollback = run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "rollback"]);
  if (!rollback.stdout.includes("0004_recovery")) throw new Error("Recovery migration rollback did not select 0004");
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  pass("recovery schema migration round trip", { migration: "0004_recovery" });

  const recovery = await import(pathToFileURL(path.join(vaultRoot, "packages", "recovery", "dist", "index.js")));
  const databaseModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "database", "dist", "index.js")));
  const storageModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "storage", "dist", "index.js")));
  const configModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "config", "dist", "index.js")));
  const config = configModule.loadEnvironment(environment, vaultRoot);
  const toolchain = (name, database) => {
    if (!/^vault(?:_stage5_[a-z]+)?$/.test(name)) throw new Error("Unsafe verifier database name");
    return new recovery.PostgresCommandToolchain({
      databaseUrl: `postgres://vault@127.0.0.1:5432/${name}`,
      database,
      pgDumpExecutable: docker,
      pgRestoreExecutable: docker,
      pgDumpPrefixArgs: ["exec", container, "pg_dump"],
      pgRestorePrefixArgs: ["exec", "-i", container, "pg_restore"],
      maximumDumpBytes: 96 * 1024 * 1024,
    });
  };
  const sourceDatabase = new databaseModule.Database(environment.DATABASE_URL, { max: 2 });
  databasesToClose.push(sourceDatabase);
  const sampleId = randomUUID();
  await sourceDatabase.withSql(async (sql) => {
    await sql`
      INSERT INTO resources (id, type, parent_id, name, storage_path, size_bytes, sha256, status)
      VALUES (${sampleId}, 'file', '00000000-0000-7000-8000-000000000001', 'recovery-proof.txt',
              'sync/recovery-proof.txt', 5, ${createHash("sha256").update("proof").digest("hex")}, 'active')
    `;
    await sql`
      INSERT INTO audit_events (id, actor_type, action, resource_id, outcome, correlation_id, details)
      VALUES (${randomUUID()}, 'system', 'recovery.fixture.created', ${sampleId}, 'success', ${`stage5-${sampleId}`}, '{}'::jsonb)
    `;
  });

  stageDirectory = path.join(vaultRoot, ".tmp", `stage5-${randomUUID()}`);
  await fs.mkdir(stageDirectory, { recursive: true });
  const limits = {
    maxArchiveBytes: 128 * 1024 * 1024,
    maxMemberBytes: 96 * 1024 * 1024,
    maxExtractedBytes: 192 * 1024 * 1024,
    maxEntries: 512,
    maxCompressionRatio: 200,
    maxManifestBytes: 1024 * 1024,
  };
  const ownerSecret = (await fs.readFile(environment.OWNER_BOOTSTRAP_TOKEN_FILE, "utf8")).trim();
  const databaseSecret = decodeURIComponent(new URL(environment.DATABASE_URL).password);
  const knownSecrets = [ownerSecret, databaseSecret];
  const sourceService = new recovery.SaturnBackupService({
    spoolRoot: path.join(stageDirectory, "source-spool"),
    limits,
    database: toolchain("vault", sourceDatabase),
    metadata: new recovery.DatabaseMetadataExporter(sourceDatabase, 2),
    knownSecrets,
    repository: new recovery.PostgresRecoveryRepository(sourceDatabase),
  });
  const archivePath = path.join(stageDirectory, "source.zip");
  const rssBefore = process.memoryUsage().rss;
  const created = await sourceService.createBackup({
    outputPath: archivePath,
    publicConfiguration: configModule.publicConfig(config),
    deploymentManifestPath: path.join(vaultRoot, "compose.yaml"),
    migrationsDirectory: path.join(vaultRoot, "packages", "database", "migrations"),
    kind: "restore_drill",
  });
  const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - rssBefore);
  const validationDirectory = path.join(stageDirectory, "independent-validation");
  const validated = await new recovery.BackupArchiveValidator(limits).validate(archivePath, validationDirectory);
  await scanFilesForSecrets(validationDirectory, knownSecrets);
  const archiveBytes = await fs.readFile(archivePath);
  for (const secret of knownSecrets) if (archiveBytes.includes(Buffer.from(secret))) throw new Error("Known secret found in final ZIP bytes");
  pass("manifest, digest and plaintext-secret boundary", {
    members: validated.manifest.members.length,
    archiveBytes: created.archiveBytes,
    extractedBytes: created.extractedBytes,
    rssDeltaBytes,
  });

  const storageRoot = path.join(stageDirectory, "storage");
  const localStorage = new storageModule.LocalStorageAdapter(storageRoot);
  await localStorage.initialize();
  const publisher = new recovery.SaturnBackupService({
    spoolRoot: path.join(stageDirectory, "publish-spool"),
    limits,
    database: toolchain("vault", sourceDatabase),
    metadata: new recovery.DatabaseMetadataExporter(sourceDatabase),
    storage: localStorage,
  });
  const published = await publisher.publishToStorage(created);
  const remote = await localStorage.openRead(published.storagePath);
  const remoteHash = createHash("sha256");
  for await (const chunk of remote) remoteHash.update(chunk);
  if (remoteHash.digest("hex") !== created.archiveSha256) throw new Error("Storage publication read-back failed");
  await localStorage.delete(published.storagePath);
  await localStorage.close();
  pass("StorageAdapter backup publication and cleanup", { storagePathClass: "backups/gateway/<generated>.zip", bytes: published.bytes });

  recreateDatabase("vault_stage5_clean");
  const cleanDatabase = new databaseModule.Database(databaseUrl(environment.DATABASE_URL, "vault_stage5_clean"), { max: 2 });
  databasesToClose.push(cleanDatabase);
  const cleanService = new recovery.SaturnBackupService({
    spoolRoot: path.join(stageDirectory, "clean-spool"),
    limits,
    database: toolchain("vault_stage5_clean", cleanDatabase),
    metadata: new recovery.DatabaseMetadataExporter(cleanDatabase),
  });
  const cleanResult = await cleanService.restore({ archivePath, mode: "clean" });
  if (cleanResult.verification.resources < 2 || cleanResult.verification.auditEvents < 1) throw new Error("Clean restore lost authoritative rows");
  pass("clean compatible database restore", { verification: cleanResult.verification, measuredRtoMs: cleanResult.measuredRtoMs });

  recreateDatabase("vault_stage5_replace");
  const replaceUrl = databaseUrl(environment.DATABASE_URL, "vault_stage5_replace");
  await databaseModule.migrate(replaceUrl, path.join(vaultRoot, "packages", "database", "migrations"));
  const replaceDatabase = new databaseModule.Database(replaceUrl, { max: 2 });
  databasesToClose.push(replaceDatabase);
  const replacementMarker = randomUUID();
  await replaceDatabase.withSql((sql) => sql`
    INSERT INTO system_metadata (key, value) VALUES ('replacement_marker', ${sql.json({ id: replacementMarker })})
  `);
  const replaceService = new recovery.SaturnBackupService({
    spoolRoot: path.join(stageDirectory, "replace-spool"),
    limits,
    database: toolchain("vault_stage5_replace", replaceDatabase),
    metadata: new recovery.DatabaseMetadataExporter(replaceDatabase, 2),
    knownSecrets,
    repository: new recovery.PostgresRecoveryRepository(replaceDatabase),
  });
  const snapshotInput = {
    publicConfiguration: configModule.publicConfig(config),
    deploymentManifestPath: path.join(vaultRoot, "compose.yaml"),
    migrationsDirectory: path.join(vaultRoot, "packages", "database", "migrations"),
  };
  const replaceResult = await replaceService.restore({
    archivePath,
    mode: "replace",
    snapshotOutputPath: path.join(stageDirectory, "replace-snapshot.zip"),
    snapshotInput,
  }, () => databaseModule.migrate(replaceUrl, path.join(vaultRoot, "packages", "database", "migrations")));
  const markerAfterReplace = await replaceDatabase.withSql((sql) => sql`SELECT value FROM system_metadata WHERE key = 'replacement_marker'`);
  if (markerAfterReplace.length !== 0) throw new Error("Replacement restore did not replace target state");
  pass("replacement restore with verified pre-restore snapshot", { measuredRtoMs: replaceResult.measuredRtoMs, snapshot: true });

  const rollbackMarker = randomUUID();
  await replaceDatabase.withSql((sql) => sql`
    INSERT INTO system_metadata (key, value) VALUES ('rollback_marker', ${sql.json({ id: rollbackMarker })})
  `);
  let migrationCalls = 0;
  await replaceService.restore({
    archivePath,
    mode: "replace",
    snapshotOutputPath: path.join(stageDirectory, "rollback-snapshot.zip"),
    snapshotInput,
  }, async () => {
    migrationCalls += 1;
    if (migrationCalls === 1) throw new Error("injected post-restore verification failure");
    await databaseModule.migrate(replaceUrl, path.join(vaultRoot, "packages", "database", "migrations"));
  }).then(
    () => { throw new Error("Injected restore failure unexpectedly succeeded"); },
    (error) => { if (!String(error).includes("injected post-restore")) throw error; },
  );
  const rollbackRows = await replaceDatabase.withSql((sql) => sql`SELECT value FROM system_metadata WHERE key = 'rollback_marker'`);
  if (rollbackRows[0]?.value?.id !== rollbackMarker) throw new Error("Pre-restore snapshot rollback did not preserve original state");
  pass("failed-restore snapshot rollback", { restoreAttempts: 2, originalMarkerPreserved: true });

  const spoolRoots = ["source-spool", "publish-spool", "clean-spool", "replace-spool"];
  for (const spool of spoolRoots) {
    const entries = await fs.readdir(path.join(stageDirectory, spool)).catch(() => []);
    if (entries.length !== 0) throw new Error(`Recovery spool was not cleaned: ${spool}`);
  }
  pass("bounded spool cleanup and recovery evidence", {
    rpoTargetMs: 6 * 60 * 60 * 1_000,
    rtoTargetMs: 4 * 60 * 60 * 1_000,
    measuredCleanRtoMs: cleanResult.measuredRtoMs,
    measuredReplaceRtoMs: replaceResult.measuredRtoMs,
    peakFixtureExtractedBytes: created.extractedBytes,
    rssDeltaBytes,
  });

  pass("hostile archive matrix", {
    unitTests: ["traversal", "corrupt", "unknown-member", "digest-mismatch", "oversized-member", "compression-ratio", "pre-mutation rejection"],
  });
  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  for (const database of databasesToClose.reverse()) await database.close().catch(() => undefined);
  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  if (stageDirectory !== undefined) await fs.rm(stageDirectory, { recursive: true, force: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
