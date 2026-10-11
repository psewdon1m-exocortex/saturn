import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { LocalStorageAdapter } from "@saturn/storage";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BackupIngestService } from "./backup.service.js";
import { MemoryRepository } from "./testing/memory.repository.js";
import type { BackupContext, BackupRunRecord } from "./types.js";

const options = { enabled: true, trustClientCertificateHeader: false, tokenRotationGraceMs: 1000, uploadChunkMaxBytes: 1024,
  incompleteTtlMs: 60_000, defaults: { requireEncryption: true, maxBackupBytes: 4096, dailyQuotaBytes: 8192,
    storedQuotaBytes: 16384, maxConcurrentRuns: 1, freshnessSlaMs: 86_400_000, retention: { daily: 7, weekly: 4, monthly: 12, yearly: 3 } } };
const payload = Buffer.from("encrypted recovery archive");
let root: string, storage: LocalStorageAdapter, repository: MemoryRepository, backups: BackupIngestService, context: BackupContext;
const published: string[] = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-incomplete-backup-"));
  storage = new LocalStorageAdapter(root); await storage.initialize(); repository = new MemoryRepository(); published.length = 0;
  backups = new BackupIngestService({ repository, storage, pepper: "p".repeat(64), options,
    catalog: { publish: async run => { published.push(run.id); }, purge: async () => undefined } });
  const identity = await backups.createService({ slug: "updater-host", namespaceSlug: "updater", name: "Updater" });
  context = await backups.authenticate(`Bearer ${identity.token}`);
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));
async function create(key = "recovery-fixture") {
  return backups.createRun(context, context.service.slug, { filename: "updater.exorecovery", createdAt: new Date(),
    backupType: "helper_recovery", expectedSize: payload.length, sha256: createHash("sha256").update(payload).digest("hex"),
    sourceVersion: "qa", encrypted: true, idempotencyKey: key });
}
async function age(id: string, state?: BackupRunRecord["state"]) {
  const run = await backups.getRunForOwner(id);
  repository.runs.set(id, { ...run, ...(state === undefined ? {} : { state }), updatedAt: new Date(Date.now() - 61_000) });
}

it("lets only the producer owning the run cancel it, idempotently, and rejects subsequent writes", async () => {
  const run = await create();
  const peer = await backups.createService({ slug: "peer", name: "Peer" });
  const other = await backups.authenticate(`Bearer ${peer.token}`);
  await expect(backups.cancelRun(other, context.service.slug, run.id)).rejects.toMatchObject({ code: "not_found" });
  await expect(backups.cancelRun(other, other.service.slug, run.id)).rejects.toMatchObject({ code: "not_found" });
  expect((await backups.cancelRun(context, context.service.slug, run.id)).failureCode).toBe("cancelled_by_producer");
  expect((await backups.cancelRun(context, context.service.slug, run.id)).state).toBe("failed");
  await expect(backups.uploadOffset(context, context.service.slug, run.id)).rejects.toMatchObject({ code: "conflict" });
  await expect(backups.append(context, context.service.slug, run.id, 0, payload.length, Readable.from(payload))).rejects.toMatchObject({ code: "conflict" });
});

it("cancels partial bytes but protects completed archives from producer cancellation and expiration", async () => {
  const partial = await create("partial-fixture");
  await backups.append(context, context.service.slug, partial.id, 0, 5, Readable.from(payload.subarray(0, 5)));
  const partialPath = (await backups.getRunForOwner(partial.id)).tempPath;
  await backups.cancelRun(context, context.service.slug, partial.id); expect(await storage.exists(partialPath)).toBe(false);
  const full = await create("complete-fixture");
  await backups.append(context, context.service.slug, full.id, 0, payload.length, Readable.from(payload));
  await backups.complete(context, context.service.slug, full.id); await age(full.id);
  await expect(backups.cancelRun(context, context.service.slug, full.id)).rejects.toMatchObject({ code: "conflict" });
  expect(await backups.expireIncompleteRuns()).toMatchObject({ scanned: 0, expired: 0 });
  expect(await fs.readFile(path.join(root, (await backups.getRunForOwner(full.id)).finalPath))).toEqual(payload);
});

it.each(["pending", "uploading", "appending"] as const)("expires an abandoned %s reservation and removes only its temporary bytes", async state => {
  const run = await create();
  if (state !== "pending") await backups.append(context, context.service.slug, run.id, 0, 5, Readable.from(payload.subarray(0, 5)));
  const record = await backups.getRunForOwner(run.id); await age(run.id, state);
  expect(await backups.expireIncompleteRuns()).toEqual({ scanned: 1, expired: 1, recovered: 0, failed: 0 });
  expect(await backups.getRunForOwner(run.id)).toMatchObject({ state: "failed", failureCode: "incomplete_expired" });
  expect(await storage.exists(record.tempPath)).toBe(false);
});

it("extends the inactivity deadline on a resume HEAD and resumes the exact stored bytes", async () => {
  const run = await create(); await backups.append(context, context.service.slug, run.id, 0, 5, Readable.from(payload.subarray(0, 5)));
  await age(run.id);
  expect(await backups.uploadOffset(context, context.service.slug, run.id)).toBe(5);
  expect(await backups.expireIncompleteRuns()).toMatchObject({ scanned: 0, expired: 0 });
  await backups.append(context, context.service.slug, run.id, 5, payload.length - 5, Readable.from(payload.subarray(5)));
  expect((await backups.complete(context, context.service.slug, run.id)).state).toBe("complete");
  expect(await fs.readFile(path.join(root, (await backups.getRunForOwner(run.id)).finalPath))).toEqual(payload);
});

it("rechecks a reservation refreshed after candidate selection and skips paused runs", async () => {
  const resumed = await create("resumed-fixture"), paused = await create("paused-fixture"); await age(resumed.id); await age(paused.id);
  const list = repository.listIncompleteRuns.bind(repository);
  repository.listIncompleteRuns = async (...args) => {
    const rows = await list(...args); await backups.uploadOffset(context, context.service.slug, resumed.id); return rows;
  };
  expect(await backups.expireIncompleteRuns(new Date(), id => id === paused.id)).toMatchObject({ scanned: 2, expired: 0 });
  expect((await backups.getRunForOwner(paused.id)).state).toBe("pending");
});

it("refreshes the inactivity deadline when the owner resumes an old paused reservation", async () => {
  const run = await create(); await age(run.id); await backups.touchRunForOwner(run.id);
  expect(await backups.expireIncompleteRuns()).toMatchObject({ scanned: 0, expired: 0 });
});

it("waits for an active chunk and rechecks its refreshed timestamp before expiring it", async () => {
  const run = await create(); await age(run.id);
  let started!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; }); const finish = new Promise<void>(resolve => { release = resolve; });
  const source = Readable.from((async function* () { started(); await finish; yield payload.subarray(0, 5); })());
  const append = backups.append(context, context.service.slug, run.id, 0, 5, source, new Date(Date.now() - 61_000));
  await writing; const cleanup = backups.expireIncompleteRuns(); release(); await append;
  expect(await cleanup).toMatchObject({ scanned: 1, expired: 0 });
  expect(await backups.getRunForOwner(run.id)).toMatchObject({ state: "uploading", receivedSize: 5 });
});

it.each([false, true])("recovers an interrupted complete upload with final object already renamed=%s", async renamed => {
  const run = await create(); await backups.append(context, context.service.slug, run.id, 0, payload.length, Readable.from(payload));
  const record = await backups.getRunForOwner(run.id);
  if (renamed) { await backups.ensureParents(record.finalPath); await storage.rename(record.tempPath, record.finalPath); }
  await age(run.id, "verifying");
  expect(await backups.expireIncompleteRuns()).toMatchObject({ expired: 0, recovered: 1, failed: 0 });
  expect(published).toContain(run.id); expect((await backups.getRunForOwner(run.id)).state).toBe("complete");
  expect(await fs.readFile(path.join(root, record.finalPath))).toEqual(payload);
});

it("retries temporary storage cleanup failures without losing metadata or bytes", async () => {
  const run = await create(); await backups.append(context, context.service.slug, run.id, 0, 5, Readable.from(payload.subarray(0, 5))); await age(run.id);
  const remove = storage.delete.bind(storage); storage.delete = async () => { throw new Error("SFTP disconnected"); };
  expect(await backups.expireIncompleteRuns()).toMatchObject({ expired: 0, failed: 1 });
  expect((await backups.getRunForOwner(run.id)).state).toBe("uploading"); storage.delete = remove;
  expect(await backups.expireIncompleteRuns()).toMatchObject({ expired: 1, failed: 0 });
});

it("preserves a renamed object and reports failed verification when its contents are corrupt", async () => {
  const run = await create(); await backups.append(context, context.service.slug, run.id, 0, payload.length, Readable.from(payload));
  const record = await backups.getRunForOwner(run.id); await backups.ensureParents(record.finalPath);
  await storage.rename(record.tempPath, record.finalPath); const corrupt = Buffer.from("corrupt committed object");
  await fs.writeFile(path.join(root, record.finalPath), corrupt); await age(run.id, "verifying");
  expect(await backups.expireIncompleteRuns()).toMatchObject({ recovered: 0, failed: 1 });
  expect(await backups.getRunForOwner(run.id)).toMatchObject({ state: "failed", failureCode: "checksum_mismatch" });
  expect(await fs.readFile(path.join(root, record.finalPath))).toEqual(corrupt); expect(published).toHaveLength(0);
});

it("uses keyset pages so expiring the first page does not skip later reservations", async () => {
  const run = await create(), original = await backups.getRunForOwner(run.id); repository.runs.clear();
  for (let index = 0; index < 501; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    repository.runs.set(id, { ...original, id, updatedAt: new Date(Date.now() - 61_000) });
  }
  expect(await backups.expireIncompleteRuns()).toMatchObject({ scanned: 501, expired: 501, failed: 0 });
});
