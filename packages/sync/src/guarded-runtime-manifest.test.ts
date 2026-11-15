import { expect, it } from "vitest";
import { parseGuardedRuntimeManifest, requireGuardedRuntimeQualification } from "./guarded-runtime-manifest.js";
const uuid = "00000000-0000-4000-8000-000000000001", hash = "a".repeat(64);
function valid() {
  return { schema: "saturn.guarded-runtime.v1", serverIdentity: uuid, policyVersion: "v1", qualificationReceiptFile: "/own/q.json", qualificationReceiptSha256: hash,
    writerDatabaseUrlFile: "/own/db.private", cursorKeyFile: "/own/key.private", cursorKeyId: "v1", maximumFileBytes: "1073741824",
    roles: { runtimeRole: "runtime", writerLogin: "writer", writerOwner: "owner", migratorRole: "migrator" },
    approvedFunctions: ["catalog_folder_command(text,jsonb,jsonb)", "catalog_upload_command(text,jsonb,jsonb,jsonb)", "catalog_guard_upgrade_file(uuid)", "catalog_folder_v2_command(text,jsonb,jsonb,jsonb)", "catalog_guard_backend_uncertain(uuid,uuid)", "outside_folder_commit(uuid,jsonb)"].map(identity => ({ identity: "public." + identity, sourceSha256: hash })),
    backend: { identity: "backend", profileId: "bootstrap", profileRevision: 1, generation: uuid, fenceReceiptFile: "/own/fence.json", fenceReceiptSha256: hash, caseSensitive: true },
    roots: [{ rootId: uuid, epoch: uuid, bindingVersion: uuid, guardRevision: uuid, activationReceiptSha256: hash }] };
}
it("accepts only a closed, immutable, explicit opt-in envelope with exact approved functions", () => {
  const m = parseGuardedRuntimeManifest(valid()); expect(m.maximumFileBytes).toBe("1073741824");
  expect(Object.isFrozen(m)).toBe(true); expect(Object.isFrozen(m.roots[0])).toBe(true); expect(Object.isFrozen(m.approvedFunctions[0])).toBe(true);
});
it.each(["0", "01", "1073741825", "9007199254740993", 1024, null])("rejects noncanonical or unqualified maximum %s", maximumFileBytes => {
  expect(() => parseGuardedRuntimeManifest({ ...valid(), maximumFileBytes })).toThrow("invalid_manifest");
});
it.each(["relative", "", "/own/\u0000secret"]) ("rejects unsafe file identity %s", cursorKeyFile => {
  expect(() => parseGuardedRuntimeManifest({ ...valid(), cursorKeyFile })).toThrow("invalid_manifest");
});
it("rejects duplicate roots, excess roots, shared privileged roles and missing or substituted SQL functions", () => {
  const m = valid(); for (const changed of [
    { ...m, roots: [...m.roots, ...m.roots] }, { ...m, roots: Array(17).fill(m.roots[0]) },
    { ...m, roles: { ...m.roles, runtimeRole: m.roles.writerLogin } },
    { ...m, approvedFunctions: m.approvedFunctions.slice(0, -1) },
    { ...m, approvedFunctions: [...m.approvedFunctions.slice(0, -1), { identity: "public.arbitrary_admin()", sourceSha256: hash }] },
    { ...m, approvedFunctions: Array(6).fill(m.approvedFunctions[0]) }, { ...m, rootSecret: "unexpected" },
  ]) expect(() => parseGuardedRuntimeManifest(changed)).toThrow("invalid_manifest");
});
function batchManifest() {
  const m = valid();
  return { ...m, schema: "saturn.guarded-runtime.v2", approvedFunctions: [...m.approvedFunctions,
    { identity: "public.sync_small_batch_command(text,jsonb,jsonb,jsonb)", sourceSha256: hash }] };
}
it('large streams require an explicit persistent staging directory and compatible capability',()=>{
  const base=batchManifest();
  const m={...base,schema:'saturn.guarded-runtime.v3',maximumFileBytes:String(64*1024**3),
    approvedFunctions:[...base.approvedFunctions,...['sync_backend_command(text,jsonb,jsonb)','sync_namespace_command(text,jsonb,jsonb,jsonb)','sync_stream_command(text,jsonb,jsonb,jsonb)','sync_retention_command(uuid,jsonb)'].map(identity=>({identity:'public.'+identity,sourceSha256:hash}))],
    extensions:{features:['stream-upload-v1','scale-transfer-v2'],verifier:null,payloadDirectory:'/durable/payloads'}};
  expect(parseGuardedRuntimeManifest(m).maximumFileBytes).toBe(String(64*1024**3));
  for(const extensions of [{features:m.extensions.features,verifier:null},{...m.extensions,payloadDirectory:'relative'},{...m.extensions,features:['scale-transfer-v2']}])expect(()=>parseGuardedRuntimeManifest({...m,extensions})).toThrow('invalid_manifest');
  expect(()=>parseGuardedRuntimeManifest({...m,maximumFileBytes:'9007199254740992'})).toThrow('invalid_manifest');
});
it("requires exactly seven pinned functions for v2 and retains the six-function v1 envelope", () => {
  const m = batchManifest(); expect(parseGuardedRuntimeManifest(m).schema).toBe("saturn.guarded-runtime.v2");
  for (const changed of [
    { ...m, schema: "saturn.guarded-runtime.v1" }, { ...valid(), schema: m.schema },
    { ...m, approvedFunctions: [...m.approvedFunctions.slice(0, -1), m.approvedFunctions[0]] },
    { ...m, approvedFunctions: [...m.approvedFunctions, m.approvedFunctions[0]] },
    { ...m, schema: "saturn.guarded-runtime.v3" },
  ]) expect(() => parseGuardedRuntimeManifest(changed)).toThrow("invalid_manifest");
});
const qualified = { schema: "saturn.guarded-qualification.v1", coverage: "append-only-directories/file-cas", approvedFunctionsSha256: hash,
  supportedWritersVerified: true, unsupportedWritersBlockedBeforeIo: true, privateLifecycleVerified: true };
it("never promotes old deployment qualification into batch qualification, or downgrades a new one", () => {
  const old = parseGuardedRuntimeManifest(valid()), next = parseGuardedRuntimeManifest(batchManifest());
  const q = { ...qualified, schema: "saturn.guarded-qualification.v2", smallBatchTransport: "saturn.small-file-batch.v1" };
  expect(() => requireGuardedRuntimeQualification(qualified, old, hash)).not.toThrow();
  expect(() => requireGuardedRuntimeQualification(q, next, hash)).not.toThrow();
  expect(() => requireGuardedRuntimeQualification(qualified, next, hash)).toThrow("deployment_unqualified");
  expect(() => requireGuardedRuntimeQualification(q, old, hash)).toThrow("deployment_unqualified");
  for (const invalid of [{ ...q, smallBatchTransport: undefined }, { ...q, smallBatchTransport: true },
    { ...q, smallBatchTransport: "saturn.small-file-batch.v2" }, { ...q, approvedFunctionsSha256: "b".repeat(64) },
    { ...q, supportedWritersVerified: false }, { ...q, unsupportedWritersBlockedBeforeIo: false }, { ...q, privateLifecycleVerified: false }])
    expect(() => requireGuardedRuntimeQualification(invalid, next, hash)).toThrow("deployment_unqualified");
});
