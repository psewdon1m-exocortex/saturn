import "reflect-metadata";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { BackupIngestService, PostgresBackupRepository, type BackupRepository, type BackupRunRecord } from "@saturn/backup-ingest";
import { Database, migrate } from "@saturn/database";
import { LocalStorageAdapter } from "@saturn/storage";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MemoryRepository } from "../../../packages/backup-ingest/src/testing/memory.repository.js";
import { BackupCapabilitiesController, BackupEnrollmentController, BackupProducerController } from "./backup.controller.js";
import { registerRawBodyParsers } from "./raw-body-parsers.js";
import { APP_CONFIG, BACKUP_INGEST_SERVICE, DEVICE_SERVICE } from "./tokens.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";

const scopes = ["updater", "neptune", "gryphon", "wyvern", "window"] as const;
let repository: BackupRepository = new MemoryRepository();
const committed = new Map<string, BackupRunRecord>();
const codes: Record<string, string> = {};
const identities: Record<string, { serviceId: string; token: string }> = {};
let root: string, origin: string, app: NestFastifyApplication, storage: LocalStorageAdapter, backups: BackupIngestService;
let database: Database | undefined, admin: Database | undefined, schema: string | undefined;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("HTTP fixture value is missing"); return value;
}
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-host-recovery-http-"));
  storage = new LocalStorageAdapter(root); await storage.initialize();
  const databaseUrl = process.env.SATURN_HOST_RECOVERY_TEST_DATABASE_URL;
  if (databaseUrl) {
    admin = new Database(databaseUrl); const isolatedSchema = "host_http_qa_" + randomUUID().replaceAll("-", ""); schema = isolatedSchema;
    await admin.withSql(sql => sql.unsafe(`CREATE SCHEMA ${isolatedSchema}`));
    const url = new URL(databaseUrl); url.searchParams.set("options", "-csearch_path=" + isolatedSchema);
    await migrate(url.toString()); database = new Database(url.toString());
    repository = new PostgresBackupRepository(database);
  }
  backups = new BackupIngestService({ repository, storage, pepper: "synthetic-host-http-pepper".repeat(3), options: {
    enabled: true, trustClientCertificateHeader: false, tokenRotationGraceMs: 1000,
    uploadChunkMaxBytes: 53, incompleteTtlMs: 60_000,
    defaults: { requireEncryption: true, maxBackupBytes: 1024 * 1024, dailyQuotaBytes: 16 * 1024 * 1024,
      storedQuotaBytes: 32 * 1024 * 1024, maxConcurrentRuns: 1, freshnessSlaMs: 86_400_000,
      retention: { daily: 7, weekly: 4, monthly: 12, yearly: 3 } },
  }, catalog: { publish: async run => { committed.set(run.id, run); }, purge: async run => { committed.delete(run.id); } } });
  @Module({ controllers: [BackupCapabilitiesController, BackupEnrollmentController, BackupProducerController], providers: [
    { provide: BACKUP_INGEST_SERVICE, useValue: backups }, { provide: DEVICE_SERVICE, useValue: {} },
    { provide: APP_CONFIG, useValue: { limits: { uploadChunkMaxBytes: 53 } } }, TransferMonitorService,
  ] })
  class TestModule { readonly fixture = "host-recovery-http"; }
  const adapter = new FastifyAdapter({ logger: false }); registerRawBodyParsers(adapter.getInstance());
  // These routes exist only in this disposable fixture, never in AppModule.
  adapter.getInstance().get("/__qa/setup-codes", () => codes);
  adapter.getInstance().get<{ Params: { scope: string } }>("/__qa/archive/:scope", async (request, reply) => {
    const run = [...committed.values()].find(value => value.state === "complete"
      && value.filename.startsWith(request.params.scope + "-component-http-go-"));
    if (!run) return reply.status(404).send();
    return reply.type("application/octet-stream").send(await fs.readFile(path.join(root, run.finalPath)));
  });
  app = await NestFactory.create<NestFastifyApplication>(TestModule, adapter, { logger: false });
  app.setGlobalPrefix("api/v1"); await app.listen(0, "0.0.0.0");
  const address = adapter.getInstance().server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not start");
  origin = `http://127.0.0.1:${String(address.port)}`;
  for (const scope of scopes) {
    const created = await backups.createService({ slug: scope + "-qa", namespaceSlug: scope,
      deploymentId: "fixture-host", pipelineKind: "host_service", name: scope });
    identities[scope] = { serviceId: created.service.id, token: created.token };
    const enrollment = await backups.createEnrollmentForService(created.service.id); codes[scope] = enrollment.code;
  }
});
afterAll(async () => {
  await app.close(); await storage.close();
  await database?.close();
  if (admin && schema) {
    const isolatedSchema = schema;
    await admin.withSql(async sql => { await sql`SET client_min_messages=warning`; await sql.unsafe(`DROP SCHEMA ${isolatedSchema} CASCADE`); });
    await admin.close();
  }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it("stores host archives over actual HTTP, rejects missing media type without accepting bytes, and resumes all five scopes", async () => {
  for (const scope of scopes) {
    const token = required(identities[scope]).token, headers = { authorization: `Bearer ${token}` };
    const body = Buffer.from(`synthetic-encrypted-envelope-${scope}-` + "0123456789abcdef".repeat(16));
    const digest = createHash("sha256").update(body).digest("hex");
    const metadata = { filename: `${scope}-component-http-node.exorecovery`, createdAt: new Date().toISOString(),
      backupType: "helper_recovery", expectedSize: body.length, sha256: digest, sourceVersion: "qa", encrypted: true };
    const create = () => fetch(`${origin}/api/v1/backups/${scope}-qa/runs`, { method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "http-node-" + scope }, body: JSON.stringify(metadata) });
    const created = await create(); expect(created.status, await created.clone().text()).toBe(201);
    const run = await created.json() as { id: string }, target = `${origin}/api/v1/backups/${scope}-qa/runs/${run.id}`;
    const offset = async () => { const response = await fetch(target + "/upload", { method: "HEAD", headers });
      expect(response.status).toBe(204); return Number(response.headers.get("upload-offset")); };
    const append = (start: number, bytes: Buffer, mediaType?: string) => fetch(target + "/upload", {
      method: "PATCH", headers: { ...headers, "upload-offset": String(start), "content-length": String(bytes.length),
        ...(mediaType === undefined ? {} : { "content-type": mediaType }) }, body: bytes,
    });
    for (const mediaType of [undefined, "application/x-wrong-type"]) {
      const rejected = await append(0, body.subarray(0, 37), mediaType);
      expect(rejected.status, await rejected.text()).toBe(415); expect(await offset()).toBe(0);
      expect(await storage.exists((await backups.getRunForOwner(run.id)).tempPath)).toBe(false);
    }
    const first = await append(0, body.subarray(0, 37), "application/offset+octet-stream"); expect(first.status).toBe(204);
    const resumed = await create(); expect((await resumed.json() as { id: string; receivedSize: number })).toMatchObject({ id: run.id, receivedSize: 37 });
    expect((await append(0, body.subarray(0, 37), "application/offset+octet-stream")).status).toBe(409);
    expect(await offset()).toBe(37);
    expect((await fetch(target + "/complete", { method: "POST", headers })).status).toBe(409);
    for (let start = 37; start < body.length; start += 53) {
      const appended = await append(start, body.subarray(start, start + 53), "application/offset+octet-stream");
      expect(appended.status, await appended.text()).toBe(204);
    }
    const peer = required(scopes.find(candidate => candidate !== scope));
    const peerHeaders = { authorization: `Bearer ${required(identities[peer]).token}` };
    expect((await fetch(target + "/upload", { method: "HEAD", headers: peerHeaders })).status).toBe(404);
    const completed = await fetch(target + "/complete", { method: "POST", headers }); expect(completed.status, await completed.clone().text()).toBe(201);
    const result = await completed.json() as BackupRunRecord;
    expect(result.state).toBe("complete"); expect(result.receipt).toMatchObject({ sha256: digest, sizeBytes: body.length });
    const stored = await backups.getRunForOwner(run.id);
    expect(stored.finalPath).toMatch(new RegExp(`^backups/${scope}/fixture-host/`));
    expect(await fs.readFile(path.join(root, stored.finalPath))).toEqual(body);
    expect(await storage.exists(stored.tempPath)).toBe(false);
  }
}, 30_000);

it.skipIf(!process.env.UPDATER_HTTP_TEST_SOURCE)("enrolls, publishes, downloads, decrypts and restores with the actual Go Updater client", async () => {
  const source = required(process.env.UPDATER_HTTP_TEST_SOURCE);
  const endpoint = origin.replace("127.0.0.1", "host.docker.internal");
  const { stdout, stderr } = await promisify(execFile)("docker", ["run", "--rm", "--shm-size=1g",
    "-v", `${source}:/workspace:ro`, "-v", "updater-recovery-history-go-cache:/go/pkg/mod",
    "-v", "updater-recovery-history-build-cache:/root/.cache/go-build", "-w", "/workspace",
    "-e", `UPDATER_SATURN_HTTP_TEST_URL=${endpoint}`, "golang:1.26.9-bookworm",
    "go", "test", "-tags=saturnintegration", "-run", "^TestActualSaturnHostRecoveryHTTP$", "-count=1", "-v", "./internal/hostrecovery"],
  { timeout: 60_000, maxBuffer: 1024 * 1024 }).catch((error: unknown) => {
    if (error instanceof Error && "stdout" in error) console.error(error.stdout);
    if (error instanceof Error && "stderr" in error) console.error(error.stderr);
    throw error;
  });
  console.log(stdout); if (stderr) console.log(stderr);
  for (const scope of scopes) {
    const runs = [...committed.values()].filter(run => run.filename.startsWith(scope + "-component-http-go-"));
    expect(runs).toHaveLength(1); const run = required(runs[0]); expect(run.state).toBe("complete");
    expect(run.receipt?.logicalPath).toMatch(new RegExp(`^/backups/${scope}/fixture-host/`));
  }
}, 70_000);
