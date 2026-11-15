import "reflect-metadata";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Database, listMigrationPairs, migrate } from "@saturn/database";
import { FileService, PostgresFileRepository, type UploadPublicationReceipt } from "@saturn/file-core";
import { LocalStorageAdapter } from "@saturn/storage";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import { checkpointMigrationCutoff } from "../../../packages/protection/src/storage-catalog-checkpoint.fixture.js";
import { inspectJournal } from "../../../packages/recovery/src/consistent-snapshot.js";
import { expect, it, vi } from "vitest";
import { SyncClientController } from "./sync-client.controller.js";
import { AUTH_SERVICE, DEVICE_SERVICE } from "./tokens.js";

const fixturePath = process.env.SYNC_MIGRATION_CUTOFF_FIXTURE;
const evidence = process.env.SATURN_MIGRATION_CUTOFF_EVIDENCE_DIR;
const exec = promisify(execFile);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const devicePepper = "latest-migration-fixture-pepper-12345678";
interface Status { id: string; etag?: string; intentHash?: string; publicationReceipt?: UploadPublicationReceipt }

it.skipIf(!fixturePath)("upgrades existing sealed uploads and device identity through every current migration without changing publication semantics", async () => {
  if (!fixturePath) throw new Error("Explicit owned migration fixture required");
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as {
    containerId: string; runId: string; databaseUrl: string; fixtureDirectory: string;
  };
  const inspected = JSON.parse((await exec("docker", ["inspect", fixture.containerId], { windowsHide: true })).stdout) as {
    Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean }; HostConfig: { NanoCpus: number; Memory: number };
  }[];
  expect(inspected[0]?.Id).toBe(fixture.containerId);
  expect(inspected[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);
  expect(inspected[0]?.State.Running).toBe(true);
  expect(inspected[0]?.HostConfig.NanoCpus).toBeLessThanOrEqual(1e9);
  expect(inspected[0]?.HostConfig.Memory).toBeLessThanOrEqual(512 * 1024 * 1024);
  const directory = path.join(fixture.fixtureDirectory, randomUUID().replaceAll("-", ""));
  await fs.mkdir(directory);
  const sourceMigrations = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url));
  // Deliberately no upper cutoff for the actual upgrade target.
  const allPairs = await listMigrationPairs(sourceMigrations);
  const baselinePairs = allPairs.filter(pair => Number(pair.name.split("_")[0]) <= 49);
  expect(baselinePairs.at(-1)?.name).toBe("0049_upload_publication_receipt");
  expect(Number(allPairs.at(-1)?.name.split("_")[0])).toBeGreaterThanOrEqual(51);
  const baseline = path.join(directory, "baseline-0049-migrations");
  await fs.mkdir(baseline);
  for (const pair of baselinePairs) for (const file of [pair.up, pair.down]) await fs.copyFile(file, path.join(baseline, path.basename(file)));
  const admin = new Database(fixture.databaseUrl, { max: 2 });
  const name = "cutoff_" + randomUUID().replaceAll("-", "");
  const url = new URL(fixture.databaseUrl); url.pathname = "/" + name;
  const db = new Database(url.toString(), { max: 4 });
  const storageRoot = path.join(directory, "storage");
  const storage = new LocalStorageAdapter(storageRoot);
  const files = new FileService(new PostgresFileRepository(db), storage);
  const devices = new DeviceService({ repository: new PostgresDeviceRepository(db), files,
    pepper: devicePepper, options: { enabled: true, publicOrigin: "https://fixture.invalid",
      uploadChunkMaxBytes: 1024 * 1024, propfindMaxItems: 100, deleteMaxItems: 10, deleteWindowMs: 10000 } });
  let app: NestFastifyApplication | undefined;
  let created = false, passed = false;
  const checks: string[] = [];
  const backendSpies: { mockRestore(): void }[] = [];
  try {
    if (evidence) await fs.writeFile(path.join(evidence, "ownership.json"), JSON.stringify({ name, directory }), { flag: "wx" });
    await admin.withSql(sql => sql.unsafe(`CREATE DATABASE ${name}`));
    created = true;
    expect(await migrate(url.toString(), baseline)).toBe(baselinePairs.length);
    await storage.initialize(); await files.initializeStorage();
    const enrolled = await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment("Latest schema")).code, "fixture");
    const auth = await devices.authenticate("Bearer " + enrolled.token);
    const input = (filename: string, value: string) => ({ path: "sync/Latest schema/" + filename,
      expectedSize: Buffer.byteLength(value), expectedSha256: hash(value), idempotencyKey: hash(randomUUID()), ifNoneMatch: "*" });
    const finalInput = input("published.txt", "original payload"), pendingInput = input("pending.txt", "pending payload");
    const final = await devices.createResumableUpload(auth, finalInput);
    await files.appendUpload(final.id, 0, finalInput.expectedSize, Readable.from("original payload"));
    await files.completeUpload(final.id);
    const original = await files.getUpload(final.id);
    const originalReceipt = original.publicationReceipt;
    if (!originalReceipt) throw new Error("Missing original immutable receipt");
    const pending = await devices.createResumableUpload(auth, pendingInput);
    const staged = await files.appendUpload(pending.id, 0, pendingInput.expectedSize, Readable.from("pending payload"));
    const legacy = await files.createUpload({ parentId: originalReceipt.parentId, filename: "legacy-unqualified.txt",
      expectedSize: 1, expectedSha256: hash("x"), idempotencyKey: "legacy-fixture-" + randomUUID() });
    const tables = ["resources", "file_versions", "devices", "upload_sessions", "operation_journal"] as const;
    const oldColumns = new Map<string, string[]>(), oldRows = new Map<string, unknown>();
    for (const table of tables) {
      const columns = await db.withSql(sql => sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=${table} ORDER BY ordinal_position`);
      oldColumns.set(table, columns.map(column => column.column_name));
      oldRows.set(table, await db.withSql(sql => sql.unsafe(`SELECT * FROM ${table} ORDER BY id`)));
    }
    if (evidence) {
      const runtime = path.join(directory, "runtime");
      await fs.mkdir(runtime);
      await fs.writeFile(path.join(runtime, "device.private.json"), JSON.stringify({
        id: enrolled.device.id, root: enrolled.device.syncRootId, token: enrolled.token, pepper: devicePepper,
      }), { flag: "wx", mode: 0o600 });
      await checkpointMigrationCutoff("before-cutoff-migrate", db, url.toString(), directory, evidence);
    }
    const applied = await migrate(url.toString(), sourceMigrations);
    expect(applied).toBe(allPairs.length - baselinePairs.length);
    const repeated = await migrate(url.toString(), sourceMigrations);
    expect(repeated).toBe(0);
    const ledger = await db.withSql(sql => sql<{ name: string }[]>`SELECT name FROM _vault_migrations ORDER BY name`);
    expect(ledger.map(row => row.name)).toEqual(allPairs.map(pair => pair.name));
    for (const table of tables) {
      const columns = oldColumns.get(table); if (!columns) throw new Error("No baseline columns");
      expect(columns.every(column => /^[a-z0-9_]+$/.test(column))).toBe(true);
      expect(await db.withSql(sql => sql.unsafe(`SELECT ${columns.join(",")} FROM ${table} ORDER BY id`))).toEqual(oldRows.get(table));
    }
    expect((await files.getUpload(final.id)).publicationReceipt).toEqual(originalReceipt);
    expect((await files.getUpload(pending.id)).publicationIntent).toBeDefined();
    expect((await files.getUpload(legacy.id)).publicationIntent).toBeUndefined();
    expect(await db.withSql(sql => sql`SELECT id FROM resources WHERE metadata_version IS NOT NULL OR sync_availability IS NOT NULL`)).toHaveLength(0);
    expect((await db.withSql(sql => inspectJournal(sql))).registeredRoots).toBe("0");
    if (evidence) await checkpointMigrationCutoff("before-cutoff-validators", db, url.toString(), directory, evidence);
    // Current lifecycle SQL wrapper and preserved v1 validator must both be
    // qualified. Accepting every language would hide a damaged deployment.
    if (allPairs.some(pair => pair.name === "0065_sync_lifecycle")) {
      for (const signature of ["catalog_guard_active_shape(jsonb)", "catalog_guard_active_shape_v1(jsonb)"]) {
        await db.withSql(sql => sql.unsafe(`ALTER FUNCTION public.${signature} SECURITY DEFINER`));
        try {
          await expect(db.withSql(sql => inspectJournal(sql))).rejects.toThrow("Unknown or incomplete ACTIVE deployment schema");
        } finally {
          await db.withSql(sql => sql.unsafe(`ALTER FUNCTION public.${signature} SECURITY INVOKER`));
        }
      }
      expect((await db.withSql(sql => inspectJournal(sql))).registeredRoots).toBe("0");
      checks.push("recovery admits lifecycle SQL wrapper plus immutable v1 validator; rejects tampered privilege shape of either validator");
    }
    checks.push("0049 existing catalogue, versions, device/token identity, sealed pending/final and legacy unsealed journal/session fields preserved through every current migration; exact complete migration ledger and idempotent second migrate");
    const completedPending = await files.completeUpload(pending.id);
    const pendingReceipt = (await files.getUpload(pending.id)).publicationReceipt;
    expect(pendingReceipt?.sha256).toBe(hash("pending payload"));
    expect(pendingReceipt?.uploadId).toBe(pending.id);
    const later = await files.createUpload({ parentId: originalReceipt.parentId, filename: originalReceipt.name,
      expectedSize: 13, expectedSha256: hash("later payload"), idempotencyKey: "other-actor-" + randomUUID(),
      overwriteResourceId: originalReceipt.resourceId, expectedVersionId: originalReceipt.versionId });
    await files.appendUpload(later.id, 0, 13, Readable.from("later payload")); await files.completeUpload(later.id);
    @Module({ controllers: [SyncClientController], providers: [{ provide: DEVICE_SERVICE, useValue: devices }, { provide: AUTH_SERVICE, useValue: {} }] })
    class FixtureModule { readonly fixture = "latest-migration"; }
    const adapter = new FastifyAdapter({ logger: false });
    app = await NestFactory.create<NestFastifyApplication>(FixtureModule, adapter, { logger: false });
    app.setGlobalPrefix("api/v1"); await app.listen(0, "127.0.0.1");
    const address = adapter.getInstance().server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback fixture port");
    const base = `http://127.0.0.1:${String(address.port)}/api/v1/sync/uploads`, headers = { authorization: "Bearer " + enrolled.token };
    const versions = await db.withSql(sql => sql`SELECT id FROM file_versions WHERE resource_id=${originalReceipt.resourceId} ORDER BY id`);
    const http = [];
    for (const method of ["stat", "exists", "write", "rename", "openRead", "mkdir"] as const) backendSpies.push(vi.spyOn(storage, method));
    for (const [method, endpoint, payload] of [["GET", base + "/" + final.id, undefined], ["POST", base + "/" + final.id + "/complete", undefined],
      ["POST", base, finalInput]] as const) {
      const response = await fetch(endpoint, { method, headers: { ...headers, ...(payload ? { "content-type": "application/json" } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}) });
      expect(response.status, await response.clone().text()).toBeLessThan(300);
      const replay = await response.json() as Status;
      expect(replay.id).toBe(final.id);
      expect(replay.publicationReceipt).toEqual(originalReceipt);
      expect(replay.etag).toBe(`"sha256-${hash("later payload")}"`);
      http.push({ method, status: response.status, id: replay.id, etag: replay.etag, receipt: replay.publicationReceipt });
    }
    backendSpies.forEach(spy => expect(spy).not.toHaveBeenCalled()); backendSpies.forEach(spy => spy.mockRestore()); backendSpies.length = 0;
    expect(await db.withSql(sql => sql`SELECT id FROM file_versions WHERE resource_id=${originalReceipt.resourceId} ORDER BY id`)).toEqual(versions);
    expect((await devices.syncMetadataCapabilities(await devices.authenticate(headers.authorization), enrolled.device.syncRootId ?? "")).features)
      .toMatchObject({ snapshot: false, deltaFeed: false, conditionalVersions: false, newSyncEngine: false, immutableUploadReceipt: false });
    checks.push("actual latest-schema HTTP GET/complete/create replay returns original immutable receipt beside current V2 legacy ETag; zero backend effects/new versions, pending upload completes, no root/capability/backfill activation");
    if (evidence) {
      const [archived] = await db.withSql(sql => sql<{ storage_path: string }[]>`SELECT storage_path FROM file_versions WHERE id=${originalReceipt.versionId}`);
      if (!archived || !pendingReceipt) throw new Error("Missing original archived version or pending receipt");
      const laterUpload = await files.getUpload(later.id);
      const byteProof = [
        { kind: "original-archive", path: archived.storage_path, sha256: originalReceipt.sha256, bytes: finalInput.expectedSize },
        { kind: "current-version", path: laterUpload.targetPath, sha256: hash("later payload"), bytes: 13 },
        { kind: "completed-pending", path: completedPending.upload.targetPath, sha256: pendingReceipt.sha256, bytes: pendingInput.expectedSize },
      ];
      for (const file of byteProof) {
        const raw = await fs.readFile(path.join(storageRoot, file.path));
        expect(raw.length).toBe(file.bytes);
        expect(createHash("sha256").update(raw).digest("hex")).toBe(file.sha256);
      }
      await fs.writeFile(path.join(directory, "proof.json"), JSON.stringify({
        name, applied, repeated, device: enrolled.device.id, root: enrolled.device.syncRootId,
        original: { receipt: originalReceipt, livePath: original.targetPath },
        pending: { receipt: pendingReceipt, tempPath: staged.tempPath, livePath: completedPending.upload.targetPath },
        legacyId: legacy.id, laterId: later.id, port: address.port, http, versions, byteProof,
      }, null, 2), { flag: "wx" });
    }
    passed = true;
  } finally {
    backendSpies.forEach(spy => spy.mockRestore());
    try {
      await app?.close();
    } finally {
      try {
        await storage.close();
      } finally {
        try {
          await db.close();
          if (created && evidence === undefined) await admin.withSql(sql => sql.unsafe(`DROP DATABASE ${name}`));
        } finally {
          await admin.close();
          await fs.writeFile(path.join(directory, "results.json"), JSON.stringify({ passed, checks,
            baseline: baselinePairs.map(pair => pair.name), target: allPairs.map(pair => pair.name), scope: "test infrastructure latest-schema successor; no runtime activation" }, null, 2) + "\n");
        }
      }
    }
  }
}, 90000);
