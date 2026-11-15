export interface GuardedRuntimeRoot {
  readonly rootId: string; readonly epoch: string; readonly bindingVersion: string;
  readonly guardRevision: string; readonly activationReceiptSha256: string;
}
export interface GuardedRuntimeManifest {
  readonly schema: "saturn.guarded-runtime.v1" | "saturn.guarded-runtime.v2" | "saturn.guarded-runtime.v3";
  readonly extensions?: { readonly features: readonly string[]; readonly payloadDirectory?:string; readonly verifier: { readonly url: string; readonly tokenFile: string; readonly registryDirectory: string } | null };
  readonly serverIdentity: string; readonly policyVersion: string;
  readonly qualificationReceiptFile: string; readonly qualificationReceiptSha256: string;
  readonly writerDatabaseUrlFile: string; readonly cursorKeyFile: string; readonly cursorKeyId: string;
  readonly maximumFileBytes: string;
  readonly roles: { readonly runtimeRole: string; readonly writerLogin: string; readonly writerOwner: string; readonly migratorRole: string };
  readonly approvedFunctions: readonly { readonly identity: string; readonly sourceSha256: string }[];
  readonly backend: {
    readonly kind?: "sftp" | "local";
    readonly identity: string; readonly profileId: string; readonly profileRevision: number;
    readonly generation: string; readonly fenceReceiptFile: string; readonly fenceReceiptSha256: string;
    readonly caseSensitive: boolean;
  };
  readonly roots: readonly GuardedRuntimeRoot[];
}
export class GuardedRuntimeError extends Error {
  constructor(readonly code: "invalid_manifest" | "deployment_unqualified" | "backend_generation_changed" | "root_unqualified") { super(code); }
}
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const SHA = /^[a-f\d]{64}$/;
const ROLE = /^[a-z_][a-z\d_]{0,62}$/;
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !(k in v))) throw new GuardedRuntimeError("invalid_manifest");
  return v as Record<string, unknown>;
}
function text(v: unknown, pattern: RegExp, maximum = 4096): string {
  if (typeof v !== "string" || v.length > maximum || !pattern.test(v)) throw new GuardedRuntimeError("invalid_manifest"); return v;
}
const identifier = /^[A-Za-z\d._:-]{1,128}$/;
// eslint-disable-next-line no-control-regex -- Protected file identifiers must reject every control byte.
const file = /^(?:[A-Za-z]:[\\/]|\/)[^\x00-\x1f]+$/;
export function parseGuardedRuntimeManifest(value: unknown,options:{allowEmptyRoots?:boolean}={}): GuardedRuntimeManifest {
  const v3 = !!value && typeof value === "object" && "schema" in value && value.schema === "saturn.guarded-runtime.v3";
  const v = record(value, ["schema", "serverIdentity", "policyVersion", "qualificationReceiptFile", "qualificationReceiptSha256", "writerDatabaseUrlFile", "cursorKeyFile", "cursorKeyId", "maximumFileBytes", "roles", "approvedFunctions", "backend", "roots", ...(v3 ? ["extensions"] : [])]);
  const schema = v["schema"];
  if (schema !== "saturn.guarded-runtime.v1" && schema !== "saturn.guarded-runtime.v2" && schema !== "saturn.guarded-runtime.v3") throw new GuardedRuntimeError("invalid_manifest");
  const smallBatches = schema !== "saturn.guarded-runtime.v1";
  let extensions: GuardedRuntimeManifest["extensions"];
  if (v3) {
    const rawExtensions=v['extensions'];
    const hasPayload=!!rawExtensions&&typeof rawExtensions==='object'&&Object.hasOwn(rawExtensions,'payloadDirectory');
    const e = record(rawExtensions, ["features", "verifier",...(hasPayload?['payloadDirectory']:[])]);
    const allowed = ["changes-wait-v1", "folder-batch-v1", "namespace-mutations-v1", "stream-upload-v1", "metadata-gzip-v1", "clone-content-v1", "scale-transfer-v2", "small-execution-job-v1"];
    if (!Array.isArray(e["features"]) || e["features"].some(f => typeof f !== "string" || !allowed.includes(f)) || new Set(e["features"]).size !== e["features"].length) throw new GuardedRuntimeError("invalid_manifest");
    let verifier: NonNullable<GuardedRuntimeManifest["extensions"]>["verifier"] = null;
    if (e["verifier"] !== null) { const config = record(e["verifier"], ["url", "tokenFile", "registryDirectory"]); verifier = { url: text(config["url"], /^https?:\/\/[^\s]+$/, 2048), tokenFile: text(config["tokenFile"], file), registryDirectory:text(config["registryDirectory"],file) }; }
    extensions = Object.freeze({ features: Object.freeze(e["features"] as string[]), verifier,...(hasPayload?{payloadDirectory:text(e['payloadDirectory'],file)}:{}) });
  }
  const roles = record(v["roles"], ["runtimeRole", "writerLogin", "writerOwner", "migratorRole"]);
  const names = ["runtimeRole", "writerLogin", "writerOwner", "migratorRole"] as const;
  const parsedRoles = Object.fromEntries(names.map(k => [k, text(roles[k], ROLE, 63)])) as GuardedRuntimeManifest["roles"];
  if (new Set(Object.values(parsedRoles)).size !== 4) throw new GuardedRuntimeError("invalid_manifest");
  const identities = ["catalog_folder_command(text,jsonb,jsonb)", "catalog_upload_command(text,jsonb,jsonb,jsonb)", "catalog_guard_upgrade_file(uuid)", "catalog_folder_v2_command(text,jsonb,jsonb,jsonb)", "catalog_guard_backend_uncertain(uuid,uuid)", "outside_folder_commit(uuid,jsonb)"];
  if (smallBatches) identities.push("sync_small_batch_command(text,jsonb,jsonb,jsonb)");
  if (v3) identities.push("sync_backend_command(text,jsonb,jsonb)", "sync_namespace_command(text,jsonb,jsonb,jsonb)", "sync_stream_command(text,jsonb,jsonb,jsonb)", "sync_retention_command(uuid,jsonb)");
  if (!Array.isArray(v["approvedFunctions"]) || v["approvedFunctions"].length !== identities.length) throw new GuardedRuntimeError("invalid_manifest");
  const approvedFunctions = v["approvedFunctions"].map((item: unknown) => {
    const p = record(item, ["identity", "sourceSha256"]);
    if (!identities.some(identity => "public." + identity === p["identity"])) throw new GuardedRuntimeError("invalid_manifest");
    return { identity: p["identity"] as string, sourceSha256: text(p["sourceSha256"], SHA, 64) };
  });
  if (new Set(approvedFunctions.map(p => p.identity)).size !== identities.length) throw new GuardedRuntimeError("invalid_manifest");
  const hasBackendKind = !!v["backend"] && typeof v["backend"] === "object" && Object.hasOwn(v["backend"], "kind");
  const b = record(v["backend"], ["identity", "profileId", "profileRevision", "generation", "fenceReceiptFile", "fenceReceiptSha256", "caseSensitive", ...(hasBackendKind ? ["kind"] : [])]);
  if (hasBackendKind && b["kind"] !== "sftp" && b["kind"] !== "local") throw new GuardedRuntimeError("invalid_manifest");
  if (!Number.isSafeInteger(b["profileRevision"]) || Number(b["profileRevision"]) < 1 || typeof b["caseSensitive"] !== "boolean") throw new GuardedRuntimeError("invalid_manifest");
  const backend = { ...(hasBackendKind ? { kind: b["kind"] as "sftp" | "local" } : {}), identity: text(b["identity"], identifier, 128), profileId: text(b["profileId"], identifier, 128), profileRevision: Number(b["profileRevision"]), generation: text(b["generation"], UUID, 36), fenceReceiptFile: text(b["fenceReceiptFile"], file), fenceReceiptSha256: text(b["fenceReceiptSha256"], SHA, 64), caseSensitive: b["caseSensitive"] };
  if (!Array.isArray(v["roots"]) || v["roots"].length < (v3&&options.allowEmptyRoots?0:1) || v["roots"].length > 16) throw new GuardedRuntimeError("invalid_manifest");
  const roots = v["roots"].map((item: unknown) => { const r = record(item, ["rootId", "epoch", "bindingVersion", "guardRevision", "activationReceiptSha256"]); return { rootId: text(r["rootId"], UUID, 36), epoch: text(r["epoch"], UUID, 36), bindingVersion: text(r["bindingVersion"], UUID, 36), guardRevision: text(r["guardRevision"], UUID, 36), activationReceiptSha256: text(r["activationReceiptSha256"], SHA, 64) }; });
  if (new Set(roots.map(r => r.rootId)).size !== roots.length) throw new GuardedRuntimeError("invalid_manifest");
  const maximumFileBytes = text(v["maximumFileBytes"], /^[1-9]\d{0,15}$/, 16);
  const scaled=extensions?.features.includes('scale-transfer-v2');
  if(extensions?.features.includes('small-execution-job-v1')&&!scaled)throw new GuardedRuntimeError('invalid_manifest');
  if(scaled&&(!extensions?.features.includes('stream-upload-v1')||!extensions.payloadDirectory))throw new GuardedRuntimeError('invalid_manifest');
  if (BigInt(maximumFileBytes) > (scaled?9007199254740991n:1073741824n)) throw new GuardedRuntimeError("invalid_manifest");
  return Object.freeze({ schema, ...(extensions ? { extensions } : {}), serverIdentity: text(v["serverIdentity"], UUID, 36), policyVersion: text(v["policyVersion"], identifier, 128), qualificationReceiptFile: text(v["qualificationReceiptFile"], file), qualificationReceiptSha256: text(v["qualificationReceiptSha256"], SHA, 64), writerDatabaseUrlFile: text(v["writerDatabaseUrlFile"], file), cursorKeyFile: text(v["cursorKeyFile"], file), cursorKeyId: text(v["cursorKeyId"], identifier, 32), maximumFileBytes, roles: Object.freeze(parsedRoles), approvedFunctions: Object.freeze(approvedFunctions.map(x => Object.freeze(x))), backend: Object.freeze(backend), roots: Object.freeze(roots.map(x => Object.freeze(x))) });
}

/** An offline proof bound by digest to this deployment and every ACTIVE root.
 * v2 qualifies transport availability; it does not assert client performance. */
export function requireGuardedRuntimeQualification(q: Record<string, unknown>, manifest: GuardedRuntimeManifest, functionsSha256: string): void {
  if (manifest.schema === "saturn.guarded-runtime.v3") {
    if (q["schema"] !== "saturn.guarded-qualification.v3" || q["coverage"] !== "namespace-mutations-v1"
      || q["approvedFunctionsSha256"] !== functionsSha256 || q["supportedWritersVerified"] !== true || q["unsupportedWritersBlockedBeforeIo"] !== true
      || q["privateLifecycleVerified"] !== true || q["singleBackendWriterVerified"] !== true || q["handoffVerified"] !== true
      || q["smallBatchTransport"] !== "saturn.small-file-batch.v1" || JSON.stringify(q["features"]) !== JSON.stringify(manifest.extensions?.features)) throw new GuardedRuntimeError("deployment_unqualified");
    return;
  }
  const batches = manifest.schema === "saturn.guarded-runtime.v2";
  if (q["schema"] !== (batches ? "saturn.guarded-qualification.v2" : "saturn.guarded-qualification.v1")
    || q["coverage"] !== "append-only-directories/file-cas" || q["approvedFunctionsSha256"] !== functionsSha256
    || q["supportedWritersVerified"] !== true || q["unsupportedWritersBlockedBeforeIo"] !== true || q["privateLifecycleVerified"] !== true
    || batches && q["smallBatchTransport"] !== "saturn.small-file-batch.v1") throw new GuardedRuntimeError("deployment_unqualified");
}
