import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { captureFixtureDocker } from "./stage3-chat-a.fault-snapshot.fixture.js";
import { promisify } from "node:util";
import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, migrate } from "@saturn/database";
import { FileService, PostgresFileRepository, PostgresRootJournal, PostgresCurrentNamespace, CatalogFolderAuthorityIssuer, ROOT_RESOURCE_ID, OUTDOOR_CONNECTIONS_RESOURCE_ID } from "@saturn/file-core";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import { LocalStorageAdapter } from "@saturn/storage";
import { CatalogUploadDatabaseCoordinator } from "../../../packages/file-core/src/catalog-upload-database.js";
import { SmallBatchRegistry } from "../../../packages/file-core/src/small-batch-registry.js";
import { readSmallBatchPlan, type SmallBatchPlan } from "../../../packages/file-core/src/small-batch-plan.js";
import { qualifyCatalogDatabaseRoles } from "../../../packages/database/src/catalog-role-qualification.js";
import { SMALL_BATCH_SCHEMA } from "../../../packages/contracts/src/sync-small-batch.js";
import { SYNC_PROTOCOL, SYNC_DESCRIPTOR_SCHEMA, encodeSyncJson, type SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import type { CatalogFolderAuthority } from "../../../packages/file-core/src/catalog-folder-authority.js";
import { inspectJournal, withRecoverySnapshot, guardRecoveryMutation } from "../../../packages/recovery/src/consistent-snapshot.js";
import { DatabaseMetadataExporter } from "../../../packages/recovery/src/metadata-exporter.js";
import { guardedSyncSmallBatchHttp, type GuardedSmallBatchRoot } from "./guarded-sync-small-batch-http.js";
import type { SmallBatchOutcome } from "./sync-small-batch-executor.js";

const fixturePath = process.env.SYNC_SMALL_BATCH_FIXTURE, exec = promisify(execFile);
describe.skipIf(!fixturePath)("durable small-batch transport declarations on owned PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", ""), databaseName = "batch_" + suffix;
  const runtimeRole = "rt_" + suffix, writerRole = "wr_" + suffix, ownerRole = "ow_" + suffix, password = randomUUID();
  const roles = [runtimeRole, writerRole, ownerRole];
  const connections: Database[] = [];
  const http = Fastify();
  let origin: string, authorization: string;
  let rootScope: GuardedSmallBatchRoot;
  let admin: Database, database: Database, runtime: Database, writer: Database, registry: SmallBatchRegistry;
  let files: FileService, proof: CatalogFolderAuthority, binding: SyncRootBinding, deviceId: string, rootName: string, directory: string;
  let initialized = false;
  let containerId: string;
  const migrations = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url));
  const json = (value: unknown) => JSON.stringify(value);
  const checks: string[] = [];
  beforeAll(async () => {
    if (!fixturePath) throw new Error("Owned fixture required");
    const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as { containerId: string; created: string; runId: string; databaseUrl: string; fixtureDirectory: string; resourceBudget?: { nanoCpus: number; memoryBytes: number } };
    const containers = JSON.parse((await exec("docker", ["inspect", fixture.containerId], { windowsHide: true })).stdout) as { Id: string; Created: string; Config: { Labels: Record<string, string> }; State: { Running: boolean }; HostConfig: { NanoCpus: number; Memory: number } }[];
    const budget = fixture.resourceBudget ?? { nanoCpus: 1e9, memoryBytes: 536870912 };
    expect([1e9, 2e9, 4e9]).toContain(budget.nanoCpus); expect([536870912, 1073741824, 2147483648]).toContain(budget.memoryBytes);
    expect(containers[0]).toMatchObject({ Id: fixture.containerId, Created: fixture.created, State: { Running: true }, HostConfig: { NanoCpus: budget.nanoCpus, Memory: budget.memoryBytes } });
    expect(containers[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);
    containerId = fixture.containerId;
    directory = path.join(fixture.fixtureDirectory, databaseName); await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "ownership.json"), json({ databaseName, roles, containerId: fixture.containerId, at: new Date().toISOString() }), { flag: "wx" });
    admin = new Database(fixture.databaseUrl, { max: 1 }); connections.push(admin);
    await admin.withSql(sql => sql.unsafe("CREATE DATABASE " + databaseName));
    const url = new URL(fixture.databaseUrl); url.pathname = "/" + databaseName;
    await migrate(url.toString(), migrations); database = new Database(url.toString(), { max: 2 }); connections.push(database);
    const storage = new LocalStorageAdapter(path.join(directory, "storage")); await storage.initialize();
    const legacy = new FileService(new PostgresFileRepository(database), storage); await legacy.initializeStorage();
    const devices = new DeviceService({ repository: new PostgresDeviceRepository(database), files: legacy, pepper: "small-batch-fixture-pepper-1234567890", options: { enabled: true, publicOrigin: "https://fixture.invalid", uploadChunkMaxBytes: 8388608, propfindMaxItems: 100, deleteMaxItems: 10, deleteWindowMs: 10000 } });
    const enrolled = await devices.redeemPlutoEnrollment((await devices.createPlutoEnrollment("Batch " + suffix)).code, "fixture");
    const rootId = enrolled.device.syncRootId; if (!rootId) throw new Error("Missing root"); deviceId = enrolled.device.id;
    const clock = await new PostgresRootJournal(database).registerRoot(rootId);
    await new PostgresCurrentNamespace(database).qualifyFixture(rootId, [rootId]);
    rootName = (await database.withSql(sql => sql<{ name: string }[]>`SELECT name FROM resources WHERE id=${rootId}`))[0]?.name ?? "";
    if (!rootName) throw new Error("Missing root name");
    for (const role of roles) await admin.withSql(sql => sql.unsafe(`CREATE ROLE ${role} ${role === ownerRole ? "NOLOGIN" : `LOGIN PASSWORD '${password}'`} NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT`));
    await database.withSql(sql => sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${roles.join(",")};
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${runtimeRole},${ownerRole};
      GRANT INSERT,UPDATE ON resources,file_versions,upload_sessions,operation_journal,sync_root_clock,sync_root_changes,sync_small_batch_budget,sync_small_batch_operations,sync_small_batches TO ${ownerRole};
      GRANT UPDATE ON devices,catalog_guard_roots TO ${ownerRole};
      GRANT UPDATE ON sync_root_policy TO ${ownerRole};
      ALTER FUNCTION public.catalog_upload_command(text,jsonb,jsonb,jsonb) OWNER TO ${ownerRole};
      ALTER FUNCTION public.catalog_guard_upgrade_file(uuid) OWNER TO ${ownerRole};
      ALTER FUNCTION public.sync_small_batch_command(text,jsonb,jsonb,jsonb) OWNER TO ${ownerRole};
      GRANT EXECUTE ON FUNCTION public.sync_small_batch_known_shape(jsonb),public.catalog_upload_known_intent(text,jsonb) TO ${ownerRole};
      GRANT EXECUTE ON FUNCTION public.catalog_upload_command(text,jsonb,jsonb,jsonb),public.catalog_guard_upgrade_file(uuid),public.sync_small_batch_command(text,jsonb,jsonb,jsonb) TO ${writerRole}`));
    const ru = new URL(url); ru.username = runtimeRole; ru.password = password; runtime = new Database(ru.toString(), { max: 2 }); connections.push(runtime);
    const wu = new URL(url); wu.username = writerRole; wu.password = password; writer = new Database(wu.toString(), { max: 2 }); connections.push(writer);
    const functions = await database.withSql(sql => sql<{ identity: string; source: string }[]>`SELECT 'public.'||p.oid::regprocedure::text AS identity, p.prosrc AS source FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE r.rolname=${ownerRole} ORDER BY p.proname`);
    const approvedFunctions = functions.map(f => ({ identity: f.identity.replace("public.public.", "public."), sourceSha256: createHash("sha256").update(f.source).digest("hex") }));
    expect(approvedFunctions).toHaveLength(3);
    await qualifyCatalogDatabaseRoles(writer, { runtimeRole, writerLogin: writerRole, writerOwner: ownerRole, migratorRole: "postgres", connection: "writer", approvedFunctions });
    await database.withSql(sql => sql`INSERT INTO catalog_guard_roots(root_id,guard_revision,writer_contract,runtime_role,writer_login,writer_owner,backend_identity,control_ancestor_ids) VALUES(${rootId},${randomUUID()},'folder-only-g1.v1',${runtimeRole},${writerRole},${ownerRole},'batch-local',ARRAY[${ROOT_RESOURCE_ID}::uuid,${OUTDOOR_CONNECTIONS_RESOURCE_ID}::uuid])`);
    const upgraded = (await writer.withSql(sql => sql<{ value: { bindingVersion: string } }[]>`SELECT public.catalog_guard_upgrade_file(${rootId}::uuid) AS value`))[0]?.value;
    if (!upgraded) throw new Error("Missing upgrade");
    binding = { protocol: SYNC_PROTOCOL, descriptor_schema: SYNC_DESCRIPTOR_SCHEMA, root_id: rootId, server_epoch: clock.epoch,
      binding_version: upgraded.bindingVersion, server_identity: "batch-fixture", policy_version: "batch-test" };
    const issuer = new CatalogFolderAuthorityIssuer(runtime, { authenticateDevice: authorization => devices.authenticateSyncMetadata(authorization) });
    proof = await issuer.device("Bearer " + enrolled.token, rootId);
    registry = new SmallBatchRegistry(writer, issuer);
    files = new FileService(new PostgresFileRepository(runtime), storage, { catalogBackendIdentity: "batch-local", catalogUploadCoordinator: new CatalogUploadDatabaseCoordinator(writer, issuer) });
    authorization = "Bearer " + enrolled.token;
    rootScope = { binding, authority: issuer, files, batches: registry };
    await http.register(guardedSyncSmallBatchHttp, { root: async id => id === binding.root_id ? rootScope : undefined });
    await http.listen({ host: "127.0.0.1", port: 0 });
    const address = http.server.address(); if (!address || typeof address === "string") throw new Error("No HTTP listener");
    origin = "http://127.0.0.1:" + String(address.port);
    initialized = true; checks.push("all migrations and exact owned fixture/three-role preflight; no existing original database changed");
  }, 60000);
  afterAll(async () => {
    if (directory) await fs.writeFile(path.join(directory, "checks.json"), json({ at: new Date().toISOString(), initialized, checks, databaseName, roles }));
    await http.close();
    for (const connection of connections.reverse()) await connection.close();
    // Keep the isolated database for failure/closure review. The wrapper owns
    // cleanup and must compare the recorded database/role/container identities.
  });
  function plan(count = 1): SmallBatchPlan {
    const bytes = Buffer.from("small payload"), hash = createHash("sha256").update(bytes).digest("hex");
    const items = Array.from({ length: count }, (_, n) => ({ operation_id: "batch-op-" + randomUUID(), source_generation: "1", source_identity: "source-" + String(n), parent_id: binding.root_id, name: randomUUID() + ".txt", size_bytes: String(bytes.length), sha256: hash, expected: { kind: "absent" as const } }));
    const manifest = { ...binding, schema: SMALL_BATCH_SCHEMA, batch_id: "batch-" + randomUUID(), rules_version: "rules-v1", items };
    const inputs = items.map(item => ({ epoch: binding.server_epoch, bindingVersion: binding.binding_version, backendIdentity: "batch-local", intent: {
      schema: "saturn.upload-intent.v2", deviceKind: "pluto", deviceId, rootId: binding.root_id, requestPath: "/fixture/" + item.name, idempotencyKey: item.operation_id,
      parentId: item.parent_id, name: item.name, targetId: null, sizeBytes: item.size_bytes, sha256: item.sha256, ifMatch: null, ifNoneMatch: "*", requireAbsent: true,
      expectedVersionId: null, condition: { kind: "absent" }, parentTopology: [{ nodeId: binding.root_id, parentId: null, name: rootName }] } }));
    return readSmallBatchPlan({ manifest, inputs }, binding);
  }
  const counts = async () => database.withSql(sql => sql`SELECT (SELECT count(*)::text FROM operation_journal) AS operations,(SELECT count(*)::text FROM upload_sessions) AS uploads,(SELECT count(*)::text FROM resources) AS resources,(SELECT published_seq::text FROM sync_root_clock WHERE root_id=${binding.root_id}) AS seq`);
  const post = (command: string, payload: unknown) => fetch(origin + "/sync/v1/roots/" + binding.root_id + "/small-batches/" + command,
    { method: "POST", headers: { authorization, "Content-Type": "application/json" }, body: json(payload) });
  function wire(value: SmallBatchPlan, payloads?: readonly Buffer[]) {
    const boundary = "batch-" + randomUUID(), metadata = Buffer.from(encodeSyncJson(value.manifest));
    const chunks: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(metadata.length)}\r\n\r\n`), metadata, Buffer.from("\r\n")];
    const offsets: number[] = [];
    for (const [n, item] of value.manifest.items.entries()) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${item.operation_id}>\r\nContent-Length: ${item.size_bytes}\r\n\r\n`));
      offsets.push(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      chunks.push(payloads?.[n] ?? Buffer.from("small payload"), Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { type: "multipart/related; boundary=" + boundary, body: Buffer.concat(chunks), offsets };
  }
  const send = (value: { type: string; body: Buffer }) => fetch(origin + "/sync/v1/roots/" + binding.root_id + "/small-batches/data",
    { method: "POST", headers: { authorization, "Content-Type": value.type }, body: value.body });
  const statuses = async (value: SmallBatchPlan) => {
    const response = await post("status", { binding, batch_id: value.manifest.batch_id }); expect(response.status).toBe(200);
    return await response.json() as SmallBatchOutcome;
  };
  function hold(url: string, prefix: Buffer, contentType: string, token = authorization) {
    let respond: (status: number | undefined) => void = () => {};
    const response = new Promise<number | undefined>(resolve => { respond = resolve; });
    const request = httpRequest(url, { method: "POST", agent: false, headers: { authorization: token, "Content-Type": contentType, "Content-Length": String(prefix.length + 1024) } }, result => {
      result.resume(); result.once("end", () => { respond(result.statusCode); });
    });
    request.once("error", () => { respond(undefined); });
    const closed = new Promise<void>(resolve => { request.once("close", resolve); });
    request.write(prefix); request.flushHeaders();
    return { request, response, closed };
  }
  it("unused migration down/up is additive and preserves original catalog", async () => {
    const before = await counts();
    if (!fixturePath) throw new Error("Missing fixture");
    const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as { databaseUrl: string };
    const legacyName = databaseName + "_m61";
    const legacyMigrations = path.join(directory, "migrations-0061");
    await fs.mkdir(legacyMigrations);
    for (const file of await fs.readdir(migrations)) {
      if (/^\d{4}_[a-z0-9_-]+\.(up|down)\.sql$/.test(file) && Number(file.slice(0, 4)) <= 61) {
        await fs.copyFile(path.join(migrations, file), path.join(legacyMigrations, file));
      }
    }
    await fs.writeFile(path.join(directory, "legacy-migration-ownership.json"),
      json({ databaseName: legacyName, containerId, migrations: legacyMigrations }), { flag: "wx" });
    await admin.withSql(sql => sql`CREATE DATABASE ${sql(legacyName)}`);
    const legacyUrl = new URL(fixture.databaseUrl);
    legacyUrl.pathname = "/" + legacyName;
    await migrate(legacyUrl.toString(), legacyMigrations);
    const legacy = new Database(legacyUrl.toString(), { max: 1 });
    try {
      const originalCatalog = () => legacy.withSql(sql => sql`SELECT id,parent_id,type,name,storage_path FROM resources ORDER BY id`);
      const legacyBefore = await originalCatalog();
      await expect(legacy.transaction(async sql => {
        await sql.unsafe(await fs.readFile(path.join(legacyMigrations, "0061_small_batch_registry.down.sql"), "utf8"));
        await sql.unsafe(await fs.readFile(path.join(legacyMigrations, "0061_small_batch_registry.up.sql"), "utf8"));
        expect((await sql`SELECT count(*)::text AS n FROM sync_small_batches`)[0]?.n).toBe("0");
        throw new Error("test rollback");
      })).rejects.toThrow("test rollback");
      expect(await originalCatalog()).toEqual(legacyBefore);
    } finally {
      await legacy.close();
    }
    expect(await counts()).toEqual(before);
    expect(await registry.status("missing-batch", binding, proof)).toBeUndefined();
    checks.push("unused 0061 down/up on its exact migration prefix; historical and current catalogs unchanged");
  });
  it("registers 500 declarations without any upload/session/catalog effect; replay preserves counters", async () => {
    const value = plan(500), before = await counts(), record = await registry.register(value, binding, proof);
    expect(record.items).toHaveLength(500); expect(record.items.every(item => item.admitted && item.uploadId === null)).toBe(true);
    expect(await counts()).toEqual(before);
    const budget = await database.withSql(sql => sql`SELECT * FROM sync_small_batch_budget`);
    expect((await registry.register(value, binding, proof)).replayed).toBe(true);
    expect(await database.withSql(sql => sql`SELECT * FROM sync_small_batch_budget`)).toEqual(budget);
    expect(await registry.status(value.manifest.batch_id, binding, proof)).toMatchObject({ replayed: true, plan: value });
    checks.push("500 item admission and replay without physical/upload effects or counter double charge");
  }, 15000);
  it("rejects changed batch identity and isolates a changed operation declaration", async () => {
    const value = plan(2); await registry.register(value, binding, proof);
    const altered = { ...value, manifest: { ...value.manifest, items: value.manifest.items.map((item, n) => n === 0 ? { ...item, source_generation: "2" } : item) } };
    await expect(registry.register(altered, binding, proof)).rejects.toMatchObject({ code: "operation_reused" });
    altered.manifest.batch_id = "retry-" + randomUUID();
    const retry = await registry.register(altered, binding, proof);
    expect(retry.items.map(item => item.admitted)).toEqual([false, true]);
    expect(retry.items.map(item => item.uploadId)).toEqual([null, null]);
    checks.push("same batch changed bytes refused; changed source generation conflicts only its member in new transport");
  });
  it("finds the original upload after a lost prepare response and after publication", async () => {
    const value = plan(), input = value.inputs[0]; if (!input) throw new Error("Missing input");
    await registry.register(value, binding, proof);
    const upload = await files.prepareCatalogUpload(input, proof), id = upload.status.session.uploadId;
    expect((await registry.status(value.manifest.batch_id, binding, proof))?.items[0]?.uploadId).toBe(id);
    const filled = await files.appendCatalogUpload(upload, proof, "0", Buffer.from("small payload"));
    const published = await files.completeCatalogUpload(filled, proof); expect(published.status.result?.status).toBe("PUBLISHED");
    const before = await counts(); const found = await registry.status(value.manifest.batch_id, binding, proof);
    expect(found?.items[0]?.uploadId).toBe(id);
    expect((await files.prepareCatalogUpload(input, proof, id)).status.result).toEqual(published.status.result);
    expect(await counts()).toEqual(before);
    checks.push("lost prepare reply recovers original id; terminal immutable receipt remains original journal authority");
  });
  it("refuses used downgrade and direct runtime/writer mutations", async () => {
    await registry.register(plan(), binding, proof);
    await expect(database.transaction(async sql => sql.unsafe(await fs.readFile(path.join(migrations, "0061_small_batch_registry.down.sql"), "utf8")))).rejects.toThrow("Used small batch registry");
    await expect(runtime.withSql(sql => sql`DELETE FROM sync_small_batches`)).rejects.toThrow();
    await expect(writer.withSql(sql => sql`UPDATE sync_small_batch_budget SET metadata_bytes=0`)).rejects.toThrow();
    await expect(database.withSql(sql => sql`DELETE FROM sync_small_batch_operations`)).rejects.toThrow("immutable");
    await expect(database.withSql(sql => sql`TRUNCATE sync_small_batch_operations`)).rejects.toThrow("cannot be truncated");
    checks.push("used rollback, runtime DML, writer direct DML and deletion of immutable declarations refused");
  });
  it("checks current binding and authorization before a missing-id lookup", async () => {
    await expect(registry.status("missing-batch", { ...binding, binding_version: randomUUID() }, proof)).rejects.toMatchObject({ code: "binding_invalid" });
    await database.transaction(async sql => {
      await sql`UPDATE devices SET state='revoked' WHERE id=${deviceId}`;
      // Commit so the separate writer connection observes current authority.
    });
    try { await expect(registry.status("missing-batch", binding, proof)).rejects.toMatchObject({ code: "authorization_changed" }); }
    finally { await database.withSql(sql => sql`UPDATE devices SET state='active' WHERE id=${deviceId}`); }
    checks.push("current binding/write revocation refuse even missing lookup; private proof does not cache authorization");
  });
  it("publishes a multi-file HTTP batch past the four-temp limit and recovers a lost 202 without rewriting", async () => {
    const value = plan(500), prepared = await post("prepare", value); expect(prepared.status, await prepared.clone().text()).toBe(202);
    const ready = await prepared.json() as SmallBatchOutcome; expect(ready.items.every(item => item.state === "MISSING")).toBe(true);
    const sent = await send(wire(value)); expect(sent.status, await sent.clone().text()).toBe(202); await sent.arrayBuffer();
    const recovered = await statuses(value); expect(recovered.items).toHaveLength(500); expect(recovered.items.every(item => item.state === "PUBLISHED")).toBe(true);
    const before = await counts(); const duplicate = await send(wire(value)); expect(duplicate.status).toBe(202);
    const replay = await duplicate.json() as SmallBatchOutcome;
    expect(replay.items.map(item => item.status?.result)).toEqual(recovered.items.map(item => item.status?.result)); expect(await counts()).toEqual(before);
    checks.push("actual HTTP500 sequential publications retain4temp limit; lost202 status and duplicate data preserve original receipts/counters");
  }, 120000);
  it("retains completed items after a truncated later part and retries only missing originals", async () => {
    const value = plan(2); expect((await post("prepare", value)).status).toBe(202);
    const payload = wire(value), second = payload.offsets[1]; if (second === undefined) throw new Error("Missing part offset");
    const interrupted = await send({ ...payload, body: payload.body.subarray(0, second + 3) }); expect(interrupted.status).toBe(400); await interrupted.arrayBuffer();
    const partial = await statuses(value); expect(partial.items.map(item => item.state), JSON.stringify(partial)).toEqual(["PUBLISHED", "MISSING"]);
    const item = value.manifest.items[1], input = value.inputs[1]; if (!item || !input) throw new Error("Missing retry input");
    const retry = readSmallBatchPlan({ manifest: { ...value.manifest, batch_id: "retry-" + randomUUID(), items: [item] }, inputs: [input] }, binding);
    expect((await post("prepare", retry)).status).toBe(202); expect((await send(wire(retry))).status).toBe(202);
    const complete = await statuses(value); expect(complete.items.map(entry => entry.state)).toEqual(["PUBLISHED", "PUBLISHED"]);
    expect(complete.items[0]?.status?.result).toEqual(partial.items[0]?.status?.result);
    checks.push("truncated later part leaves first receipt and no second upload/session; new transport retries second original only");
  });
  it("rejects corrupt or trailing transport bytes before allocating the affected upload", async () => {
    const value = plan(); await post("prepare", value); const before = await counts();
    const bad = wire(value, [Buffer.from("wrong payload")]); expect((await send(bad)).status).toBe(400); expect(await counts()).toEqual(before);
    const good = wire(value); expect((await send({ ...good, body: Buffer.concat([good.body, Buffer.from("extra")]) })).status).toBe(400); expect(await counts()).toEqual(before);
    expect((await statuses(value)).items[0]?.state).toBe("MISSING");
    checks.push("hash mismatch and last-part epilogue cannot create upload/session or publication");
  });
  it("publishes a zero-byte file and isolates one valid member's namespace conflict", async () => {
    const original = plan(), first = original.manifest.items[0], input = original.inputs[0]; if (!first || !input) throw new Error("Missing original");
    const emptySha = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    const empty = readSmallBatchPlan({ manifest: { ...original.manifest, items: [{ ...first, size_bytes: "0", sha256: emptySha }] }, inputs: [{ ...input, intent: { ...input.intent, sizeBytes: "0", sha256: emptySha } }] }, binding);
    expect((await post("prepare", empty)).status).toBe(202); expect((await send(wire(empty, [Buffer.alloc(0)]))).status).toBe(202);
    expect((await statuses(empty)).items[0]?.state).toBe("PUBLISHED");
    const independent = plan(2), other = independent.manifest.items[0], otherInput = independent.inputs[0]; if (!other || !otherInput) throw new Error("Missing conflict input");
    const conflicting = readSmallBatchPlan({ manifest: { ...independent.manifest, items: independent.manifest.items.map((item, n) => n === 0 ? { ...item, name: first.name } : item) },
      inputs: independent.inputs.map((entry, n) => n === 0 ? { ...entry, intent: { ...entry.intent, name: first.name } } : entry) }, binding);
    expect((await post("prepare", conflicting)).status).toBe(202); const response = await send(wire(conflicting)); expect(response.status).toBe(202);
    const result = await response.json() as SmallBatchOutcome; expect(result.items.map(item => item.state)).toEqual(["CONFLICT", "PUBLISHED"]);
    expect(result.items[0]?.code).toBe("precondition_failed");
    checks.push("zero-length independent backend verification publishes; one member's CAS rejection does not roll back the other publication");
  });
  it("authenticates before a partial JSON body and releases all four stalled request slots", async () => {
    const slow = Fastify(); let arrived = 0, resolveFour: () => void = () => {};
    const four = new Promise<void>(resolve => { resolveFour = resolve; });
    slow.addHook("onRequest", (_request, _reply, done) => { arrived++; if (arrived === 4) resolveFour(); done(); });
    await slow.register(guardedSyncSmallBatchHttp, { root: async id => id === binding.root_id ? rootScope : undefined, requestDeadlineMs: 1000 });
    await slow.listen({ host: "127.0.0.1", port: 0 }); const address = slow.server.address();
    if (!address || typeof address === "string") throw new Error("No deadline listener");
    const base = "http://127.0.0.1:" + String(address.port) + "/sync/v1/roots/" + binding.root_id + "/small-batches/";
    const stalled = Array.from({ length: 4 }, () => hold(base + "prepare", Buffer.from("{"), "application/json"));
    try {
      await four;
      const denied = await fetch(base + "status", { method: "POST", headers: { authorization, "Content-Type": "application/json" }, body: json({ binding, batch_id: "not-registered" }) });
      expect(denied.status).toBe(429); expect(denied.headers.get("Retry-After")).toBe("1"); await denied.arrayBuffer();
      await Promise.all(stalled.map(item => item.closed));
      expect(await Promise.all(stalled.map(item => item.response))).toEqual([undefined, undefined, undefined, undefined]);
      const next = await fetch(base + "status", { method: "POST", headers: { authorization, "Content-Type": "application/json" }, body: json({ binding, batch_id: "not-registered" }) });
      expect(next.status).toBe(404); await next.arrayBuffer();
      const unauthenticated = hold(base + "prepare", Buffer.from("{"), "application/json", "Bearer invalid");
      expect(await unauthenticated.response).toBe(401); await unauthenticated.closed;
    } finally { for (const pending of stalled) pending.request.destroy(); await Promise.all(stalled.map(item => item.closed)); await slow.close(); }
    checks.push("four partial JSON requests bounded; fifth gets429/Retry-After; deadline joins sockets and releases slots; invalid credential gets401 before body completion");
  }, 10000);
  it("cancels a stalled binary input without allocating an incomplete file", async () => {
    const value = plan(); await post("prepare", value); const before = await counts(), payload = wire(value), start = payload.offsets[0];
    if (start === undefined) throw new Error("No part offset");
    const slow = Fastify(); await slow.register(guardedSyncSmallBatchHttp, { root: async id => id === binding.root_id ? rootScope : undefined, requestDeadlineMs: 500 });
    await slow.listen({ host: "127.0.0.1", port: 0 }); const address = slow.server.address(); if (!address || typeof address === "string") throw new Error("No listener");
    const pending = hold("http://127.0.0.1:" + String(address.port) + "/sync/v1/roots/" + binding.root_id + "/small-batches/data", payload.body.subarray(0, start + 3), payload.type);
    try { await pending.closed; expect(await pending.response).toBeUndefined(); }
    finally { pending.request.destroy(); await pending.closed; await slow.close(); }
    expect(await counts()).toEqual(before); expect((await statuses(value)).items[0]?.state).toBe("MISSING");
    checks.push("actual stalled multipart input cancelled and joined at deadline, no private file/session allocated for incomplete item");
  }, 10000);
  it("turns bounded SQL lock contention into retryable HTTP admission without registering partial metadata", async () => {
    const value = plan(), before = await counts();
    await database.transaction(async sql => {
      await sql`SELECT root_id FROM sync_root_clock WHERE root_id=${binding.root_id} FOR UPDATE`;
      const response = await post("prepare", value); expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("1"); await response.arrayBuffer();
    });
    expect(await registry.status(value.manifest.batch_id, binding, proof)).toBeUndefined(); expect(await counts()).toEqual(before);
    checks.push("owned synthetic SQL lock timeout rolls back registration and responds429/Retry-After; no partial original or root reset");
  }, 10000);
  it("rejects partial guards and an inconsistent materialized byte budget in recovery", async () => {
    const before = await database.transaction(sql => inspectJournal(sql));
    expect(before.smallBatchShape).toBe(SMALL_BATCH_SCHEMA);
    await expect(database.transaction(async sql => {
      await sql`ALTER TABLE sync_small_batches DISABLE TRIGGER sync_small_batches_guard`;
      await inspectJournal(sql);
    })).rejects.toThrow("Incomplete small batch registry guards");
    await expect(database.transaction(async sql => {
      await sql`ALTER TABLE sync_small_batch_budget DISABLE TRIGGER sync_small_batch_budget_guard`;
      await sql`UPDATE sync_small_batch_budget SET metadata_bytes=metadata_bytes+1`;
      await sql`ALTER TABLE sync_small_batch_budget ENABLE TRIGGER sync_small_batch_budget_guard`;
      await inspectJournal(sql);
    })).rejects.toThrow("Incoherent small batch originals/counters");
    expect(await database.transaction(sql => inspectJournal(sql))).toEqual(before);
    checks.push("disabled guards and corrupted budget rejected; negative fixture transactions roll back exactly");
  });
  it("exports and restores a coherent original registry and original upload receipts", async () => {
    const destination = path.join(directory, "metadata"), exporter = new DatabaseMetadataExporter(database, 100, { maximumExportBytes: 16 * 1024 * 1024 });
    const dumpPath = path.join(directory, "registry.dump"), restoreName = databaseName + "_restore";
    await fs.writeFile(path.join(directory, "restore-ownership.json"), json({ databaseName: restoreName, containerId, at: new Date().toISOString() }), { flag: "wx" });
    const evidence = await withRecoverySnapshot(database, 30000, undefined, async snapshot => {
      const members = await exporter.exportFromSnapshot(destination, snapshot);
      for (const name of ["sync_small_batch_budget", "sync_small_batch_operations", "sync_small_batches"]) expect(members.some(member => member.path === "metadata/" + name + ".jsonl")).toBe(true);
      const dump = (await exec("docker", ["exec", containerId, "pg_dump", "-U", "postgres", "-d", databaseName, "--format=custom", "--no-owner", "--no-acl", "--snapshot=" + snapshot.snapshotId], { windowsHide: true, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })).stdout;
      await fs.writeFile(dumpPath, dump, { flag: "wx" });
      const pins = await Promise.all(members.map(async member => { const bytes = await fs.readFile(member.sourcePath); return { path: member.path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length }; }));
      return { journal: snapshot.journal, pins };
    });
    await admin.withSql(sql => sql.unsafe("CREATE DATABASE " + restoreName));
    await captureFixtureDocker(directory, ["exec", "-i", containerId, "pg_restore", "-U", "postgres", "-d", restoreName, "--no-owner", "--no-acl", "--exit-on-error"], await fs.readFile(dumpPath));
    if (!fixturePath) throw new Error("Missing fixture");
    const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as { databaseUrl: string };
    const restoredUrl = new URL(fixture.databaseUrl); restoredUrl.pathname = "/" + restoreName;
    const restored = new Database(restoredUrl.toString(), { max: 1 });
    try {
      expect(await restored.transaction(sql => inspectJournal(sql))).toEqual(evidence.journal);
      const members = await new DatabaseMetadataExporter(restored, 100, { maximumExportBytes: 16 * 1024 * 1024 }).exportTo(path.join(directory, "restored-metadata"));
      const pins = await Promise.all(members.map(async member => { const bytes = await fs.readFile(member.sourcePath); return { path: member.path, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length }; }));
      expect(pins).toEqual(evidence.pins);
      await expect(restored.transaction(sql => guardRecoveryMutation(sql))).rejects.toThrow("automatic recovery is blocked");
      await fs.writeFile(path.join(directory, "restore-proof.json"), json({ at: new Date().toISOString(), journal: evidence.journal, matchedMembers: members.length, dumpSha256: createHash("sha256").update(await fs.readFile(dumpPath)).digest("hex") }));
    } finally { await restored.close(); }
    checks.push("same-cut pg_dump plus bounded JSONL, actual pg_restore and every metadata digest match; automatic registered-root recovery remains blocked");
  }, 45000);
});
