import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { Database } from "@saturn/database";
import { loadEnvironment } from "@saturn/config";
import { FileService, PostgresFileRepository } from "@saturn/file-core";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import { LocalStorageAdapter, SftpStorageAdapter } from "@saturn/storage";
import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { qualifyCatalogDatabaseRoles } from "../../../packages/database/src/catalog-role-qualification.js";
import { DurableBackendExecutor, type BackendCommand } from "../../../packages/storage/src/durable-backend-executor.js";
import { BackendPayloadStore } from "../../../packages/storage/src/backend-payload-store.js";
import { CatalogFolderAuthorityIssuer } from "../../../packages/file-core/src/catalog-folder-authority.js";
import { CatalogNamespaceMutations } from "../../../packages/file-core/src/catalog-namespace-mutations.js";
import { CatalogRootAdmission } from "../../../packages/file-core/src/catalog-root-admission.js";
import { CatalogUploadDatabaseCoordinator } from "../../../packages/file-core/src/catalog-upload-database.js";
import { CatalogFolderV2DatabaseCoordinator } from "../../../packages/file-core/src/catalog-folder-v2-database.js";
import { CatalogStreamUpload } from "../../../packages/file-core/src/catalog-stream-upload.js";
import type { CatalogUploadPrepareInput, UploadPublicationIntentV2 } from "../../../packages/file-core/src/catalog-upload-intent.js";
import { fixtureManifest, sha, uid, type activeFixture } from "./stage3-chat-a.fixture.js";
import { sharedBackendFactory } from "./completion-shared-backend.fixture.js";

export interface RetainedClient {
  kind: "windows" | "pluto"; databaseName: string; binding: SyncRootBinding;
  backendIdentity: string; authorization: string; deviceId: string; rootName: string;
  receipt: string; namespace: { codec: "portable_v1"; policyHash: string };
}
/** Test receiver restart only. Never activates/adopts a root or alters an
 * original. A durable STOPPED owner receipt is mandatory before takeover. */
export async function resumeCompletionFixture(c: RetainedClient): Promise<Awaited<ReturnType<typeof activeFixture>>> {
  const uuid = (value: string): UUID => { assert(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(value)); return value as UUID; };
  const manifest = await fixtureManifest();
  assert(/^stage3_[a-f0-9]{32}$/.test(c.databaseName));
  const suffix = c.databaseName.slice(7), directory = path.join(manifest.fixtureDirectory, c.databaseName);
  await fs.access(directory);
  const url = new URL(manifest.databaseUrl); url.pathname = "/" + c.databaseName;
  const admin = new Database(url.toString(), { max: 4 });
  const scalePlan = process.env.COMPLETION_SCALE_ACTIVATION
    ? z.object({ databases: z.array(z.object({ database: z.string(), rootId: z.string(), payloadDirectory: z.string(),
      maximumFileBytes: z.string(), approvedFunctions: z.array(z.object({ identity: z.string(), sourceSha256: z.string() })) })) })
      .parse(JSON.parse(await fs.readFile(process.env.COMPLETION_SCALE_ACTIVATION, "utf8"))).databases.find(x => x.database === c.databaseName)
    : undefined;
  if (process.env.COMPLETION_SCALE_ACTIVATION) {
    assert(scalePlan && scalePlan.rootId === c.binding.root_id && path.isAbsolute(scalePlan.payloadDirectory), "Exact offline scale activation plan required");
  }
  let runtime: Database | undefined, writer: Database | undefined, executor: DurableBackendExecutor | undefined;
  try {
    const rows = await admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT g.*,c.epoch,c.binding_version,c.namespace_state,r.name,r.storage_path,
      b.generation,b.state AS backend_state,b.stopped_receipt,p.codec,p.policy_hash,p.state AS policy_state
      FROM catalog_guard_roots g JOIN sync_root_clock c ON c.root_id=g.root_id JOIN resources r ON r.id=g.root_id
      JOIN sync_backend_executor b ON b.backend_identity=g.backend_identity JOIN sync_root_policy p ON p.root_id=g.root_id
      WHERE g.root_id=${c.binding.root_id}`);
    assert.equal(rows.length, 1); const row = requireDefined(rows[0]);
    const active = row.active_runtime as Record<string, unknown>;
    assert.equal(row.backend_state, "STOPPED"); assert(row.stopped_receipt);
    assert.equal(row.namespace_state, "ACTIVE"); assert.equal(row.policy_state, "ACTIVE");
    assert.equal(row.epoch, c.binding.server_epoch); assert.equal(row.binding_version, c.binding.binding_version);
    assert.equal(row.backend_identity, c.backendIdentity); assert.equal(row.name, c.rootName);
    assert.equal(active.serverIdentity, c.binding.server_identity); assert.equal(active.policyVersion, c.binding.policy_version);
    assert.equal(active.qualificationReceiptSha256, c.receipt);
    assert.equal(row.codec, c.namespace.codec); assert.equal(row.policy_hash, c.namespace.policyHash);
    const roles = { runtimeRole: String(row.runtime_role), writerLogin: String(row.writer_login), writerOwner: String(row.writer_owner), migratorRole: "postgres" };
    assert.equal(roles.runtimeRole, "rt_" + suffix); assert.equal(roles.writerLogin, "wr_" + suffix); assert.equal(roles.writerOwner, "ow_" + suffix);
    const functions = await admin.withSql(sql => sql<{ identity: string; source: string }[]>`SELECT p.oid::regprocedure::text AS identity,p.prosrc AS source FROM pg_proc p WHERE p.proowner=(SELECT oid FROM pg_roles WHERE rolname=${roles.writerOwner}) ORDER BY p.oid`);
    const observedFunctions = functions.map(f => ({ identity: "public." + f.identity.replace(/^public\./, ""), sourceSha256: sha(f.source) }));
    const approvedFunctions = scalePlan?.approvedFunctions ?? observedFunctions;
    if (scalePlan) {
      assert.deepEqual([...observedFunctions].sort((a,b)=>a.identity.localeCompare(b.identity)), [...approvedFunctions].sort((a,b)=>a.identity.localeCompare(b.identity)));
      const policy = requireDefined((await admin.withSql(sql => sql<{features: string[]; maximum: string; migrations: number}[]>`SELECT features,
        (SELECT active_runtime->>'maximumFileBytes' FROM catalog_guard_roots WHERE root_id=${c.binding.root_id}) AS maximum,
        (SELECT count(*)::int FROM _vault_migrations WHERE name IN ('0071_snapshot_cardinality','0072_backend_parallel_claims','0073_upload_command_batch','0074_stream_upload_v2')) AS migrations
        FROM sync_root_policy WHERE root_id=${c.binding.root_id}`))[0]);
      assert.equal(policy.migrations,4);assert(policy.features.includes('scale-transfer-v2')&&policy.features.includes('stream-upload-v1'));
      assert.equal(policy.maximum,scalePlan.maximumFileBytes);
    }
    assert(approvedFunctions.some(f => f.identity === "public.sync_small_batch_command(text,jsonb,jsonb,jsonb)"));
    const ru = new URL(url), wu = new URL(url); ru.username = roles.runtimeRole; wu.username = roles.writerLogin;
    runtime = new Database(ru.toString(), { max: 4 }); writer = new Database(wu.toString(), { max: scalePlan?8:4 });
    await qualifyCatalogDatabaseRoles(writer, { ...roles, connection: "writer", approvedFunctions });
    let raw;
    if (process.env.COMPLETION_SHARED_BACKEND) {
      await sharedBackendFactory(); // validate the live container and loopback endpoint, without creating a root
      const shared = z.object({ containerId: z.string(), created: z.string(), runId: z.string(), prefix: z.string(), environmentFile: z.string() }).parse(JSON.parse(await fs.readFile(process.env.COMPLETION_SHARED_BACKEND, "utf8")));
      const owned = z.object({ containerId: z.string(), created: z.string(), runId: z.string(), root: z.string() }).parse(JSON.parse(await fs.readFile(path.join(directory, "shared-backend.json"), "utf8")));
      assert.equal(owned.containerId, shared.containerId); assert.equal(owned.created, shared.created); assert.equal(owned.runId, shared.runId);
      const config = loadEnvironment(z.record(z.string(), z.string()).parse(JSON.parse(await fs.readFile(shared.environmentFile, "utf8"))), process.cwd(), false).storage;
      assert.equal(owned.root, path.posix.join(config.root, shared.prefix, suffix));
      raw = new SftpStorageAdapter({ ...config, root: owned.root });
    } else raw = new LocalStorageAdapter(path.join(directory, "storage"));
    const writerDb = writer, runtimeDb = runtime;
    const command: BackendCommand = async (command, identity, payload) => requireDefined((await writerDb.withSql(sql => sql<{ value: unknown }[]>`SELECT sync_backend_command(${command},${JSON.stringify(identity)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`))[0]).value;
    const generation = uuid(String(row.generation)); executor = new DurableBackendExecutor(raw, command, c.backendIdentity, generation,268435456,undefined,
      scalePlan ? {payloads:new BackendPayloadStore(scalePlan.payloadDirectory,c.backendIdentity,generation),workers:4}:{});
    const legacy = new FileService(new PostgresFileRepository(runtime), raw);
    const devices = new DeviceService({ repository: new PostgresDeviceRepository(runtime), files: legacy, pepper: "stage3-disposable-pepper-123456789012345678", options: { enabled: true, publicOrigin: "https://fixture.invalid", uploadChunkMaxBytes: 8388608, propfindMaxItems: 100, deleteMaxItems: 500, deleteWindowMs: 10000 } });
    const issuer = new CatalogFolderAuthorityIssuer(runtime, { authenticateDevice: a => devices.authenticate(a) });
    const proof = await issuer.device(c.authorization, c.binding.root_id);
    const device = (await devices.authenticate(c.authorization)).device; assert.equal(device.id, c.deviceId);
    const admission = new CatalogRootAdmission(), mutations = new CatalogNamespaceMutations(writer, issuer, executor, admission);
    const maximumFileBytes=scalePlan?.maximumFileBytes??"1073741824";
    const files = new FileService(new PostgresFileRepository(runtime), executor, { uploadMaxBytes: Number(maximumFileBytes), catalogBackendIdentity: c.backendIdentity, catalogRootAdmission: admission,
      catalogUploadCoordinator: new CatalogUploadDatabaseCoordinator(writer, issuer, maximumFileBytes, true,!!scalePlan), catalogFolderV2Coordinator: new CatalogFolderV2DatabaseCoordinator(writer, issuer, true) });
    const binding = { epoch: c.binding.server_epoch, bindingVersion: c.binding.binding_version, guardRevision: String(row.guard_revision) };
    const uploadInput = (name: string, bytes: Buffer, previous?: { nodeId: string; metadataVersion: string; versionId: string }): CatalogUploadPrepareInput & { intent: UploadPublicationIntentV2 } => ({ epoch: binding.epoch, bindingVersion: binding.bindingVersion, backendIdentity: c.backendIdentity,
      intent: { schema: "saturn.upload-intent.v2", deviceKind: c.kind === "windows" ? "windows_sync" : "pluto", deviceId: c.deviceId, rootId: c.binding.root_id, requestPath: "/stage3/" + name, idempotencyKey: uid(), parentId: c.binding.root_id, name, targetId: previous?.nodeId ?? null, sizeBytes: String(bytes.length), sha256: sha(bytes), ifMatch: null, ifNoneMatch: previous ? null : "*", requireAbsent: !previous, expectedVersionId: previous?.versionId ?? null, condition: previous ? { kind: "match", nodeId: previous.nodeId, metadataVersion: previous.metadataVersion } : { kind: "absent" }, parentTopology: [{ nodeId: c.binding.root_id, parentId: null, name: c.rootName }] } });
    const upload = async (input: CatalogUploadPrepareInput, bytes: Buffer) => { let prepared = await files.prepareCatalogUpload(input, proof); if (bytes.length) prepared = await files.appendCatalogUpload(prepared, proof, "0", bytes); return files.completeCatalogUpload(prepared, proof); };
    const streams = new CatalogStreamUpload(writer, issuer, executor, files), activeExecutor = executor;
    await executor.start();
    return { db: admin, admin, runtime, writer, url: url.toString(), directory, suffix, roles, approvedFunctions, raw, executor, command, generation, backendIdentity: c.backendIdentity,
      rootId: c.binding.root_id, binding, wireBinding: { ...c.binding, server_identity: uuid(c.binding.server_identity) }, namespace: c.namespace, issuer, proof, mutations, admission, authorization: c.authorization, legacy, devices, rootPath: String(row.storage_path), files, uploadInput, upload, streams,
      close: async () => { await activeExecutor.close(); await writerDb.close(); await runtimeDb.close(); await admin.close(); } };
  } catch (e) { await executor?.close().catch(() => undefined); await writer?.close(); await runtime?.close(); await admin.close(); throw e; }
}
