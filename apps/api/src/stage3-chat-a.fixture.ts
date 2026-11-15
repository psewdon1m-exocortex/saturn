import { parseFixtureContainer } from "./docker-container.fixture.js";
import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Database, migrate } from "@saturn/database";
import { FileService, PostgresFileRepository, PostgresRootJournal, PostgresCurrentNamespace, ROOT_RESOURCE_ID, SYNC_RESOURCE_ID, OUTDOOR_CONNECTIONS_RESOURCE_ID } from "@saturn/file-core";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import { LocalStorageAdapter, type StorageAdapter } from "@saturn/storage";
import { DurableBackendExecutor, type BackendCommand } from "../../../packages/storage/src/durable-backend-executor.js";
import { BackendPayloadStore } from "../../../packages/storage/src/backend-payload-store.js";
import { CatalogFolderAuthorityIssuer } from "../../../packages/file-core/src/catalog-folder-authority.js";
import { CatalogNamespaceMutations } from "../../../packages/file-core/src/catalog-namespace-mutations.js";
import { CatalogRootAdmission } from "../../../packages/file-core/src/catalog-root-admission.js";
import { CatalogUploadDatabaseCoordinator } from "../../../packages/file-core/src/catalog-upload-database.js";
import { CatalogFolderV2DatabaseCoordinator } from "../../../packages/file-core/src/catalog-folder-v2-database.js";
import type { CatalogUploadPrepareInput, UploadPublicationIntentV2 } from "../../../packages/file-core/src/catalog-upload-intent.js";
import { CatalogStreamUpload } from "../../../packages/file-core/src/catalog-stream-upload.js";

export const exec = promisify(execFile);
export const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export const migrations = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url));
export const uid = randomUUID;
export function barrier() { let release!: () => void; const entered = new Promise<void>(r => { release = r; }); return { entered, release }; }
export async function evidence(id: string, name: string, value: unknown) {
  const base = process.env.STAGE3_CHAT_A_EVIDENCE;
  if (!base) throw Error("STAGE3_CHAT_A_EVIDENCE required");
  const dir = path.join(base, id); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name + ".json"), JSON.stringify(value, null, 2));
}
export async function fixtureManifest() {
  const file = process.env.STAGE3_CHAT_A_FIXTURE;
  if (!file) throw Error("STAGE3_CHAT_A_FIXTURE required; never use a working database");
  const f = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "")) as {
    containerId: string; runId: string; databaseUrl: string; fixtureDirectory: string; created: string;
    resourceBudget?: { nanoCpus: number; memoryBytes: number };
  };
  const budget = f.resourceBudget ?? { nanoCpus: 1e9, memoryBytes: 536870912 };
  if (![1e9, 2e9, 4e9].includes(budget.nanoCpus) || ![536870912, 1073741824, 2147483648].includes(budget.memoryBytes)) throw Error("unapproved fixture resource budget");
  const c = parseFixtureContainer((await exec("docker", ["inspect", f.containerId], { windowsHide: true })).stdout);
  if (c.Id !== f.containerId || c.Created !== f.created || c.Config.Labels["exocortex.sync-performance.run"] !== f.runId
    || !c.State.Running || c.HostConfig.NanoCpus !== budget.nanoCpus || c.HostConfig.Memory !== budget.memoryBytes) throw Error("fixture custody mismatch");
  const u = new URL(f.databaseUrl);
  if (u.hostname !== "127.0.0.1" || requireDefined(requireDefined(c.NetworkSettings.Ports["5432/tcp"])[0]).HostPort !== u.port) throw Error("fixture endpoint mismatch");
  return f;
}
export async function databaseFixture(id: string, cutoff = 68) {
  const f = await fixtureManifest(), suffix = uid().replaceAll("-", ""), name = "stage3_" + suffix;
  const directory = path.join(f.fixtureDirectory, name); await fs.mkdir(directory);
  const admin = new Database(f.databaseUrl, { max: 1 });
  try {
    await admin.withSql(sql => sql.unsafe(`CREATE DATABASE ${name}`));
    // These two tests assert PL/pgSQL call counts. Enable observation only
    // for their new disposable database, before migrations or role pools.
    if(id==='smallfile-registration-proof'||id==='smallfile-stored-shape')
      await admin.withSql(sql=>sql.unsafe(`ALTER DATABASE ${name} SET track_functions='pl'`));
    // Native harness comparison only, before any pool connects to this fresh
    // owned database. Production settings and other fixtures are untouched.
    if(id==='smallfile-native-receiver'&&process.env.SMALL_FILE_NATIVE_SQL_PROFILE==='0'){
      await admin.withSql(sql=>sql.unsafe(`ALTER DATABASE ${name} SET pg_stat_statements.track='none'`));
      await admin.withSql(sql=>sql.unsafe(`ALTER DATABASE ${name} SET track_functions='none'`));
      await admin.withSql(sql=>sql.unsafe(`ALTER DATABASE ${name} SET track_io_timing='off'`));
    }
  } finally { await admin.close(); }
  const url = new URL(f.databaseUrl); url.pathname = "/" + name;
  const selected = path.join(directory, "migrations"); await fs.mkdir(selected);
  for (const file of await fs.readdir(migrations)) if (Number(file.slice(0, 4)) <= cutoff) await fs.copyFile(path.join(migrations, file), path.join(selected, file));
  try { await migrate(url.toString(), selected); }
  catch (e) { await evidence(id, "migration-failure", { message: String(e), ...(e as object) }); throw e; }
  const db = new Database(url.toString(), { max: 8 });
  await evidence(id, "fixture-" + suffix, { name, directory, containerId: f.containerId, runId: f.runId, cutoff });
  return { db, url: url.toString(), directory, suffix, close: () => db.close() };
}
export const functionsV1 = ["catalog_folder_command(text,jsonb,jsonb)", "catalog_upload_command(text,jsonb,jsonb,jsonb)", "catalog_guard_upgrade_file(uuid)", "catalog_folder_v2_command(text,jsonb,jsonb,jsonb)", "catalog_guard_backend_uncertain(uuid,uuid)", "outside_folder_commit(uuid,jsonb)"];
export const functionsV2 = [...functionsV1, "sync_small_batch_command(text,jsonb,jsonb,jsonb)"];
export const functionsV3 = [...functionsV2, "sync_backend_command(text,jsonb,jsonb)", "sync_namespace_command(text,jsonb,jsonb,jsonb)", "sync_stream_command(text,jsonb,jsonb,jsonb)", "sync_retention_command(uuid,jsonb)"];
export async function rolesFixture(f: Awaited<ReturnType<typeof databaseFixture>>, signatures: readonly string[] = functionsV3) {
  const roles = { runtimeRole: "rt_" + f.suffix, writerLogin: "wr_" + f.suffix, writerOwner: "ow_" + f.suffix, migratorRole: "postgres" };
  for (const role of [roles.runtimeRole, roles.writerLogin, roles.writerOwner]) await f.db.withSql(sql => sql.unsafe(`CREATE ROLE ${role} ${role === roles.writerOwner ? "NOLOGIN" : "LOGIN"} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`));
  // The generated LOGIN roles use the isolated fixture credential when SCRAM
  // is configured. Keep the fixture's HBA and authentication unchanged.
  const password = decodeURIComponent(new URL(f.url).password);
  if (password) for (const role of [roles.runtimeRole, roles.writerLogin])
    await f.db.withSql(sql => sql.unsafe(`ALTER ROLE ${role} PASSWORD '${password.replaceAll("'", "''")}'`));
  await f.db.withSql(sql => sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${roles.runtimeRole},${roles.writerLogin},${roles.writerOwner}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${roles.runtimeRole},${roles.writerOwner}`));
  for (const signature of signatures) await f.db.withSql(sql => sql.unsafe(`ALTER FUNCTION public.${signature} OWNER TO ${roles.writerOwner}; GRANT EXECUTE ON FUNCTION public.${signature} TO ${roles.writerLogin}`));
  // Invoker helpers remain owned by migrator. Only the NOLOGIN definer owner receives access.
  await f.db.withSql(sql => sql.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${roles.writerOwner}`));
  const rows = await f.db.withSql(sql => sql<{ identity: string; source: string }[]>`SELECT p.oid::regprocedure::text AS identity,p.prosrc AS source FROM pg_proc p WHERE p.proowner=(SELECT oid FROM pg_roles WHERE rolname=${roles.writerOwner}) ORDER BY p.oid`);
  const approvedFunctions = rows.map(r => ({ identity: "public." + r.identity.replace(/^public\./, ""), sourceSha256: sha(r.source) }));
  const ru = new URL(f.url), wu = new URL(f.url); ru.username = roles.runtimeRole; wu.username = roles.writerLogin;
  const runtime = new Database(ru.toString(), { max: 4 }), writer = new Database(wu.toString(), { max: 4 });
  return { roles, approvedFunctions, runtime, writer, close: async () => { await runtime.close(); await writer.close(); } };
}
export type FixtureStorageFactory = (directory: string, suffix: string) => Promise<StorageAdapter>;
export async function backendFixture(
  id: string, cutoff = 68, storageFactory?: FixtureStorageFactory, commandFactory?: (writer: Database) => BackendCommand,
) {
  const f = await databaseFixture(id, cutoff), r = await rolesFixture(f), generation = uid(), backendIdentity = "backend-" + f.suffix;
  await f.db.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO sync_backend_executor(backend_identity,generation,writer_login,writer_owner) VALUES(${backendIdentity},${generation},${r.roles.writerLogin},${r.roles.writerOwner})`);
  const command: BackendCommand = commandFactory?.(r.writer) ?? (async (command, identity, payload) => requireDefined((await r.writer.withSql(sql => sql<{ value: unknown }[]>`SELECT sync_backend_command(${command},${JSON.stringify(identity)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`))[0]).value);
  const raw = storageFactory ? await storageFactory(f.directory, f.suffix) : new LocalStorageAdapter(path.join(f.directory, "storage"));
  if (raw instanceof LocalStorageAdapter) await raw.initialize();
  const executor = new DurableBackendExecutor(raw, command, backendIdentity, generation,268435456,undefined,cutoff>=72?{payloads:new BackendPayloadStore(path.join(f.directory,'payloads'),backendIdentity,generation),workers:4}:{});
  return { ...f, ...r, admin: f.db, raw, executor, command, generation, backendIdentity, close: async () => { await executor.close(); await r.close(); await f.close(); } };
}
export async function activeFixture(id: string, kind: "windows" | "pluto" = "windows", cutoff = 68, storageFactory?: FixtureStorageFactory,maximumFileBytes='1073741824') {
  return requireDefined((await activeRootsFixture(id, kind, 1, cutoff, storageFactory,maximumFileBytes))[0]);
}
export async function activeRootsFixture(id: string, kind: "windows" | "pluto", count: number, cutoff = 68, storageFactory?: FixtureStorageFactory,maximumFileBytes='1073741824') {
  const f = await backendFixture(id, cutoff, storageFactory), legacy = new FileService(new PostgresFileRepository(f.admin), f.raw);
  await legacy.initializeStorage();
  const deviceOptions = { enabled: true, publicOrigin: "https://fixture.invalid", uploadChunkMaxBytes: 8388608, propfindMaxItems: 100, deleteMaxItems: 500, deleteWindowMs: 10000 };
  const devices = new DeviceService({ repository: new PostgresDeviceRepository(f.admin), files: legacy, pepper: "stage3-disposable-pepper-123456789012345678", options: deviceOptions });
  const enrollments = [];
  for (let n = 0; n < count; n++) enrollments.push(kind === "windows" ? await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment("stage3-" + String(n))).code, "fixture") : await devices.redeemPlutoEnrollment((await devices.createPlutoEnrollment("stage3-" + String(n))).code, "fixture"));
  const roots = [];
  for (const enrolled of enrollments) roots.push(await activateRootFixture(id, kind, f, legacy, devices, enrolled,maximumFileBytes));
  return roots;
}
async function activateRootFixture(id: string, kind: "windows" | "pluto", f: Awaited<ReturnType<typeof backendFixture>>, legacy: FileService, devices: DeviceService, enrolled: Awaited<ReturnType<DeviceService["redeemWindowsEnrollment"]>>,maximumFileBytes:string) {
  const rootId = requireDefined(enrolled.device.syncRootId);
  await new PostgresRootJournal(f.admin).registerRoot(rootId);
  await new PostgresCurrentNamespace(f.admin).qualifyFixture(rootId, [rootId]);
  await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE resources SET sync_availability='AVAILABLE' WHERE id=${rootId}`);
  await f.admin.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO catalog_guard_roots(root_id,guard_revision,writer_contract,runtime_role,writer_login,writer_owner,backend_identity,control_ancestor_ids) VALUES(${rootId},${uid()},'folder-only-g1.v1',${f.roles.runtimeRole},${f.roles.writerLogin},${f.roles.writerOwner},${f.backendIdentity},ARRAY[${ROOT_RESOURCE_ID}::uuid,${kind === "windows" ? SYNC_RESOURCE_ID : OUTDOOR_CONNECTIONS_RESOURCE_ID}::uuid])`);
  await f.writer.withSql(sql => sql<Record<string, unknown>[]>`SELECT catalog_guard_upgrade_file(${rootId}::uuid)`);
  const row = requireDefined((await f.admin.withSql(sql => sql<{ epoch: string; metadata_version: string; storage_path: string }[]>`SELECT c.epoch,r.metadata_version,r.storage_path FROM sync_root_clock c JOIN resources r ON r.id=c.root_id WHERE c.root_id=${rootId}`))[0]);
  const activation = { schema: "saturn.catalog-active.v1", rootId, serverEpoch: row.epoch, serverIdentity: uid(), policyVersion: "stage3", backendIdentity: f.backendIdentity, backendProfileId: "bootstrap", backendProfileRevision: 1, backendGeneration: f.generation, fenceReceiptSha256: sha("isolated-closed-custody"), qualificationReceiptSha256: sha("isolated-role-proof"), activationReceiptSha256: sha(rootId), maximumFileBytes, observedMetadataVersion: row.metadata_version, observedPathSha256: sha(row.storage_path), observedAt: new Date().toISOString(), oldExecutorsDrained: true, oldCredentialsRevoked: true, emptyPhysicalRootVerified: true };
  if ((await f.raw.list(row.storage_path, undefined, 1)).entries.length) throw Error("activation needs empty fixture");
  const binding = requireDefined((await f.admin.withSql(sql => sql<{ value: { epoch: string; bindingVersion: string; guardRevision: string } }[]>`SELECT catalog_guard_activate_empty(${rootId}::uuid,${JSON.stringify(activation)}::text::jsonb) AS value`))[0]).value;
  const namespace = { codec: "portable_v1" as const, policyHash: sha("stage3-include-all") };
  await f.admin.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO sync_root_policy(root_id,codec,policy_hash,policy_version,features,state) VALUES(${rootId},${namespace.codec},${namespace.policyHash},'stage3','["namespace-mutations-v1","clone-content-v1","stream-upload-v1"]','ACTIVE')`);
  const issuer = new CatalogFolderAuthorityIssuer(f.runtime, { authenticateDevice: a => devices.authenticate(a) });
  const authorization = "Bearer " + enrolled.token;
  const proof = await issuer.device(authorization, rootId), admission = new CatalogRootAdmission();
  const mutations = new CatalogNamespaceMutations(f.writer, issuer, f.executor, admission);
  const files = new FileService(new PostgresFileRepository(f.runtime), f.executor, { uploadMaxBytes: Number(maximumFileBytes), catalogBackendIdentity: f.backendIdentity, catalogRootAdmission: admission,
    catalogUploadCoordinator: new CatalogUploadDatabaseCoordinator(f.writer, issuer, maximumFileBytes, true), catalogFolderV2Coordinator: new CatalogFolderV2DatabaseCoordinator(f.writer, issuer, true) });
  const rootName = requireDefined((await f.admin.withSql(sql => sql<{ name: string }[]>`SELECT name FROM resources WHERE id=${rootId}`))[0]).name;
  const uploadInput = (name: string, bytes: Buffer, previous?: { nodeId: string; metadataVersion: string; versionId: string }): CatalogUploadPrepareInput & { intent: UploadPublicationIntentV2 } => ({ epoch: binding.epoch, bindingVersion: binding.bindingVersion, backendIdentity: f.backendIdentity,
    intent: { schema: "saturn.upload-intent.v2", deviceKind: kind === "windows" ? "windows_sync" : "pluto", deviceId: enrolled.device.id, rootId, requestPath: "/stage3/" + name, idempotencyKey: uid(), parentId: rootId, name, targetId: previous?.nodeId ?? null, sizeBytes: String(bytes.length), sha256: sha(bytes), ifMatch: null, ifNoneMatch: previous ? null : "*", requireAbsent: !previous, expectedVersionId: previous?.versionId ?? null, condition: previous ? { kind: "match", nodeId: previous.nodeId, metadataVersion: previous.metadataVersion } : { kind: "absent" }, parentTopology: [{ nodeId: rootId, parentId: null, name: rootName }] } satisfies UploadPublicationIntentV2 });
  const upload = async (input: CatalogUploadPrepareInput, bytes: Buffer) => { let prepared = await files.prepareCatalogUpload(input, proof); if (bytes.length) prepared = await files.appendCatalogUpload(prepared, proof, "0", bytes); return files.completeCatalogUpload(prepared, proof); };
  const streams = new CatalogStreamUpload(f.writer, issuer, f.executor, files);
  await f.executor.start();
  await evidence(id, "active-" + rootId, { rootId, binding, generation: f.generation, backendIdentity: f.backendIdentity, namespace, deviceId: enrolled.device.id });
  const wireBinding = { protocol: "neptune-sync/1" as const, descriptor_schema: "saturn.current-namespace.v1" as const, server_identity: activation.serverIdentity, root_id: rootId, server_epoch: binding.epoch, policy_version: "stage3", binding_version: binding.bindingVersion };
  return { ...f, rootId, binding, wireBinding, namespace, issuer, proof, mutations, admission, authorization, legacy, devices, rootPath: row.storage_path, files, uploadInput, upload, streams };
}

