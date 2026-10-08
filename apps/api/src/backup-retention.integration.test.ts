import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Database, migrate } from "@saturn/database";
import { AuditService } from "@saturn/audit";
import { FileService, PostgresFileRepository, BACKUPS_RESOURCE_ID } from "@saturn/file-core";
import { BackupIngestService, PostgresBackupRepository } from "@saturn/backup-ingest";
import { LocalStorageAdapter } from "@saturn/storage";
import { expect, it } from "vitest";

const databaseUrl = process.env.PLUTO_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("retention preserves audit identities, expires removed versions and retries a lost catalog acknowledgement", async () => {
  if (!databaseUrl) throw new Error("Database test configuration is missing");
  const schema = `retention_${randomUUID().replaceAll("-", "")}`, admin = new Database(databaseUrl);
  await admin.withSql(sql => sql.unsafe(`CREATE SCHEMA ${schema}`));
  const url = new URL(databaseUrl); url.searchParams.set("options", `-c search_path=${schema}`);
  await migrate(url.toString(), path.resolve("../../packages/database/migrations"));
  const database = new Database(url.toString()), root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-retention-"));
  const storage = new LocalStorageAdapter(root), repository = new PostgresFileRepository(database), audit = new AuditService(database);
  const files = new FileService(repository, storage, { auditSink: audit });
  const backups = new BackupIngestService({ repository: new PostgresBackupRepository(database), storage, audit,
    pepper: "retention-regression-test-pepper-32-characters", options: { enabled: true, trustClientCertificateHeader: false,
      tokenRotationGraceMs: 1000, uploadChunkMaxBytes: 1024, incompleteTtlMs: 60000,
      defaults: { requireEncryption: false, maxBackupBytes: 1024, dailyQuotaBytes: 8192, storedQuotaBytes: 8192,
        maxConcurrentRuns: 1, freshnessSlaMs: 86400000, retention: { daily: 1, weekly: 1, monthly: 1, yearly: 1 } } },
    catalog: { publish: async run => { await files.adoptExistingFile({ rootId: BACKUPS_RESOURCE_ID, storagePath: run.finalPath, sizeBytes: run.expectedSize, sha256: run.expectedSha256, mimeType: "application/zip" }); },
      purge: run => files.purgeAdoptedFile({ rootId: BACKUPS_RESOURCE_ID, storagePath: run.finalPath, sha256: run.expectedSha256 }) } });
  try {
    await storage.initialize(); await files.initializeStorage();
    const enrolled = await backups.createService({ slug: "precious", name: "Precious" }), context = await backups.authenticate(`Bearer ${enrolled.token}`);
    const artifact = async (generation: number) => {
      const bytes = Buffer.from(`valuable backup ${String(generation)}`), sha256 = createHash("sha256").update(bytes).digest("hex");
      const run = await backups.createRun(context, "precious", { filename: "backup.zip", createdAt: new Date(`2026-10-06T10:00:0${String(generation)}Z`), backupType: "full", expectedSize: bytes.length, sha256, sourceVersion: "1", encrypted: false, idempotencyKey: randomUUID() });
      await backups.append(context, "precious", run.id, 0, bytes.length, Readable.from(bytes)); await backups.complete(context, "precious", run.id);
      const stored = await database.withSql(sql => sql<{ id: string; storage_path: string }[]>`SELECT r.id,r.storage_path FROM resources r JOIN file_versions v ON v.id=r.current_version_id WHERE v.sha256=${sha256}`);
      const resource = stored[0]; if (resource === undefined) throw new Error("Published archive is missing");
      return { id: run.id, resource, bytes };
    };
    const old = await artifact(1), newest = await artifact(2);
    await backups.recordRestoreTest(old.id, { method: "integrity_check", outcome: "success" });
    // Simulate a process/connection failure between physical deletion and its
    // catalog acknowledgement. The next retention pass must finish safely.
    const remove = repository.removeAdoptedFile.bind(repository); let failed = false;
    repository.removeAdoptedFile = async (...args) => { if (!failed) { failed = true; throw new Error("lost catalog connection"); } return remove(...args); };
    expect(await backups.applyRetention()).toMatchObject({ candidates: 1, purged: 0, failed: 1 });
    expect(await backups.applyRetention()).toMatchObject({ candidates: 1, purged: 1, failed: 0 });
    expect(await backups.applyRetention()).toMatchObject({ candidates: 0, purged: 0, failed: 0 });
    expect(await files.getResource(old.resource.id)).toMatchObject({ status: "purged" });
    expect((await files.listVersions(old.resource.id)).every(version => version.state === "expired")).toBe(true);
    expect(await storage.exists(old.resource.storage_path)).toBe(false);
    expect(await fs.readFile(path.join(root, newest.resource.storage_path))).toEqual(newest.bytes);
    const references = await database.withSql(sql => sql<{ count: number }[]>`SELECT count(*)::int AS count FROM audit_events WHERE resource_id=${old.resource.id}`);
    expect(references[0]?.count).toBeGreaterThan(0);
    expect((await files.getResource(BACKUPS_RESOURCE_ID)).sizeBytes).toBe(newest.bytes.length);
  } finally {
    await storage.close(); await database.close(); await fs.rm(root, { recursive: true, force: true });
    await admin.withSql(sql => sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)); await admin.close();
  }
});
