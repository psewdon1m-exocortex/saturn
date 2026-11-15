function required<T>(value: T | null | undefined): T { if (value === null || value === undefined) throw new Error("Required isolated fixture value missing"); return value; }
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
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
import { inspectJournal, assertUnregisteredRecovery } from "../../../packages/recovery/src/consistent-snapshot.js";
import { guardedSyncRuntimeHttp } from "./guarded-sync-runtime-http.js";
import { OwnerAuthService, PostgresOwnerAuthRepository } from "@saturn/auth";
import { GUARDED_UPLOAD_FRAME_TYPE } from "./guarded-sync-upload-http.js";
import { GuardedOutsideFolderService } from "../../../packages/sync/src/guarded-outside-folder.js";
import { PostgresCatalogMutationGuard } from "../../../packages/file-core/src/catalog-guard-admission.js";
import { CatalogUploadDatabaseCoordinator } from "../../../packages/file-core/src/catalog-upload-database.js";
const fixturePath = process.env.SYNC_GUARDED_RUNTIME_FIXTURE, exec = promisify(execFile), sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it.skipIf(!fixturePath)("qualifies explicit empty ACTIVE roots through the ordinary factory, current capability and fixed physical/SQL fences", async () => {
    const batches = process.env.SYNC_GUARDED_RUNTIME_BATCH === "true";
    if (!fixturePath)
        throw Error("Own fixture required");
    const f = JSON.parse(await fs.readFile(fixturePath, "utf8")) as {
        containerId: string;
        runId: string;
        databaseUrl: string;
        fixtureDirectory: string;
    };
    const owned = JSON.parse((await exec("docker", ["inspect", f.containerId], { windowsHide: true })).stdout) as {
        Id: string;
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
    expect(owned[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(f.runId);
    expect(owned[0]?.State.Running).toBe(true);
    expect(owned[0]?.HostConfig.NanoCpus).toBe(1e9);
    expect(owned[0]?.HostConfig.Memory).toBe(536870912);
    const suffix = randomUUID().replaceAll("-", ""), name = "active_" + suffix, directory = path.join(f.fixtureDirectory, name);
    await fs.mkdir(directory);
    const admin = new Database(f.databaseUrl, { max: 1 }), url = new URL(f.databaseUrl);
    url.pathname = "/" + name;
    const rt = "rt_" + suffix, wr = "wr_" + suffix, ow = "ow_" + suffix, password = randomUUID().replaceAll("-", "");
    await fs.writeFile(path.join(directory, "ownership.json"), JSON.stringify({ at: new Date().toISOString(), generatedDatabase: name,
        generatedRoles: [rt, wr, ow], postgresContainer: f.containerId, postgresRun: f.runId, batches }), { flag: "wx" });
    let db: Database | undefined, runtimeDb: Database | undefined, writerDb: Database | undefined, runtime: GuardedRuntime | undefined;
    const sftpPath = process.env.SYNC_GUARDED_RUNTIME_SFTP;
    const sftp = sftpPath ? JSON.parse(await fs.readFile(sftpPath, "utf8")) as {
        containerId: string;
        runId: string;
        ownership?: { label: "exocortex.sync-performance.endurance"; created: string; image: string; volume: string };
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
            Created: string; Image: string; Mounts: { Type: string; Name: string; Destination: string }[];
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
        expect(ci[0]?.Config.Labels[sftp.ownership?.label ?? "exocortex.sync-performance.run"]).toBe(sftp.runId);
        if (sftp.ownership) {
            expect(ci[0]?.Created).toBe(sftp.ownership.created); expect(ci[0]?.Image).toBe(sftp.ownership.image);
            expect(ci[0]?.Mounts.filter(m => m.Type === "volume" && m.Name === sftp.ownership?.volume && m.Destination === "/home/qa/data")).toHaveLength(1);
        }
        expect(ci[0]?.State.Running).toBe(true);
        expect(ci[0]?.HostConfig.NanoCpus).toBe(1e9);
        expect(ci[0]?.HostConfig.Memory).toBe(268435456);
        await fs.copyFile(required(sftp.storage.passwordFile), credential);
        const initial = new SftpStorageAdapter(sftp.storage);
        await initial.mkdir(name);
        await initial.close();
    }
    const raw: StorageAdapter = sftpConfig ? new SftpStorageAdapter(sftpConfig) : new LocalStorageAdapter(path.join(directory, "storage")), app = Fastify({ logger: false });
    const checks: string[] = [], negatives: string[] = [];
    let passed = false, retainedForHandoff = false;
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
        const outsideParent = await legacy.createFolder(ROOT_RESOURCE_ID, "outside-existing-" + suffix);
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
        if (batches) {
            const batchMigrations = path.join(directory, "cut61");
            await fs.mkdir(batchMigrations);
            for (const file of await fs.readdir(migrations)) {
                const migration = Number(file.slice(0, 4));
                if (migration > 58 && migration <= 61)
                    await fs.copyFile(path.join(migrations, file), path.join(batchMigrations, file));
            }
            expect(await migrate(url.toString(), batchMigrations)).toBe(3);
            const ledger = await adb.withSql(sql => sql<{ name: string }[]> `SELECT name FROM _vault_migrations ORDER BY name DESC LIMIT 1`);
            expect(ledger).toEqual([{ name: "0061_small_batch_registry" }]);
            await adb.withSql(sql => sql.unsafe(`GRANT SELECT ON sync_small_batch_budget,sync_small_batch_operations,sync_small_batches TO ${rt},${ow};
                GRANT INSERT ON sync_small_batch_budget,sync_small_batch_operations,sync_small_batches TO ${ow};GRANT UPDATE ON sync_small_batch_budget TO ${ow};
                ALTER FUNCTION public.sync_small_batch_command(text,jsonb,jsonb,jsonb) OWNER TO ${ow};
                GRANT EXECUTE ON FUNCTION public.sync_small_batch_command(text,jsonb,jsonb,jsonb) TO ${wr}`));
        }
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
        expect(functions).toHaveLength(batches ? 7 : 6);
        const qualificationFile = path.join(directory, "qualification.json"), fenceFile = path.join(directory, "fence.json"), writerFile = path.join(directory, "writer.private"), cursorFile = path.join(directory, "cursor.key"), manifestFile = path.join(directory, "manifest.private.json");
        await fs.writeFile(qualificationFile, JSON.stringify({ schema: batches ? "saturn.guarded-qualification.v2" : "saturn.guarded-qualification.v1", coverage: "append-only-directories/file-cas", approvedFunctionsSha256: guardedApprovedFunctionsSha256(functions), supportedWritersVerified: true, unsupportedWritersBlockedBeforeIo: true, privateLifecycleVerified: true,
            ...(batches ? { smallBatchTransport: "saturn.small-file-batch.v1" } : {}) }), { mode: 0o600 });
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
        const manifest: GuardedRuntimeManifest = { schema: batches ? "saturn.guarded-runtime.v2" : "saturn.guarded-runtime.v1", serverIdentity, policyVersion: "active58", qualificationReceiptFile: qualificationFile, qualificationReceiptSha256: qualifiedSha,
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
        if (process.env.SYNC_GUARDED_RUNTIME_HANDOFF === "true") {
            if (!sftp)
                throw Error("Ordinary API handoff requires its actual SFTP backend");
            const { ordinaryFixtureEnvironment } = await import("./guarded-runtime-nest.integration-helper.js");
            const environment = await ordinaryFixtureEnvironment({ directory, databaseUrl: ru.toString(), storage: storageConfig, manifestFile,
                ownerKey, authPepper: "outside-owner-pepper-123456789012345678", devicePepper: device.pepper, rootId: required(roots[0]), deviceToken: windows.token });
            const contexts = [];
            for (const [i, subject] of subjects.entries()) {
                const scope = required((await active.scope(required(roots[i]))));
                expect((await raw.list(required((await adb.withSql(sql => sql<{
                    storage_path: string;
                }[]> `SELECT storage_path FROM resources WHERE id=${required(roots[i])}`))[0]).storage_path, undefined, 1)).entries).toHaveLength(0);
                contexts.push({ kind: i === 0 ? "windows_sync" : "pluto", deviceId: subject.device.id, rootId: roots[i], token: subject.token, binding: scope.binding, backendIdentity: manifest.backend.identity,
                    qualificationReceiptSha256: qualifiedSha, rootName: required((await adb.withSql(sql => sql<{
                        name: string;
                    }[]> `SELECT name FROM resources WHERE id=${required(roots[i])}`))[0]).name });
            }
            await fs.writeFile(path.join(directory, "ordinary.private.json"), JSON.stringify({ schema: "saturn.ordinary-active-fixture.v1", environment, clients: contexts,
                manifestFile, fixtureDirectory: directory, generatedDatabase: name, generatedRoles: [rt, wr, ow], postgresOwnership: { containerId: f.containerId, runId: f.runId }, sftpOwnership: { containerId: sftp.containerId, runId: sftp.runId },
                schemaCut: batches ? 61 : 58, sourceStatus: "candidate-active-ordinary-qualification" }, null, 2), { mode: 0o600 });
            await fs.writeFile(path.join(f.fixtureDirectory, "ordinary-handoff-latest.json"), JSON.stringify({ privateFile: path.join(directory, "ordinary.private.json"), schemaCut: batches ? 61 : 58, generatedDatabase: name, generatedRoles: [rt, wr, ow], createdAt: new Date().toISOString() }, null, 2));
            retainedForHandoff = true;
            passed = true;
            return;
        }
        const currentRootVersion = (root: string) => adb.withSql(sql => sql `SELECT metadata_version,size_bytes::text FROM resources WHERE id=${root}`);
        const beforeOutside = await Promise.all(roots.map(currentRootVersion));
        const fresh = await active.ownerAction({ bootstrap: ownerKey }, () => active.legacyFiles.createFolder(ROOT_RESOURCE_ID, "direct-new-" + suffix), "direct-new-" + suffix);
        expect(await active.ownerAction({ bootstrap: ownerKey }, () => active.legacyFiles.createFolder(ROOT_RESOURCE_ID, "direct-new-" + suffix), "direct-new-" + suffix)).toEqual(fresh);
        await expect(active.legacyFiles.createFolder(ROOT_RESOURCE_ID, "bare-actor", { type: "owner_bootstrap", id: "owner" })).rejects.toMatchObject({ code: "authority_invalid" });
        await expect(active.ownerAction({ bootstrap: "invalid-owner" }, () => active.legacyFiles.createFolder(ROOT_RESOURCE_ID, "bad-owner"))).rejects.toMatchObject({ code: "authority_invalid" });
        await expect(active.legacyStorage.mkdir("unreserved-new-root-child")).rejects.toMatchObject({ code: "guarded_write_refused" });
        const directUpload = await active.legacyFiles.createUpload({ parentId: fresh.id, filename: "direct.txt", expectedSize: 3, expectedSha256: sha("abc"), idempotencyKey: "direct-upload-" + suffix });
        await active.legacyFiles.appendUpload(directUpload.id, 0, 3, Readable.from("abc"));
        const directFile = await active.legacyFiles.completeUpload(directUpload.id);
        const enrollmentWindows = await active.ownerAction({ bootstrap: ownerKey }, () => active.devices.createWindowsEnrollment("second windows " + suffix));
        const secondWindows = await active.devices.redeemWindowsEnrollment(enrollmentWindows.code, "fixture");
        expect((await active.devices.authenticate("Bearer " + secondWindows.token)).device.id).toBe(secondWindows.device.id);
        const enrollmentPluto = await active.ownerAction({ bootstrap: ownerKey }, () => active.devices.createPlutoEnrollment("second pluto " + suffix));
        const secondPluto = await active.devices.redeemPlutoEnrollment(enrollmentPluto.code, "fixture");
        expect((await active.devices.authenticate("Bearer " + secondPluto.token)).device.id).toBe(secondPluto.device.id);
        expect((await fetch(origin + "/sync/v1/roots/" + required(secondWindows.device.syncRootId) + "/capabilities", { headers: { Authorization: "Bearer " + secondWindows.token } })).status).toBe(404);
        checks.push("fresh actual owner proof reserves ordinary directROOT child before mkdir; original-key replay; direct child upload; actual second Windows+Pluto enrollment redemption/auth stays legacy404; bare actor/wrong owner/unreserved raw child denied");
        const sameName = "same-name-" + suffix, concurrent = await Promise.allSettled(Array.from({ length: 4 }, () => active.ownerAction({ bootstrap: ownerKey }, () => active.legacyFiles.createFolder(ROOT_RESOURCE_ID, sameName))));
        expect(concurrent.filter(x => x.status === "fulfilled")).toHaveLength(1);
        expect(concurrent.filter(x => x.status === "rejected")).toHaveLength(3);
        const foreign = "foreign-existing-" + suffix;
        await raw.mkdir(foreign);
        const foreignKey = "foreign-original-" + suffix;
        await expect(active.ownerAction({ bootstrap: ownerKey }, () => active.legacyFiles.createFolder(ROOT_RESOURCE_ID, foreign), foreignKey)).rejects.toMatchObject({ code: "reconciliation_required" });
        const pending = required((await adb.withSql(sql => sql<{
            id: string;
            status: string;
            error_code: string;
        }[]> `SELECT r.id,r.status,j.error_code FROM resources r JOIN operation_journal j ON j.resource_id=r.id WHERE j.idempotency_key=${"outside-folder:" + foreignKey}`))[0]);
        expect(pending.status).toBe("pending");
        expect(pending.error_code).toBe("reconciliation_required");
        await expect(active.ownerAction({ bootstrap: ownerKey }, () => active.legacyFiles.createFolder(ROOT_RESOURCE_ID, foreign), foreignKey)).rejects.toMatchObject({ code: "reconciliation_required" });
        await expect(required(runtimeDb).withSql(sql => sql `UPDATE resources SET status='active' WHERE id=${pending.id}`)).rejects.toThrow("outside pending identity");
        await expect(required(runtimeDb).withSql(sql => sql `DELETE FROM resources WHERE id=${pending.id}`)).rejects.toThrow("outside pending outcome");
        await expect(required(runtimeDb).withSql(sql => sql `DELETE FROM operation_journal WHERE id=${pending.id}`)).rejects.toThrow("outside original identity");
        await expect(active.legacyStorage.delete(foreign)).rejects.toMatchObject({ code: "guarded_write_refused" });
        expect((await raw.stat(foreign)).type).toBe("directory");
        checks.push("four concurrent same-name ROOT reservations publish one original identity; pre-existing physical foreign directory leaves pending/UNKNOWN original, original replay cannot retry/adopt/delete/forget it");
        const ackService = new GuardedOutsideFolderService(runtimeDb, required(writerDb), active.legacyStorage, { catalogMutationGuard: new PostgresCatalogMutationGuard(runtimeDb) }, input => auth.validateSession(input));
        const commit = required(writerDb).transaction.bind(writerDb), ack = vi.spyOn(required(writerDb), "transaction").mockImplementationOnce(async (...args) => { await commit(...args); throw Error("lost SQL commit ACK"); });
        const mkdir = vi.spyOn(raw, "mkdir"), ackName = "lost-sql-ack-" + suffix, ackKey = "lost-sql-ack-key-" + suffix;
        const ackFolder = await ackService.ownerAction({ bootstrap: ownerKey }, () => ackService.createFolder(ROOT_RESOURCE_ID, ackName), ackKey);
        ack.mockRestore();
        expect(await ackService.ownerAction({ bootstrap: ownerKey }, () => ackService.createFolder(ROOT_RESOURCE_ID, ackName), ackKey)).toEqual(ackFolder);
        expect(mkdir).toHaveBeenCalledTimes(1);
        mkdir.mockRestore();
        expect((await adb.withSql(sql => sql<{
            state: string;
            error_code: string | null;
        }[]> `SELECT state,error_code FROM operation_journal WHERE id=${ackFolder.id}`))[0]).toEqual({ state: "active", error_code: null });
        checks.push("actual fixed outside commit then lost SQL ACK queries accepted original before compensation; same UUID/key replay has one physical mkdir and no UNKNOWN downgrade");
        const session = await auth.authenticate(ownerKey, "127.0.0.1", "active-test");
        const web = { session: { token: session.token, userAgent: "active-test", isMutation: true, origin: "https://fixture.invalid", csrfCookie: session.csrfToken, csrfHeader: session.csrfToken } };
        await active.ownerAction(web, () => active.legacyFiles.createFolder(ROOT_RESOURCE_ID, "web-owned-" + suffix));
        await auth.logout(session.token);
        await expect(active.ownerAction(web, () => active.legacyFiles.createFolder(ROOT_RESOURCE_ID, "revoked-web-" + suffix))).rejects.toMatchObject({ code: "invalid_session" });
        for (const probe of [{ id: fresh.id, change: "name=name||'-changed'" }, { id: fresh.id, change: "storage_path=storage_path||'-changed'" },
            { id: fresh.id, change: "size_bytes=size_bytes+1" }, { id: directFile.resource.id, change: "sha256=" + "'" + sha("changed") + "'" }]) {
            await adb.transaction(async (sql) => {
                await sql `UPDATE resources SET sync_availability='AVAILABLE' WHERE id=${probe.id}`;
                const before = required((await sql<{
                    metadata_version: string;
                }[]> `SELECT metadata_version FROM resources WHERE id=${probe.id}`)[0]).metadata_version;
                await sql.unsafe("UPDATE resources SET " + probe.change + " WHERE id=$1", [probe.id]);
                const changed = required((await sql<{
                    metadata_version: string;
                    sync_availability: string;
                }[]> `SELECT metadata_version,sync_availability FROM resources WHERE id=${probe.id}`)[0]);
                expect(changed.sync_availability).toBe("UNKNOWN");
                expect(changed.metadata_version).not.toBe(before);
                throw Error("rollback-availability-probe");
            }).catch((error: unknown) => expect(String(error)).toContain("rollback-availability-probe"));
        }
        checks.push("actual owner web session+CSRF may reserve; logout refuses new effect; unqualified namespace/path/hash/size changes cannot inherit physical AVAILABLE, UUID renews and probes roll back");
        const outside = await active.legacyFiles.createFolder(outsideParent.id, "outside-" + suffix);
        const u = await active.legacyFiles.createUpload({ parentId: outside.id, filename: "outside.txt", expectedSize: 3, expectedSha256: sha("abc"), idempotencyKey: "outside-" + suffix });
        await active.legacyFiles.appendUpload(u.id, 0, 3, Readable.from("abc"));
        await active.legacyFiles.completeUpload(u.id);
        await active.legacyFiles.trashResource(outside.id, { idempotencyKey: "outside-trash-" + suffix });
        expect(await Promise.all(roots.map(currentRootVersion))).toEqual(beforeOutside);
        checks.push("ordinary outside create/upload/trash with shared CONTROL aggregate renewal cannot alter guarded root metadata/CAS");
        const receipts: CatalogUploadStatus[] = [];
        for (const [n, subject] of subjects.entries()) {
            const rootId = required(roots[n]), scope = required((await active.scope(rootId))), base = "/sync/v1/roots/" + rootId;
            const cap = await fetch(origin + base + "/capabilities", { headers: { Authorization: "Bearer " + subject.token } });
            expect(cap.status).toBe(200);
            const envelope = await cap.json() as {
                binding: unknown;
                device_id: string;
                coverage: string;
            };
            expect(envelope.device_id).toBe(subject.device.id);
            expect(envelope.binding).toEqual(scope.binding);
            expect(envelope.coverage).toBe("append-only-directories/file-cas");
            const batchCapability = await fetch(origin + base + "/small-batches/capabilities", { headers: { Authorization: "Bearer " + subject.token } });
            expect(batchCapability.status).toBe(batches ? 200 : 404);
            if (batches) {
                expect(await batchCapability.json()).toEqual({ schema: "saturn.small-file-batch-capabilities.v1", transport: "saturn.small-file-batch.v1",
                    binding: scope.binding, device_id: subject.device.id, backend_identity: "active-local", qualification_receipt_sha256: manifest.qualificationReceiptSha256,
                    limits: { items: 500, file_bytes: "262144", data_bytes: "33554432", manifest_bytes: "4194304" } });
            }
            expect((await fetch(origin + base + "/small-batches/capabilities", { headers: { Authorization: "Bearer " + required(subjects[1 - n]).token } })).status).toBe(401);
            expect((await fetch(origin + base + "/capabilities", { headers: { Authorization: "Bearer " + required(subjects[1 - n]).token } })).status).toBe(401);
            const rootName = required((await adb.withSql(sql => sql<{
                name: string;
            }[]> `SELECT name FROM resources WHERE id=${rootId}`))[0]).name;
            const folderInput = { operationId: randomUUID(), idempotencyKey: "modern-folder-" + randomUUID(), rootId, epoch: scope.binding.server_epoch, bindingVersion: scope.binding.binding_version, parentId: rootId, name: "modern", mode: "ensure", parentTopology: [{ nodeId: rootId, parentId: null, name: rootName }] };
            const folderResult = await json(base + "/directories/ensure-v2", { binding: scope.binding, input: folderInput }, subject.token);
            expect(folderResult.status).toBe(200);
            expect((await json(base + "/directories/ensure-v2", { binding: scope.binding, input: folderInput }, subject.token)).value["replayed"]).toBe(true);
            const childId = ((folderResult.value["result"] as {
                description: {
                    node_id: string;
                    availability: string;
                };
            }).description);
            expect(childId.availability).toBe("AVAILABLE");
            const input: CatalogUploadPrepareInput = { epoch: scope.binding.server_epoch, bindingVersion: scope.binding.binding_version, backendIdentity: "active-local", intent: { schema: "saturn.upload-intent.v2", deviceKind: n === 0 ? "windows_sync" : "pluto", deviceId: subject.device.id, rootId, requestPath: "/active/modern/file.txt", idempotencyKey: "active-upload-" + randomUUID(), parentId: childId.node_id, name: "file.txt", targetId: null, sizeBytes: "3", sha256: sha("one"), ifMatch: null, ifNoneMatch: "*", requireAbsent: true, expectedVersionId: null, condition: { kind: "absent" }, parentTopology: [{ nodeId: childId.node_id, parentId: rootId, name: "modern" }, { nodeId: rootId, parentId: null, name: rootName }] } };
            const huge = await json(base + "/catalog-uploads/prepare", { binding: scope.binding, input: { ...input, intent: { ...input.intent, idempotencyKey: "huge-" + randomUUID(), name: "huge", sizeBytes: "1073741825" } } }, subject.token);
            expect(huge.status).toBe(413);
            const proof = await scope.authority.device("Bearer " + subject.token, rootId), coordinator = new CatalogUploadDatabaseCoordinator(required(writerDb), scope.authority, "1073741824");
            const privateInputs = Array.from({ length: 4 }, (_, i) => ({ ...input, intent: { ...input.intent, name: "private-" + i.toString(), idempotencyKey: "private-" + i.toString() + "-" + randomUUID() } }));
            const originals = await Promise.all(privateInputs.map(i => coordinator.prepare(i, proof)));
            expect(originals.every(p => p.status.session.phase === "transport" && p.status.result === undefined)).toBe(true);
            expect((await fetch(origin + base + "/capabilities", { headers: { Authorization: "Bearer " + subject.token } })).status).toBe(200);
            await expect(coordinator.prepare({ ...input, intent: { ...input.intent, name: "private-fifth", idempotencyKey: "private-fifth-" + randomUUID() } }, proof)).rejects.toMatchObject({ code: "admission_full" });
            const cancelled = await Promise.all(originals.map(p => coordinator.cancel(p, proof)));
            expect(cancelled.every(p => p.status.result?.status === "NOT_PUBLISHED")).toBe(true);
            expect((await fetch(origin + base + "/capabilities", { headers: { Authorization: "Bearer " + subject.token } })).status).toBe(200);
            const prepared = await json(base + "/catalog-uploads/prepare", { binding: scope.binding, input }, subject.token);
            expect(prepared.status).toBe(200);
            const status = prepared.value as unknown as CatalogUploadStatus;
            expect((await fetch(origin + base + "/capabilities", { headers: { Authorization: "Bearer " + subject.token } })).status).toBe(200);
            const meta = Buffer.from(JSON.stringify({ binding: scope.binding, input, upload_id: status.session.uploadId, offset: "0" })), frame = Buffer.alloc(4 + meta.length + 3);
            frame.writeUInt32BE(meta.length);
            meta.copy(frame, 4);
            frame.write("one", 4 + meta.length);
            expect((await fetch(origin + base + "/catalog-uploads/append", { method: "PATCH", headers: { Authorization: "Bearer " + subject.token, "Content-Type": GUARDED_UPLOAD_FRAME_TYPE }, body: frame })).status).toBe(200);
            const committed = await json(base + "/catalog-uploads/complete", { binding: scope.binding, input, upload_id: status.session.uploadId }, subject.token);
            expect(committed.status).toBe(200);
            const result = committed.value as unknown as CatalogUploadStatus;
            expect(result.result?.status).toBe("PUBLISHED");
            receipts.push(result);
            expect(await json(base + "/catalog-uploads/complete", { binding: scope.binding, input, upload_id: status.session.uploadId }, subject.token)).toEqual({ status: 200, value: { ...committed.value, replayed: true } });
            await expect(active.legacyFiles.createFolder(rootId, "blocked")).rejects.toMatchObject({ code: "binding_invalid" });
            const target = required((await adb.withSql(sql => sql<{
                storage_path: string;
            }[]> `SELECT storage_path FROM resources WHERE parent_id=${childId.node_id} AND name='file.txt'`))[0]).storage_path;
            await expect(active.legacyStorage.write(target, Readable.from("BAD"), { offset: 0, create: false })).rejects.toMatchObject({ code: "guarded_write_refused" });
            const stream = await raw.openRead(target), chunks: Buffer[] = [];
            for await (const chunk of stream)
                chunks.push(Buffer.from(chunk as Uint8Array));
            expect(Buffer.concat(chunks).toString()).toBe("one");
            if (result.result?.status !== "PUBLISHED")
                throw Error("Actual publication required");
            const description = result.result.publishedDescription;
            if (input.intent.schema !== "saturn.upload-intent.v2" || description.content_version_id === null)
                throw Error("Modern file content identity required");
            const secondInput: CatalogUploadPrepareInput = { ...input, intent: { ...input.intent, schema: "saturn.upload-intent.v2", idempotencyKey: "overwrite-" + randomUUID(), targetId: description.node_id,
                    expectedVersionId: description.content_version_id, requireAbsent: false, ifNoneMatch: null, sha256: sha("two"), condition: { kind: "match", nodeId: description.node_id, metadataVersion: description.version } } };
            const second = await json(base + "/catalog-uploads/prepare", { binding: scope.binding, input: secondInput }, subject.token);
            expect(second.status).toBe(200);
            const secondStatus = second.value as unknown as CatalogUploadStatus;
            const secondMeta = Buffer.from(JSON.stringify({ binding: scope.binding, input: secondInput, upload_id: secondStatus.session.uploadId, offset: "0" })), secondFrame = Buffer.alloc(4 + secondMeta.length + 3);
            secondFrame.writeUInt32BE(secondMeta.length);
            secondMeta.copy(secondFrame, 4);
            secondFrame.write("two", 4 + secondMeta.length);
            expect((await fetch(origin + base + "/catalog-uploads/append", { method: "PATCH", headers: { Authorization: "Bearer " + subject.token, "Content-Type": GUARDED_UPLOAD_FRAME_TYPE }, body: secondFrame })).status).toBe(200);
            expect((await json(base + "/catalog-uploads/complete", { binding: scope.binding, input: secondInput, upload_id: secondStatus.session.uploadId }, subject.token)).status).toBe(200);
            const write = vi.spyOn(raw, "write"), rename = vi.spyOn(raw, "rename"), copy = vi.spyOn(raw, "copy");
            const historical = await json(base + "/catalog-uploads/complete", { binding: scope.binding, input, upload_id: status.session.uploadId }, subject.token);
            expect(historical.status).toBe(200);
            expect(historical.value).toEqual({ ...committed.value, replayed: true });
            expect(write).not.toHaveBeenCalled();
            expect(rename).not.toHaveBeenCalled();
            expect(copy).not.toHaveBeenCalled();
            write.mockRestore();
            rename.mockRestore();
            copy.mockRestore();
            const lower = new CatalogUploadDatabaseCoordinator(required(writerDb), scope.authority, "2"), lowerFiles = new FileService(new PostgresFileRepository(runtimeDb), raw, { uploadMaxBytes: 2, catalogBackendIdentity: "active-local", catalogUploadCoordinator: lower });
            const acceptedOriginal = await lowerFiles.prepareCatalogUpload(input, proof, status.session.uploadId);
            expect((await lowerFiles.completeCatalogUpload(acceptedOriginal, proof)).status.result).toEqual(result.result);
            const all = await adb.withSql(sql => sql<{
                sync_availability: string;
            }[]> `SELECT sync_availability FROM resources WHERE id IN (${rootId},${childId.node_id})`);
            expect(all.every(r => r.sync_availability === "AVAILABLE")).toBe(true);
            await fs.writeFile(path.join(directory, "read-after-upload-" + rootId + ".json"), JSON.stringify(await adb.withSql(sql => sql `SELECT c.namespace_state,c.epoch,c.binding_version,g.guard_revision,r.sync_availability,
        catalog_guard_active_valid(g) AS active_valid,catalog_guard_read_admission(c.root_id,c.epoch,c.binding_version,g.guard_revision) AS read_allowed,
        (SELECT count(*)::int FROM operation_journal j WHERE j.sync_root_id=c.root_id AND j.sync_result IS NULL) AS pending FROM sync_root_clock c JOIN catalog_guard_roots g ON g.root_id=c.root_id JOIN resources r ON r.id=c.root_id WHERE c.root_id=${rootId}`), null, 2));
            expect(required((await adb.withSql(sql => sql<{
                sync_availability: string;
            }[]> `SELECT sync_availability FROM resources WHERE id=${rootId}`))[0]).sync_availability).toBe("AVAILABLE");
            const snapshotId = randomUUID();
            let stage = await json(base + "/snapshots/start", { binding: scope.binding, snapshot_id: snapshotId }, subject.token);
            for (let attempts = 0; stage.value["state"] !== "READY" && attempts < 10; attempts++)
                stage = await json(base + "/snapshots/step", { binding: scope.binding, snapshot_id: snapshotId }, subject.token);
            await fs.writeFile(path.join(directory, "snapshot-http-" + rootId + ".json"), JSON.stringify(stage, null, 2));
            expect(stage.status).toBe(200);
            expect(stage.value["state"]).toBe("READY");
            const ready = await json(base + "/snapshots/ready", { binding: scope.binding, snapshot_id: snapshotId }, subject.token);
            expect(ready.status).toBe(200);
            const entries = await json(base + "/entries", { binding: scope.binding, cursor: ready.value["entries_cursor"] }, subject.token);
            expect(entries.status).toBe(200);
            const items = entries.value["items"] as {
                node_id: string;
                availability: string;
            }[];
            expect(items.filter(r => [rootId, childId.node_id].includes(r.node_id)).every(r => r.availability === "AVAILABLE")).toBe(true);
            expect(items).toHaveLength(3);
        }
        checks.push("actual HTTP capabilities both fresh devices/full7+peer rejection; private original leaves currentR readable; framed append/complete/historical replay; legacy pre-I/O reject and SHA readback; ACTIVE snapshot materialization");
        for (const [n, subject] of subjects.entries()) {
            const rootId = required(roots[n]), scope = required(await active.scope(rootId)), base = "/sync/v1/roots/" + rootId + "/small-batches";
            if (!batches) {
                expect(scope.batches).toBeUndefined();
                expect((await json(base + "/prepare", {}, subject.token)).status).toBe(410);
                continue;
            }
            expect(scope.batches).toBeDefined();
            const rootName = required((await adb.withSql(sql => sql<{ name: string }[]>`SELECT name FROM resources WHERE id=${rootId}`))[0]).name;
            const payloads = Array.from({ length: 8 }, (_, i) => Buffer.from(i === 0 ? "" : "batch content " + String(i)));
            const inputs: CatalogUploadPrepareInput[] = payloads.map((payload, i) => ({ epoch: scope.binding.server_epoch, bindingVersion: scope.binding.binding_version,
                backendIdentity: "active-local", intent: { schema: "saturn.upload-intent.v2", deviceKind: n === 0 ? "windows_sync" : "pluto", deviceId: subject.device.id, rootId,
                    requestPath: "/active/batch-" + String(i), idempotencyKey: "active-batch-" + randomUUID(), parentId: rootId, name: "batch-" + String(i), targetId: null,
                    sizeBytes: String(payload.length), sha256: sha(payload), ifMatch: null, ifNoneMatch: "*", requireAbsent: true, expectedVersionId: null,
                    condition: { kind: "absent" }, parentTopology: [{ nodeId: rootId, parentId: null, name: rootName }] } }));
            const manifest = { ...scope.binding, schema: "saturn.small-file-batch.v1", batch_id: randomUUID(), rules_version: "active-fixture-1",
                items: inputs.map(input => ({ operation_id: input.intent.idempotencyKey, source_generation: "1", source_identity: "fixture-" + input.intent.idempotencyKey,
                    parent_id: rootId, name: input.intent.name, size_bytes: input.intent.sizeBytes, sha256: input.intent.sha256, expected: { kind: "absent" } })) };
            const plan = { manifest, inputs }, batchStatus = { binding: scope.binding, batch_id: manifest.batch_id };
            const originalRows = () => adb.withSql(sql => sql`SELECT to_jsonb(j) AS row FROM operation_journal j WHERE sync_root_id=${rootId} ORDER BY id`);
            const before = await originalRows();
            expect((await json(base + "/prepare", plan, required(subjects[1 - n]).token)).status).toBe(401);
            const prepared = await json(base + "/prepare", plan, subject.token);
            expect(prepared.status).toBe(202); expect(await originalRows()).toEqual(before);
            expect((prepared.value["items"] as { state: string }[]).every(item => item.state === "MISSING")).toBe(true);
            const boundary = "batch-" + randomUUID(), metadata = Buffer.from(JSON.stringify(manifest));
            const chunks = [Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(metadata.length)}\r\n\r\n`), metadata, Buffer.from("\r\n")];
            for (const [i, payload] of payloads.entries()) chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${required(inputs[i]).intent.idempotencyKey}>\r\nContent-Length: ${String(payload.length)}\r\n\r\n`), payload, Buffer.from("\r\n"));
            chunks.push(Buffer.from(`--${boundary}--\r\n`));
            const send = () => fetch(origin + base + "/data", { method: "POST", headers: { Authorization: "Bearer " + subject.token, "Content-Type": "multipart/related; boundary=" + boundary }, body: Buffer.concat(chunks) });
            const sent = await send(); expect(sent.status).toBe(202); await sent.arrayBuffer(); // Ignore ACK; recover the immutable originals via status.
            const received = await json(base + "/status", batchStatus, subject.token);
            expect(received.status).toBe(200);
            const items = received.value["items"] as { state: string; status: CatalogUploadStatus }[];
            expect(items).toHaveLength(8); expect(items.every(item => item.state === "PUBLISHED" && item.status.result?.status === "PUBLISHED")).toBe(true);
            const after = await originalRows(); expect(after.length).toBe(before.length + 8);
            const replay = await send(); expect(replay.status).toBe(202); await replay.arrayBuffer();
            expect(await originalRows()).toEqual(after); expect(await json(base + "/status", batchStatus, subject.token)).toEqual(received);
            for (const [i, input] of inputs.entries()) {
                const target = required((await adb.withSql(sql => sql<{ storage_path: string }[]>`SELECT storage_path FROM resources WHERE parent_id=${rootId} AND name=${input.intent.name}`))[0]).storage_path;
                const chunks: Buffer[] = []; for await (const chunk of await raw.openRead(target)) chunks.push(Buffer.from(chunk as Uint8Array));
                expect(Buffer.concat(chunks)).toEqual(payloads[i]);
            }
            await expect(required(runtimeDb).withSql(sql => sql`SELECT sync_small_batch_command('status',${JSON.stringify(scope.binding)}::text::jsonb,'{}','{}')`)).rejects.toThrow("permission denied");
            await expect(required(writerDb).withSql(sql => sql`UPDATE sync_small_batch_budget SET metadata_bytes=0 WHERE root_id=${rootId}`)).rejects.toThrow("permission denied");
        }
        checks.push(batches ? "v2 ordinary factory: both-device batch register/data/status, lost ACK, immutable replay, peer/direct-SQL denial, zero-file and every backend SHA; v1 client capability remains conservative" : "v1 factory remains usable and refuses batch route without allocating registry or private data");
        const beforeDenial = await adb.withSql(sql => sql `SELECT id,current_version_id,sha256,size_bytes::text FROM resources WHERE status='active' ORDER BY id`);
        await adb.withSql(sql => sql `UPDATE devices SET can_read=false WHERE id=${windows.device.id}`);
        expect((await fetch(origin + "/sync/v1/roots/" + required(roots[0]) + "/capabilities", { headers: { Authorization: "Bearer " + windows.token } })).status).toBe(403);
        await adb.withSql(sql => sql `UPDATE devices SET can_read=true,state='revoked' WHERE id=${windows.device.id}`);
        expect((await fetch(origin + "/sync/v1/roots/" + required(roots[0]) + "/capabilities", { headers: { Authorization: "Bearer " + windows.token } })).status).toBe(401);
        await adb.withSql(sql => sql `UPDATE devices SET state='active' WHERE id=${windows.device.id}`);
        expect(await adb.withSql(sql => sql `SELECT id,current_version_id,sha256,size_bytes::text FROM resources WHERE status='active' ORDER BY id`)).toEqual(beforeDenial);
        checks.push("current revoked/read-denied device capability has 401/403 and cannot obtain legacy404 fallback; publication catalog and versions unchanged");
        if (sftp && process.env.SYNC_GUARDED_RUNTIME_NEST === "true") {
            const { qualifyOrdinaryNest } = await import("./guarded-runtime-nest.integration-helper.js");
            await qualifyOrdinaryNest({ directory, databaseUrl: ru.toString(), storage: storageConfig, manifestFile,
                ownerKey, authPepper: "outside-owner-pepper-123456789012345678", devicePepper: device.pepper,
                rootId: required(roots[0]), deviceToken: windows.token });
            checks.push("actual ordinary Nest AppModule, zero provider overrides, fenced FILE/STORAGE DI, owner401, directROOT folder and second enrollment/redeem/device heartbeat over real SFTP");
        }
        if (process.env.SYNC_GUARDED_RUNTIME_PLAN === "true") {
            await adb.transaction(async (sql) => {
                await sql `SET LOCAL statement_timeout='60s'`;
                // Synthetic catalog-only query-plan data, rolled back. This does not
                // qualify filesystem content or publication/history of these rows.
                await sql.unsafe("ALTER TABLE resources DISABLE TRIGGER USER");
                await sql `INSERT INTO resources(id,type,parent_id,name,storage_path,status) SELECT gen_random_uuid(),'folder',${ROOT_RESOURCE_ID},'fence-plan-'||n,'fence-plan-'||n,'active' FROM generate_series(1,100000) n`;
                await sql.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
                await sql.unsafe("ALTER TABLE resources ENABLE TRIGGER USER");
                await sql.unsafe("ANALYZE resources");
                const plans = [];
                for (const sensitive of [true, false])
                    plans.push(await sql `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT EXISTS(SELECT 1 FROM resources r WHERE r.parent_id=${ROOT_RESOURCE_ID}
          AND r.status IN ('active','trashed','purged') AND cardinality(public.catalog_guard_scope(r.id,false))=0
          AND (${sensitive} AND r.storage_path='fence-plan-100000' OR NOT ${sensitive} AND lower(r.storage_path)='fence-plan-100000')) AS known`);
                await fs.writeFile(path.join(directory, "fence-100k-plans.json"), JSON.stringify(plans, null, 2));
                const text = JSON.stringify(plans);
                expect(text).toContain("resources_storage_path_key");
                expect(text).toContain("resources_lower_storage_path_idx");
                expect(text).not.toContain('"Node Type":"Seq Scan"');
                throw Error("rollback-fence-plan-fixture");
            }).catch((error: unknown) => expect(String(error)).toContain("rollback-fence-plan-fixture"));
            checks.push("100k synthetic outside siblings: exact/folded storage path index scans, no resource Seq Scan; catalog-only benchmark transaction rolled back");
        }
        const inspected = await adb.transaction(sql => inspectJournal(sql));
        expect(inspected.activeRuntimeRoots).toBe("2");
        expect(() => assertUnregisteredRecovery(inspected)).toThrow("backend reconciliation");
        await expect(adb.transaction(sql => sql.unsafe(down))).rejects.toThrow("explicit retirement");
        await adb.transaction(async (sql) => { await sql.unsafe("DROP FUNCTION catalog_guard_backend_uncertain(uuid,uuid)"); await expect(inspectJournal(sql)).rejects.toThrow("incomplete ACTIVE deployment"); throw Error("rollback-shape-probe"); }).catch((e: unknown) => expect(String(e)).toContain("rollback-shape-probe"));
        for (const broken of ["DROP FUNCTION outside_folder_commit(uuid,jsonb)", "ALTER TABLE resources DISABLE TRIGGER outside_folder_pending_identity_guard", "ALTER TABLE operation_journal DISABLE TRIGGER outside_folder_original_guard"]) {
            await adb.transaction(async (sql) => { await sql.unsafe(broken); await expect(inspectJournal(sql)).rejects.toThrow(/ACTIVE deployment/); throw Error("rollback-shape-probe"); }).catch((e: unknown) => expect(String(e)).toContain("rollback-shape-probe"));
        }
        await fs.writeFile(credential, "changed-generation");
        await expect(active.scope(required(roots[0]))).rejects.toMatchObject({ code: "backend_generation_changed" });
        const closed = await adb.withSql(sql => sql<{
            namespace_state: string;
            epoch: string;
            binding_version: string;
            published_seq: string;
        }[]> `SELECT namespace_state,epoch,binding_version,published_seq::text FROM sync_root_clock ORDER BY root_id`);
        expect(closed.every(c => c.namespace_state === "BACKEND_UNCERTAIN")).toBe(true);
        for (const c of closed)
            expect(activeRoots.some(r => r.epoch === c.epoch && r.bindingVersion !== c.binding_version)).toBe(true);
        expect((await fetch(origin + "/sync/v1/roots/" + required(roots[0]) + "/capabilities", { headers: { Authorization: "Bearer " + windows.token } })).status).toBe(409);
        checks.push("coherent ACTIVE metadata retained; current registered-root restore/downgrade blocked; missing helper fails closed; changed actual credential closes both roots atomically per root, binding rotates and epoch/history/result retained, no legacy404 fallback");
        passed = true;
        await fs.writeFile(path.join(directory, "result.json"), JSON.stringify({ passed, batches, backend: sftp ? "sftp" : "local", checks, negatives, roots, receipts, closed }, null, 2));
    }
    finally {
        await app.close();
        await runtime?.close();
        await writerDb?.close();
        await runtimeDb?.close();
        await db?.close();
        await raw.close();
        if (!retainedForHandoff && passed) {
            await admin.withSql(sql => sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
            for (const role of [rt, wr, ow])
                await admin.withSql(sql => sql.unsafe(`DROP ROLE IF EXISTS ${role}`));
        }
        await admin.close();
        if (sftp && !retainedForHandoff && passed) {
            const c = JSON.parse((await exec("docker", ["inspect", sftp.containerId], { windowsHide: true })).stdout) as {
                Id: string;
                Created: string; Image: string; Mounts: { Type: string; Name: string; Destination: string }[];
                Config: {
                    Labels: Record<string, string>;
                };
            }[];
            if (c[0]?.Id !== sftp.containerId || required(c[0]).Config.Labels[sftp.ownership?.label ?? "exocortex.sync-performance.run"] !== sftp.runId || !/^active_[a-f0-9]{32}$/.test(name) || sftp.storage.root !== "/data"
                || sftp.ownership && (c[0].Created !== sftp.ownership.created || c[0].Image !== sftp.ownership.image
                    || c[0].Mounts.filter(m => m.Type === "volume" && m.Name === sftp.ownership?.volume && m.Destination === "/home/qa/data").length !== 1))
                required(undefined);
            await exec("docker", ["exec", sftp.containerId, "rm", "-rf", "--", "/home/qa/data/" + name], { windowsHide: true });
        }
        await fs.writeFile(path.join(directory, retainedForHandoff ? "handoff-retained.json" : "cleanup.json"), JSON.stringify({ passed, checks, negatives, generatedDatabase: name, generatedRoles: [rt, wr, ow], cleanupComplete: !retainedForHandoff && passed, retainedForHandoff }, null, 2));
    }
}, 120000);
