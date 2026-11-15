import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Database, migrate } from "@saturn/database";
import { FileService, PostgresFileRepository, SYNC_RESOURCE_ID } from "@saturn/file-core";
import { LocalStorageAdapter } from "@saturn/storage";
import { expect, it } from "vitest";
import { PostgresReconciliationRepository } from "./postgres-reconciliation.repository.js";
import { ReconciliationService } from "./reconciliation.service.js";
import { checkpointReconciliation } from "./storage-catalog-checkpoint.fixture.js";

const baseUrl = process.env.PIPELINE_TEST_DATABASE_URL;
const evidence = process.env.SATURN_RECONCILIATION_EVIDENCE_DIR;
async function custody(name: string, directory: string, scenario: string) {
  if (evidence === undefined) return undefined;
  const root = await fs.realpath(os.tmpdir());
  if (!path.isAbsolute(evidence) || path.dirname(await fs.realpath(evidence)) !== root
    || path.dirname(await fs.realpath(directory)) !== root || !/^audit_[a-f0-9]{32}$/.test(name)) {
    throw new Error("Reconciliation evidence paths are outside the private fixture");
  }
  const proof = await fs.mkdtemp(path.join(root, "saturn-reconcile-proof-"));
  const record = JSON.stringify({ name, directory, scenario, proof });
  await fs.writeFile(path.join(proof, "ownership.json"), record, { flag: "wx" });
  await fs.writeFile(path.join(evidence, scenario + ".json"), record, { flag: "wx" });
  return proof;
}
it.skipIf(!baseUrl)("protects a live scan and recovers its running record after the owning database session disconnects", async () => {
  if (!baseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-reconcile-restart-"));
  const proof = await custody(name, root, "disconnect");
  const admin = new Database(baseUrl, { max: 1 });
  const storage = new LocalStorageAdapter(proof === undefined ? root : path.join(root, "storage"));
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
    await checkpointReconciliation("before-disconnect", db, url.toString(), root, proof);
    release?.(); release = undefined;
    await previous.close(); previous = undefined;
    expect((await service.run("metadata")).state).toBe("complete");
    const runs = await repository.listRuns(10);
    const interrupted = runs.find(item => item.id === interruptedId);
    expect(interrupted).toMatchObject({ state: "failed", errorCode: "reconciliation_interrupted" });
    expect(interrupted?.finishedAt).toBeInstanceOf(Date);
    expect(runs.filter(item => item.state === "running")).toHaveLength(0);
    expect((await service.run("metadata")).state).toBe("complete");
    if (proof !== undefined) await fs.writeFile(path.join(proof, "result.json"), JSON.stringify({ interruptedId }), { flag: "wx" });
  } finally {
    release?.(); await previous?.close(); await db?.close(); await storage.close();
    if (created && proof === undefined) await admin.withSql(sql => sql`DROP DATABASE ${sql(name)}`);
    await admin.close(); if (proof === undefined) await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);

it.skipIf(!baseUrl).each([false, true])("keeps a durable interrupted overwrite active until recovery (replacement at target: %s)", async (replacementAtTarget) => {
  if (!baseUrl) throw new Error("PIPELINE_TEST_DATABASE_URL is required");
  const name = `audit_${randomUUID().replaceAll("-", "")}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-reconcile-overwrite-"));
  const proof = await custody(name, root, replacementAtTarget ? "target" : "temporary");
  const admin = new Database(baseUrl, { max: 1 });
  const storage = new LocalStorageAdapter(proof === undefined ? root : path.join(root, "storage"));
  let db: Database | undefined, created = false;
  try {
    await admin.withSql(sql => sql`CREATE DATABASE ${sql(name)}`); created = true;
    const url = new URL(baseUrl); url.pathname = `/${name}`;
    await migrate(url.toString());
    db = new Database(url.toString(), { max: 1, maintenanceBarrier: true });
    const files = new PostgresFileRepository(db), fileService = new FileService(files, storage);
    await storage.initialize(); await fileService.initializeStorage();
    const upload = async (body: string, overwriteResourceId?: string) => {
      const item = await fileService.createUpload({ parentId: SYNC_RESOURCE_ID, filename: "setting-1.conf", expectedSize: Buffer.byteLength(body), idempotencyKey: `dav-upload-${randomUUID()}`, auditActor: { type: "device_token", id: "recovery-probe" }, ...(overwriteResourceId === undefined ? {} : { overwriteResourceId }) });
      await fileService.appendUpload(item.id, 0, Buffer.byteLength(body), Readable.from(body));
      return item;
    };
    const original = (await fileService.completeUpload((await upload("original")).id)).resource;
    if (original.currentVersionId === undefined) throw new Error("Version missing");
    const overwrite = await upload("replacement", original.id);
    expect(overwrite.auditActorType).toBe("device_token");
    const archive = `_system/versions/${original.id}/${original.currentVersionId}/setting-1.conf`;
    await checkpointReconciliation("before-rename", db, url.toString(), root, proof);
    await files.setUploadState(overwrite.id, "committing", { actualSha256: createHash("sha256").update("replacement").digest("hex"), errorCode: "reconciliation_required" });
    await storage.rename(overwrite.targetPath, archive);
    if (replacementAtTarget) await storage.rename(overwrite.tempPath, overwrite.targetPath);
    await checkpointReconciliation("before-recovery", db, url.toString(), root, proof);
    // Simulate process death: volatile locks are gone, the durable commit remains.
    await db.reconcileInactiveFileLocks();
    expect((await files.getUpload(overwrite.id))?.status).toBe("committing");
    await expect(fileService.abandonUpload(overwrite.id)).rejects.toThrow("recovering");
    const reconciliation = new ReconciliationService(new PostgresReconciliationRepository(db), storage);
    for (const mode of ["metadata", "full_hash"] as const) {
      const scan = await reconciliation.run(mode);
      expect(scan.state).toBe("complete");
      expect((await files.getResource(original.id))?.status).toBe("active");
      expect((await reconciliation.listIssues(scan.id)).filter(issue => issue.resourceId === original.id)).toEqual([]);
    }
    const recovered = await fileService.completeUpload(overwrite.id);
    expect(recovered.upload).toMatchObject({ id: overwrite.id, status: "active" });
    expect(recovered.resource).toMatchObject({ id: original.id, status: "active" });
    expect(Buffer.concat(await (await storage.openRead(archive)).toArray()).toString()).toBe("original");
    expect(Buffer.concat(await (await storage.openRead(overwrite.targetPath)).toArray()).toString()).toBe("replacement");
    expect(await fileService.listVersions(original.id)).toHaveLength(2);
    // A subsequent client PUT must overwrite the same identity rather than hit
    // resources_storage_path_key after a false missing classification.
    const next = await fileService.completeUpload((await upload("next", original.id)).id);
    expect(next.resource.id).toBe(original.id);
    expect((await reconciliation.run("full_hash")).issueCount).toBe(0);
    // Once the commit has finished, actual missing storage must still be detected.
    await checkpointReconciliation("before-missing", db, url.toString(), root, proof);
    await storage.delete(next.resource.storagePath);
    const missing = await reconciliation.run("metadata");
    expect((await files.getResource(original.id))?.status).toBe("missing");
    expect((await reconciliation.listIssues(missing.id)).filter(issue => issue.resourceId === original.id)).toHaveLength(1);
    if (proof !== undefined) {
      await fs.writeFile(path.join(proof, "result.json"), JSON.stringify({
        replacementAtTarget, resource: original.id, originalVersion: original.currentVersionId,
        originalUpload: overwrite.id, currentVersion: next.resource.currentVersionId, missingRun: missing.id,
      }), { flag: "wx" });
    }
  } finally {
    await db?.close(); await storage.close();
    if (created && proof === undefined) await admin.withSql(sql => sql`DROP DATABASE ${sql(name)}`);
    await admin.close(); if (proof === undefined) await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);
