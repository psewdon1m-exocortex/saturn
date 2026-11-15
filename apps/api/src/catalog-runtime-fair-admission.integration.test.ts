function required<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error("Required isolated fixture value missing"); return value; }
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { Database, migrate } from "@saturn/database";
import { FileService, PostgresFileRepository, PostgresRootJournal, PostgresCurrentNamespace, ROOT_RESOURCE_ID, SYNC_RESOURCE_ID, OUTDOOR_CONNECTIONS_RESOURCE_ID } from "@saturn/file-core";
import { DeviceService, PostgresDeviceRepository } from "@saturn/sync";
import { LocalStorageAdapter, RuntimeStorageManager, SftpStorageAdapter, type StorageAdapter } from "@saturn/storage";
import type { SftpStorageConfig } from "@saturn/config";
import { GuardedRuntime, guardedStorageConfigSha256, guardedApprovedFunctionsSha256 } from "../../../packages/sync/src/guarded-runtime.js";
import type { GuardedRuntimeManifest } from "../../../packages/sync/src/guarded-runtime-manifest.js";
import type { CatalogUploadPrepareInput, CatalogUploadStatus } from "../../../packages/file-core/src/catalog-upload-intent.js";
import { guardedSyncRuntimeHttp } from "./guarded-sync-runtime-http.js";
import { OwnerAuthService, PostgresOwnerAuthRepository } from "@saturn/auth";
import { GUARDED_UPLOAD_FRAME_TYPE } from "./guarded-sync-upload-http.js";
import { CatalogFolderV2DatabaseCoordinator } from "../../../packages/file-core/src/catalog-folder-v2-database.js";
import { CatalogRootAdmission } from "../../../packages/file-core/src/catalog-root-admission.js";
import { CatalogUploadDatabaseCoordinator } from "../../../packages/file-core/src/catalog-upload-database.js";
const fixturePath = process.env.SYNC_FAIR_ADMISSION_FIXTURE, exec = promisify(execFile), sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it.skipIf(!fixturePath)("qualifies bounded fair folder/file publication with original IDs and unchanged ACTIVE SQL guard", async () => {
    if (!fixturePath)
        throw Error("Own fixture required");
    const f = JSON.parse(await fs.readFile(fixturePath, "utf8")) as {
        containerId: string;
        runId: string;
        databaseUrl: string;
        fixtureDirectory: string;
        created: string;
    };
    const owned = JSON.parse((await exec("docker", ["inspect", f.containerId], { windowsHide: true })).stdout) as {
        Id: string;
        Created: string;
        Config: {
            Labels: Record<string, string>;
        };
        State: {
            Running: boolean;
        };
        HostConfig: {
            NanoCpus: number;
            Memory: number;
        };
    }[];
    expect(owned[0]?.Id).toBe(f.containerId);
    expect(owned[0]?.Created).toBe(f.created);
    expect(owned[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(f.runId);
    expect(owned[0]?.State.Running).toBe(true);
    expect(owned[0]?.HostConfig.NanoCpus).toBe(1e9);
    expect(owned[0]?.HostConfig.Memory).toBe(536870912);
    const suffix = randomUUID().replaceAll("-", ""), name = "fair_" + suffix, directory = path.join(f.fixtureDirectory, name);
    await fs.mkdir(directory);
    const currentSid = (await exec("powershell", ["-NoProfile", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true })).stdout.trim();
    await exec("icacls", [directory, "/inheritance:r", "/grant:r", `*${currentSid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true });
    const admin = new Database(f.databaseUrl, { max: 1 }), url = new URL(f.databaseUrl);
    url.pathname = "/" + name;
    const rt = "rt_" + suffix, wr = "wr_" + suffix, ow = "ow_" + suffix, password = randomUUID().replaceAll("-", "");
    let db: Database | undefined, runtimeDb: Database | undefined, writerDb: Database | undefined, runtime: GuardedRuntime | undefined;
    const sftpPath = process.env.SYNC_FAIR_ADMISSION_SFTP;
    const sftp = sftpPath ? JSON.parse(await fs.readFile(sftpPath, "utf8")) as {
        containerId: string;
        runId: string;
        created: string;
        storage: SftpStorageConfig;
    } : undefined;
    const credential = path.join(directory, "backend.password");
    const sftpConfig = sftp ? { host: sftp.storage.host, port: sftp.storage.port, username: sftp.storage.username,
        root: (sftp.storage.root + "/" + name).replace(/^\/+/, ""), passwordFile: credential,
        hostFingerprint: sftp.storage.hostFingerprint, authMode: "password_file" as const,
        operationTimeoutMs: sftp.storage.operationTimeoutMs, healthTimeoutMs: sftp.storage.healthTimeoutMs,
        maxConnections: sftp.storage.maxConnections, requireFsync: sftp.storage.requireFsync ?? false } : undefined;
    if (sftp) {
        const ci = JSON.parse((await exec("docker", ["inspect", sftp.containerId], { windowsHide: true })).stdout) as {
            Id: string;
            Created: string;
            Config: {
                Labels: Record<string, string>;
            };
            State: {
                Running: boolean;
            };
            HostConfig: {
                NanoCpus: number;
                Memory: number;
            };
        }[];
        expect(ci[0]?.Id).toBe(sftp.containerId);
        expect(ci[0]?.Created).toBe(sftp.created);
        expect(ci[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(sftp.runId);
        expect(ci[0]?.State.Running).toBe(true);
        expect(ci[0]?.HostConfig.NanoCpus).toBeLessThanOrEqual(1e9);
        expect(ci[0]?.HostConfig.Memory).toBe(268435456);
        await fs.copyFile(required(sftp.storage.passwordFile), credential);
        const initial = new SftpStorageAdapter(sftp.storage);
        await initial.mkdir(name);
        await initial.close();
    }
    const raw: StorageAdapter = sftpConfig ? new SftpStorageAdapter(sftpConfig) : new LocalStorageAdapter(path.join(directory, "storage")), app = Fastify({ logger: false });
    const checks: string[] = [], negatives: string[] = [];
    let passed = false;
    try {
        await admin.withSql(sql => sql.unsafe("CREATE DATABASE " + name));
        db = new Database(url.toString(), { max: 4 });
        const adb = db, migrations = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)), cut = path.join(directory, "cut57");
        await fs.mkdir(cut);
        for (const file of await fs.readdir(migrations))
            if (Number(file.slice(0, 4)) <= 57)
                await fs.copyFile(path.join(migrations, file), path.join(cut, file));
        await migrate(url.toString(), cut);
        if (raw instanceof LocalStorageAdapter)
            await raw.initialize();
        const legacy = new FileService(new PostgresFileRepository(adb), raw);
        await legacy.initializeStorage();
        const ownerKey = randomUUID(), auth = new OwnerAuthService({ repository: new PostgresOwnerAuthRepository(adb), ownerAccessKey: ownerKey,
            pepper: "outside-owner-pepper-123456789012345678", options: { publicOrigin: "https://fixture.invalid", sessionIdleTtlMs: 600000, sessionAbsoluteTtlMs: 3600000,
                reauthTtlMs: 600000, failureLimit: 10, failureWindowMs: 60000 } });
        await auth.initialize();
        const deviceOptions = { enabled: true, publicOrigin: "https://fixture.invalid", uploadChunkMaxBytes: 8388608, propfindMaxItems: 100, deleteMaxItems: 10, deleteWindowMs: 10000 };
        const device = { pepper: "guarded-active-pepper-123456789012345678", options: deviceOptions };
        const devices = new DeviceService({ repository: new PostgresDeviceRepository(adb), files: legacy, ...device });
        const windows = await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment("active windows")).code, "fixture");
        const pluto = await devices.redeemPlutoEnrollment((await devices.createPlutoEnrollment("active pluto")).code, "fixture");
        const subjects = [windows, pluto];
        const roots = subjects.map(s => required(s.device.syncRootId));
        expect(roots.every(Boolean)).toBe(true);
        const journal = new PostgresRootJournal(adb), namespace = new PostgresCurrentNamespace(adb);
        for (const root of roots) {
            const emptyPath = required((await adb.withSql(sql => sql<{
                storage_path: string;
            }[]> `SELECT storage_path FROM resources WHERE id=${root}`))[0]).storage_path;
            expect((await raw.list(emptyPath, undefined, 1)).entries).toHaveLength(0);
            await journal.registerRoot(root);
            await namespace.qualifyFixture(root, [root]);
            await adb.withSql(sql => sql `UPDATE resources SET sync_availability='AVAILABLE' WHERE id=${root}`);
        }
        for (const role of [rt, wr, ow])
            await admin.withSql(sql => sql.unsafe(`CREATE ROLE ${role} ${role === ow ? "NOLOGIN" : `LOGIN PASSWORD '${password}'`} NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT`));
        await adb.withSql(sql => sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${rt},${wr},${ow};GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${rt};GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ow};GRANT INSERT,UPDATE ON resources,file_versions,upload_sessions,operation_journal,sync_root_clock,sync_root_changes TO ${ow};GRANT UPDATE ON devices,catalog_guard_roots TO ${ow};GRANT UPDATE(owner_id) ON owner_credentials TO ${ow};GRANT UPDATE(id) ON web_sessions TO ${ow};
      ALTER FUNCTION public.catalog_folder_command(text,jsonb,jsonb) OWNER TO ${ow};ALTER FUNCTION public.catalog_upload_command(text,jsonb,jsonb,jsonb) OWNER TO ${ow};ALTER FUNCTION public.catalog_guard_upgrade_file(uuid) OWNER TO ${ow};ALTER FUNCTION public.catalog_folder_v2_command(text,jsonb,jsonb,jsonb) OWNER TO ${ow};
      GRANT EXECUTE ON FUNCTION public.catalog_folder_command(text,jsonb,jsonb),public.catalog_upload_command(text,jsonb,jsonb,jsonb),public.catalog_guard_upgrade_file(uuid),public.catalog_folder_v2_command(text,jsonb,jsonb,jsonb) TO ${wr}`));
        const ru = new URL(url);
        ru.username = rt;
        ru.password = password;
        runtimeDb = new Database(ru.toString(), { max: 4 });
        const wu = new URL(url);
        wu.username = wr;
        wu.password = password;
        writerDb = new Database(wu.toString(), { max: 4 });
        for (const [n, root] of roots.entries()) {
            await adb.withSql(sql => sql `INSERT INTO catalog_guard_roots(root_id,guard_revision,writer_contract,runtime_role,writer_login,writer_owner,backend_identity,control_ancestor_ids)
        VALUES(${root},${randomUUID()},'folder-only-g1.v1',${rt},${wr},${ow},'active-local',ARRAY[${ROOT_RESOURCE_ID}::uuid,${n === 0 ? SYNC_RESOURCE_ID : OUTDOOR_CONNECTIONS_RESOURCE_ID}::uuid])`);
            await writerDb.withSql(sql => sql `SELECT public.catalog_guard_upgrade_file(${root}::uuid)`);
        }
        const up = await fs.readFile(path.join(migrations, "0058_guarded_runtime_activation.up.sql"), "utf8"), down = await fs.readFile(path.join(migrations, "0058_guarded_runtime_activation.down.sql"), "utf8");
        const clocksBefore = await adb.withSql(sql => sql `SELECT to_jsonb(c) AS value FROM sync_root_clock c ORDER BY root_id`);
        try {
            await adb.transaction(sql => sql.unsafe(up));
        }
        catch (error) {
            const e = error as {
                message: string;
                code?: string;
                position?: string;
                internal_position?: string;
                internal_query?: string;
                where?: string;
            };
            await fs.writeFile(path.join(directory, "migration58-failure.json"), JSON.stringify({ message: e.message, code: e.code, position: e.position, internalPosition: e.internal_position, internalQuery: e.internal_query, context: e.where }, null, 2));
            throw error;
        }
        expect(await adb.withSql(sql => sql `SELECT to_jsonb(c) AS value FROM sync_root_clock c ORDER BY root_id`)).toEqual(clocksBefore);
        await adb.transaction(sql => sql.unsafe(down));
        await adb.transaction(sql => sql.unsafe(up));
        await adb.withSql(sql => sql `INSERT INTO _vault_migrations(name) VALUES('0058_guarded_runtime_activation')`);
        await adb.withSql(sql => sql.unsafe(`ALTER FUNCTION public.catalog_guard_backend_uncertain(uuid,uuid) OWNER TO ${ow};GRANT EXECUTE ON FUNCTION public.catalog_guard_backend_uncertain(uuid,uuid) TO ${wr};ALTER FUNCTION public.outside_folder_commit(uuid,jsonb) OWNER TO ${ow};GRANT EXECUTE ON FUNCTION public.outside_folder_commit(uuid,jsonb) TO ${wr}`));
        if (!sftp)
            await fs.writeFile(credential, randomUUID(), { mode: 0o600 });
        const storageConfig = sftpConfig ?? { host: "local-fixture", port: 22, username: "qa", root: "/data", hostFingerprint: "SHA256:" + "A".repeat(43), authMode: "password_file" as const, passwordFile: credential,
            connectTimeoutMs: 1000, operationTimeoutMs: 2000, keepaliveIntervalMs: 1000, healthTimeoutMs: 1000, maxConnections: 4 };
        const manager = new RuntimeStorageManager(storageConfig, path.join(directory, "storage-runtime"), () => raw);
        await manager.initialize();
        await expect(GuardedRuntime.create({ database: runtimeDb, storage: manager, device })).rejects.toMatchObject({ code: "deployment_unqualified" });
        negatives.push("registered roots without exact deployment manifest refuse startup");
        const functionRows = await adb.withSql(sql => sql<{
            identity: string;
            source: string;
        }[]> `SELECT p.oid::regprocedure::text AS identity,p.prosrc AS source FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=${ow}) ORDER BY p.oid`);
        const functions = functionRows.map(r => ({ identity: r.identity.startsWith("public.") ? r.identity : "public." + r.identity, sourceSha256: sha(r.source) }));
        expect(functions).toHaveLength(6);
        const qualificationFile = path.join(directory, "qualification.json"), fenceFile = path.join(directory, "fence.json"), writerFile = path.join(directory, "writer.private"), cursorFile = path.join(directory, "cursor.key"), manifestFile = path.join(directory, "manifest.private.json");
        await fs.writeFile(qualificationFile, JSON.stringify({ schema: "saturn.guarded-qualification.v1", coverage: "append-only-directories/file-cas", approvedFunctionsSha256: guardedApprovedFunctionsSha256(functions), supportedWritersVerified: true, unsupportedWritersBlockedBeforeIo: true, privateLifecycleVerified: true }), { mode: 0o600 });
        const generation = randomUUID();
        await fs.writeFile(fenceFile, JSON.stringify({ schema: "saturn.backend-fence.v1", backendIdentity: "active-local", profileId: "bootstrap", profileRevision: 1, generation,
            storageConfigSha256: guardedStorageConfigSha256(manager.current()), credentialSha256: sha(await fs.readFile(credential)), oldExecutorsDrained: true, oldCredentialsRevoked: true, protectedAncestorsVerified: true }), { mode: 0o600 });
        await fs.writeFile(writerFile, wu.toString(), { mode: 0o600 });
        await fs.writeFile(cursorFile, Buffer.from(randomUUID().replaceAll("-", "")), { mode: 0o600 });
        const qualifiedSha = sha(await fs.readFile(qualificationFile)), fenceSha = sha(await fs.readFile(fenceFile)), serverIdentity = randomUUID();
        const activeRoots: GuardedRuntimeManifest["roots"][number][] = [];
        for (const rootId of roots) {
            const r = required((await adb.withSql(sql => sql<{
                epoch: string;
                metadata_version: string;
                storage_path: string;
                name: string;
            }[]> `SELECT c.epoch,r.metadata_version,r.storage_path,r.name FROM sync_root_clock c JOIN resources r ON r.id=c.root_id WHERE c.root_id=${rootId}`))[0]);
            expect((await raw.list(r.storage_path, undefined, 1)).entries).toHaveLength(0);
            const proof = { schema: "saturn.catalog-active.v1", rootId, serverEpoch: r.epoch, serverIdentity, policyVersion: "active58", backendIdentity: "active-local", backendProfileId: "bootstrap", backendProfileRevision: 1, backendGeneration: generation,
                fenceReceiptSha256: fenceSha, qualificationReceiptSha256: qualifiedSha, activationReceiptSha256: sha(rootId + generation), maximumFileBytes: "1073741824", observedMetadataVersion: r.metadata_version, observedPathSha256: sha(r.storage_path), observedAt: new Date().toISOString(), oldExecutorsDrained: true, oldCredentialsRevoked: true, emptyPhysicalRootVerified: true };
            await expect(adb.withSql(sql => sql `SELECT catalog_guard_activate_empty(${rootId}::uuid,${JSON.stringify({ ...proof, observedPathSha256: "0".repeat(64) })}::text::jsonb)`)).rejects.toThrow("empty_root_activation_unqualified");
            await expect(required(runtimeDb).withSql(sql => sql `SELECT catalog_guard_activate_empty(${rootId}::uuid,${JSON.stringify(proof)}::text::jsonb)`)).rejects.toThrow("permission denied");
            await fs.writeFile(path.join(directory, "activation-preflight-" + rootId + ".json"), JSON.stringify(await adb.withSql(sql => sql `SELECT catalog_guard_active_shape(${JSON.stringify(proof)}::text::jsonb) AS shape,
        catalog_guard_active_valid(jsonb_populate_record(g,${JSON.stringify({ active_runtime: proof })}::text::jsonb)) AS valid,
        catalog_guard_activation_preflight(jsonb_populate_record(g,${JSON.stringify({ active_runtime: proof })}::text::jsonb)) AS preflight,
        to_jsonb(c) AS clock,to_jsonb(r)-'storage_path' AS resource FROM catalog_guard_roots g JOIN sync_root_clock c ON c.root_id=g.root_id JOIN resources r ON r.id=g.root_id WHERE g.root_id=${rootId}`), null, 2));
            const activated = required((await adb.withSql(sql => sql<{
                value: {
                    epoch: string;
                    bindingVersion: string;
                    guardRevision: string;
                };
            }[]> `SELECT catalog_guard_activate_empty(${rootId}::uuid,${JSON.stringify(proof)}::text::jsonb) AS value`))[0]).value;
            expect(activated.epoch).toBe(r.epoch);
            activeRoots.push({ rootId, epoch: activated.epoch, bindingVersion: activated.bindingVersion, guardRevision: activated.guardRevision, activationReceiptSha256: proof.activationReceiptSha256 });
        }
        checks.push("additive58 leaves old clocks intact; down/up before opt-in; exact empty roots/current device/raw path proof/table-owner only activation renews binding+guard, preserves epoch0");
        const manifest: GuardedRuntimeManifest = { schema: "saturn.guarded-runtime.v1", serverIdentity, policyVersion: "active58", qualificationReceiptFile: qualificationFile, qualificationReceiptSha256: qualifiedSha,
            writerDatabaseUrlFile: writerFile, cursorKeyFile: cursorFile, cursorKeyId: "active58", maximumFileBytes: "1073741824", roles: { runtimeRole: rt, writerLogin: wr, writerOwner: ow, migratorRole: "postgres" }, approvedFunctions: functions,
            backend: { identity: "active-local", profileId: "bootstrap", profileRevision: 1, generation, fenceReceiptFile: fenceFile, fenceReceiptSha256: fenceSha, caseSensitive: sftp ? true : process.platform !== "win32" }, roots: activeRoots };
        await fs.writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
        runtime = await GuardedRuntime.create({ database: runtimeDb, storage: manager, manifestFile, device, validateOwnerSession: input => auth.validateSession(input) });
        const active = runtime;
        await app.register(guardedSyncRuntimeHttp, { runtime: active, database: runtimeDb });
        await app.listen({ host: "127.0.0.1", port: 0 });
        const bound = app.server.address();
        if (!bound || typeof bound === "string")
            throw Error("No loopback");
        const origin = "http://127.0.0.1:" + String(bound.port);
        const json = async (route: string, body: unknown, token: string) => { const response = await fetch(origin + route, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, value: await response.json() as Record<string, unknown> }; };
        function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
        const holds: { suffix: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }[] = [];
        const pending: Promise<unknown>[] = [];
        const hold = (suffix: string) => { const value = { suffix, entered: deferred(), release: deferred() }; holds.push(value); return value; };
        const mkdirOriginal = raw.mkdir.bind(raw), writeOriginal = raw.write.bind(raw);
        const mkdir = vi.spyOn(raw, "mkdir").mockImplementation(async storagePath => {
            const value = holds.find(h => storagePath.endsWith("/" + h.suffix));
            if (value) { value.entered.resolve(); await value.release.promise; }
            return mkdirOriginal(storagePath);
        });
        const scopeA = required(await active.scope(required(roots[0]))), scopeB = required(await active.scope(required(roots[1])));
        const proofA = await scopeA.authority.device("Bearer " + windows.token, required(roots[0])), proofB = await scopeB.authority.device("Bearer " + pluto.token, required(roots[1]));
        const rootNames = await Promise.all(roots.map(root => adb.withSql(sql => sql<{ name: string }[]>`SELECT name FROM resources WHERE id=${root}`)));
        const folderInput = (n: number, name: string) => ({ operationId: randomUUID(), idempotencyKey: "fair-folder-" + randomUUID(), rootId: required(roots[n]), epoch: (n === 0 ? scopeA : scopeB).binding.server_epoch,
            bindingVersion: (n === 0 ? scopeA : scopeB).binding.binding_version, parentId: required(roots[n]), name, mode: "ensure" as const,
            parentTopology: [{ nodeId: required(roots[n]), parentId: null, name: required(required(rootNames[n])[0]).name }] });
        const fileInput = (n: number, name: string, bytes: Buffer): CatalogUploadPrepareInput => ({ epoch: (n === 0 ? scopeA : scopeB).binding.server_epoch,
            bindingVersion: (n === 0 ? scopeA : scopeB).binding.binding_version, backendIdentity: "active-local", intent: { schema: "saturn.upload-intent.v2", deviceKind: n === 0 ? "windows_sync" : "pluto",
                deviceId: required(subjects[n]).device.id, rootId: required(roots[n]), requestPath: "/fair/" + name, idempotencyKey: "fair-upload-" + randomUUID(), parentId: required(roots[n]), name, targetId: null,
                sizeBytes: String(bytes.length), sha256: sha(bytes), ifMatch: null, ifNoneMatch: "*", requireAbsent: true, expectedVersionId: null, condition: { kind: "absent" }, parentTopology: folderInput(n, "unused").parentTopology } });
        const row = (id: string) => adb.withSql(sql => sql<{ phase: string; claim: boolean; actual_sha256: string | null; received: string; result: unknown }[]>`SELECT j.upload_effect_state AS phase,j.upload_claim_token IS NOT NULL AS claim,u.actual_sha256,u.received_size::text AS received,j.sync_result AS result FROM operation_journal j JOIN upload_sessions u ON u.id=j.id WHERE j.id=${id}`);
        const prepare = async (n: number, name: string, bytes = Buffer.from("abc")) => {
            const scope = n === 0 ? scopeA : scopeB, proof = n === 0 ? proofA : proofB, input = fileInput(n, name, bytes);
            const original = await scope.files.prepareCatalogUpload(input, proof);
            const written = bytes.length ? await scope.files.appendCatalogUpload(original, proof, "0", bytes) : original;
            return { original: written, input, bytes, scope, proof };
        };
        const assertPrivate = async (original: Awaited<ReturnType<typeof prepare>>["original"], bytes: Buffer) => {
            expect(required((await row(original.status.session.uploadId))[0])).toMatchObject({ phase: "transport", claim: false, actual_sha256: null, result: null });
            expect(await raw.exists(original.execution.targetPath)).toBe(false);
            const chunks: Buffer[] = []; for await (const chunk of await raw.openRead(original.execution.tempPath)) chunks.push(Buffer.from(chunk as Uint8Array));
            expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));
        };
        try {
            // Exact predecessor behavior: omitted local admission, unchanged actual SQL/roles.
            const unqueued = new FileService(new PostgresFileRepository(required(runtimeDb)), raw, { catalogBackendIdentity: "active-local", uploadMaxBytes: 1073741824,
                catalogUploadCoordinator: new CatalogUploadDatabaseCoordinator(required(writerDb), scopeA.authority, "1073741824"),
                catalogFolderV2Coordinator: new CatalogFolderV2DatabaseCoordinator(required(writerDb), scopeA.authority) });
            const baseline = await prepare(0, "original-red.bin", Buffer.alloc(155043, 19)), blocked = hold("red-held-folder"), originalFolder = folderInput(0, blocked.suffix);
            const oldFolder = unqueued.ensureCatalogFolderV2(originalFolder, proofA); pending.push(oldFolder); await blocked.entered.promise;
            if (process.env.SYNC_FAIR_ADMISSION_RED === "true") {
                try { await expect(unqueued.completeCatalogUpload(await unqueued.prepareCatalogUpload(baseline.input, proofA, baseline.original.status.session.uploadId), proofA)).resolves.toMatchObject({ status: { result: { status: "PUBLISHED" } } }); }
                finally { blocked.release.resolve(); await oldFolder; }
                throw Error("Predecessor unexpectedly passed deterministic RED");
            }
            await expect(unqueued.completeCatalogUpload(await unqueued.prepareCatalogUpload(baseline.input, proofA, baseline.original.status.session.uploadId), proofA)).rejects.toMatchObject({ code: "reconciliation_required" });
            await assertPrivate(baseline.original, baseline.bytes);
            await fs.writeFile(path.join(directory, "primary-red.json"), JSON.stringify({ originalUploadId: baseline.original.status.session.uploadId, originalKey: baseline.input.intent.idempotencyKey, row: await row(baseline.original.status.session.uploadId), folderOperation: originalFolder.operationId, bytes: baseline.bytes.length, sha256: sha(baseline.bytes), sqlGuardUnchanged: true }, null, 2));
            blocked.release.resolve(); await oldFolder;
            const restored = await scopeA.files.completeCatalogUpload(await scopeA.files.prepareCatalogUpload(baseline.input, proofA, baseline.original.status.session.uploadId), proofA);
            expect(restored.status.result?.status).toBe("PUBLISHED"); expect(restored.status.session.uploadId).toBe(baseline.original.status.session.uploadId);
            checks.push("actual deterministic predecessor RED: qualified concurrent folder causes unchanged SQL409 before verify; exact155043 temp/key/UUID remain; same-ID successor publishes once after release");

            const child = await prepare(0, "queued-file.bin"), cross = await prepare(1, "cross-root.bin"), second = hold("green-held-folder"), first = scopeA.files.ensureCatalogFolderV2(folderInput(0, second.suffix), proofA); pending.push(first); await second.entered.promise;
            const completed = scopeA.files.completeCatalogUpload(child.original, proofA); pending.push(completed);
            let settled = false; void completed.finally(() => { settled = true; }).catch(() => undefined);
            await new Promise(r => setTimeout(r, 50)); expect(settled).toBe(false); await assertPrivate(child.original, child.bytes);
            // Separate runtime/local gate cannot fabricate liveness or bypass the durable fence.
            const foreign = new FileService(new PostgresFileRepository(required(runtimeDb)), raw, { catalogBackendIdentity: "active-local", uploadMaxBytes: 1073741824, catalogRootAdmission: new CatalogRootAdmission(),
                catalogUploadCoordinator: new CatalogUploadDatabaseCoordinator(required(writerDb), scopeA.authority, "1073741824") });
            await expect(foreign.completeCatalogUpload(await foreign.prepareCatalogUpload(child.input, proofA, child.original.status.session.uploadId), proofA)).rejects.toMatchObject({ code: "reconciliation_required" }); await assertPrivate(child.original, child.bytes);
            const crossResult = await scopeB.files.completeCatalogUpload(cross.original, proofB); expect(crossResult.status.result?.status).toBe("PUBLISHED"); expect(settled).toBe(false);
            const acrossFolder = await scopeB.files.ensureCatalogFolderV2(folderInput(1, "cross-root-folder"), proofB); expect(acrossFolder.result.status).toBe("CREATED");
            second.release.resolve(); await first; expect((await completed).status.result?.status).toBe("PUBLISHED");
            checks.push("GREEN holds original preclaim/no target write while queued; distinct root+same ROOT control ancestors independently publish; separate runtime preserves SQL409 and private original");

            const fairness = await prepare(0, "fairness-file.bin"), fairHold = hold("fairness-held-folder"), firstFair = scopeA.files.ensureCatalogFolderV2(folderInput(0, fairHold.suffix), proofA); pending.push(firstFair); await fairHold.entered.promise;
            const arrival = vi.spyOn(CatalogRootAdmission.prototype, "run"), order: string[] = [], file = scopeA.files.completeCatalogUpload(fairness.original, proofA).then(value => { order.push("file"); return value; }); pending.push(file);
            // FIFO starts at admission after private hash/MIME, not HTTP request arrival.
            // Observe the real admission call before offering later folder work.
            await vi.waitFor(() => expect(arrival).toHaveBeenCalled()); expect(arrival.mock.calls[0]?.[0]).toBe(required(roots[0])); arrival.mockRestore();
            // Continue feeding batches while the file is queued; no polling/backoff lottery.
            const stream = Array.from({ length: 12 }, (_, n) => scopeA.files.ensureCatalogFolderV2(folderInput(0, "continuous-" + String(n)), proofA).then(value => { order.push("folder-" + String(n)); return value; })); pending.push(...stream);
            fairHold.release.resolve(); await firstFair; expect((await file).status.result?.status).toBe("PUBLISHED"); await Promise.all(stream); expect(order[0]).toBe("file");
            checks.push("actual continuous folder backlog FIFO admits same original file before later folders, without repeated429 or starvation");

            const chunkFiles = await Promise.all(Array.from({ length: 4 }, (_, n) => scopeA.files.prepareCatalogUpload(fileInput(0, "parallel-temp-" + String(n), Buffer.from("123")), proofA)));
            const writeHold = deferred(), allWrites = deferred(); let activeWrites = 0, maxWrites = 0;
            const writes = vi.spyOn(raw, "write").mockImplementation(async (...args) => { if (chunkFiles.some(p => p.execution.tempPath === args[0])) { activeWrites++; maxWrites = Math.max(maxWrites, activeWrites); if (activeWrites === 4) allWrites.resolve(); await writeHold.promise; try { return await writeOriginal(...args); } finally { activeWrites--; } } return writeOriginal(...args); });
            const append = chunkFiles.map(p => scopeA.files.appendCatalogUpload(p, proofA, "0", Buffer.from("123"))); pending.push(...append);
            try { await allWrites.promise; expect(maxWrites).toBe(4); await scopeA.files.ensureCatalogFolderV2(folderInput(0, "while-four-private-streams"), proofA); }
            finally { writeHold.resolve(); }
            const written = await Promise.all(append); writes.mockRestore(); expect(written.every(p => p.status.session.receivedSizeBytes === "3")).toBe(true);
            const publications = await Promise.all(written.map(p => scopeA.files.completeCatalogUpload(p, proofA))); expect(publications.every(p => p.status.result?.status === "PUBLISHED")).toBe(true);
            checks.push("four true private byte streams overlap; folder can publish during private writes; progress/final publication use shared queue and all four receipts complete");

            const cancellation = await prepare(0, "cancelled-before-publication.bin"), waitGate = new CatalogRootAdmission({ maximumQueuedPerRoot: 1, maximumWaitMs: 50 });
            const smallQueue = new FileService(new PostgresFileRepository(required(runtimeDb)), raw, { catalogBackendIdentity: "active-local", uploadMaxBytes: 1073741824, catalogRootAdmission: waitGate,
                catalogUploadCoordinator: new CatalogUploadDatabaseCoordinator(required(writerDb), scopeA.authority, "1073741824"), catalogFolderV2Coordinator: new CatalogFolderV2DatabaseCoordinator(required(writerDb), scopeA.authority) });
            const restoredCancel = await smallQueue.prepareCatalogUpload(cancellation.input, proofA, cancellation.original.status.session.uploadId);
            const queueHold = hold("bounded-queue-folder"), queueFolder = smallQueue.ensureCatalogFolderV2(folderInput(0, queueHold.suffix), proofA); pending.push(queueFolder); await queueHold.entered.promise;
            const cancelPromise = smallQueue.cancelCatalogUpload(restoredCancel, proofA); pending.push(cancelPromise);
            await expect(cancelPromise).rejects.toMatchObject({ code: "admission_full" }); await assertPrivate(cancellation.original, cancellation.bytes);
            const abort = new AbortController(), abortedInput = folderInput(0, "never-reserved-on-cancel"), aborted = smallQueue.ensureCatalogFolderV2(abortedInput, proofA, abort.signal); pending.push(aborted); abort.abort();
            await expect(aborted).rejects.toMatchObject({ code: "cancelled" }); expect(await adb.withSql(sql => sql`SELECT id FROM operation_journal WHERE id=${abortedInput.operationId}`)).toHaveLength(0);
            queueHold.release.resolve(); await queueFolder; expect((await smallQueue.cancelCatalogUpload(restoredCancel, proofA)).status.result?.status).toBe("NOT_PUBLISHED");
            expect(await raw.exists(cancellation.original.execution.targetPath)).toBe(false);
            checks.push("actual bounded wait/cancel before SQL leaves original private bytes/no claim/no target; cancelled waiter never reserves folder; same original cancellation after release records NOT_PUBLISHED");

            const base = "/sync/v1/roots/" + required(roots[0]), httpInput = fileInput(0, "http-original.bin", Buffer.from("one"));
            const preparedHttp = await json(base + "/catalog-uploads/prepare", { binding: scopeA.binding, input: httpInput }, windows.token); expect(preparedHttp.status).toBe(200);
            const httpStatus = preparedHttp.value as unknown as CatalogUploadStatus, meta = Buffer.from(JSON.stringify({ binding: scopeA.binding, input: httpInput, upload_id: httpStatus.session.uploadId, offset: "0" })), frame = Buffer.alloc(4 + meta.length + 3); frame.writeUInt32BE(meta.length); meta.copy(frame, 4); frame.write("one", 4 + meta.length);
            expect((await fetch(origin + base + "/catalog-uploads/append", { method: "PATCH", headers: { Authorization: "Bearer " + windows.token, "Content-Type": GUARDED_UPLOAD_FRAME_TYPE }, body: frame })).status).toBe(200);
            const httpHold = hold("http-held-folder"), httpFolder = json(base + "/directories/ensure-v2", { binding: scopeA.binding, input: folderInput(0, httpHold.suffix) }, windows.token); pending.push(httpFolder); await httpHold.entered.promise;
            const httpComplete = json(base + "/catalog-uploads/complete", { binding: scopeA.binding, input: httpInput, upload_id: httpStatus.session.uploadId }, windows.token); pending.push(httpComplete);
            await new Promise(r => setTimeout(r, 50)); expect(required((await row(httpStatus.session.uploadId))[0]).claim).toBe(false);
            httpHold.release.resolve(); expect((await httpFolder).status).toBe(200); const publishedHttp = await httpComplete; expect(publishedHttp.status).toBe(200); expect((publishedHttp.value as unknown as CatalogUploadStatus).session.uploadId).toBe(httpStatus.session.uploadId);
            expect((await json(base + "/catalog-uploads/complete", { binding: scopeA.binding, input: httpInput, upload_id: httpStatus.session.uploadId }, windows.token)).value["replayed"]).toBe(true);
            checks.push("actual loopback authenticated framing/ensure/complete restores original key/UUID between requests, queues cleanly, and replays immutable historical result without second version");

            const overflowHold = hold("http-capacity-folder"), overflowFolder = json(base + "/directories/ensure-v2", { binding: scopeA.binding, input: folderInput(0, overflowHold.suffix) }, windows.token); pending.push(overflowFolder); await overflowHold.entered.promise;
            const arrivals = vi.spyOn(CatalogRootAdmission.prototype, "run"), queuedInputs = Array.from({ length: 16 }, (_, n) => folderInput(0, "queued-http-" + String(n)));
            const requests = queuedInputs.map(input => json(base + "/directories/ensure-v2", { binding: scopeA.binding, input }, windows.token)); pending.push(...requests);
            await vi.waitFor(() => expect(arrivals.mock.calls.length).toBe(16)); arrivals.mockRestore();
            const rejectedInput = folderInput(0, "http-queue-overflow"), denied = await json(base + "/directories/ensure-v2", { binding: scopeA.binding, input: rejectedInput }, windows.token);
            expect(denied).toEqual({ status: 429, value: { code: "admission_full", retry_after_ms: 1000 } }); expect(await adb.withSql(sql => sql`SELECT id FROM operation_journal WHERE id=${rejectedInput.operationId}`)).toHaveLength(0);
            overflowHold.release.resolve(); expect((await overflowFolder).status).toBe(200); expect((await Promise.all(requests)).every(r => r.status === 200)).toBe(true);
            checks.push("actualHTTP seventeenth queued request gets bounded429 before reservation/claim/mkdir; all sixteen admitted FIFO requests publish without409");

            const storm = await prepare(0, "post-effect-commit.bin"), physical = deferred(), physicalRelease = deferred(), originalRename = raw.rename.bind(raw);
            const rename = vi.spyOn(raw, "rename").mockImplementation(async (from, to) => { if (from === storm.original.execution.tempPath) { await originalRename(from, to); physical.resolve(); await physicalRelease.promise; return; } return originalRename(from, to); });
            const writer = scopeA.files.completeCatalogUpload(storm.original, proofA); pending.push(writer); await physical.promise;
            const replayArrival = vi.spyOn(CatalogRootAdmission.prototype, "run"), replayStorm = Array.from({ length: 16 }, () => json(base + "/catalog-uploads/complete", { binding: scopeA.binding, input: httpInput, upload_id: httpStatus.session.uploadId }, windows.token)); pending.push(...replayStorm);
            try { await vi.waitFor(() => expect(replayArrival.mock.calls.length).toBe(16)); expect(required((await row(storm.original.status.session.uploadId))[0]).phase).toBe("physical_pending"); }
            finally { replayArrival.mockRestore(); physicalRelease.resolve(); }
            expect((await writer).status.result?.status).toBe("PUBLISHED"); const replayResponses = await Promise.all(replayStorm); expect(replayResponses.every(r => r.status === 200 || r.status === 429)).toBe(true); rename.mockRestore();
            expect(required((await adb.withSql(sql => sql<{ namespace_state: string }[]>`SELECT namespace_state FROM sync_root_clock WHERE root_id=${required(roots[0])}`))[0]).namespace_state).toBe("ACTIVE");
            expect(await adb.withSql(sql => sql`SELECT id FROM file_versions WHERE resource_id=${storm.original.execution.nodeId}`)).toHaveLength(1);
            checks.push("historical HTTP replay storm cannot occupy SQL budget ahead of the admitted post-effect writer: original commit completes, one version, ACTIVE retained; excess receipt lookups remain bounded200/429");

            if (sftp && process.env.SYNC_FAIR_ADMISSION_ORDINARY_ENTRY) {
                const { ordinaryFixtureEnvironment, qualifyOrdinaryNest } = await import("./guarded-runtime-nest.integration-helper.js");
                const actualInput = { directory, databaseUrl: ru.toString(), storage: storageConfig, manifestFile, ownerKey, authPepper: "outside-owner-pepper-123456789012345678", devicePepper: device.pepper, rootId: required(roots[0]), deviceToken: windows.token };
                await qualifyOrdinaryNest(actualInput);
                const nativeDirectory = path.join(directory, "ordinary-native"); await fs.mkdir(nativeDirectory);
                const environment = await ordinaryFixtureEnvironment({ ...actualInput, directory: nativeDirectory }), clients = subjects.map((s, n) => ({ kind: n === 0 ? "windows_sync" : "pluto", deviceId: s.device.id, rootId: required(roots[n]), token: s.token,
                    binding: (n === 0 ? scopeA : scopeB).binding, backendIdentity: "active-local", rootName: required(required(rootNames[n])[0]).name }));
                const privateFile = path.join(directory, "ordinary.private.json");
                await fs.writeFile(privateFile, JSON.stringify({ schema: "saturn.ordinary-active-fixture.v1", schemaCut: 58, manifestFile, environment, clients, fixtureDirectory: directory,
                    postgresOwnership: { containerId: f.containerId, runId: f.runId }, sftpOwnership: { containerId: sftp.containerId, runId: sftp.runId } }, null, 2));
                const ordinary = await exec(process.execPath, [process.env.SYNC_FAIR_ADMISSION_ORDINARY_ENTRY, privateFile], { windowsHide: true, timeout: 120000 });
                await fs.writeFile(path.join(directory, "ordinary-runner.stdout.log"), ordinary.stdout); await fs.writeFile(path.join(directory, "ordinary-runner.stderr.log"), ordinary.stderr);
                expect(JSON.parse(await fs.readFile(path.join(directory, "ordinary-actual.json"), "utf8"))).toMatchObject({ passed: true });
                checks.push("actual ordinary Nest providers and frozen normal main API+worker/no overrides; both capabilities/heartbeats, six files+twelve concurrent directories, three authenticated product DAV SHA readbacks; exact native FILETIME/argv joins");
            }

            const uncertainFile = await prepare(1, "unknown-held-file.bin"), failureName = "unknown-directory";
            mkdir.mockImplementation(async storagePath => { if (storagePath.endsWith("/" + failureName)) throw Error("fixture lost exclusive mkdir response"); return mkdirOriginal(storagePath); });
            await expect(scopeB.files.ensureCatalogFolderV2(folderInput(1, failureName), proofB)).rejects.toMatchObject({ code: "reconciliation_required" });
            await expect(scopeB.files.completeCatalogUpload(uncertainFile.original, proofB)).rejects.toMatchObject({ code: "binding_invalid" }); await assertPrivate(uncertainFile.original, uncertainFile.bytes);
            expect(required((await adb.withSql(sql => sql<{ namespace_state: string }[]>`SELECT namespace_state FROM sync_root_clock WHERE root_id=${required(roots[1])}`))[0]).namespace_state).toBe("BACKEND_UNCERTAIN");
            checks.push("real unknown folder outcome closes root and subsequent file publication despite a released local FIFO; no claim/adoption/delete or receipt fabrication");
            expect(await adb.withSql(sql => sql<{ source: string }[]>`SELECT prosrc AS source FROM pg_proc WHERE oid='public.catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure`)).toEqual(functionRows.filter(r => r.identity.includes("catalog_upload_command")).map(r => ({ source: r.source })));
            const ledger = await adb.withSql(sql => sql`SELECT j.id,j.operation_type,j.state,j.upload_effect_state,j.sync_first_seq::text,j.sync_last_seq::text,j.sync_result IS NOT NULL AS accepted FROM operation_journal j WHERE j.sync_root_id=ANY(${roots}::uuid[]) ORDER BY j.id`);
            passed = true; await fs.writeFile(path.join(directory, "result.json"), JSON.stringify({ passed, backend: sftp ? "sftp" : "local", checks, negatives, ledger, sqlMigrationUnchanged: 58, maximumPrivateWrites: maxWrites, fairness: order }, null, 2));
        } finally { for (const value of holds) value.release.resolve(); await Promise.allSettled(pending); vi.restoreAllMocks(); }
    } finally {
        await app.close(); await runtime?.close(); await writerDb?.close(); await runtimeDb?.close(); await db?.close(); await raw.close();
        await admin.withSql(sql => sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)); for (const role of [rt, wr, ow]) await admin.withSql(sql => sql.unsafe(`DROP ROLE IF EXISTS ${role}`)); await admin.close();
        await fs.writeFile(path.join(directory, "cleanup.json"), JSON.stringify({ passed, generatedDatabase: name, generatedRoles: [rt, wr, ow], cleanupComplete: true, retainedForHandoff: false }, null, 2));
    }
}, 120000);
