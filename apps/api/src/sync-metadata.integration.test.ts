import "reflect-metadata";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { request as httpRequest } from "node:http";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Database, migrate } from "@saturn/database";
import { FileService, PostgresFileRepository, SYNC_METADATA_MAX_BYTES } from "@saturn/file-core";
import { LocalStorageAdapter } from "@saturn/storage";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import { checkpointMetadata } from "../../../packages/protection/src/storage-catalog-checkpoint.fixture.js";
import { expect, it } from "vitest";
import { SyncMetadataController } from "./sync-metadata.controller.js";
import { registerSyncMetadataLimits } from "./sync-metadata-limits.js";
import { DEVICE_SERVICE } from "./tokens.js";

const databaseUrl = process.env.SYNC_METADATA_TEST_DATABASE_URL;
const auditRoot = process.env.SYNC_METADATA_TEST_AUDIT;
const custody = process.env.SATURN_METADATA_EVIDENCE_DIR;
const devicePepper = "isolated-sync-metadata-pepper-123456789012345";
type Sql = Parameters<Parameters<Database["withSql"]>[0]>[0];
interface CapturedQuery { readonly strings: TemplateStringsArray; readonly parameters: readonly unknown[] }
class RecordingDatabase extends Database {
  recording = false;
  statements = 0;
  metadataQuery: CapturedQuery | undefined;
  override withSql<T>(action: (sql: Sql) => Promise<T>): Promise<T> {
    return super.withSql(sql => action(new Proxy(sql, {
      apply: (target, thisArg, args: unknown[]) => {
        const strings = args[0] as TemplateStringsArray;
        if (this.recording && typeof strings[0] === "string") {
          this.statements++;
          if (strings[0].includes("WITH RECURSIVE allowed_root")) this.metadataQuery = { strings, parameters: args.slice(1) };
        }
        return Reflect.apply(target, thisArg, args) as unknown;
      },
    })));
  }
}

async function chunkedRequest(url: string, headers: Record<string, string>): Promise<{ status: number; body: string; bytesSent: number }> {
  return new Promise((resolve, reject) => {
    let bytesSent = 0, responded = false;
    const request = httpRequest(url, { method: "POST", headers }, response => {
      responded = true;
      let body = "";
      response.setEncoding("utf8"); response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => { request.end(); resolve({ status: response.statusCode ?? 0, body, bytesSent }); });
      response.on("error", error => { reject(new Error("raw chunked response failed", { cause: error })); });
    });
    request.on("error", error => { if (!responded) reject(new Error("raw chunked request failed before readable response", { cause: error })); });
    const write = () => {
      if (responded) return;
      if (bytesSent >= SYNC_METADATA_MAX_BYTES + 65536) {
        setTimeout(() => { if (!responded) request.end(); }, 50); return;
      }
      bytesSent += 65536;
      const ready = request.write(Buffer.alloc(65536, 32));
      if (ready) setTimeout(write, 2); else request.once("drain", () => { setTimeout(write, 2); });
    };
    write();
  });
}

it.skipIf(!databaseUrl || !auditRoot)("proves bounded ID metadata over HTTP and a wide PostgreSQL catalog", async () => {
  if (!databaseUrl || !auditRoot) throw new Error("Explicit isolated metadata test settings required");
  const runId = randomUUID().replaceAll("-", ""), name = "sync_metadata_" + runId;
  const qaRoot = path.join(auditRoot, runId); await fs.mkdir(qaRoot, { recursive: true });
  const admin = new Database(databaseUrl);
  const scopedUrl = new URL(databaseUrl); scopedUrl.pathname = "/" + name; scopedUrl.searchParams.delete("options");
  const database = new RecordingDatabase(scopedUrl.toString()), storage = new LocalStorageAdapter(path.join(qaRoot, "storage"));
  const repository = new PostgresFileRepository(database), files = new FileService(repository, storage);
  const devices = new DeviceService({ files, repository: new PostgresDeviceRepository(database),
    pepper: devicePepper, options: { enabled: true, publicOrigin: "https://test.invalid",
      uploadChunkMaxBytes: 8 * 1024 * 1024, propfindMaxItems: 100, deleteMaxItems: 2, deleteWindowMs: 1000 } });
  @Module({ controllers: [SyncMetadataController], providers: [{ provide: DEVICE_SERVICE, useValue: devices }] })
  class TestModule { readonly fixture = "metadata-only-isolated"; }
  // Match production's larger upload limit: the metadata route must reduce it.
  const adapter = new FastifyAdapter({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  registerSyncMetadataLimits(adapter.getInstance());
  let app: NestFastifyApplication | undefined;
  let passed = false, created = false;
  const checks: string[] = [];
  try {
    if (custody) await fs.writeFile(path.join(custody, "ownership.json"), JSON.stringify({ name, directory: qaRoot }), { flag: "wx" });
    await admin.withSql(sql => sql.unsafe(`CREATE DATABASE ${name}`));
    created = true;
    const applied = await migrate(scopedUrl.toString());
    app = await NestFactory.create<NestFastifyApplication>(TestModule, adapter, { logger: false });
    app.setGlobalPrefix("api/v1");
    await storage.initialize(); await files.initializeStorage();
    const windowsEnrollment = await devices.createWindowsEnrollment("metadata windows");
    const windows = await devices.redeemWindowsEnrollment(windowsEnrollment.code, "metadata-test");
    const plutoEnrollment = await devices.createPlutoEnrollment("metadata pluto");
    const pluto = await devices.redeemPlutoEnrollment(plutoEnrollment.code, "metadata-test");
    const generic = await devices.createDevice({ name: "metadata generic", scopeIds: ["00000000-0000-7000-8000-000000000001"],
      rights: { read: true, write: false, move: false, delete: false } });
    const root = windowsEnrollment.device.syncRootId, peer = plutoEnrollment.device.syncRootId;
    if (!root || !peer) throw new Error("Generated device root missing");
    if (custody) {
      const runtime = path.join(qaRoot, "runtime");
      await fs.mkdir(runtime);
      await fs.writeFile(path.join(runtime, "authority.private.json"), JSON.stringify({
        root, peer, pepper: devicePepper,
        devices: [windows, pluto, generic].map(({ device, token }) => ({ id: device.id, token })),
      }), { flag: "wx", mode: 0o600 });
    }
    const id = (index: number) => "11111111-1111-7111-8111-" + index.toString(16).padStart(12, "0");
    const outside = randomUUID(), inactive = randomUUID(), badChild = randomUUID(), cycleA = randomUUID(), cycleB = randomUUID();
    const chain = Array.from({ length: 129 }, () => randomUUID());
    await database.withSql(async sql => {
      // Catalog-only synthetic fixture: no physical files, no production SFTP.
      await sql`INSERT INTO resources (id,type,parent_id,name,storage_path,size_bytes,sha256,status)
        SELECT ('11111111-1111-7111-8111-' || lpad(to_hex(i),12,'0'))::uuid, 'file', ${root}::uuid,
          'file-' || i::text, 'synthetic/' || i::text, 9007199254740993::bigint, repeat('a',64), 'active'
        FROM generate_series(1,100000) AS i`;
      await sql`INSERT INTO resources (id,type,parent_id,name,storage_path,status) VALUES
        (${outside},'file',${peer},'peer-file','synthetic/peer-file','active'),
        (${inactive},'folder',${root},'inactive','synthetic/inactive','trashed'),
        (${badChild},'file',${inactive},'hidden-child','synthetic/hidden-child','active'),
        (${cycleA},'folder',${root},'cycle-a','synthetic/cycle-a','active'),
        (${cycleB},'folder',${cycleA},'cycle-b','synthetic/cycle-b','active')`;
      await sql`UPDATE resources SET parent_id = ${cycleB} WHERE id = ${cycleA}`;
      for (let index = 0; index < chain.length; index++) {
        await sql`INSERT INTO resources (id,type,parent_id,name,storage_path,status)
          VALUES (${chain[index] ?? ""},'folder',${index === 0 ? root : chain[index-1] ?? ""},
            ${"depth-" + String(index + 1)},${"synthetic/depth-" + String(index + 1)},'active')`;
      }
      await sql`ANALYZE resources`;
    });
    await app.listen(0, "127.0.0.1");
    const address = adapter.getInstance().server.address();
    if (!address || typeof address === "string") throw new Error("Metadata test port missing");
    const origin = "http://127.0.0.1:" + String(address.port);
    const headers = { authorization: "Bearer " + windows.token, "content-type": "application/json", connection: "close" };
    const endpoint = `/api/v1/sync/roots/${root}/metadata/batch`;
    const capsUrl = `/api/v1/sync/roots/${root}/capabilities`;
    const requests: { route: string; method: string; status: number }[] = [];
    const request = async (url: string, payload?: Readonly<Record<string, unknown>>, token: string | null = windows.token) => {
      const method = payload === undefined ? "GET" : "POST";
      const response = await fetch(origin + url, {
        method, headers: { ...(token === null ? {} : { authorization: "Bearer " + token }), "content-type": "application/json", connection: "close" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const body = await response.text();
      requests.push({ route: url, method, status: response.status });
      return { statusCode: response.status, headers: response.headers, body, json: (): unknown => JSON.parse(body) };
    };
    const capabilities = await request(capsUrl);
    expect(capabilities.statusCode).toBe(200); expect(capabilities.headers.get("cache-control")).toBe("no-store");
    expect(capabilities.json()).toMatchObject({ features: { metadataBatch: true, snapshot: false, deltaFeed: false, batchResolve: false,
      batchDirectories: false, conditionalVersions: false, newSyncEngine: false }, limits: { maxAncestorHops: 128 } });
    expect(capabilities.json()).not.toHaveProperty("serverEpoch"); checks.push("honest-capabilities");

    const absent = randomUUID();
    const mixed = await request(endpoint, { nodeIds: [id(500), absent, id(500).toUpperCase(), root, outside, inactive, badChild,
      cycleA, cycleB, chain[127], chain[128]] });
    expect(mixed.statusCode).toBe(200);
    const { results: items } = mixed.json() as { results: { nodeId: string; status: string; metadata?: Record<string, unknown> }[] };
    expect(items.map(item => item.status)).toEqual(["found","not_found","found","found","not_found","not_found","not_found",
      "not_found","not_found","found","not_found"]);
    expect(items[0]?.metadata).toEqual({ nodeId: id(500), parentId: root, name: "file-500", type: "file",
      sizeBytes: "9007199254740993", sha256: "a".repeat(64), legacyETag: '"sha256-' + "a".repeat(64) + '"' });
    expect(items[3]?.metadata?.parentId).toBeNull();
    for (const item of items.filter(item => item.status === "not_found")) expect(Object.keys(item)).toEqual(["nodeId", "status"]);
    expect(mixed.body).not.toMatch(/storagePath|currentVersionId|tokenHash|securityClassification/);
    checks.push("mixed-duplicates-bigint-minimal-projection", "peer-trash-inactive-parent-cycle-depth");

    for (const body of [{ nodeIds: [] }, { nodeIds: ["not-a-uuid"] }, { nodeIds: [id(1)], extra: true },
      { nodeIds: Array<string>(501).fill(id(1)) }, { nodeIds: [null] }, { nodeIds: id(1) }]) {
      expect((await request(endpoint, body)).statusCode).toBe(400);
    }
    expect((await request("/api/v1/sync/roots/not-uuid/capabilities")).statusCode).toBe(400);
    expect((await request(capsUrl, undefined, null)).statusCode).toBe(401);
    expect((await request(capsUrl, undefined, generic.token)).statusCode).toBe(403);
    expect((await request(`/api/v1/sync/roots/${peer}/capabilities`)).statusCode).toBe(404);
    expect((await request(`/api/v1/sync/roots/${peer}/metadata/batch`, { nodeIds: [outside] })).statusCode).toBe(404);
    const plutoOwn = await request(`/api/v1/sync/roots/${peer}/metadata/batch`, { nodeIds: [outside, root] }, pluto.token);
    expect(plutoOwn.statusCode).toBe(200);
    expect((plutoOwn.json() as { results: { status: string }[] }).results.map(item => item.status)).toEqual(["found","not_found"]);
    checks.push("http-shapes-auth-root-kind-peer");

    const validBody = JSON.stringify({ nodeIds: [id(1)] });
    const exact = validBody + " ".repeat(SYNC_METADATA_MAX_BYTES - Buffer.byteLength(validBody));
    await fs.writeFile(path.join(qaRoot, "progress.json"), JSON.stringify({ checks, step: "http-exact-bound" }));
    const exactResponse = await fetch(origin + endpoint, { method: "POST", headers, body: exact });
    expect(exactResponse.status).toBe(200); await exactResponse.arrayBuffer();
    await fs.writeFile(path.join(qaRoot, "progress.json"), JSON.stringify({ checks, step: "http-plus-one-bound" }));
    const tooLarge = await fetch(origin + endpoint, { method: "POST", headers, body: exact + " " });
    expect(tooLarge.status).toBe(413); await tooLarge.arrayBuffer();
    expect((await request(capsUrl)).statusCode).toBe(200);
    await fs.writeFile(path.join(qaRoot, "progress.json"), JSON.stringify({ checks, step: "http-gzip-bound" }));
    const compressed = await fetch(origin + endpoint, { method: "POST", headers: { ...headers, "content-encoding": "gzip" }, body: gzipSync(exact + " ") });
    expect(compressed.status).toBe(415); await compressed.arrayBuffer();
    expect((await request(capsUrl)).statusCode).toBe(200);
    await fs.writeFile(path.join(qaRoot, "progress.json"), JSON.stringify({ checks, step: "http-chunked-bound" }));
    // A streamed body omits Content-Length, testing actual received-byte bound.
    const streamed = await fetch(origin + endpoint, { method: "POST", headers, body: new ReadableStream({
      start(controller) { for (let index=0; index<65; index++) controller.enqueue(Buffer.alloc(65536, 32)); controller.close(); },
    }), duplex: "half" });
    expect(streamed.status).toBe(413); await streamed.arrayBuffer();
    const rawChunked = await chunkedRequest(origin + endpoint, headers);
    expect(rawChunked.status).toBe(413); expect(rawChunked.body).toContain('"statusCode":413');
    expect((await request(capsUrl)).statusCode).toBe(200);
    await fs.writeFile(path.join(qaRoot, "http-limits.json"), JSON.stringify({ exactUncompressedBytes: SYNC_METADATA_MAX_BYTES,
      exactStatus: exactResponse.status, plusOneStatus: tooLarge.status, unsupportedGzipStatus: compressed.status,
      fetchChunkedStatus: streamed.status, rawChunked, subsequentCapabilitiesStatus: 200,
      clientObservation: "Initial fetch using pooled keep-alive connection observed ECONNRESET; explicit Connection: close and raw client stop-writes path produce readable HTTP413. No reset accepted as a pass." }, null, 2));
    checks.push("http-exact-4mib-plus-one-chunked-gzip");

    const scopedRequest = { rootId: root, rootParentId: "00000000-0000-7000-8000-000000000004", nodeIds: Array.from({ length: 500 }, (_, i) => id(i+1)) };
    database.recording = true; database.statements = 0;
    const samples: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      database.statements = 0;
      const start = performance.now(); const many = await repository.readScopedSyncMetadata(scopedRequest); samples.push(performance.now() - start);
      expect(database.statements).toBe(1); expect(many.nodes).toHaveLength(501); expect(many.rootActive).toBe(true);
    }
    const recorded = database.metadataQuery;
    database.statements = 0;
    const duplicateMany = await repository.readScopedSyncMetadata({ ...scopedRequest, nodeIds: Array<string>(500).fill(id(1)) });
    expect(database.statements).toBe(1); expect(duplicateMany.nodes).toHaveLength(2);
    database.recording = false;
    if (!recorded) throw new Error("Metadata SELECT was not captured");
    const strings = [...recorded.strings]; strings[0] = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + (strings[0] ?? "");
    const template = Object.assign(strings, { raw: [...strings] }) as unknown as TemplateStringsArray;
    const explain = await database.withSql(sql => Reflect.apply(sql, sql, [template, ...recorded.parameters]) as Promise<unknown>);
    expect(JSON.stringify(explain)).not.toContain('"Node Type":"Seq Scan"');
    await fs.writeFile(path.join(qaRoot, "explain.json"), JSON.stringify(explain, null, 2));
    await fs.writeFile(path.join(qaRoot, "benchmark.json"), JSON.stringify({ catalogRows: 100000, items: 500, metadataStatements: 1,
      samplesMs: samples, medianMs: [...samples].sort((a,b) => a-b)[1], p95Ms: Math.max(...samples),
      coverage: "DB-only synthetic metadata catalog; three microbenchmark samples, including cold JIT overhead. No backend content or SFTP efficiency measurement." }, null, 2));
    checks.push("500-items-one-select-postgresql-explain");

    if (custody) await checkpointMetadata("before-metadata-shapes", database, scopedUrl.toString(), qaRoot, custody);
    for (const status of ["pending", "missing", "error", "quarantined", "trashed"]) {
      await database.withSql(sql => sql`UPDATE resources SET status = ${status} WHERE id = ${id(2)}`);
      expect((await request(endpoint, { nodeIds: [id(2)] })).json()).toEqual({ rootId: root, results: [{ nodeId: id(2), status: "not_found" }] });
    }
    await database.withSql(sql => sql`UPDATE resources SET status = 'active', name = repeat('x',1021) WHERE id = ${id(2)}`);
    expect((await request(endpoint, { nodeIds: [id(2)] })).statusCode).toBe(413);
    await database.withSql(sql => sql`UPDATE resources SET name = 'file-2' WHERE id = ${id(2)}`);
    await database.withSql(sql => sql`UPDATE resources SET type = 'file' WHERE id = ${root}`);
    expect((await request(capsUrl)).statusCode).toBe(404);
    await database.withSql(sql => sql`UPDATE resources SET type = 'folder', parent_id = '00000000-0000-7000-8000-000000000009' WHERE id = ${root}`);
    expect((await request(capsUrl)).statusCode).toBe(404);
    await database.withSql(sql => sql`UPDATE resources SET parent_id = '00000000-0000-7000-8000-000000000004' WHERE id = ${root}`);
    checks.push("all-inactive-states-oversized-name-invalid-root-type-and-parent");

    if (custody) await checkpointMetadata("before-metadata-revoke", database, scopedUrl.toString(), qaRoot, custody);
    await database.withSql(sql => sql`UPDATE resources SET status = 'trashed' WHERE id = ${root}`);
    expect((await request(capsUrl)).statusCode).toBe(404);
    expect((await request(endpoint, { nodeIds: [id(1)] })).statusCode).toBe(404);
    await database.withSql(sql => sql`UPDATE resources SET status = 'active' WHERE id = ${root}`);
    await database.withSql(sql => sql`UPDATE devices SET can_read = false WHERE id = ${windowsEnrollment.device.id}`);
    expect((await request(capsUrl)).statusCode).toBe(403);
    await database.withSql(sql => sql`UPDATE devices SET can_read = true, scope_ids = ARRAY[${peer}::uuid] WHERE id = ${windowsEnrollment.device.id}`);
    expect((await request(capsUrl)).statusCode).toBe(404);
    await database.withSql(sql => sql`UPDATE devices SET scope_ids = ARRAY[${root}::uuid], state = 'revoked' WHERE id = ${windowsEnrollment.device.id}`);
    expect((await request(capsUrl)).statusCode).toBe(401);
    checks.push("http-inactive-root-read-right-scope-revocation");
    passed = true;
    await fs.writeFile(path.join(qaRoot, "results.json"), JSON.stringify({
      ok: true, checks, name, applied, root, peer, port: address.port, requests, mixedStatuses: items.map(item => item.status),
      scope: "bounded read-only API on synthetic metadata rows; local HTTP with current PostgreSQL migrations",
    }, null, 2));
  } finally {
    let dropped = false;
    try {
      await app?.close();
    } finally {
      try {
        await storage.close();
      } finally {
        try {
          await database.close();
          if (created && !custody) {
            await admin.withSql(sql => sql.unsafe(`DROP DATABASE ${name}`));
            dropped = true;
          }
        } finally {
          await admin.close();
          await fs.writeFile(path.join(qaRoot, "cleanup.json"), JSON.stringify({ name, dropped, retained: created && !dropped, passed }, null, 2));
        }
      }
    }
  }
}, 120000);
