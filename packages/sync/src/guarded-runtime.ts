import { requireDefined } from "../../contracts/src/require-defined.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { Database } from "@saturn/database";
import { qualifyCatalogDatabaseRoles } from "../../database/src/catalog-role-qualification.js";
import { FileService, PostgresFileRepository } from "@saturn/file-core";
import type { FileServiceOptions } from "../../file-core/src/file.service.js";
import { CatalogFolderAuthorityIssuer, type CatalogFolderAuthority } from "../../file-core/src/catalog-folder-authority.js";
import { PostgresCatalogMutationGuard, assertGuardedNamespaceAdmission, type GuardedNamespaceBinding } from "../../file-core/src/catalog-guard-admission.js";
import { LegacyStorageFence, PostgresLegacyStoragePolicy } from "../../file-core/src/legacy-storage-fence.js";
import { CatalogUploadDatabaseCoordinator } from "../../file-core/src/catalog-upload-database.js";
import { CatalogFolderV2DatabaseCoordinator } from "../../file-core/src/catalog-folder-v2-database.js";
import { CatalogRootAdmission } from "../../file-core/src/catalog-root-admission.js";
import { CatalogNamespaceMutations } from "../../file-core/src/catalog-namespace-mutations.js";
import { CatalogStreamUpload } from "../../file-core/src/catalog-stream-upload.js";
import { CatalogPlutoRetention } from "../../file-core/src/catalog-pluto-retention.js";
import { DurableBackendExecutor, BackendExecutorError, type BackendExecutorIdentity } from "../../storage/src/durable-backend-executor.js";
import { BackendPayloadStore } from "../../storage/src/backend-payload-store.js";
import { StorageVerifierClient } from "../../storage/src/storage-verifier.client.js";
import { StorageVerifierRegistry, type VerifierObject } from "../../storage/src/storage-verifier-registry.js";
import type { PreparedCatalogUpload } from "../../file-core/src/catalog-upload-database.js";
import type { IntegrityScrubOptions,ScrubVersion } from "../../protection/src/integrity-scrub.service.js";
import type { SyncMutationInput } from "../../contracts/src/sync-extensions.js";
import { SYNC_EXTENSION_REVISIONS, parseSyncNamespacePolicy, type SyncNamespacePolicy, type SyncCapabilityExtensions } from "../../contracts/src/sync-extensions.js";
import type { StorageVerifyRequest } from "../../contracts/src/storage-verifier.js";
import { SmallBatchRegistry } from "../../file-core/src/small-batch-registry.js";
import { SMALL_BATCH_SCHEMA, SMALL_BATCH_MAX_ITEMS, SMALL_BATCH_MAX_FILE_BYTES, SMALL_BATCH_MAX_DATA_BYTES, SMALL_BATCH_MAX_MANIFEST_BYTES } from "../../contracts/src/sync-small-batch.js";
import { CatalogFolderError } from "../../file-core/src/catalog-folder-intent.js";
import type { StorageAdapter, RuntimeStorageManager, ActiveStorageProfile, StorageReadOptions, StorageWriteOptions, StorageRenameGroupMember } from "@saturn/storage";
import type { SyncRootBinding } from "../../contracts/src/sync-protocol.js";
import { DeviceService } from "./device.service.js";
import { PostgresDeviceRepository } from "./postgres-device.repository.js";
import type { DeviceOptions } from "./types.js";
import type { OwnerSession, SessionValidationInput } from "@saturn/auth";
import { GuardedOutsideFolderService, type GuardedOwnerInput } from "./guarded-outside-folder.js";
import { PostgresSyncSnapshotStage } from "./sync-snapshot-stage.js";
import { PostgresSyncSnapshotReader } from "./sync-snapshot-read.js";
import { collectExpiredSyncSnapshots } from "./sync-snapshot-maintenance.js";
import { parseGuardedRuntimeManifest, requireGuardedRuntimeQualification, GuardedRuntimeError, type GuardedRuntimeManifest } from "./guarded-runtime-manifest.js";
import { parseGuardedBackendFence } from "./guarded-backend-fence.js";
import { createGuardedBackendCommand } from "./guarded-backend-command.js";
export { createGuardedBackendCommand } from "./guarded-backend-command.js";

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GuardedRuntimeError("deployment_unqualified");
  return value as Record<string, unknown>;
}
async function boundedFile(file: string, maximum: number): Promise<Buffer> {
  if (!path.isAbsolute(file)) throw new GuardedRuntimeError("deployment_unqualified");
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) throw new GuardedRuntimeError("deployment_unqualified");
  // Protected operator-owned deployment files, never provisioned through HTTP.
  const h = await fs.open(file, "r");
  try {
    const bytes = Buffer.alloc(maximum + 1), read = await h.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > maximum || read.bytesRead < 1) throw new GuardedRuntimeError("deployment_unqualified");
    return bytes.subarray(0, read.bytesRead);
  } finally { await h.close(); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value);
}
/** Fingerprint of the actual adapter configuration, including credential-file
 * identity but never its contents. Credential bytes have an independent digest. */
export function guardedStorageConfigSha256(profile: ActiveStorageProfile): string { return sha(canonical(profile.config)); }
export function guardedApprovedFunctionsSha256(functions: GuardedRuntimeManifest["approvedFunctions"]): string { return sha(canonical(functions)); }
export interface GuardedRuntimeScope {
  readonly binding: SyncRootBinding; readonly guard: GuardedNamespaceBinding;
  readonly authority: CatalogFolderAuthorityIssuer; readonly files: FileService;
  readonly stage: PostgresSyncSnapshotStage; readonly reader: PostgresSyncSnapshotReader;
  readonly admission: CatalogRootAdmission;
  readonly batches?: SmallBatchRegistry;
  readonly extensions?: readonly string[];
  readonly namespace?: SyncNamespacePolicy;
  readonly mutations?: CatalogNamespaceMutations;
  readonly streams?: CatalogStreamUpload;
  /** Old parent-only fixture route is never usable in an ACTIVE runtime. */
  readonly ensureFolder: (_request: unknown, _proof: CatalogFolderAuthority) => Promise<never>;
}
export interface GuardedRuntimeOptions {
  readonly database: Database; readonly storage: RuntimeStorageManager; readonly manifestFile?: string;
  readonly onBackendOwner?: (identity: BackendExecutorIdentity, state: 'ACTIVE' | 'STOPPED') => Promise<void>;
  readonly files?: Pick<FileServiceOptions, "uploadMaxBytes" | "uploadChunkMaxBytes" | "uploadIncompleteTtlMs" | "trashRetentionMs" | "auditSink">;
  readonly device: { readonly pepper: string; readonly options: DeviceOptions };
  readonly validateOwnerSession?: (input: SessionValidationInput) => Promise<OwnerSession>;
}

/** Modern view exists only inside this qualified factory; no raw adapter is
 * returned to a controller or worker. Every physical call rechecks generation.
 * Closing is owned by the runtime, not a request-scoped FileService. */
export class BackendCheckedStorage implements StorageAdapter {
  constructor(private readonly raw: StorageAdapter, private readonly check: () => Promise<void>) {}
  async assertReady(): Promise<void> { await this.check(); await this.raw.assertReady?.(); }
  async stat(p: string) { await this.check(); return this.raw.stat(p); }
  async list(p: string, cursor: string | undefined, limit: number) { await this.check(); return this.raw.list(p, cursor, limit); }
  async openRead(p: string, options?: StorageReadOptions) { await this.check(); return this.raw.openRead(p, options); }
  async exists(p: string) { await this.check(); return this.raw.exists(p); }
  async statFs() { await this.check(); return this.raw.statFs(); }
  async write(p: string, source: Readable, options: StorageWriteOptions) { await this.check(); return this.raw.write(p, source, options); }
  async supportsWriteOnce():Promise<boolean>{
    return typeof this.raw.writeOnce==='function'&&typeof this.raw.supportsWriteOnce==='function'&&await this.raw.supportsWriteOnce();
  }
  async writeOnce(taskId:string,p:string,bytes:Buffer,options:StorageWriteOptions):Promise<number>{
    await this.check();
    if(!this.raw.writeOnce||!await this.supportsWriteOnce())throw new BackendExecutorError('unsupported');
    return this.raw.writeOnce(taskId,p,bytes,options);
  }
  async supportsWriteVerifiedOnce():Promise<boolean>{
    return typeof this.raw.writeVerifiedOnce==='function'&&typeof this.raw.supportsWriteVerifiedOnce==='function'&&await this.raw.supportsWriteVerifiedOnce();
  }
  async writeVerifiedOnce(taskId:string,p:string,bytes:Buffer){
    await this.check();
    if(!this.raw.writeVerifiedOnce||!await this.supportsWriteVerifiedOnce())throw new BackendExecutorError('unsupported');
    return this.raw.writeVerifiedOnce(taskId,p,bytes);
  }
  async truncate(p: string, n: number) { await this.check(); return this.raw.truncate(p, n); }
  async mkdir(p: string) { await this.check(); return this.raw.mkdir(p); }
  async rename(a: string, b: string) { await this.check(); return this.raw.rename(a, b); }
  async supportsRenameGroupOnce():Promise<boolean>{
    return typeof this.raw.renameGroupOnce==='function'&&typeof this.raw.supportsRenameGroupOnce==='function'&&await this.raw.supportsRenameGroupOnce();
  }
  async renameGroupOnce(taskId:string,members:readonly StorageRenameGroupMember[]):Promise<void>{
    await this.check();
    if(!this.raw.renameGroupOnce||!await this.supportsRenameGroupOnce())throw new BackendExecutorError('unsupported');
    return this.raw.renameGroupOnce(taskId,members);
  }
  async copy(a: string, b: string) { await this.check(); return this.raw.copy(a, b); }
  async delete(p: string) { await this.check(); return this.raw.delete(p); }
  async close() { /* shared runtime owns the underlying adapter */ }
}
class LegacyProfileStorage extends LegacyStorageFence {
  constructor(private readonly manager: RuntimeStorageManager, private readonly admission: PostgresLegacyStoragePolicy, effects?: StorageAdapter) { super(effects ?? manager, admission,!!effects); }
  refresh(): Promise<void> { return this.admission.assertBackend(); }
  current(): ActiveStorageProfile { return this.manager.current(); }
}

/** Ordinary API and worker composition. Registered roots without the complete
 * operator manifest refuse startup rather than obtaining an unfenced legacy
 * adapter. No migration, enrollment, role grants or credential rotation occurs. */
export class GuardedRuntime {
  #legacyStorage: StorageAdapter & { refresh(): Promise<void>; current(): ActiveStorageProfile }; #legacyFiles: FileService;
  #devices: DeviceService;
  get legacyStorage(): StorageAdapter { return this.#legacyStorage; }
  get catalogStorage() { return this.#legacyStorage; }
  get legacyFiles(): FileService { return this.#legacyFiles; }
  get devices(): DeviceService { return this.#devices; }
  ownerAction<T>(input: GuardedOwnerInput, action: () => Promise<T>, key?: string): Promise<T> {
    return this.#legacyFiles instanceof GuardedOutsideFolderService ? this.#legacyFiles.ownerAction(input, action, key) : action();
  }
  readonly #scopes = new Map<string, GuardedRuntimeScope>();
  #writer: Database | undefined; #manifest: GuardedRuntimeManifest | undefined;
  #backendExecutor: DurableBackendExecutor | undefined;
  #retention: CatalogPlutoRetention | undefined;
  #backendCheck: () => Promise<void> = () => Promise.resolve();
  #closed = false;
  readonly #catalogAdmission = new CatalogRootAdmission();
  private constructor(private readonly input: GuardedRuntimeOptions, guardedSchema: boolean) {
    this.#legacyStorage = input.storage;
    this.#legacyFiles = new FileService(new PostgresFileRepository(input.database), this.legacyStorage, {
      ...input.files, ...(guardedSchema ? { catalogMutationGuard: new PostgresCatalogMutationGuard(input.database) } : {}),
    });
    this.#devices = new DeviceService({ repository: new PostgresDeviceRepository(input.database), files: this.legacyFiles,
      pepper: input.device.pepper, options: input.device.options, ...(input.files?.auditSink ? { audit: input.files.auditSink } : {}) });
  }
  static async create(input: GuardedRuntimeOptions): Promise<GuardedRuntime> {
    const schema = (await input.database.withSql(sql => sql<{ guarded: boolean }[]>`SELECT to_regclass('public.catalog_guard_roots') IS NOT NULL AS guarded`))[0]?.guarded === true;
    const roots = schema ? await input.database.withSql(sql => sql<{ root_id: string }[]>`SELECT root_id FROM public.catalog_guard_roots ORDER BY root_id LIMIT 17`) : [];
    if (roots.length > 16 || (!input.manifestFile && roots.length !== 0) || (input.manifestFile && !schema)) throw new GuardedRuntimeError("deployment_unqualified");
    const runtime = new GuardedRuntime(input, schema);
    if (!input.manifestFile) return runtime;
    try { await runtime.#qualify(input.manifestFile, roots.map(r => r.root_id)); return runtime; }
    catch (e) {
      await (runtime.#backendExecutor ? runtime.#backendExecutor.close() : input.storage.close()).catch(() => undefined);
      await runtime.#writer?.close(); throw e;
    }
  }
  async #qualify(file: string, rootIds: readonly string[]): Promise<void> {
    const manifest = parseGuardedRuntimeManifest(JSON.parse((await boundedFile(file, 65536)).toString("utf8")));
    if (manifest.roots.length !== rootIds.length || manifest.roots.some(r => !rootIds.includes(r.rootId))) throw new GuardedRuntimeError("deployment_unqualified");
    const qualificationBytes = await boundedFile(manifest.qualificationReceiptFile, 65536), q = object(JSON.parse(qualificationBytes.toString("utf8")));
    if (sha(qualificationBytes) !== manifest.qualificationReceiptSha256) throw new GuardedRuntimeError("deployment_unqualified");
    requireGuardedRuntimeQualification(q, manifest, guardedApprovedFunctionsSha256(manifest.approvedFunctions));
    const fenceBytes = await boundedFile(manifest.backend.fenceReceiptFile, 16384);
    if (sha(fenceBytes) !== manifest.backend.fenceReceiptSha256) throw new GuardedRuntimeError("deployment_unqualified");
    const fence = parseGuardedBackendFence(JSON.parse(fenceBytes.toString("utf8")), manifest);
    const writerUrl = (await boundedFile(manifest.writerDatabaseUrlFile, 8192)).toString("utf8").trim();
    this.#writer = new Database(writerUrl, { max: 4, maintenanceBarrier: true, maintenanceScope: this.input.database });
    const policy = { ...manifest.roles, approvedFunctions: manifest.approvedFunctions };
    await qualifyCatalogDatabaseRoles(this.input.database, { ...policy, connection: "runtime" });
    await qualifyCatalogDatabaseRoles(this.#writer, { ...policy, connection: "writer" });
    const current = await this.input.database.withSql(sql => sql<{ root_id: string; epoch: string; binding_version: string; guard_revision: string; valid: boolean }[]>`
      SELECT g.root_id,c.epoch,c.binding_version,g.guard_revision,
        c.namespace_state='ACTIVE' AND public.catalog_guard_active_valid(g)
        AND g.runtime_role=${manifest.roles.runtimeRole} AND g.writer_login=${manifest.roles.writerLogin} AND g.writer_owner=${manifest.roles.writerOwner}
        AND g.backend_identity=${manifest.backend.identity} AND g.active_runtime->>'serverIdentity'=${manifest.serverIdentity}
        AND g.active_runtime->>'policyVersion'=${manifest.policyVersion} AND g.active_runtime->>'backendGeneration'=${manifest.backend.generation}
        AND g.active_runtime->>'backendProfileId'=${manifest.backend.profileId} AND (g.active_runtime->>'backendProfileRevision')::numeric=${manifest.backend.profileRevision}
        AND g.active_runtime->>'fenceReceiptSha256'=${manifest.backend.fenceReceiptSha256}
        AND g.active_runtime->>'qualificationReceiptSha256'=${manifest.qualificationReceiptSha256}
        AND (g.active_runtime->>'maximumFileBytes')::numeric>=${manifest.maximumFileBytes}::numeric AS valid
      FROM public.catalog_guard_roots g JOIN public.sync_root_clock c ON c.root_id=g.root_id ORDER BY g.root_id LIMIT 17`);
    if (current.length !== manifest.roots.length || current.some(r => !r.valid || !manifest.roots.some(m => m.rootId === r.root_id && m.epoch === r.epoch && m.bindingVersion === r.binding_version && m.guardRevision === r.guard_revision)))
      throw new GuardedRuntimeError("deployment_unqualified");
    const activation = await this.input.database.withSql(sql => sql<{ root_id: string; sha: string }[]>`SELECT root_id,active_runtime->>'activationReceiptSha256' AS sha FROM public.catalog_guard_roots ORDER BY root_id LIMIT 17`);
    if (activation.some(r => !manifest.roots.some(m => m.rootId === r.root_id && m.activationReceiptSha256 === r.sha))) throw new GuardedRuntimeError("deployment_unqualified");
    const writer = this.#writer;
    let broken = false, closing: Promise<void> | undefined;
    const closeAdmission = async (): Promise<never> => {
      broken = true;
      closing ??= Promise.all(manifest.roots.map(r => writer.withSql(sql => sql`SELECT public.catalog_guard_backend_uncertain(${r.rootId}::uuid,${manifest.backend.generation}::uuid)`)))
        .then(() => undefined);
      await closing.catch(() => undefined); // failure still refuses this process; it never permits fallback or retries effects
      throw new GuardedRuntimeError("backend_generation_changed");
    };
    const profile = async (p: ActiveStorageProfile): Promise<void> => {
      if (broken) return closeAdmission();
      try {
        if (p.profileId !== manifest.backend.profileId || p.revision !== manifest.backend.profileRevision || guardedStorageConfigSha256(p) !== fence.storageConfigSha256) return await closeAdmission();
        if (p.config.backend === "local") {
          if (manifest.backend.kind !== "local" || fence.schema !== "saturn.backend-fence.local.v1") return await closeAdmission();
          const custody = await this.input.storage.localCustody();
          if (custody.sha256 !== fence.localCustodySha256 || custody.receipt.backendIdentity !== manifest.backend.identity || custody.receipt.generation !== manifest.backend.generation) return await closeAdmission();
          return;
        }
        if (manifest.backend.kind === "local" || fence.schema !== "saturn.backend-fence.v1") return await closeAdmission();
        const credential = p.config.authMode === "password_file" ? p.config.passwordFile : p.config.privateKeyFile;
        if (credential === undefined || sha(await boundedFile(credential, 262144)) !== fence.credentialSha256) return await closeAdmission();
      } catch { return closeAdmission(); }
    };
    this.#backendCheck = async () => { await profile(this.input.storage.current()); await this.input.storage.refresh(); await profile(this.input.storage.current()); };
    await this.input.storage.installProfileGuard(profile);
    await this.#backendCheck();
    if(manifest.extensions)this.input.storage.enableExactPaths();
    const verifierRegistry=manifest.extensions?.verifier?new StorageVerifierRegistry(manifest.extensions.verifier.registryDirectory):undefined;
    await verifierRegistry?.initialize();
    if (manifest.extensions) {
      this.#backendExecutor = new DurableBackendExecutor(this.input.storage, createGuardedBackendCommand(writer), manifest.backend.identity, manifest.backend.generation,268435456,async(identity,state)=>{
        await verifierRegistry?.owner({backendIdentity:identity.backendIdentity,backendGeneration:identity.generation,ownerId:identity.ownerId,fencingToken:identity.fencingToken},state);
        await this.input.onBackendOwner?.(identity,state);
      },{...(manifest.extensions.payloadDirectory?{payloads:new BackendPayloadStore(manifest.extensions.payloadDirectory,manifest.backend.identity,manifest.backend.generation)}:{}),workers:manifest.extensions.features.includes('scale-transfer-v2')?4:1,groupStorageCheck:this.#backendCheck});
      await this.#backendExecutor.start();
      this.#retention = new CatalogPlutoRetention(writer, this.#catalogAdmission, this.#backendExecutor.identity);
    }
    const policyStorage = new PostgresLegacyStoragePolicy(this.input.database, this.#backendCheck, manifest.backend.caseSensitive);
    // Only this one construction supplies the scoped bypass; public legacy services receive the fenced view.
    this.#legacyStorage = new LegacyProfileStorage(this.input.storage, policyStorage, this.#backendExecutor);
    this.#legacyFiles = new GuardedOutsideFolderService(this.input.database, this.#writer, this.legacyStorage,
      { ...this.input.files, catalogMutationGuard: new PostgresCatalogMutationGuard(this.input.database) }, this.input.validateOwnerSession);
    this.#devices = new DeviceService({ repository: new PostgresDeviceRepository(this.input.database), files: this.legacyFiles,
      pepper: this.input.device.pepper, options: this.input.device.options, ...(this.input.files?.auditSink ? { audit: this.input.files.auditSink } : {}) });
    const issuer = new CatalogFolderAuthorityIssuer(this.input.database, { authenticateDevice: a => this.devices.authenticate(a) });
    const modernStorage = new BackendCheckedStorage(this.#backendExecutor ?? this.input.storage, this.#backendCheck);
    const remoteVerifier = manifest.extensions?.verifier ? new StorageVerifierClient({ url: manifest.extensions.verifier.url,
      token: (await boundedFile(manifest.extensions.verifier.tokenFile, 4096)).toString("utf8").trim() }) : undefined;
    const files = new FileService(new PostgresFileRepository(this.input.database), modernStorage, { ...this.input.files,
      uploadMaxBytes: Number(manifest.maximumFileBytes), catalogBackendIdentity: manifest.backend.identity,
      catalogMutationGuard: new PostgresCatalogMutationGuard(this.input.database),
      catalogUploadCoordinator: new CatalogUploadDatabaseCoordinator(writer, issuer, manifest.maximumFileBytes,!!manifest.extensions,manifest.extensions?.features.includes('scale-transfer-v2')),
      catalogFolderV2Coordinator: new CatalogFolderV2DatabaseCoordinator(writer, issuer,!!manifest.extensions),
      catalogRootAdmission: this.#catalogAdmission,
      ...(this.#backendExecutor ? { catalogVerify: async (prepared:PreparedCatalogUpload, relativePath:string, sizeBytes:string, sha256:string, contentVersionId:string) => {
        // An unavailable optional adapter verifier must not consume a backend
        // diagnostic/read lease just to reject. The transfer executor still
        // performs its complete, generation-checked SHA readback fallback.
        if(!remoteVerifier&&!await this.input.storage.supportsVerify())throw new BackendExecutorError('unsupported');
        const current = await requireDefined(this.#backendExecutor).diagnostics() as { state: string; ownerId: string; fencingToken: string };
        if (current.state !== "RUNNING" || !current.ownerId || !current.fencingToken) throw new BackendExecutorError("backend_draining");
        const request: StorageVerifyRequest = { schema: "saturn.storage-verify.v1", requestId: randomUUID(), backendIdentity: manifest.backend.identity,
          backendGeneration: manifest.backend.generation, ownerId: current.ownerId, fencingToken: current.fencingToken, rootId: prepared.input.intent.rootId,
          operationId: prepared.status.session.operationId, intentSha256: prepared.status.session.intentHash, contentVersionId, relativePath,
          sizeBytes, sha256, maximumBytes: sizeBytes, timeoutMs:Math.max(30000,Math.min(86400000,Math.ceil(Number(sizeBytes)/(8*1024*1024))*1000)), requireDurability: "readback" };
        const objects:VerifierObject[]=[{contentVersionId:prepared.execution.versionId,relativePath:prepared.execution.tempPath,sizeBytes:prepared.input.intent.sizeBytes,sha256:prepared.input.intent.sha256}];
        const before=prepared.execution.before;
        if(before?.content_version_id&&before.content_sha256)objects.push({contentVersionId:before.content_version_id,relativePath:prepared.execution.targetPath,sizeBytes:before.size_bytes,sha256:before.content_sha256});
        await requireDefined(this.#backendExecutor).withReadBudget(async()=>{
          if(remoteVerifier&&verifierRegistry){await verifierRegistry.operation(request,objects);await remoteVerifier.verify(request);}
          else await this.input.storage.verify(request);
        });
      } } : {}),
    });
    const cursorBytes = await boundedFile(manifest.cursorKeyFile, 128);
    if (cursorBytes.length < 32 || cursorBytes.length > 64) throw new GuardedRuntimeError("deployment_unqualified");
    const batches = manifest.schema !== "saturn.guarded-runtime.v1" ? new SmallBatchRegistry(writer, issuer) : undefined;
    const mutations = manifest.extensions ? new CatalogNamespaceMutations(writer, issuer, modernStorage, this.#catalogAdmission) : undefined;
    const streams = manifest.extensions ? new CatalogStreamUpload(writer, issuer, modernStorage, files) : undefined;
    for (const r of manifest.roots) {
      const guard = Object.freeze({ rootId: r.rootId, epoch: r.epoch, bindingVersion: r.bindingVersion, guardRevision: r.guardRevision });
      const binding: SyncRootBinding = Object.freeze({ protocol: "neptune-sync/1", descriptor_schema: "saturn.current-namespace.v1", server_identity: manifest.serverIdentity,
        root_id: r.rootId, server_epoch: r.epoch, policy_version: manifest.policyVersion, binding_version: r.bindingVersion });
      const scope = { wire: binding, guard };
      let namespace: SyncNamespacePolicy | undefined;
      let extensions: readonly string[] | undefined;
      if (manifest.extensions) {
        const row = (await this.input.database.withSql(sql => sql<{ codec: string; policy_hash: string; features: string[]; state: string; policy_version: string }[]>`SELECT codec,policy_hash,features,state,policy_version FROM public.sync_root_policy WHERE root_id=${r.rootId}`))[0];
        if (!row || !['ACTIVE','PAUSED'].includes(row.state) || row.policy_version !== manifest.policyVersion) throw new GuardedRuntimeError("root_unqualified");
        namespace = parseSyncNamespacePolicy({ codec: row.codec, policyHash: row.policy_hash });
        extensions = Object.freeze(manifest.extensions.features.filter(feature => row.features.includes(feature)));
      }
      this.#scopes.set(r.rootId, Object.freeze({ binding, guard, authority: issuer, files, admission: this.#catalogAdmission,
        ...(batches ? { batches } : {}),
        ...(namespace && extensions && mutations && streams ? { namespace, extensions, mutations, streams } : {}),
        stage: new PostgresSyncSnapshotStage(this.input.database, issuer, scope),
        reader: new PostgresSyncSnapshotReader(this.input.database, issuer, scope, manifest.cursorKeyId, [{ id: manifest.cursorKeyId, secret: cursorBytes }]),
        ensureFolder: () => Promise.reject(new CatalogFolderError("binding_invalid")),
      }));
    }
    if(this.#legacyFiles instanceof GuardedOutsideFolderService&&manifest.extensions){
      this.#legacyFiles.installNamespaceRuntime(async(rootId,ownerIssuer)=>{
        const scope=await this.scope(rootId);
        return scope?.namespace?{binding:scope.binding,namespace:scope.namespace,mutations:new CatalogNamespaceMutations(writer,ownerIssuer,modernStorage,this.#catalogAdmission)}:undefined;
      });
    }
    this.#manifest = manifest;
  }
  async scope(rootId: string): Promise<GuardedRuntimeScope | undefined> {
    if (this.#closed) throw new GuardedRuntimeError("root_unqualified");
    const scope = this.#scopes.get(rootId);
    if (!scope) return undefined;
    await this.#backendCheck();
    if(scope.namespace){
      const row=(await this.input.database.withSql(sql=>sql<{state:string;codec:string;policy_hash:string}[]>`SELECT state,codec,policy_hash FROM sync_root_policy WHERE root_id=${rootId}`))[0];
      if(!row||!["ACTIVE","PAUSED"].includes(row.state)||row.codec!==scope.namespace.codec||row.policy_hash!==scope.namespace.policyHash)throw new GuardedRuntimeError("root_unqualified");
    }
    // Each actual method rechecks the exact root/current proof inside its SQL transaction.
    return scope;
  }
  async capabilities(rootId: string, authorization: string | undefined) {
    const authenticated = await this.devices.authenticate(authorization), device = authenticated.device;
    if (!["windows_sync", "pluto"].includes(device.deviceKind) || device.syncRootId !== rootId || device.scopeIds.length !== 1 || device.scopeIds[0] !== rootId)
      throw new CatalogFolderError("authority_invalid");
    if (!device.rights.read || !device.rights.write) throw new CatalogFolderError("authorization_changed");
    const scope = await this.scope(rootId), manifest = this.#manifest;
    if (!scope || !manifest) return undefined;
    const proof = await scope.authority.device(authorization, rootId), principal = scope.authority.deviceCredential(proof, rootId);
    try {
      await this.input.database.transaction(async sql => { await assertGuardedNamespaceAdmission(sql, scope.guard); await scope.authority.fingerprint(sql, proof, rootId); });
    } catch (error) {
      // An owned in-flight publication still closes namespace admission. Only
      // its liveness changes the error to retryable; no capability is granted.
      if (error instanceof Error && 'code' in error && error.code === 'reconciliation_required' && scope.streams?.hasPendingCompletion)
        throw Object.assign(new Error('publication_pending'), {code:'publication_pending'});
      throw error;
    }
    return { schema: "saturn.sync-capabilities.v1", binding: scope.binding, device_id: principal.deviceId,
      backend_identity: manifest.backend.identity, qualification_receipt_sha256: manifest.qualificationReceiptSha256,
      coverage: manifest.extensions ? "namespace-mutations-v1" : "append-only-directories/file-cas", features: ["snapshot-v1", "changes-v1", "folder-v2", "catalog-upload-v2", ...(scope.extensions ?? []).filter(feature=>feature!=='small-execution-job-v1')],
      ...(scope.namespace ? { extensions: { revisions: SYNC_EXTENSION_REVISIONS, namespace: scope.namespace,
        minimum_writer: "saturn.namespace-mutation.v1", backend_policy: "managed-exclusive",
        limits: { metadata_items: 500, metadata_bytes: 4194304, long_poll_ms: 25000, gzip_threshold_bytes: 16384, stream_chunk_bytes: 4194304, stream_maximum_chunks: scope.extensions?.includes('scale-transfer-v2')?2147483648:256 } } satisfies SyncCapabilityExtensions } : {}),
      limits: { data_jobs: scope.extensions?.includes('scale-transfer-v2')?8:4, large_jobs: 2, spool_bytes: "1073741824", maximum_file_bytes: manifest.maximumFileBytes } };
  }
  async smallExecutionJobCapabilities(rootId:string,authorization:string|undefined,pipeline=false,singleRequest=false){
    const base=await this.smallBatchCapabilities(rootId,authorization);
    if(!base||!(await this.scope(rootId))?.extensions?.includes('small-execution-job-v1'))return undefined;
    const supported=await this.input.database.withSql(async sql=>(await sql<{present:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_accept_job_v1(jsonb,jsonb)') IS NOT NULL AS present`)[0]?.present===true);
    if(!supported)throw new GuardedRuntimeError('deployment_unqualified');
    if(singleRequest&&!await this.input.database.withSql(async sql=>(await sql<{present:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_job_single_request_v1()') IS NOT NULL AS present`)[0]?.present===true))return undefined;
    if(pipeline&&!await this.input.database.withSql(async sql=>(await sql<{present:boolean}[]>`SELECT to_regprocedure('public.catalog_upload_job_pipeline_v1()') IS NOT NULL AS present`)[0]?.present===true))return undefined;
    return {...base,schema:singleRequest?'saturn.small-execution-job-single-request-capabilities.v1':pipeline?'saturn.small-execution-job-pipeline-capabilities.v1':'saturn.small-execution-job-capabilities.v1',transport:'saturn.small-execution-job.v1',
      limits:{items:16,file_bytes:'262144',data_bytes:'4194304',manifest_bytes:'1048576',...(pipeline?{jobs:2}:{})}};
  }
  async smallBatchCapabilities(rootId: string, authorization: string | undefined) {
    // Preserve the v1 envelope for older clients. The optional transport has
    // its own authenticated probe and exists only in a qualified v2 scope.
    const base = await this.capabilities(rootId, authorization);
    if (!base || !(await this.scope(rootId))?.batches) return undefined;
    return { schema: "saturn.small-file-batch-capabilities.v1", transport: SMALL_BATCH_SCHEMA,
      binding: base.binding, device_id: base.device_id, backend_identity: base.backend_identity,
      qualification_receipt_sha256: base.qualification_receipt_sha256,
      limits: { items: SMALL_BATCH_MAX_ITEMS, file_bytes: String(SMALL_BATCH_MAX_FILE_BYTES),
        data_bytes: String(SMALL_BATCH_MAX_DATA_BYTES), manifest_bytes: String(SMALL_BATCH_MAX_MANIFEST_BYTES) } };
  }
  async assertReady(): Promise<void> {
    if (this.#closed) throw new BackendExecutorError("backend_owner_unavailable");
    await this.#backendCheck();
    await this.#backendExecutor?.assertReady();
  }
  async diagnostics(): Promise<unknown> { return this.#backendExecutor ? this.#backendExecutor.diagnostics() : { mode: "legacy", backendOwner: "process-local" }; }
  async maintainSnapshots(): Promise<void> {
    if (this.#closed) return;
    // Collectors cover the database, not only the issuer's root. Run once,
    // independently of reconciliation/scrub and without physical backend I/O.
    const scope = this.#scopes.values().next().value;
    if (scope) await collectExpiredSyncSnapshots(scope);
  }
  /** Bounded maintenance; publication schedules work in the same SQL commit. */
  async maintainRetention(): Promise<void> {
    if (this.#closed || !this.#retention || !this.#backendExecutor) return;
    await this.#backendCheck();
    const closed=()=>this.#closed;
    for (const root of this.#scopes.keys()) {
      if (closed()) return;
      await this.#retention.tick(root);
      // A reviewed fence may have released only immutable retention deletions.
      // start() still requires the durable STOPPED ownership receipt/state.
      await this.#backendExecutor.start();
    }
  }
  async rootDiagnostics(rootId:string,authorization:string|undefined){
    const authenticated=await this.devices.authenticate(authorization),device=authenticated.device;
    if(device.syncRootId!==rootId||device.scopeIds.length!==1||device.scopeIds[0]!==rootId||!device.rights.read)throw new CatalogFolderError('authority_invalid');
    if(!this.#scopes.has(rootId)||!this.#manifest?.extensions)return undefined;
    const backend=await this.#backendExecutor?.diagnostics();
    return this.input.database.transaction(async sql=>{
      await sql`SET LOCAL statement_timeout='2s'`;
      const root=(await sql`SELECT c.namespace_state,c.published_seq::text,p.state AS policy_state,p.codec FROM sync_root_clock c JOIN sync_root_policy p ON p.root_id=c.root_id WHERE c.root_id=${rootId}`)[0];
      const phases=await sql`SELECT coalesce(namespace_state,upload_effect_state,catalog_effect_state,state) AS phase,count(*)::text AS count,min(created_at) AS oldest FROM operation_journal WHERE sync_root_id=${rootId} AND sync_result IS NULL GROUP BY 1`;
      const streams=(await sql`SELECT count(*)::text AS pending,coalesce(sum(received_size),0)::text AS received_bytes FROM sync_stream_uploads WHERE root_id=${rootId} AND state<>'PUBLISHED'`)[0];
      const uploads=(await sql`SELECT count(*) FILTER(WHERE j.sync_result IS NULL)::text AS pending,
        coalesce(sum(u.received_size) FILTER(WHERE j.sync_result IS NULL),0)::text AS received_bytes,
        count(*) FILTER(WHERE u.actual_sha256 IS NOT NULL AND j.sync_result IS NULL)::text AS verified,
        count(*) FILTER(WHERE j.sync_result->>'status'='PUBLISHED')::text AS published
        FROM operation_journal j JOIN upload_sessions u ON u.id=j.upload_id WHERE j.sync_root_id=${rootId}`)[0];
      const retention=(await sql`SELECT count(*)::text AS retained_versions,coalesce(sum(v.size_bytes),0)::text AS retained_bytes FROM file_versions v JOIN resources r ON r.id=v.resource_id
        WHERE v.id IS DISTINCT FROM r.current_version_id AND v.state IN ('active','error') AND public.catalog_guard_scope(r.id,false)=ARRAY[${rootId}::uuid]`)[0];
      const retentionQueue=(await sql`SELECT count(*) FILTER(WHERE o.state='QUEUED')::text AS pending_deletes,
        coalesce(sum(o.size_bytes) FILTER(WHERE o.state='QUEUED'),0)::text AS pending_delete_bytes,
        count(*) FILTER(WHERE t.state='UNKNOWN')::text AS unknown_deletes,
        (SELECT count(*)::text FROM sync_retention_work WHERE root_id=${rootId}) AS pending_resources
        FROM sync_retention_originals o JOIN sync_backend_tasks t ON t.id=o.task_id WHERE o.root_id=${rootId}`)[0];
      const publicBackend=backend?Object.fromEntries(Object.entries(backend).filter(([key])=>!['ownerId','fencingToken','generation'].includes(key))):undefined;
      return {schema:'saturn.sync-diagnostics.v1',root,phases,streams,uploads,retention,retentionQueue,backend:publicBackend,features:this.#scopes.get(rootId)?.extensions??[],managedExclusive:true};
    });
  }
  get scrubOptions():IntegrityScrubOptions {
    return this.#manifest?.extensions?{maximumBytes:256*1024*1024,maximumMs:10000,quarantine:(row,actualSize)=>this.#scrubMismatch(row,actualSize)}:{};
  }
  async #scrubMismatch(row:ScrubVersion,actualSize:number):Promise<boolean>{
    const roots=await this.input.database.withSql(sql=>sql<{root:string}[]>`SELECT unnest(public.catalog_guard_scope(${row.resource_id}::uuid,false))::text AS root`);
    if(!roots.length)return false;
    if(roots.length!==1)throw new GuardedRuntimeError("root_unqualified");
    const rootId=requireDefined(roots[0]).root,scope=await this.scope(rootId);
    if(!scope?.mutations||!scope.namespace)throw new GuardedRuntimeError("root_unqualified");
    const key="scrub:"+row.id+":"+row.sha256.slice(0,32);
    const old=(await this.input.database.withSql(sql=>sql<{namespace_intent:{input:SyncMutationInput&{kind:"availability"};namespace:SyncNamespacePolicy}}[]>`SELECT namespace_intent FROM operation_journal WHERE idempotency_key=${"namespace:"+key}`))[0];
    let input:SyncMutationInput&{kind:"availability"};
    if(old)input=old.namespace_intent.input;
    else{
      const current=(await this.input.database.withSql(sql=>sql<{metadata_version:string;valid:boolean}[]>`SELECT r.metadata_version,
        EXISTS(SELECT 1 FROM file_versions v WHERE v.id=${row.id} AND v.resource_id=r.id AND v.state='active' AND v.sha256=${row.sha256} AND v.storage_path=${row.storage_path}) AS valid FROM resources r WHERE r.id=${row.resource_id}`))[0];
      if(!current?.valid)return true;
      input={schema:"saturn.namespace-mutation.v1",operationId:randomUUID(),idempotencyKey:key,rootId,epoch:scope.binding.server_epoch,bindingVersion:scope.binding.binding_version,
        expected:{kind:"version",node_id:row.resource_id,version:current.metadata_version},kind:"availability",availability:"UNAVAILABLE",reason:"integrity_scrub",contentVersionId:row.id,sha256:row.sha256};
    }
    await scope.mutations.markUnavailable(input,old?.namespace_intent.namespace??scope.namespace);
    await this.input.files?.auditSink?.write({action:"file.integrity.mismatch",actorType:"worker",actorId:"integrity-scrub",resourceId:row.resource_id,outcome:"failure",correlationId:key,details:{versionId:row.id,actualSize}});
    return true;
  }
  async close(): Promise<void> {
    this.#closed = true; this.#catalogAdmission.close(); await this.#catalogAdmission.drain();
    await Promise.all([...this.#scopes.values()].flatMap(scope => scope.streams ? [scope.streams.close()] : []));
    try{if(this.#backendExecutor)await this.#backendExecutor.close();else await this.input.storage.close();}finally{await this.#writer?.close();}
  }
}
