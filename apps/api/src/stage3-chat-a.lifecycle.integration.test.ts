import {restoreFixtureArchive} from "./stage3-chat-a.restore.fixture.js";
import {ownedLifecycleCommand} from "./stage3-chat-a.owned-command.fixture.js";
import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
interface LifecycleResults { "migrate-plan": {file:string;id:string;blockers:string[];nodeCount:number;treeSha256:string}; backup:{dump:string;sha256:string}; adopt:{schema:string;binding:SyncRootBinding;runtimeManifestFile:string}; "rollback-plan":{binaryRollbackAllowed:boolean} }
import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { scryptSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { FileService, PostgresFileRepository } from "@saturn/file-core";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import { Database } from "@saturn/database";
import { GuardedRuntime, guardedStorageConfigSha256, guardedApprovedFunctionsSha256 } from "../../../packages/sync/src/guarded-runtime.js";
import { LocalStorageAdapter, RuntimeStorageManager } from "@saturn/storage";
import { CatalogPlutoRetention } from "../../../packages/file-core/src/catalog-pluto-retention.js";
import { CatalogRootAdmission } from "../../../packages/file-core/src/catalog-root-admission.js";
import { CatalogFolderAuthorityIssuer } from "../../../packages/file-core/src/catalog-folder-authority.js";
import { SmallBatchRegistry } from "../../../packages/file-core/src/small-batch-registry.js";
import { backendFixture, uid, sha, evidence, fixtureManifest } from "./stage3-chat-a.fixture.js";
import { runChatABenefit } from "./stage3-chat-a.benefit.js";
import { runChatAInterop } from "./stage3-chat-a.interop.js";
import { DurableBackendExecutor } from "../../../packages/storage/src/durable-backend-executor.js";
import { CatalogNamespaceMutations } from "../../../packages/file-core/src/catalog-namespace-mutations.js";
import { CatalogUploadDatabaseCoordinator } from "../../../packages/file-core/src/catalog-upload-database.js";
import { CatalogStreamUpload, parseStreamPrepare } from "../../../packages/file-core/src/catalog-stream-upload.js";
import { parseSyncMutationInput } from "../../../packages/contracts/src/sync-extensions.js";
import { barrier } from "./stage3-chat-a.fixture.js";

it("A15 bounded alternating baseline/feature benefit, 1100 files per run", () => runChatABenefit(), 3600000);
it("A15 isolated follow-up pair with retained earlier rounds", () => runChatABenefit(false, true), 1200000);
it("A15 transport smoke before benefit measurement", () => runChatABenefit(true), 60000);
it("A15 available real B/C handoff wire artifacts against owned API", runChatAInterop, 180000);

it.each([1, 13, 16])("A13 populated legacy CLI with %i versions: readonly plan, restore, adoption and retained history", async count => {
  const f = await backendFixture("A13");
  try {
    const legacy = new FileService(new PostgresFileRepository(f.admin), f.raw); await legacy.initializeStorage();
    const devices = new DeviceService({ repository: new PostgresDeviceRepository(f.admin), files: legacy, pepper: "stage3-lifecycle-pepper-123456789012345678", options: { enabled: true, publicOrigin: "https://fixture.invalid", uploadChunkMaxBytes: 8388608, propfindMaxItems: 100, deleteMaxItems: 500, deleteWindowMs: 10000 } });
    const enrolled = count === 1 ? await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment("lifecycle")).code, "fixture") : await devices.redeemPlutoEnrollment((await devices.createPlutoEnrollment("lifecycle")).code, "fixture");
    const rootId = requireDefined(enrolled.device.syncRootId);
    const root = requireDefined((await f.admin.withSql(sql => sql<{ storage_path: string }[]>`SELECT storage_path FROM resources WHERE id=${rootId}`))[0]);
    const nodeId = uid(), versions = Array.from({ length: count }, () => uid()), versionId = requireDefined(versions[count === 1 ? 0 : 2]), bytes = Buffer.from("lifecycle source 314159"), storagePath = root.storage_path + "/COMLPT1.md";
    await f.raw.write(storagePath, Readable.from(bytes), { offset: 0, create: true });
    await f.admin.transaction(async sql => {
      await sql<Record<string, unknown>[]>`INSERT INTO resources(id,type,parent_id,name,storage_path,size_bytes,sha256,current_version_id,status,security_classification) VALUES(${nodeId},'file',${rootId},'COMLPT1.md',${storagePath},${String(bytes.length)},${sha(bytes)},${versionId},'active','public')`;
      for (const [n, version] of versions.entries()) {
        const archive = version === versionId ? storagePath : `_system/versions/${nodeId}/${version}/COMLPT1.md`;
        if (version !== versionId) { await fs.mkdir(path.join(f.directory, "storage", path.dirname(archive)), { recursive: true }); await f.raw.write(archive, Readable.from(bytes), { offset: 0, create: true }); }
        await sql<Record<string, unknown>[]>`INSERT INTO file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason,created_at) VALUES(${version},${nodeId},${archive},${sha(bytes)},${String(bytes.length)},'text/plain','initial',${new Date(Date.UTC(2026, 9, 1, 0, 0, n))})`;
      }
    });
    const save = async (name: string, value: unknown, raw = false) => { const file = path.join(f.directory, name); await fs.writeFile(file, raw ? String(value) : JSON.stringify(value), { mode: 0o600 }); return file; };
    const features = ["namespace-mutations-v1", "stream-upload-v1", "clone-content-v1"];
    const credentialCanary = "fixture-credential-canary-" + uid(), credentialFile = await save("credential.txt", credentialCanary, true);
    const storageConfig = { host: "127.0.0.1", port: 22, username: "fixture", root: "fixture", hostFingerprint: "SHA256:" + "a".repeat(43), authMode: "password_file" as const, passwordFile: credentialFile, operationTimeoutMs: 30000, healthTimeoutMs: 2000, maxConnections: 4, requireFsync: true };
    const qualificationFile = await save("qualification.json", { schema: "saturn.guarded-qualification.v3", coverage: "namespace-mutations-v1", approvedFunctionsSha256: guardedApprovedFunctionsSha256(f.approvedFunctions), supportedWritersVerified: true, unsupportedWritersBlockedBeforeIo: true, privateLifecycleVerified: true, singleBackendWriterVerified: true, handoffVerified: true, smallBatchTransport: "saturn.small-file-batch.v1", features });
    const fenceFile = await save("fence.json", { schema: "saturn.backend-fence.v1", backendIdentity: f.backendIdentity, profileId: "bootstrap", profileRevision: 1, generation: f.generation, storageConfigSha256: guardedStorageConfigSha256({ profileId: "bootstrap", revision: 1, activatedAt: "", source: "bootstrap", config: storageConfig }), credentialSha256: sha(credentialCanary), oldExecutorsDrained: true, oldCredentialsRevoked: true, protectedAncestorsVerified: true });
    const wu = new URL(f.url); wu.username = f.roles.writerLogin;
    const storageRoot = path.join(f.directory, "storage"), stat = await fs.lstat(storageRoot, { bigint: true }), fenceSha = sha(await fs.readFile(fenceFile));
    const custodyFile = await save("custody.json", { schema: "saturn.local-backend-custody.v1", backendIdentity: f.backendIdentity, backendGeneration: f.generation, fenceReceiptSha256: fenceSha, root: storageRoot, device: stat.dev.toString(), inode: stat.ino.toString() });
    const manifest = { schema: "saturn.guarded-runtime.v3", extensions: { features, verifier: null }, serverIdentity: uid(), policyVersion: "stage3", qualificationReceiptFile: qualificationFile, qualificationReceiptSha256: sha(await fs.readFile(qualificationFile)), writerDatabaseUrlFile: await save("writer.url", wu.toString(), true), cursorKeyFile: await save("cursor.key", "x".repeat(32), true), cursorKeyId: "fixture", maximumFileBytes: "1073741824", roles: f.roles, approvedFunctions: f.approvedFunctions, backend: { identity: f.backendIdentity, profileId: "bootstrap", profileRevision: 1, generation: f.generation, fenceReceiptFile: fenceFile, fenceReceiptSha256: fenceSha, caseSensitive: false }, roots: [] };
    const config = { schema: "saturn.sync-lifecycle.v1", rootId, databaseUrlFile: await save("admin.url", f.url, true), manifestFile: await save("manifest.json", manifest), outputDirectory: path.join(f.directory, "output"), codec: "portable_v1", policyHash: sha("include-all"), storage: { kind: "local", root: storageRoot, custodyFile }, ...(process.env.STAGE3_CHAT_A_PG_DUMP ? { pgDumpExecutable: process.env.STAGE3_CHAT_A_PG_DUMP } : {}) };
    const configFile = await save("config.json", config);
    const command = async <T extends string>(action: T, artifact?: string, fault?: string) => {
      const output = await ownedLifecycleCommand(f, {action,lifecycleConfig:configFile,...(artifact?{artifact}:{}),...(fault?{fault}:{}),privateArtifacts:[configFile,config.manifestFile,manifest.writerDatabaseUrlFile,manifest.cursorKeyFile,config.databaseUrlFile,qualificationFile,fenceFile,custodyFile,credentialFile,...(artifact?[artifact]:[])]});
      const result = JSON.parse(output.stdout) as T extends keyof LifecycleResults ? LifecycleResults[T] : unknown; await evidence("A13", action + "-" + uid(), result); return result;
    };
    const before = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,metadata_version,current_version_id FROM resources ORDER BY id`);
    if (count === 1) {
      await expect(f.admin.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO resources(id,type,parent_id,name,storage_path,status) VALUES(${uid()},'file',${rootId},'comlpt1.md',${root.storage_path + "/collision"},'active')`)).rejects.toThrow();
      const bad = uid(); await f.admin.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO resources(id,type,parent_id,name,storage_path,status) VALUES(${bad},'file',${rootId},${"e\u0301.txt"},${root.storage_path + "/decomposed"},'active')`);
      const blocked = await command("migrate-plan"); expect(blocked.blockers.length).toBeGreaterThan(0); await expect(command("adopt", blocked.file)).rejects.toThrow();
      await f.admin.withSql(sql => sql<Record<string, unknown>[]>`DELETE FROM resources WHERE id=${bad}`);
    }
    await command("inspect"); const plan = await command("migrate-plan"); expect(plan.blockers).toEqual([]); expect(plan.nodeCount).toBe(2);
    expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,metadata_version,current_version_id FROM resources ORDER BY id`)).toEqual(before);
    await command("checkpoint");
    if (!process.env.STAGE3_CHAT_A_PG_DUMP) throw Error("real fixture pg_dump executable required");
    const backup = await command("backup"); expect(sha(await fs.readFile(backup.dump))).toBe(backup.sha256);
    const container = (await fixtureManifest()).containerId, restoredName = "stage3_restore_" + uid().replaceAll("-", "");
    const restoreOperation=await restoreFixtureArchive(backup.dump,backup.sha256,restoredName,f.directory);
    const restoreUrl = new URL(f.url); restoreUrl.pathname = "/" + restoredName;
    const restored = new Database(restoreUrl.toString(), { max: 1 });
    try { const restoredRows=await restored.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,metadata_version,current_version_id FROM resources ORDER BY id`); expect(restoredRows).toEqual(before); await evidence("A13","restored-"+String(count),{count,sourceDirectory:f.directory,sourceDatabase:new URL(f.url).pathname.slice(1),containerId:container,restoredName,restoreOperation,backup:{path:backup.dump,sha256:backup.sha256},expectedRows:before,actualRows:restoredRows}); } finally { await restored.close(); }
    if (count === 1) {
      const originalCustody = await fs.readFile(custodyFile), custody = JSON.parse(originalCustody.toString()) as Record<string,unknown>;
      await fs.writeFile(custodyFile, JSON.stringify({ ...custody, inode: "0" })); await expect(command("adopt", plan.file)).rejects.toThrow("local_custody_unproved"); await fs.writeFile(custodyFile, originalCustody);
      const originalManifest = await fs.readFile(config.manifestFile);
      await fs.writeFile(config.manifestFile, JSON.stringify({ ...manifest, backend: { ...manifest.backend, generation: uid() } })); await expect(command("adopt", plan.file)).rejects.toThrow("fence_unproved"); await fs.writeFile(config.manifestFile, originalManifest);
      expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,metadata_version,current_version_id FROM resources ORDER BY id`)).toEqual(before);
    }
    if (count === 1) {
      for (const fault of ["before-progress", "after-progress", "after-receipt"]) {
        await expect(command("adopt", plan.file, fault)).rejects.toMatchObject({ code: 86 });
        const state = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,state,verified_nodes,result FROM sync_migration_plans WHERE id=${plan.id}`);
        const progress = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT node_id,fingerprint FROM sync_migration_progress WHERE plan_id=${plan.id}`);
        if (fault === "before-progress") expect(progress).toHaveLength(0);
        if (fault === "after-progress") expect(progress).toHaveLength(1);
        if (fault === "after-receipt") expect(requireDefined(state[0]).state).toBe("APPLIED");
        await evidence("A13", "crash-" + fault, { planId: plan.id, state, progress });
      }
    }
    const adopted = await command("adopt", plan.file); expect(adopted.schema).toBe("saturn.sync-adoption.v1");
    expect((await command("adopt", plan.file)).binding).toEqual(adopted.binding);
    if (count === 1) {
      const manager = new RuntimeStorageManager(storageConfig, path.join(f.directory, "runtime-profile"), () => new LocalStorageAdapter(storageRoot)); await manager.initialize();
      const runtime = await GuardedRuntime.create({ database: f.runtime, storage: manager, manifestFile: adopted.runtimeManifestFile, device: { pepper: "stage3-lifecycle-pepper-123456789012345678", options: { enabled: true, publicOrigin: "https://fixture.invalid", uploadChunkMaxBytes: 8388608, propfindMaxItems: 100, deleteMaxItems: 500, deleteWindowMs: 10000 } } });
      try {
        const scope = requireDefined((await runtime.scope(rootId))), authorization = "Bearer " + enrolled.token, proof = await scope.authority.device(authorization, rootId);
        const rootName = requireDefined((await f.admin.withSql(sql => sql<{ name: string }[]>`SELECT name FROM resources WHERE id=${rootId}`))[0]).name;
        for (const name of [".git", "node_modules", ".audit"]) await scope.files.ensureCatalogFolderV2({ operationId: uid(), idempotencyKey: uid(), rootId, epoch: scope.binding.server_epoch, bindingVersion: scope.binding.binding_version, parentId: rootId, name, mode: "ensure", parentTopology: [{ nodeId: rootId, parentId: null, name: rootName }] }, proof);
        const payload = Buffer.from("received-but-not-published"), input = { epoch: scope.binding.server_epoch, bindingVersion: scope.binding.binding_version, backendIdentity: f.backendIdentity, intent: { schema: "saturn.upload-intent.v2" as const, deviceKind: "windows_sync" as const, deviceId: enrolled.device.id, rootId, requestPath: "/fixture/pending", idempotencyKey: uid(), parentId: rootId, name: "pending", targetId: null, sizeBytes: String(payload.length), sha256: sha(payload), ifMatch: null, ifNoneMatch: "*" as const, requireAbsent: true, expectedVersionId: null, condition: { kind: "absent" as const }, parentTopology: [{ nodeId: rootId, parentId: null, name: rootName }] } };
        let pending = await scope.files.prepareCatalogUpload(input, proof); pending = await scope.files.appendCatalogUpload(pending, proof, "0", payload);
        const diagnostics = await runtime.rootDiagnostics(rootId, authorization);
        expect(requireDefined(diagnostics).uploads).toMatchObject({ received_bytes: String(payload.length), published: "0", verified: "0" });
        const exported = JSON.stringify(diagnostics); expect(exported).not.toContain(credentialCanary); expect(exported).not.toContain(payload.toString()); expect(exported).not.toContain(enrolled.token); expect(exported).not.toContain("fencingToken"); expect(requireDefined(requireDefined(diagnostics).backend).writtenBytes).toBe(String(payload.length));
        const readDiagnostics = Object.getOwnPropertyDescriptor(DurableBackendExecutor.prototype, "diagnostics")?.value as DurableBackendExecutor["diagnostics"];
        const unknown = vi.spyOn(DurableBackendExecutor.prototype, "diagnostics").mockImplementation(async function (this: DurableBackendExecutor) { const result = {...await readDiagnostics.call(this)}; delete result.writtenBytes; return result; });
        try { expect(requireDefined(requireDefined((await runtime.rootDiagnostics(rootId, authorization))).backend).writtenBytes).toBeUndefined(); } finally { unknown.mockRestore(); }
        await expect(runtime.rootDiagnostics(uid(), authorization)).rejects.toThrow();
        const original = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,upload_intent,sync_result FROM operation_journal WHERE upload_id=${pending.status.session.uploadId}`);
        await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE sync_root_policy SET policy_hash=${sha("exclude-reviewed")} WHERE root_id=${rootId}`);
        await expect(runtime.scope(rootId)).rejects.toThrow("root_unqualified");
        expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,upload_intent,sync_result FROM operation_journal WHERE upload_id=${pending.status.session.uploadId}`)).toEqual(original);
        expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT name FROM resources WHERE parent_id=${rootId} AND name IN('.git','node_modules','.audit') AND status='active'`)).toHaveLength(3);
        await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE sync_root_policy SET policy_hash=${config.policyHash} WHERE root_id=${rootId}`); expect(await runtime.scope(rootId)).toBe(scope);
        await scope.files.cancelCatalogUpload(pending, proof); await evidence("A10", "runtime-diagnostics", diagnostics);
        const ownerSecret = "fixture-owner-" + uid(), salt = Buffer.alloc(16, 17), verifier = scryptSync(ownerSecret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
        await f.admin.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO owner_credentials(owner_id,algorithm,salt_hex,verifier_hex) VALUES('owner','scrypt-v1',${salt.toString("hex")},${verifier})`);
        const selected = requireDefined((await f.admin.withSql(sql => sql<{ id: string }[]>`SELECT id FROM resources WHERE parent_id=${rootId} AND name='.audit'`))[0]), ownerKey = uid();
        const trash = () => runtime.ownerAction({ bootstrap: ownerSecret }, () => runtime.legacyFiles.trashResource(selected.id, { idempotencyKey: ownerKey }));
        expect((await trash()).status).toBe("trashed"); expect((await trash()).status).toBe("trashed");
        const approvals = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,items,approved_at FROM sync_delete_plans WHERE root_id=${rootId}`); expect(approvals).toHaveLength(1); expect(requireDefined(approvals[0]).approved_at).not.toBeNull();
        await evidence("A06", "owner-delete", { target: selected.id, approvals });
      } finally { await runtime.close(); }
    }
    if (count > 1) {
      let racePin: string | undefined;
      const retention = new CatalogPlutoRetention(f.writer, new CatalogRootAdmission(), f.executor.identity);
      if (count === 16) {
        await f.admin.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO laboratory_assets(id,resource_id,mode,pinned_version_id,public_filename,label,disposition,state,created_at,updated_at) VALUES(${uid()},${nodeId},'public_immutable',${requireDefined(versions[0])},'pinned.md','fixture','inline','active',now(),now())`);
        const metadata = requireDefined((await f.admin.withSql(sql => sql<{ metadata_version: string }[]>`SELECT metadata_version FROM resources WHERE id=${nodeId}`))[0]).metadata_version;
        const rootName = requireDefined((await f.admin.withSql(sql => sql<{ name: string }[]>`SELECT name FROM resources WHERE id=${rootId}`))[0]).name;
        const operationKey = uid(), input = { epoch: adopted.binding.server_epoch, bindingVersion: adopted.binding.binding_version, backendIdentity: f.backendIdentity, intent: { schema: "saturn.upload-intent.v2", deviceKind: "pluto", deviceId: enrolled.device.id, rootId, requestPath: "/fixture/COMLPT1.md", idempotencyKey: operationKey, parentId: rootId, name: "COMLPT1.md", targetId: nodeId, sizeBytes: String(bytes.length), sha256: sha(bytes), ifMatch: null, ifNoneMatch: null, requireAbsent: false, expectedVersionId: versions[1], condition: { kind: "match", nodeId, metadataVersion: metadata }, parentTopology: [{ nodeId: rootId, parentId: null, name: rootName }] } };
        const issuer = new CatalogFolderAuthorityIssuer(f.runtime, { authenticateDevice: a => devices.authenticate(a) }), proof = await issuer.device("Bearer " + enrolled.token, rootId);
        await new SmallBatchRegistry(f.writer, issuer).register({ manifest: { ...adopted.binding, schema: "saturn.small-file-batch.v1", batch_id: uid(), rules_version: "1", items: [{ operation_id: operationKey, source_generation: "1", source_identity: uid(), parent_id: rootId, name: "COMLPT1.md", size_bytes: String(bytes.length), sha256: sha(bytes), expected: { kind: "version", node_id: nodeId, version: metadata } }] }, inputs: [input] }, adopted.binding, proof);
        expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,operation_key FROM sync_small_batch_operations`))[0]).id).not.toBe(operationKey);
        await f.executor.start();
        const admission = new CatalogRootAdmission(), files = new FileService(new PostgresFileRepository(f.runtime), f.executor, { catalogBackendIdentity: f.backendIdentity, catalogRootAdmission: admission, catalogUploadCoordinator: new CatalogUploadDatabaseCoordinator(f.writer, issuer, "1073741824", true) });
        const streamBytes = Buffer.from("stream"), streamInput = parseStreamPrepare({ schema: "saturn.stream-upload.v1", operationId: uid(), source: { generation: "pending", witnessSha256: sha("witness") }, chunkBytes: 4194304, prepare: { ...input, intent: { ...input.intent, idempotencyKey: uid(), requestPath: "/fixture/stream", name: "stream", targetId: null, expectedVersionId: null, requireAbsent: true, ifNoneMatch: "*", condition: { kind: "absent" }, sizeBytes: String(streamBytes.length), sha256: null } } });
        const streams = new CatalogStreamUpload(f.writer, issuer, f.executor, files); await streams.prepare(streamInput, proof);
        expect((await retention.tick(rootId)).deferred).toBe("originals_pending");
        await streams.append(streamInput, { index: 0, offset: "0", length: String(streamBytes.length), sha256: sha(streamBytes) }, streamBytes, proof); await streams.seal(streamInput, { sha256: sha(streamBytes), sourceGeneration: "pending", sourceWitnessSha256: streamInput.source.witnessSha256 }, proof);
        const mutations = new CatalogNamespaceMutations(f.writer, issuer, f.executor, admission), namespace = { codec: "portable_v1" as const, policyHash: config.policyHash };
        const mutation = parseSyncMutationInput({ schema: "saturn.namespace-mutation.v1", operationId: uid(), idempotencyKey: uid(), rootId, epoch: adopted.binding.server_epoch, bindingVersion: adopted.binding.binding_version, kind: "create-empty", expected: { kind: "absent" }, parentId: rootId, name: "namespace-pending" });
        await f.writer.withSql(sql => sql<Record<string, unknown>[]>`SELECT sync_namespace_command('reserve',${JSON.stringify({ input: mutation, namespace })}::text::jsonb,${JSON.stringify(issuer.deviceCredential(proof, rootId))}::text::jsonb,'{}'::jsonb)`);
        expect((await retention.tick(rootId)).deferred).toBe("originals_pending"); await mutations.execute(mutation, namespace, proof);
        // A real row-lock barrier makes pin-before-expiry deterministic.
        racePin = uid(); const locked = barrier(), release = barrier();
        const pin = f.admin.transaction(async sql => { await sql<Record<string, unknown>[]>`INSERT INTO laboratory_assets(id,resource_id,mode,pinned_version_id,public_filename,label,disposition,state,created_at,updated_at) VALUES(${requireDefined(racePin)},${nodeId},'public_immutable',${requireDefined(versions[6])},'race.md','race','inline','active',now(),now())`; locked.release(); await release.entered; });
        await locked.entered;
        // Rotate the work queue until the original historical resource is next.
        await f.admin.withSql(sql => sql<Record<string, unknown>[]>`UPDATE sync_retention_work SET attempted_at=CASE WHEN resource_id=${nodeId} THEN '-infinity'::timestamptz ELSE now() END WHERE root_id=${rootId}`);
        const expiry = retention.tick(rootId);
        try { await vi.waitFor(async () => expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%sync_retention_command%'`)).not.toHaveLength(0)); } finally { release.release(); }
        await pin; await expiry;
        expect(requireDefined((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT state FROM file_versions WHERE id=${requireDefined(versions[6])}`))[0]).state).toBe("active");
      }
      await f.executor.start();
      for (let n = 0; n < 8; n++) { await retention.tick(rootId); await vi.waitFor(async () => expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_tasks WHERE state IN('QUEUED','RUNNING')`)).toHaveLength(0)); }
      const active = await f.admin.withSql(sql => sql<{ id: string }[]>`SELECT id FROM file_versions WHERE resource_id=${nodeId} AND state='active'`);
      expect(active).toHaveLength(count === 16 ? 13 : 10); expect(active.map(v => v.id)).toContain(versionId);
      if (count === 16) { expect(active.map(v => v.id)).toContain(versions[0]); expect(active.map(v => v.id)).toContain(versions[1]); }
      if (racePin) {
        await f.admin.withSql(sql => sql<Record<string, unknown>[]>`DELETE FROM laboratory_assets WHERE id=${racePin}`);
        for (let n = 0; n < 5; n++) { await retention.tick(rootId); await vi.waitFor(async () => expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM sync_backend_tasks WHERE state IN('QUEUED','RUNNING')`)).toHaveLength(0)); }
        expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM file_versions WHERE resource_id=${nodeId} AND state='active'`)).toHaveLength(12);
      }
      const expired = requireDefined((await f.admin.withSql(sql => sql<{ id: string }[]>`SELECT id FROM file_versions WHERE resource_id=${nodeId} AND state='expired' LIMIT 1`))[0]);
      await expect(f.admin.withSql(sql => sql<Record<string, unknown>[]>`INSERT INTO laboratory_assets(id,resource_id,mode,pinned_version_id,public_filename,label,disposition,state,created_at,updated_at) VALUES(${uid()},${nodeId},'public_immutable',${expired.id},'late.md','late','inline','active',now(),now())`)).rejects.toThrow();
      await evidence("A07", "adopted-history-" + String(count), { currentIndex: 3, versions, active: active.map(v => v.id), pins: count === 16 ? versions.slice(0, 2) : [] });
      await f.executor.close();
    }
    await command("pause"); await command("resume");
    const rollback = await command("rollback-plan"); expect(rollback.binaryRollbackAllowed).toBe(false);
    expect((await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id,current_version_id FROM resources WHERE id=${nodeId}`))[0]).toEqual({ id: nodeId, current_version_id: versionId });
    await expect(f.runtime.withSql(sql => sql<Record<string, unknown>[]>`UPDATE resources SET name='old-writer' WHERE id=${nodeId}`)).rejects.toThrow();
    const altered = JSON.parse(await fs.readFile(plan.file, "utf8")) as Record<string,unknown>; altered.treeSha256 = sha("wrong");
    await expect(command("adopt", await save("wrong-plan.json", altered))).rejects.toThrow();
    await evidence("A13", "completed", { rootId, nodeId, versionId, adopted, backupExecuted: Boolean(process.env.STAGE3_CHAT_A_PG_DUMP) });
  } finally { await f.close(); }
}, 120000);
