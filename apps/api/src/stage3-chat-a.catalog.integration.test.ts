import {startOwnedFixtureProcess,requireNormalFixtureExit} from "./stage3-chat-a.owned-process.fixture.js";
interface ChangePage {items:{name:string}[];next_cursor:string;from_exclusive:string;to_inclusive:string}
import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import { expect, it } from "vitest";
import { Database, migrate, rollback } from "@saturn/database";
import { FileService, PostgresFileRepository, ROOT_RESOURCE_ID } from "@saturn/file-core";
import { PostgresCatalogMutationGuard } from "../../../packages/file-core/src/catalog-guard-admission.js";
import { qualifyCatalogDatabaseRoles } from "../../../packages/database/src/catalog-role-qualification.js";
import { parseSyncMutationInput, parseSyncDeletePlan } from "../../../packages/contracts/src/sync-extensions.js";
import { CatalogPlutoRetention } from "../../../packages/file-core/src/catalog-pluto-retention.js";
import { parseStreamPrepare, CatalogStreamUpload } from "../../../packages/file-core/src/catalog-stream-upload.js";
import { vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { guardedSyncHttp } from "./guarded-sync-http.js";
import { guardedSyncStreamHttp } from "./guarded-sync-stream-http.js";
import { guardedSyncMutationHttp } from "./guarded-sync-mutation-http.js";
import { PostgresSyncSnapshotStage } from "../../../packages/sync/src/sync-snapshot-stage.js";
import { PostgresSyncSnapshotReader } from "../../../packages/sync/src/sync-snapshot-read.js";
import { LocalStorageAdapter } from "@saturn/storage";
import { DurableBackendExecutor } from "../../../packages/storage/src/durable-backend-executor.js";
import { SmallBatchRegistry } from "../../../packages/file-core/src/small-batch-registry.js";
import { SmallBatchExecutor } from "./sync-small-batch-executor.js";
import { databaseFixture, rolesFixture, functionsV1, functionsV2, migrations, evidence, activeFixture, activeRootsFixture, barrier, uid, sha } from "./stage3-chat-a.fixture.js";

it("A06 ACTIVE empty, metadata proof, case-only move, stale CAS and durable approved quarantine", async () => {
  const f = await activeFixture("A06");
  const base = { schema: "saturn.namespace-mutation.v1", rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion };
  const make = (fields: object) => parseSyncMutationInput({ ...base, operationId: uid(), idempotencyKey: uid(), ...fields });
  try {
    const empty = make({ kind: "create-empty", expected: { kind: "absent" }, parentId: f.rootId, name: "file.txt" });
    const made = await f.mutations.execute(empty, f.namespace, f.proof); expect(made.state).toBe("PUBLISHED");
    expect(await f.mutations.execute(empty, f.namespace, f.proof)).toEqual(made);
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM upload_sessions`)).toHaveLength(0);
    let d = requireDefined(made.result).description;
    const condition = () => ({ kind: "version", node_id: d.node_id, version: d.version });
    const row = requireDefined((await f.admin.withSql(sql => sql<{ current_version_id: string }[]>`SELECT current_version_id FROM resources WHERE id=${d.node_id}`))[0]);
    const metadata = make({ kind: "metadata-patch", expected: condition(), contentVersionId: row.current_version_id, sha256: sha(""), modifiedAt: "2026-10-14T10:00:00Z" });
    d = requireDefined((await f.mutations.execute(metadata, f.namespace, f.proof)).result).description;
    expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT current_version_id FROM resources WHERE id=${d.node_id}`))[0]).current_version_id).toBe(row.current_version_id);
    const stale = make({ kind: "move", expected: condition(), parentId: f.rootId, name: "FILE.txt" });
    d = requireDefined((await f.mutations.execute(stale, f.namespace, f.proof)).result).description;
    await expect(f.mutations.execute(parseSyncMutationInput({ ...stale, operationId: uid(), idempotencyKey: uid(), name: "stale.txt" }), f.namespace, f.proof)).rejects.toMatchObject({ code: "precondition_failed" });
    const plan = parseSyncDeletePlan({ schema: "saturn.delete-plan.v1", planId: uid(), planDigest: sha("reviewed"), items: [{ nodeId: d.node_id, version: d.version }] });
    const deletion = make({ kind: "quarantine-delete", expected: condition(), planId: plan.planId, planDigest: plan.planDigest });
    await expect(f.mutations.execute(make({ kind: "quarantine-delete", expected: condition(), planId: null, planDigest: null }), f.namespace, f.proof)).rejects.toMatchObject({ code: "approval_stale" });
    await expect(f.mutations.execute(deletion, f.namespace, f.proof)).rejects.toMatchObject({ code: "approval_stale" });
    const approval = await f.mutations.approveDeletePlan(f.rootId, f.binding.epoch, f.binding.bindingVersion, plan, f.namespace, f.proof);
    expect(await f.mutations.approveDeletePlan(f.rootId, f.binding.epoch, f.binding.bindingVersion, plan, f.namespace, f.proof)).toEqual(approval);
    expect(requireDefined((await f.mutations.execute(deletion, f.namespace, f.proof)).result).tombstone).toBe(true);
    await evidence("A06", "receipt", { made, approval, deleted: await f.mutations.status(deletion, f.namespace, f.proof) });
  } finally { await f.close(); }
}, 60000);

it("A02 additive migrations through 0070, repeat no-op, empty down/up and strict roles", async () => {
  const f = await databaseFixture("A02", 61); let roles: Awaited<ReturnType<typeof rolesFixture>> | undefined;
  try {
    const selectedMigrations = path.join(f.directory, "migrations-through-0070");
    await fs.mkdir(selectedMigrations);
    for (const file of await fs.readdir(migrations))
      if (/^\d{4}_.*\.(up|down)\.sql$/.test(file) && Number(file.slice(0, 4)) <= 70)
        await fs.copyFile(path.join(migrations, file), path.join(selectedMigrations, file));
    const oldEpoch = uid();
    await f.db.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO sync_root_clock(root_id,epoch,published_seq) VALUES(${ROOT_RESOURCE_ID},${oldEpoch},1)`);
    for (const state of ["committing", "active"]) await f.db.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,payload,sync_root_id,sync_epoch,sync_intent_hash,sync_first_seq,sync_last_seq,sync_result) VALUES(${uid()},'fixture',${state},${uid()},${JSON.stringify({ original: "314159", expected: uid() })}::text::jsonb,${ROOT_RESOURCE_ID},${oldEpoch},${sha(state)},${state === "active" ? 1 : null},${state === "active" ? 1 : null},${state === "active" ? JSON.stringify({ receipt: uid(), status: "PUBLISHED" }) : null}::text::jsonb)`);
    const originals = await f.db.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,state,idempotency_key,payload,sync_root_id,sync_epoch,sync_intent_hash,sync_first_seq,sync_last_seq,sync_result FROM operation_journal ORDER BY id`);
    const before = await f.db.withSql(sql => sql<Record<string, unknown>[]>`SELECT name FROM _vault_migrations ORDER BY name`);
    try { expect(await migrate(f.url, selectedMigrations)).toBe(9); }
    catch (e) { const error = e as Record<string, unknown>; await evidence("A02", "upgrade-failure", { message: String(e), code: error.code, position: error.position, internal_query: error.internal_query, internal_position: error.internal_position, where: error.where }); throw e; }
    expect(await migrate(f.url, selectedMigrations)).toBe(0);
    expect(await rollback(f.url, selectedMigrations)).toBe("0070_namespace_guard_index");
    expect(await rollback(f.url, selectedMigrations)).toBe("0069_clone_admission_index");
    expect(await rollback(f.url, selectedMigrations)).toBe("0068_retention_backlog_admission");
    expect(await migrate(f.url, selectedMigrations)).toBe(3);
    roles = await rolesFixture(f);
    expect(await f.db.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,state,idempotency_key,payload,sync_root_id,sync_epoch,sync_intent_hash,sync_first_seq,sync_last_seq,sync_result FROM operation_journal ORDER BY id`)).toEqual(originals);
    const policy = { ...roles.roles, approvedFunctions: roles.approvedFunctions, connection: "runtime" as const };
    expect((await qualifyCatalogDatabaseRoles(roles.runtime, policy)).sessionRole).toBe(roles.roles.runtimeRole);
    expect((await qualifyCatalogDatabaseRoles(roles.writer, { ...policy, connection: "writer" })).sessionRole).toBe(roles.roles.writerLogin);
    await expect(qualifyCatalogDatabaseRoles(roles.runtime, { ...policy, approvedFunctions: policy.approvedFunctions.map((p, n) => n === 0 ? { ...p, sourceSha256: "0".repeat(64) } : p) })).rejects.toThrow();
    await expect(roles.runtime.withSql(sql => sql<Record<string, unknown>[]>`SELECT sync_retention_command(gen_random_uuid(),'{}'::jsonb)`)).rejects.toThrow("permission denied");
    await expect(roles.runtime.withSql(sql => sql<Record<string, unknown>[]>`TRUNCATE sync_retention_originals`)).rejects.toThrow();
    await expect(roles.runtime.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO sync_backend_executor(backend_identity,generation) VALUES('forged',gen_random_uuid())`)).rejects.toThrow();
    await expect(roles.writer.withSql(sql => sql<Record<string, unknown>[]>`SELECT sync_retention_command(gen_random_uuid(),'{}'::jsonb)`)).rejects.toThrow("binding_invalid");
    await f.db.withSql(sql => sql.unsafe(`GRANT ${requireDefined(roles).roles.writerOwner} TO ${requireDefined(roles).roles.runtimeRole}`));
    await expect(qualifyCatalogDatabaseRoles(roles.runtime, policy)).rejects.toThrow("privileged_membership");
    await f.db.withSql(sql => sql.unsafe(`REVOKE ${requireDefined(roles).roles.writerOwner} FROM ${requireDefined(roles).roles.runtimeRole}`));
    await f.db.withSql(sql => sql.unsafe(`ALTER FUNCTION public.sync_retention_command(uuid,jsonb) OWNER TO postgres`));
    await expect(qualifyCatalogDatabaseRoles(roles.runtime, policy)).rejects.toThrow("unapproved_function");
    await f.db.withSql(sql => sql.unsafe(`ALTER FUNCTION public.sync_retention_command(uuid,jsonb) OWNER TO ${requireDefined(roles).roles.writerOwner}`));
    const arbitrary = "other_" + f.suffix; await f.db.withSql(sql => sql.unsafe(`CREATE ROLE ${arbitrary} LOGIN NOSUPERUSER NOINHERIT`));
    const otherUrl = new URL(f.url); otherUrl.username = arbitrary; const other = new Database(otherUrl.toString(), { max: 1 });
    try { await expect(other.withSql(sql => sql<Record<string, unknown>[]>`TRUNCATE sync_retention_originals`)).rejects.toThrow(); await expect(other.withSql(sql => sql<Record<string, unknown>[]>`SELECT sync_retention_command(gen_random_uuid(),'{}'::jsonb)`)).rejects.toThrow(); } finally { await other.close(); }
    expect((await qualifyCatalogDatabaseRoles(roles.runtime, policy)).sessionRole).toBe(roles.roles.runtimeRole);
    const retained = await f.db.withSql(sql => sql<Record<string, unknown>[]>`SELECT name FROM _vault_migrations ORDER BY name`);
    expect(retained.slice(0, before.length)).toEqual(before);
    await evidence("A02", "roles", { roles: roles.roles, functions: roles.approvedFunctions, migrationCount: retained.length });
  } finally { await roles?.close(); await f.close(); }
}, 90000);

it.each([["v1", functionsV1], ["v2", functionsV2]] as const)("A02 %s legacy role qualification remains valid without broadening entry points", async (revision, signatures) => {
  const f = await databaseFixture("A02-" + revision, 61), r = await rolesFixture(f, signatures);
  try { for (const connection of ["runtime", "writer"] as const) expect((await qualifyCatalogDatabaseRoles(r[connection], { ...r.roles, approvedFunctions: r.approvedFunctions, connection })).approvedFunctions).toHaveLength(signatures.length); }
  finally { await r.close(); await f.close(); }
}, 30000);

it("A09 batch originals: published, missing, partial and rejected; missing-only subset retains IDs", async () => {
  const f = await activeFixture("A09-batch");
  try {
    const bytes = Buffer.from("batch-314159"), inputs = Array.from({ length: 6 }, (_, n) => f.uploadInput("batch-" + String(n), bytes));
    const plan = { manifest: { ...f.wireBinding, schema: "saturn.small-file-batch.v1", batch_id: uid(), rules_version: "1", items: inputs.map(i => ({ operation_id: i.intent.idempotencyKey, source_generation: "1", source_identity: uid(), parent_id: f.rootId, name: i.intent.name, size_bytes: String(bytes.length), sha256: sha(bytes), expected: { kind: "absent" } })) }, inputs };
    const registry = new SmallBatchRegistry(f.writer, f.issuer);
    await registry.register(plan, f.wireBinding, f.proof);
    await f.upload(requireDefined(inputs[0]), bytes); await f.upload(requireDefined(inputs[1]), bytes);
    let partial = await f.files.prepareCatalogUpload(requireDefined(inputs[4]), f.proof); partial = await f.files.appendCatalogUpload(partial, f.proof, "0", bytes.subarray(0, 3));
    const rejected = await f.files.prepareCatalogUpload(requireDefined(inputs[5]), f.proof); await f.files.cancelCatalogUpload(rejected, f.proof);
    const reopened = new SmallBatchRegistry(f.writer, f.issuer), replay = await reopened.register(plan, f.wireBinding, f.proof);
    expect(replay.replayed).toBe(true); expect(replay.plan.inputs).toEqual(inputs);
    const batch = new SmallBatchExecutor(reopened, f.files, f.wireBinding, f.proof);
    const status = await batch.status(replay);
    expect(status.items.map(i => i.state)).toEqual(["PUBLISHED", "PUBLISHED", "MISSING", "MISSING", "PENDING", "NOT_PUBLISHED"]);
    const subset = { manifest: { ...plan.manifest, batch_id: uid(), items: [plan.manifest.items[2], plan.manifest.items[3]] }, inputs: [inputs[2], inputs[3]] };
    const registered = await reopened.register(subset, f.wireBinding, f.proof); expect(registered.plan.inputs).toEqual([inputs[2], inputs[3]]);
    const restoredPartial = await f.files.prepareCatalogUpload(requireDefined(inputs[4]), f.proof, partial.status.session.uploadId);
    expect(restoredPartial.status.session.receivedSizeBytes).toBe("3");
    expect(restoredPartial.status.session.uploadId).toBe(partial.status.session.uploadId);
    await evidence("A09", "batch", { status, individualIds: inputs.map(i => i.intent.idempotencyKey), originalBatch: plan.manifest.batch_id, subsetBatch: subset.manifest.batch_id });
  } finally { await f.close(); }
}, 60000);

it("A06 approved tree requires postorder; wrong digest/item/root and legacy writers refuse before IO", async () => {
  const f = await activeFixture("A06-tree"), topology = f.uploadInput("unused", Buffer.alloc(0)).intent;
  try {
    const rootTopology = topology.parentTopology;
    const folder = async (name: string, parentId = f.rootId, parentTopology = rootTopology) => (await f.files.ensureCatalogFolderV2({ operationId: uid(), idempotencyKey: uid(), rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, parentId, parentTopology, name, mode: "ensure" }, f.proof)).result.description;
    const parent = await folder("parent"), child = await folder("child", parent.node_id, [{ nodeId: parent.node_id, parentId: f.rootId, name: "parent" }, ...rootTopology]);
    const base = { schema: "saturn.namespace-mutation.v1", rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion };
    const make = (extra: object) => parseSyncMutationInput({ ...base, operationId: uid(), idempotencyKey: uid(), ...extra });
    const leaf = requireDefined((await f.mutations.execute(make({ kind: "create-empty", expected: { kind: "absent" }, parentId: child.node_id, name: "leaf" }), f.namespace, f.proof)).result).description;
    const items = [parent, child, leaf].map(d => ({ nodeId: d.node_id, version: d.version })), plan = parseSyncDeletePlan({ schema: "saturn.delete-plan.v1", planId: uid(), planDigest: sha(JSON.stringify(items)), items });
    // Parent metadata is content/topology identity, not a mutable child-count token.
    await f.mutations.approveDeletePlan(f.rootId, f.binding.epoch, f.binding.bindingVersion, plan, f.namespace, f.proof);
    const deletion = (d: typeof parent, digest = plan.planDigest) => make({ kind: "quarantine-delete", expected: { kind: "version", node_id: d.node_id, version: d.version }, planId: plan.planId, planDigest: digest });
    await expect(f.mutations.execute(deletion(parent), f.namespace, f.proof)).rejects.toMatchObject({ code: "directory_not_empty" });
    await expect(f.mutations.execute(deletion(leaf, sha("wrong")), f.namespace, f.proof)).rejects.toMatchObject({ code: "approval_stale" });
    await expect(f.mutations.approveDeletePlan(f.rootId, f.binding.epoch, f.binding.bindingVersion, { ...plan, items: [{ nodeId: uid(), version: leaf.version }] }, f.namespace, f.proof)).rejects.toThrow();
    await expect(f.mutations.approveDeletePlan(uid(), f.binding.epoch, f.binding.bindingVersion, plan, f.namespace, f.proof)).rejects.toThrow();
    const legacy = new FileService(new PostgresFileRepository(f.runtime), f.raw, { catalogMutationGuard: new PostgresCatalogMutationGuard(f.runtime) });
    const before = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,state,payload FROM operation_journal ORDER BY id`);
    const io = ["write", "mkdir", "rename", "copy", "delete", "truncate", "openRead", "stat", "list", "exists", "statFs"].map(m => vi.spyOn(f.raw, m as "stat"));
    const refused = [() => legacy.createFolder(f.rootId, "legacy"), () => legacy.moveResource(leaf.node_id, { parentId: ROOT_RESOURCE_ID, idempotencyKey: uid() }), () => legacy.copyResource(leaf.node_id, { parentId: ROOT_RESOURCE_ID, idempotencyKey: uid() }), () => legacy.trashResource(parent.node_id, { idempotencyKey: uid() }), () => legacy.restoreResource(leaf.node_id, { idempotencyKey: uid() }), () => legacy.restoreVersion(leaf.node_id, uid(), { idempotencyKey: uid() }), () => legacy.createUpload({ parentId: child.node_id, filename: "webdav", expectedSize: 1, idempotencyKey: uid() }), () => legacy.purgeAdoptedFile({ rootId: f.rootId, storagePath: f.rootPath + "/legacy", sha256: sha("") })];
    refused.push(() => legacy.adoptExistingFile({ rootId: f.rootId, storagePath: f.rootPath + "/imported", sizeBytes: 0, sha256: sha(""), mimeType: "application/octet-stream" }));
    for (const action of refused) await expect(action()).rejects.toMatchObject({ code: "binding_invalid" });
    for (const spy of io) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,state,payload FROM operation_journal ORDER BY id`)).toEqual(before);
    const receipts = []; for (const d of [leaf, child, parent]) receipts.push(await f.mutations.execute(deletion(d), f.namespace, f.proof));
    expect(receipts.every(r => r.state === "PUBLISHED" && r.result?.tombstone)).toBe(true);
    await evidence("A06", "postorder", { plan, order: [leaf.node_id, child.node_id, parent.node_id], receipts, refusedWriters: refused.length });
  } finally { await f.close(); }
}, 60000);

it("A11 known hash clone is independent, replayed once, no-match and foreign reference refused", async () => {
  const f = await activeFixture("A11");
  try {
    const bytes = Buffer.from("deterministic-314159"), published = await f.upload(f.uploadInput("source", bytes), bytes);
    expect(published.status.result?.status).toBe("PUBLISHED");
    const lookup = await f.mutations.lookup(f.rootId, f.binding.epoch, f.binding.bindingVersion, String(bytes.length), sha(bytes), f.proof);
    expect(lookup.reference).not.toBeNull();
    expect((await f.mutations.lookup(f.rootId, f.binding.epoch, f.binding.bindingVersion, "99", sha("no-match"), f.proof)).reference).toBeNull();
    const input = parseSyncMutationInput({ schema: "saturn.namespace-mutation.v1", kind: "clone-content", operationId: uid(), idempotencyKey: uid(), rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, expected: { kind: "absent" }, parentId: f.rootId, name: "clone", source: lookup.reference });
    const cloned = await f.mutations.execute(input, f.namespace, f.proof); expect(cloned.state).toBe("PUBLISHED");
    expect(await f.mutations.execute(input, f.namespace, f.proof)).toEqual(cloned);
    const paths = await f.admin.withSql(sql => sql<{ name: string; storage_path: string; id: string }[]>`SELECT id,name,storage_path FROM resources WHERE parent_id=${f.rootId} ORDER BY name`);
    const source = requireDefined(paths.find(p => p.name === "source")), target = requireDefined(paths.find(p => p.name === "clone"));
    expect(source.id).not.toBe(target.id);
    await expect(f.issuer.device("Bearer invalid-fixture-token", f.rootId)).rejects.toThrow();
    await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE sync_root_policy SET features='["namespace-mutations-v1"]' WHERE root_id=${f.rootId}`);
    await expect(f.mutations.execute(parseSyncMutationInput({ ...input, operationId: uid(), idempotencyKey: uid(), name: "off" }), f.namespace, f.proof)).rejects.toMatchObject({ code: "unsupported" });
    await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE sync_root_policy SET features='["namespace-mutations-v1","clone-content-v1"]' WHERE root_id=${f.rootId}`);
    const r = requireDefined((await f.admin.withSql(sql => sql<{ metadata_version: string; current_version_id: string }[]>`SELECT metadata_version,current_version_id FROM resources WHERE id=${source.id}`))[0]);
    const changed = Buffer.from("changed-source"); await f.upload(f.uploadInput("source", changed, { nodeId: source.id, metadataVersion: r.metadata_version, versionId: r.current_version_id }), changed);
    await expect(f.mutations.execute(parseSyncMutationInput({ ...input, operationId: uid(), idempotencyKey: uid(), name: "stale-source" }), f.namespace, f.proof)).rejects.toMatchObject({ code: "precondition_failed" });
    expect(await f.mutations.status(input, f.namespace, f.proof)).toEqual(cloned);
    await f.raw.delete(source.storage_path);
    const chunks: Buffer[] = []; for await (const chunk of await f.raw.openRead(target.storage_path)) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    await expect(f.mutations.execute(parseSyncMutationInput({ ...input, operationId: uid(), idempotencyKey: uid(), name: "foreign", source: { ...lookup.reference, nodeId: uid() } }), f.namespace, f.proof)).rejects.toMatchObject({ code: "precondition_failed" });
    await evidence("A11", "clone", { source: source.id, target: target.id, bytes: bytes.length, sha256: sha(bytes), receipt: cloned });
  } finally { await f.close(); }
}, 60000);

it("A01 A09 real HTTP mutation batch and binary stream seal preserve canonical originals", async () => {
  const f = await activeFixture("A09-HTTP"), app = Fastify();
  try {
    const guard = { rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, guardRevision: f.binding.guardRevision }, scope = { wire: f.wireBinding, guard };
    const root = { binding: f.wireBinding, guard, authority: f.issuer, files: f.files, admission: f.admission, namespace: f.namespace, mutations: f.mutations, streams: f.streams, extensions: ["stream-upload-v1", "namespace-mutations-v1"], stage: new PostgresSyncSnapshotStage(f.runtime, f.issuer, scope), reader: new PostgresSyncSnapshotReader(f.runtime, f.issuer, scope, "fixture", [{ id: "fixture", secret: Buffer.alloc(32, 31) }]), ensureFolder: async (): Promise<never> => { throw Error("unused"); } };
    await app.register(guardedSyncStreamHttp, { root: async () => root }); await app.register(guardedSyncMutationHttp, { root: async () => root });
    const request = (endpoint: string, payload: object | Buffer, binary = false) => app.inject({ method: binary ? "PATCH" : "POST", url: `/sync/v1/roots/${f.rootId}/` + endpoint, headers: { authorization: f.authorization, "content-type": binary ? "application/vnd.saturn.sync-stream.v1" : "application/json" }, payload });
    const empty = parseSyncMutationInput({ schema: "saturn.namespace-mutation.v1", operationId: uid(), idempotencyKey: uid(), rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, kind: "create-empty", expected: { kind: "absent" }, parentId: f.rootId, name: "COMLPT1.md" });
    const batch = { binding: f.wireBinding, namespace: f.namespace, items: [{ ref: "empty", input: empty }, { ref: "conflict", input: { ...empty, operationId: uid(), idempotencyKey: uid() } }] };
    const mutations = await request("mutations/batch", batch); expect(mutations.statusCode).toBe(200);
    const batchResult = mutations.json<{outcomes:[{outcome:{state:string}},{code:string}]}>(); expect(batchResult.outcomes[0].outcome.state).toBe("PUBLISHED"); expect(batchResult.outcomes[1].code).toBe("precondition_failed");
    const bytes = Buffer.alloc(12 * 1024 * 1024 + 17, 41), prepare = f.uploadInput("stream-wire", bytes);
    const input = parseStreamPrepare({ schema: "saturn.stream-upload.v1", operationId: uid(), source: { generation: "7", witnessSha256: sha("wire-source") }, chunkBytes: 4194304, prepare: { ...prepare, intent: { ...prepare.intent, sha256: null } } }), envelope = { binding: f.wireBinding, input };
    expect((await request("stream-uploads/prepare", envelope)).statusCode).toBe(200);
    const chunks = [];
    for (let index = 0; index * 4194304 < bytes.length; index++) {
      const data = bytes.subarray(index * 4194304, (index + 1) * 4194304), chunk = { index, offset: String(index * 4194304), length: String(data.length), sha256: sha(data) }, metadata = Buffer.from(JSON.stringify({ ...envelope, chunk })), length = Buffer.alloc(4); length.writeUInt32BE(metadata.length); chunks.push(chunk);
      const response = await request("stream-uploads/chunk", Buffer.concat([length, metadata, data]), true); expect(response.statusCode).toBe(200); expect(response.json<{state:string}>().state).toBe("RECEIVING");
      if (index === 0) expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM resources WHERE parent_id=${f.rootId} AND name='stream-wire'`)).toHaveLength(0);
    }
    const seal = { sha256: sha(bytes), sourceGeneration: input.source.generation, sourceWitnessSha256: input.source.witnessSha256 };
    expect((await request("stream-uploads/seal", { ...envelope, seal: { ...seal, authority: true } })).statusCode).toBe(400);
    const terminal = await request("stream-uploads/seal", { ...envelope, seal }); expect(terminal.statusCode).toBe(200); expect(terminal.json<{state:string}>().state).toBe("PUBLISHED");
    expect((await request("stream-uploads/complete", envelope)).json()).toEqual(terminal.json<{state:string}>());
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM operation_journal WHERE id=${input.operationId} AND sync_result IS NOT NULL`)).toHaveLength(1);
    await evidence("A15", "server-contract-examples", { origin: "CHAT-A own HTTP fixture; not a B/C caller artifact", binding: f.wireBinding, mutationBatch: batch, mutationResponse: batchResult, streamPrepare: envelope, chunks, streamSeal: { ...envelope, seal }, terminal: terminal.json<{state:string}>(), bytesSha256: sha(bytes) });
  } finally { await app.close(); await f.close(); }
}, 60000);

it("A09 streaming early chunks, replay, restart, invalid seals and one terminal receipt", async () => {
  const f = await activeFixture("A09");
  try {
    const bytes = Buffer.alloc(12 * 1024 * 1024 + 17, 73), prepare = f.uploadInput("stream.bin", bytes);
    const input = parseStreamPrepare({ schema: "saturn.stream-upload.v1", operationId: uid(), source: { generation: "fixture-g1", witnessSha256: sha("source-witness") }, chunkBytes: 4194304, prepare: { ...prepare, intent: { ...prepare.intent, sha256: null } } });
    expect((await f.streams.prepare(input, f.proof)).state).toBe("RECEIVING");
    const outOfOrder = bytes.subarray(4194304, 8388608);
    await expect(f.streams.append(input, { index: 1, offset: "4194304", length: String(outOfOrder.length), sha256: sha(outOfOrder) }, outOfOrder, f.proof)).rejects.toThrow();
    let streams = f.streams;
    for (let index = 0; index < 4; index++) {
      const part = bytes.subarray(index * 4194304, (index + 1) * 4194304), chunk = { index, offset: String(index * 4194304), length: String(part.length), sha256: sha(part) };
      const ack = await streams.append(input, chunk, part, f.proof); expect(ack.receivedSizeBytes).toBe(String(Math.min((index + 1) * 4194304, bytes.length)));
      streams = new CatalogStreamUpload(f.writer, f.issuer, f.executor, f.files);
      expect(await streams.status(input, f.proof)).toEqual(ack); expect(await streams.append(input, chunk, part, f.proof)).toEqual(ack);
      const changed = Buffer.alloc(part.length, 74);
      await expect(streams.append(input, { ...chunk, sha256: sha(changed) }, changed, f.proof)).rejects.toThrow();
      expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM resources WHERE parent_id=${f.rootId} AND type='file'`)).toHaveLength(0);
      if (index === 0) await expect(f.streams.append(input, { ...chunk, sha256: sha("wrong") }, part, f.proof)).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(f.streams.seal(input, { sha256: sha(bytes), sourceGeneration: "changed", sourceWitnessSha256: input.source.witnessSha256 }, f.proof)).rejects.toThrow();
    const seal = { sha256: sha(bytes), sourceGeneration: input.source.generation, sourceWitnessSha256: input.source.witnessSha256 };
    let result;
    try { result = await f.streams.seal(input, seal, f.proof); }
    catch (original) { try { await f.writer.withSql(sql => sql<Record<string, unknown>[]>`SELECT sync_stream_command('seal',${JSON.stringify(input)}::text::jsonb,${JSON.stringify(f.issuer.deviceCredential(f.proof,f.rootId))}::text::jsonb,${JSON.stringify(seal)}::text::jsonb)`); } catch (e) { const error = e as Record<string,unknown>; await evidence("A09", "seal-failure", { message: String(e), code: error.code, where: error.where, query: error.internal_query }); } throw original; }
    expect(result.state).toBe("PUBLISHED"); expect(await f.streams.complete(input, f.proof)).toEqual(result);
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM file_versions WHERE resource_id IN(SELECT id FROM resources WHERE parent_id=${f.rootId})`)).toHaveLength(1);
    await evidence("A09", "stream", { input, result });
  } finally { await f.close(); }
}, 90000);

it.each(["final-sha", "CAS"])("A09 invalid %s seal preserves stream original and current", async mode => {
  const f = await activeFixture("A09-negative-" + mode);
  try {
    const bytes = Buffer.alloc(1024, 31), prepare = f.uploadInput("race", bytes), input = parseStreamPrepare({ schema: "saturn.stream-upload.v1", operationId: uid(), source: { generation: "g1", witnessSha256: sha("witness") }, chunkBytes: 4194304, prepare: { ...prepare, intent: { ...prepare.intent, sha256: null } } });
    await f.streams.prepare(input, f.proof); await f.streams.append(input, { index: 0, offset: "0", length: String(bytes.length), sha256: sha(bytes) }, bytes, f.proof);
    if (mode === "CAS") await f.upload(f.uploadInput("race", bytes), bytes);
    const before = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,current_version_id,sha256 FROM resources WHERE parent_id=${f.rootId}`);
    await expect(f.streams.seal(input, { sha256: mode === "final-sha" ? sha("wrong-final") : sha(bytes), sourceGeneration: "g1", sourceWitnessSha256: input.source.witnessSha256 }, f.proof)).rejects.toThrow();
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,current_version_id,sha256 FROM resources WHERE parent_id=${f.rootId}`)).toEqual(before);
    const status = await new CatalogStreamUpload(f.writer, f.issuer, f.executor, f.files).status(input, f.proof);
    expect(status.operationId).toBe(input.operationId); expect(status.state).not.toBe("PUBLISHED");
    await evidence("A09", mode, { input, status, before });
  } finally { await f.close(); }
}, 60000);

it("A07 retention retains ten active versions; A08 atomic expiry, durable DONE receipts and down refusal", async () => {
  const f = await activeFixture("A07", "pluto");
  try {
    let previous: { nodeId: string; metadataVersion: string; versionId: string } | undefined;
    for (let n = 1; n <= 13; n++) {
      const bytes = Buffer.from("version-" + String(n));
      const result = await f.upload(f.uploadInput("history", bytes, previous), bytes); expect(result.status.result?.status).toBe("PUBLISHED");
      const r = requireDefined((await f.admin.withSql(sql => sql<{ id: string; metadata_version: string; current_version_id: string }[]>`SELECT id,metadata_version,current_version_id FROM resources WHERE parent_id=${f.rootId} AND name='history'`))[0]);
      previous = { nodeId: r.id, metadataVersion: r.metadata_version, versionId: r.current_version_id };
    }
    const retention = new CatalogPlutoRetention(f.writer, f.admission, f.executor.identity);
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM file_versions WHERE resource_id=${requireDefined(previous).nodeId} AND state='active'`)).toHaveLength(13);
    for (let n = 0; n < 8; n++) { await retention.tick(f.rootId); await vi.waitFor(async () => expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_tasks WHERE state IN('QUEUED','RUNNING')`)).toHaveLength(0)); }
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM file_versions WHERE resource_id=${requireDefined(previous).nodeId} AND state='active'`)).toHaveLength(10);
    const originals = await f.admin.withSql(sql => sql<{ state: string; receipt: unknown; task_id: string; storage_path: string }[]>`SELECT state,receipt,task_id,storage_path FROM sync_retention_originals ORDER BY version_id`);
    expect(originals).toHaveLength(3); expect(originals.every(o => o.state === "DELETED" && o.receipt)).toBe(true);
    for (const original of originals) expect(await f.raw.exists(original.storage_path)).toBe(false);
    await expect(rollback(f.url, migrations)).rejects.toThrow("retention_originals_require_forward_migration");
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state,receipt,task_id,storage_path FROM sync_retention_originals ORDER BY version_id`)).toEqual(originals);
    await evidence("A07", "retention", { current: previous, originals });
  } finally { await f.close(); }
}, 120000);

it("A05 real SQL cursor survives event between poll/read and reader restart; replay keeps exact boundary", async () => {
  const f = await activeFixture("A05-cursor"), app = Fastify();
  const scope = { wire: f.wireBinding, guard: { rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, guardRevision: f.binding.guardRevision } }, stage = new PostgresSyncSnapshotStage(f.runtime, f.issuer, scope), keys = [{ id: "fixture", secret: Buffer.alloc(32, 17) }];
  let reader = new PostgresSyncSnapshotReader(f.runtime, f.issuer, scope, "fixture", keys);
  try {
    const snapshotId = uid(); let progress = await stage.start(f.proof, snapshotId);
    for (let n = 0; progress.state !== "READY" && n < 10; n++) progress = await stage.step(snapshotId, f.proof);
    expect(progress.state).toBe("READY"); const ready = await reader.ready(snapshotId, f.proof);
    const mutation = (name: string) => parseSyncMutationInput({ schema: "saturn.namespace-mutation.v1", operationId: uid(), idempotencyKey: uid(), rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, kind: "create-empty", expected: { kind: "absent" }, parentId: f.rootId, name });
    const available = reader.changesAvailable.bind(reader); let injected = false;
    vi.spyOn(reader, "changesAvailable").mockImplementation(async (cursor, proof) => { const result = await available(cursor, proof); if (!injected) { expect(result).toBe(false); injected = true; await f.mutations.execute(mutation("between-poll-and-read"), f.namespace, f.proof); } return result; });
    await app.register(guardedSyncHttp, { root: async () => ({ binding: f.wireBinding, authority: f.issuer, stage, reader, extensions: ["changes-wait-v1"], ensureFolder: async () => { throw Error("unused"); } }) });
    const request = (cursor: string) => app.inject({ method: "POST", url: `/sync/v1/roots/${f.rootId}/changes`, headers: { authorization: f.authorization }, payload: { binding: f.wireBinding, cursor, wait_ms: 25000 } });
    const first = await request(ready.changes_cursor); expect(first.statusCode).toBe(200); const page = first.json<ChangePage>(); expect(page.items).toHaveLength(1);
    await f.mutations.execute(mutation("after-first-boundary"), f.namespace, f.proof);
    reader = new PostgresSyncSnapshotReader(f.runtime, f.issuer, scope, "fixture", keys);
    expect((await request(ready.changes_cursor)).body).toBe(first.body);
    const next = (await request(page.next_cursor)).json<ChangePage>(); expect(next.items).toHaveLength(1); expect(requireDefined(next.items[0]).name).toBe("after-first-boundary"); expect(next.from_exclusive).toBe(page.to_inclusive);
    await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE sync_snapshot_stage SET lease_until=now()-interval '1 second' WHERE id=${snapshotId}`);
    const expired = await request(next.next_cursor); expect(expired.statusCode).toBe(410); expect(expired.json<{code:string}>().code).toBe("cursor_expired");
    await evidence("A05", "durable-cursors", { ready, page, next, replayExact: true });
  } finally { await app.close(); await f.close(); }
}, 60000);

it("A08 lost physical-delete ACK remains UNKNOWN until reviewed closed-channel handoff, same task recovery", async () => {
  const f = await activeFixture("A08", "pluto"); let replacement: DurableBackendExecutor | undefined;
  try {
    let previous: { nodeId: string; metadataVersion: string; versionId: string } | undefined;
    for (let n = 0; n < 11; n++) {
      const bytes = Buffer.from("crash-version-" + String(n)); await f.upload(f.uploadInput("history", bytes, previous), bytes);
      const r = requireDefined((await f.admin.withSql(sql => sql<{ id: string; metadata_version: string; current_version_id: string }[]>`SELECT id,metadata_version,current_version_id FROM resources WHERE parent_id=${f.rootId} AND name='history'`))[0]);
      previous = { nodeId: r.id, metadataVersion: r.metadata_version, versionId: r.current_version_id };
    }
    const receipts = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,sync_result FROM operation_journal WHERE sync_result IS NOT NULL ORDER BY id`);
    const remove = f.raw.delete.bind(f.raw); let effects = 0;
    vi.spyOn(f.raw, "delete").mockImplementation(async p => { await remove(p); effects++; throw Error("fixture lost delete ACK"); });
    const retention = new CatalogPlutoRetention(f.writer, f.admission, f.executor.identity);
    expect((await retention.tick(f.rootId)).planned).toBe(1);
    await vi.waitFor(async () => expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_tasks WHERE state='UNKNOWN'`)).toHaveLength(1));
    const original = requireDefined((await f.admin.withSql(sql => sql<{ task_id: string; state: string; receipt: unknown; storage_path: string }[]>`SELECT task_id,state,receipt,storage_path FROM sync_retention_originals`))[0]);
    expect(original.state).toBe("QUEUED"); expect(original.receipt).toBeNull(); expect(await f.raw.exists(original.storage_path)).toBe(false); expect(effects).toBe(1);
    expect((await retention.tick(f.rootId)).resumed).toBe(0);
    await expect(f.executor.close()).rejects.toThrow("backend_close_unconfirmed");
    const generation = uid();
    await f.admin.transaction(async sql => {
      await sql<Record<string, unknown>[]>`UPDATE sync_backend_executor SET generation=${generation},state='UNKNOWN',owner_id=NULL,fencing_token=NULL WHERE backend_identity=${f.backendIdentity}`;
      await sql<Record<string, unknown>[]>`UPDATE sync_backend_tasks SET state='REJECTED' WHERE backend_identity=${f.backendIdentity} AND state='QUEUED'`;
    });
    replacement = new DurableBackendExecutor(new LocalStorageAdapter(path.join(f.directory, "storage")), f.command, f.backendIdentity, generation);
    const resumed = new CatalogPlutoRetention(f.writer, f.admission, replacement.identity);
    expect((await resumed.tick(f.rootId)).resumed).toBe(0);
    await f.admin.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO sync_backend_handoffs(id,backend_identity,previous_generation,next_generation,receipt) VALUES(${uid()},${f.backendIdentity},${f.generation},${generation},${JSON.stringify({ oldConnectionsClosed: true, evidence: "owned raw adapter close observed after injected ACK loss", previousOwner: f.executor.identity.ownerId, previousFence: f.executor.identity.fencingToken })}::text::jsonb)`);
    expect((await resumed.tick(f.rootId)).resumed).toBe(1);
    await replacement.start();
    await vi.waitFor(async () => expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state FROM sync_backend_tasks WHERE id=${original.task_id}`))[0]).state).toBe("DONE"));
    expect((await resumed.tick(f.rootId)).completed).toBe(1);
    expect((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT task_id,state FROM sync_retention_originals`))[0]).toEqual({ task_id: original.task_id, state: "DELETED" });
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,sync_result FROM operation_journal WHERE sync_result IS NOT NULL ORDER BY id`)).toEqual(receipts);
    await evidence("A08", "handoff", { originalTaskId: original.task_id, oldGeneration: f.generation, generation, effectsBeforeRecovery: effects, receiptsPreserved: receipts.length });
  } finally { await replacement?.close(); await f.executor.close().catch(() => undefined); await Promise.all([f.writer.close(), f.runtime.close(), f.admin.close()]); }
}, 90000);

it.each(["queued", "effect", "done"])("A08 native retention process crash at %s recovers the exact original after closed-channel handoff", async phase => {
  const f = await activeFixture("A08-process-" + phase, "pluto"); let replacement: DurableBackendExecutor | undefined;
  try {
    let previous: { nodeId: string; metadataVersion: string; versionId: string } | undefined;
    for (let n = 0; n < 11; n++) {
      const bytes = Buffer.from("retention-crash-" + String(n)); await f.upload(f.uploadInput("history", bytes, previous), bytes);
      const row = requireDefined((await f.admin.withSql(sql => sql<{id:string;metadata_version:string;current_version_id:string}[]>`SELECT id,metadata_version,current_version_id FROM resources WHERE parent_id=${f.rootId} AND name='history'`))[0]);
      previous = { nodeId: row.id, metadataVersion: row.metadata_version, versionId: row.current_version_id };
    }
    const publications = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,sync_result FROM operation_journal ORDER BY id`);
    await f.executor.close();
    const url = new URL(f.url); url.username = f.roles.writerLogin;
    const config = path.join(f.directory, "retention-crash.json"), helper = fileURLToPath(new URL("./stage3-chat-a.executor-helper.mts", import.meta.url));
    await fs.writeFile(config, JSON.stringify({ url: url.toString(), directory: path.join(f.directory, "storage"), backendIdentity: f.backendIdentity, generation: f.generation, rootId: f.rootId, phase: "retention-" + phase }));
    const owned = await startOwnedFixtureProcess(helper, config, {faultScope:"A08-native-retention-"+phase}), child = owned.child;
    const exited = owned.closed;
    try {
      const event = await owned.message<{ pid: number; identity: object }>();
      expect(event.pid).toBe(child.pid);
      if (phase === "done") await vi.waitFor(async () => expect((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT t.state FROM sync_retention_originals o JOIN sync_backend_tasks t ON t.id=o.task_id`))[0]?.state).toBe("DONE"));
      await owned.crash(); await exited;
      const original = requireDefined((await f.admin.withSql(sql => sql<{state:string;receipt:unknown;task_state:string;storage_path:string;version_id:string;task_id:string}[]>`SELECT o.*,t.state AS task_state FROM sync_retention_originals o JOIN sync_backend_tasks t ON t.id=o.task_id`))[0]);
      expect(original.state).toBe("QUEUED"); expect(original.receipt).toBeNull(); expect(original.task_state).toBe(phase === "queued" ? "QUEUED" : phase === "effect" ? "RUNNING" : "DONE");
      const storage = new LocalStorageAdapter(path.join(f.directory, "storage")); expect(await storage.exists(original.storage_path)).toBe(phase === "queued"); await storage.close();
      expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state FROM file_versions WHERE id=${original.version_id}`))[0]).state).toBe("expired");
      const generation = uid();
      await f.admin.transaction(async sql => {
        await sql<Record<string, unknown>[]>`UPDATE sync_backend_executor SET generation=${generation},state='UNKNOWN',owner_id=NULL,fencing_token=NULL WHERE backend_identity=${f.backendIdentity}`;
        await sql<Record<string, unknown>[]>`UPDATE sync_backend_tasks SET state=CASE WHEN state='QUEUED' THEN 'REJECTED' ELSE 'UNKNOWN' END WHERE id=${original.task_id} AND state IN('QUEUED','RUNNING')`;
        await sql<Record<string, unknown>[]>`INSERT INTO sync_backend_handoffs(id,backend_identity,previous_generation,next_generation,receipt) VALUES(${uid()},${f.backendIdentity},${f.generation},${generation},${JSON.stringify({ oldConnectionsClosed: true, evidence: "owned native child killed and exit joined", pid: child.pid, helper, previousIdentity: event.identity })}::text::jsonb)`;
      });
      replacement = new DurableBackendExecutor(new LocalStorageAdapter(path.join(f.directory, "storage")), f.command, f.backendIdentity, generation);
      const retention = new CatalogPlutoRetention(f.writer, f.admission, replacement.identity), progress = await retention.tick(f.rootId);
      expect(phase === "done" ? progress.completed : progress.resumed).toBe(1);
      await replacement.start();
      await vi.waitFor(async () => expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state FROM sync_backend_tasks WHERE id=${original.task_id}`))[0]).state).toBe("DONE"));
      await retention.tick(f.rootId);
      expect((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT task_id,state FROM sync_retention_originals`))[0]).toEqual({ task_id: original.task_id, state: "DELETED" });
      expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,sync_result FROM operation_journal ORDER BY id`)).toEqual(publications);
      await evidence("A08", "native-crash-" + phase, { pid: child.pid, helper, original, recovery: progress, publicationReceiptsPreserved: publications.length });
    } finally { if (child.exitCode === null && child.signalCode === null) await owned.stop(); await exited; }
  } finally { await replacement?.close(); await f.close(); }
}, 60000);

it("A07 two roots/processes cap retention at two; exact terminal operation key releases only its pin; A08 DONE precedes receipt", async () => {
  const roots = await activeRootsFixture("A07-two-roots", "pluto", 2), first = requireDefined(roots[0]), second = requireDefined(roots[1]), entered = barrier(), release = barrier();
  const history: { versions: string[]; nodeId: string; inputs: ReturnType<typeof first.uploadInput>[] }[] = [];
  try {
    for (const f of roots) {
      let previous: { nodeId: string; metadataVersion: string; versionId: string } | undefined;
      const versions: string[] = [], inputs: ReturnType<typeof f.uploadInput>[] = [];
      for (let n = 0; n < 13; n++) {
        const bytes = Buffer.from("history-" + String(n)), input = f.uploadInput("history", bytes, previous); inputs.push(input); await f.upload(input, bytes);
        const row = requireDefined((await f.admin.withSql(sql => sql<{ id: string; current_version_id: string; metadata_version: string }[]>`SELECT id,current_version_id,metadata_version FROM resources WHERE parent_id=${f.rootId} AND name='history'`))[0]);
        versions.push(row.current_version_id); previous = { nodeId: row.id, versionId: row.current_version_id, metadataVersion: row.metadata_version };
      }
      history.push({ versions, nodeId: requireDefined(previous).nodeId, inputs });
    }
    const old = requireDefined(requireDefined(history[0]).inputs[1]), pending = { ...old, intent: { ...old.intent, idempotencyKey: uid() } }, terminal = requireDefined(requireDefined(history[0]).inputs[2]);
    const inputs = [pending, terminal], registry = new SmallBatchRegistry(first.writer, first.issuer);
    for (const input of inputs) await registry.register({ manifest: { ...first.wireBinding, schema: "saturn.small-file-batch.v1", batch_id: uid(), rules_version: "1", items: [{ operation_id: input.intent.idempotencyKey, source_generation: "1", source_identity: uid(), parent_id: first.rootId, name: input.intent.name, size_bytes: input.intent.sizeBytes, sha256: input.intent.sha256, expected: { kind: "version", node_id: requireDefined(history[0]).nodeId, version: (input.intent as { condition: { metadataVersion: string } }).condition.metadataVersion } }] }, inputs: [input] }, first.wireBinding, first.proof);
    const registrations = await first.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,operation_key FROM sync_small_batch_operations`); expect(registrations.every(r => r.id !== r.operation_key)).toBe(true);
    const originalReceipts = await first.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,sync_result FROM operation_journal ORDER BY id`), remove = first.raw.delete.bind(first.raw);
    const hold = vi.spyOn(first.raw, "delete").mockImplementation(async p => { entered.release(); await release.entered; return remove(p); });
    const retention = new CatalogPlutoRetention(first.writer, first.admission, first.executor.identity);
    expect((await retention.tick(first.rootId)).planned).toBe(2); await entered.entered;
    const originals = await first.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT version_id,task_id,state,receipt FROM sync_retention_originals`);
    expect(originals).toHaveLength(2); expect(originals.every(o => o.state === "QUEUED" && o.receipt === null)).toBe(true);
    expect(await first.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM file_versions WHERE state='expired'`)).toHaveLength(2);
    const url = new URL(first.url); url.username = first.roles.writerLogin; const config = path.join(first.directory, "worker-retention.json"), helper = fileURLToPath(new URL("./stage3-chat-a.executor-helper.mts", import.meta.url));
    await fs.writeFile(config, JSON.stringify({ url: url.toString(), directory: path.join(first.directory, "storage"), backendIdentity: first.backendIdentity, generation: first.generation, phase: "retention", rootId: second.rootId }));
    const owned = await startOwnedFixtureProcess(helper, config), child = owned.child;
    const exit = owned.closed;
    try {
      const event = await owned.message<{ pid: number; result: object }>();
      expect(event.pid).toBe(child.pid); expect(event.result).toMatchObject({ planned: 0, deferred: "retention_budget" }); await requireNormalFixtureExit(exit);
      await evidence("A07", "backend-cap", { roots: roots.map(f => f.rootId), pid: child.pid, helper, event, originals });
    } finally { release.release(); await requireNormalFixtureExit(exit); }
    await vi.waitFor(async () => expect(await first.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_tasks WHERE state IN('QUEUED','RUNNING')`)).toHaveLength(0)); hold.mockRestore();
    const beforeReceipt = await first.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT o.task_id,o.state,o.receipt,o.size_bytes,t.state AS task_state FROM sync_retention_originals o JOIN sync_backend_tasks t ON t.id=o.task_id`);
    expect(beforeReceipt.every(r => r.task_state === "DONE" && r.receipt === null && r.state === "QUEUED")).toBe(true);
    expect(beforeReceipt.reduce((sum, r) => sum + Number(r.size_bytes), 0)).toBeGreaterThan(0);
    expect((await new CatalogPlutoRetention(first.writer, first.admission, first.executor.identity).tick(first.rootId)).completed).toBe(2);
    for (const f of roots) for (let n = 0; n < 5; n++) { await new CatalogPlutoRetention(f.writer, f.admission, f.executor.identity).tick(f.rootId); await vi.waitFor(async () => expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_tasks WHERE state IN('QUEUED','RUNNING')`)).toHaveLength(0)); }
    const kept = await first.admin.withSql(sql => sql<{ id: string }[]>`SELECT id FROM file_versions WHERE resource_id=${requireDefined(history[0]).nodeId} AND state='active'`);
    expect(kept).toHaveLength(11); expect(kept.map(r => r.id)).toContain(requireDefined(history[0]).versions[0]); expect(kept.map(r => r.id)).not.toContain(requireDefined(history[0]).versions[1]);
    expect(await first.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM file_versions WHERE resource_id=${requireDefined(history[1]).nodeId} AND state='active'`)).toHaveLength(10);
    expect(await first.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,sync_result FROM operation_journal ORDER BY id`)).toEqual(originalReceipts);
    await evidence("A08", "done-before-receipt", { beforeReceipt, originals, finalized: await first.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT version_id,task_id,state,receipt FROM sync_retention_originals`) });
  } finally { release.release(); await first.close(); }
}, 120000);
