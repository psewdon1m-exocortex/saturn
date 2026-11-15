import { isolatedTestDatabase } from "../../../packages/database/src/isolated-test-database.fixture.js";
import { recordBackupPreEffect } from "./backup-coherent-test.fixture.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Database } from "@saturn/database";
import { BackupIngestService, PostgresBackupRepository } from "@saturn/backup-ingest";
import { LocalStorageAdapter } from "@saturn/storage";
import { expect, it } from "vitest";

const databaseUrl = process.env.PLUTO_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("resume HEAD waits for a live append and repairs a crashed append under the PostgreSQL run lock", async () => {
  if (!databaseUrl) throw new Error("Database test configuration is missing");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-backup-resume-"));
  const isolated = await isolatedTestDatabase(databaseUrl, undefined, root);
  const database = new Database(isolated.url);
  const storage = new LocalStorageAdapter(root), repository = new PostgresBackupRepository(database);
  const input = { repository, storage, pepper: "backup-resume-regression-pepper-32-characters", options: {
    enabled: true, trustClientCertificateHeader: false, tokenRotationGraceMs: 1000, uploadChunkMaxBytes: 1024, incompleteTtlMs: 60000,
    defaults: { requireEncryption: false, maxBackupBytes: 1024, dailyQuotaBytes: 8192, storedQuotaBytes: 8192,
      maxConcurrentRuns: 1, freshnessSlaMs: 86400000, retention: { daily: 1, weekly: 1, monthly: 1, yearly: 1 } }
  } };
  const writer = new BackupIngestService(input), restarted = new BackupIngestService(input);
  try {
    await storage.initialize();
    const enrolled = await writer.createService({ slug: "crash-test", name: "Crash test" }), context = await writer.authenticate(`Bearer ${enrolled.token}`);
    const payload = Buffer.from("precious archive"), run = await writer.createRun(context, "crash-test", { filename: "backup.zip", createdAt: new Date(), backupType: "full", expectedSize: payload.length, sha256: createHash("sha256").update(payload).digest("hex"), sourceVersion: "1", encrypted: false, idempotencyKey: randomUUID() });
    let entered!: () => void, release!: () => void;
    const writing = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    const firstChunk = Readable.from((async function* () { entered(); await gate; yield payload.subarray(0, 3); })());
    const append = writer.append(context, "crash-test", run.id, 0, 3, firstChunk);
    await writing;
    let headFinished = false;
    const head = restarted.uploadOffset(context, "crash-test", run.id).then(offset => { headFinished = true; return offset; });
    try { await new Promise(r => setTimeout(r, 50)); expect(headFinished).toBe(false); }
    finally { release(); }
    expect(await append).toBe(3); expect(await head).toBe(3);
    const claimed = await repository.claimAppend(context.service.id, run.id, 3, payload.length - 3, new Date());
    await recordBackupPreEffect(database, isolated.url, root, "backup-resume", [{runId: run.id, relativePath: claimed.tempPath, bytes: payload.subarray(0, 3)}]);
    await storage.write(claimed.tempPath, Readable.from(payload.subarray(3)), { offset: 3, create: false });
    // New service instance, same durable run; the previous writer no longer holds its lock.
    expect(await restarted.uploadOffset(context, "crash-test", run.id)).toBe(3);
    expect(await fs.readFile(path.join(root, claimed.tempPath))).toEqual(payload.subarray(0, 3));
    await restarted.append(context, "crash-test", run.id, 3, payload.length - 3, Readable.from(payload.subarray(3)));
    expect(await restarted.complete(context, "crash-test", run.id)).toMatchObject({ state: "complete" });
    expect(await fs.readFile(path.join(root, claimed.finalPath))).toEqual(payload);
  } finally {
    await storage.close(); await database.close(); if (!isolated.retained) await fs.rm(root, { recursive: true, force: true });
  }
}, process.env.SATURN_TEST_ISOLATION_EVIDENCE_DIR === undefined ? undefined : 30_000);
