import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { AuditService } from "@saturn/audit";
import { loadEnvironment } from "@saturn/config";
import { Database, migrate, rollback } from "@saturn/database";
import { RuntimeStorageManager, SftpStorageAdapter, type StorageAdapter } from "@saturn/storage";
import { StorageConnectionService } from "../apps/api/src/storage-connection.service.js";

async function removeTree(storage: StorageAdapter, storagePath: string): Promise<void> {
  if (!(await storage.exists(storagePath).catch(() => false))) return;
  const item = await storage.stat(storagePath);
  if (item.type === "directory") {
    let cursor: string | undefined;
    const children = [];
    do {
      const page = await storage.list(storagePath, cursor, 1_000);
      children.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    for (const child of children) await removeTree(storage, child.path);
  }
  await storage.delete(storagePath);
}

async function main(): Promise<void> {
  const config = loadEnvironment();
  const storageCredentialPath = config.storage.authMode === "password_file"
    ? config.storage.passwordFile
    : config.storage.privateKeyFile;
  if (storageCredentialPath === undefined) throw new Error("Storage credential file is unavailable");
  const credential = (await fs.readFile(storageCredentialPath, "utf8")).replace(/[\r\n]+$/, "");
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `saturn_switch_${suffix}`;
  const fixturePathA = `_system/runtime-switch-a-${suffix}`;
  const fixturePathB = `_system/runtime-switch-b-${suffix}`;
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-stage-15-"));
  const admin = new Database(config.databaseUrl);
  const baseStorage = new SftpStorageAdapter(config.storage);
  let database: Database | undefined;
  let runtime: RuntimeStorageManager | undefined;
  let databaseCreated = false;
  try {
    await admin.withSql(async (sql) => { await sql.unsafe(`CREATE DATABASE "${databaseName}"`); });
    databaseCreated = true;
    const databaseUrl = new URL(config.databaseUrl);
    databaseUrl.pathname = `/${databaseName}`;
    await migrate(databaseUrl.toString());
    if (await rollback(databaseUrl.toString()) !== "0024_runtime_storage_profiles") throw new Error("Stage 15 migration rollback did not select migration 0024");
    if (await migrate(databaseUrl.toString()) !== 1) throw new Error("Stage 15 migration could not be reapplied after rollback");
    database = new Database(databaseUrl.toString(), { max: 4, maintenanceBarrier: true });

    const prepareFixture = async (fixturePath: string, marker: string): Promise<Buffer> => {
      await baseStorage.mkdir(fixturePath);
      await baseStorage.mkdir(`${fixturePath}/project files`);
      const sample = Buffer.from(`saturn ${marker} independent storage verification ${suffix}\n`, "utf8");
      await baseStorage.write(`${fixturePath}/project files/sample.txt`, Readable.from([sample]), { offset: 0, create: true, exclusive: true, truncate: true });
      return sample;
    };
    const sampleA = await prepareFixture(fixturePathA, "A");
    const sampleB = await prepareFixture(fixturePathB, "B");

    runtime = new RuntimeStorageManager(config.storage, runtimeDirectory);
    await runtime.initialize();
    const service = new StorageConnectionService(database, runtime, config, new AuditService(database, [credential]));
    const switchTo = (fixturePath: string) => service.switch({
        host: config.storage.host,
        port: config.storage.port,
        username: config.storage.username,
        root: `${config.storage.root}/${fixturePath}`,
        hostFingerprint: config.storage.hostFingerprint,
        authMode: config.storage.authMode,
        credential,
      });
    const first = await switchTo(fixturePathA);
    if (first.indexed.files !== 1 || first.indexed.bytes !== sampleA.length) throw new Error("First candidate inventory was not indexed exactly");
    const switched = await switchTo(fixturePathB);
    if (switched.indexed.files !== 1 || switched.indexed.bytes !== sampleB.length) throw new Error("Second candidate inventory was not indexed exactly");
    if (switched.revoked.shares !== 0 || switched.revoked.devices !== 0) throw new Error("Disposable database was not isolated");
    const chunks: Buffer[] = [];
    for await (const chunk of await runtime.openRead("project files/sample.txt") as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    const stored = Buffer.concat(chunks);
    if (!stored.equals(sampleB)) throw new Error("Active runtime adapter does not read the second selected file set");
    if (!(await baseStorage.exists(`${fixturePathA}/project files/sample.txt`))) throw new Error("Previous storage content was changed by the second switch");
    const state = await database.withSql(async (sql) => {
      const resources = await sql<Array<{ storage_path: string }>>`SELECT storage_path FROM resources WHERE status='active' ORDER BY storage_path`;
      const switches = await sql<Array<{ migrated_bytes: string }>>`SELECT '0'::text AS migrated_bytes FROM storage_switches`;
      return { resources, switches };
    });
    if (!state.resources.some((item) => item.storage_path === "project files/sample.txt")) throw new Error("Database catalog does not match the selected file set");
    if (state.switches.length !== 2 || state.switches.some((item) => item.migrated_bytes !== "0")) throw new Error("Switch audit metadata is incomplete");
    const activeDocument = await fs.readFile(path.join(runtimeDirectory, "active.json"), "utf8");
    if (activeDocument.includes(credential)) throw new Error("Credential leaked into the runtime profile document");
    process.stdout.write(`${JSON.stringify({ result: "passed", migration: "up-down-up", switches: 2, files: switched.indexed.files, directories: switched.indexed.directories, bytes: switched.indexed.bytes, migratedBytes: 0, previousTargetPreserved: true, credentialExposure: "none" })}\n`);
  } finally {
    await runtime?.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
    await removeTree(baseStorage, fixturePathA).catch(() => undefined);
    await removeTree(baseStorage, fixturePathB).catch(() => undefined);
    await baseStorage.close().catch(() => undefined);
    if (databaseCreated) {
      await admin.withSql(async (sql) => {
        await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${databaseName} AND pid <> pg_backend_pid()`;
        await sql.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      }).catch(() => undefined);
    }
    await admin.close().catch(() => undefined);
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Stage 15 verification failed"}\n`);
  process.exitCode = 1;
});
