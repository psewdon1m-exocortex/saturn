import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Database, migrate } from "@saturn/database";
import { LocalStorageAdapter } from "@saturn/storage";
import { expect, it } from "vitest";
import { PostgresReconciliationRepository } from "./postgres-reconciliation.repository.js";
import { ReconciliationService } from "./reconciliation.service.js";

const baseUrl = process.env.PIPELINE_TEST_DATABASE_URL;
it.skipIf(!baseUrl)("protects a live scan and recovers its running record after the owning database session disconnects", async () => {
  if (!baseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-reconcile-restart-"));
  const admin = new Database(baseUrl, { max: 1 });
  const storage = new LocalStorageAdapter(root);
  let db: Database | undefined, previous: Database | undefined, created = false;
  let release: (() => void) | undefined;
  try {
    await admin.withSql(sql => sql`CREATE DATABASE ${sql(name)}`); created = true;
    const url = new URL(baseUrl); url.pathname = `/${name}`;
    await migrate(url.toString());
    db = new Database(url.toString(), { max: 1, maintenanceBarrier: true });
    previous = new Database(url.toString(), { max: 1 });
    await storage.initialize();
    const roots = await db.withSql(sql => sql<{ storage_path: string }[]>`SELECT storage_path FROM resources WHERE parent_id='00000000-0000-7000-8000-000000000001'`);
    for (const item of roots) await storage.mkdir(item.storage_path);
    const interruptedId = randomUUID();
    // An old timestamp alone must never allow takeover of a live full hash scan.
    await previous.withSql(async sql => {
      const lease = await sql.reserve(); release = () => lease.release();
      await lease`SELECT pg_advisory_lock(hashtextextended('saturn-reconciliation',0))`;
      await lease`INSERT INTO reconciliation_runs(id,mode,state,started_at) VALUES(${interruptedId},'full_hash','running',now()-interval '7 days')`;
    });
    const repository = new PostgresReconciliationRepository(db);
    const service = new ReconciliationService(repository, storage);
    await expect(service.run("metadata")).rejects.toThrow("locked");
    expect((await repository.listRuns(10))[0]).toMatchObject({ id: interruptedId, state: "running" });
    // Closing the owner connection releases the session lock, as process death
    // would, but deliberately leaves its durable run record unfinished.
    release?.(); release = undefined;
    await previous.close(); previous = undefined;
    expect((await service.run("metadata")).state).toBe("complete");
    const runs = await repository.listRuns(10);
    const interrupted = runs.find(item => item.id === interruptedId);
    expect(interrupted).toMatchObject({ state: "failed", errorCode: "reconciliation_interrupted" });
    expect(interrupted?.finishedAt).toBeInstanceOf(Date);
    expect(runs.filter(item => item.state === "running")).toHaveLength(0);
    expect((await service.run("metadata")).state).toBe("complete");
  } finally {
    release?.(); await previous?.close(); await db?.close(); await storage.close();
    if (created) await admin.withSql(sql => sql`DROP DATABASE ${sql(name)} WITH (FORCE)`);
    await admin.close(); await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);
