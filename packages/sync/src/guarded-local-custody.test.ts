import { describe, expect, it } from "vitest";
import { parseGuardedRuntimeManifest } from "./guarded-runtime-manifest.js";
import { parseGuardedBackendFence } from "./guarded-backend-fence.js";

const uuid = "00000000-0000-4000-8000-000000000001", sha = "a".repeat(64);
function manifest(kind?: unknown) {
  return { schema: "saturn.guarded-runtime.v1", serverIdentity: uuid, policyVersion: "v1", qualificationReceiptFile: "/own/q.json", qualificationReceiptSha256: sha,
    writerDatabaseUrlFile: "/own/db.private", cursorKeyFile: "/own/key.private", cursorKeyId: "v1", maximumFileBytes: "1073741824",
    roles: { runtimeRole: "runtime", writerLogin: "writer", writerOwner: "owner", migratorRole: "migrator" },
    approvedFunctions: ["catalog_folder_command(text,jsonb,jsonb)", "catalog_upload_command(text,jsonb,jsonb,jsonb)", "catalog_guard_upgrade_file(uuid)", "catalog_folder_v2_command(text,jsonb,jsonb,jsonb)", "catalog_guard_backend_uncertain(uuid,uuid)", "outside_folder_commit(uuid,jsonb)"].map(identity => ({ identity: "public." + identity, sourceSha256: sha })),
    backend: { ...(kind === undefined ? {} : { kind }), identity: "backend", profileId: "bootstrap", profileRevision: 1, generation: uuid, fenceReceiptFile: "/own/fence.json", fenceReceiptSha256: sha, caseSensitive: true },
    roots: [{ rootId: uuid, epoch: uuid, bindingVersion: uuid, guardRevision: uuid, activationReceiptSha256: sha }] };
}
const common = { backendIdentity: "backend", profileId: "bootstrap", profileRevision: 1, generation: uuid, storageConfigSha256: sha,
  oldExecutorsDrained: true, oldCredentialsRevoked: true, protectedAncestorsVerified: true };

describe("qualified local custody manifest boundary", () => {
  it("keeps the original SFTP manifest and fence byte shape", () => {
    const parsed = parseGuardedRuntimeManifest(manifest());
    expect(parsed.backend).not.toHaveProperty("kind");
    const fence = { ...common, schema: "saturn.backend-fence.v1", credentialSha256: sha };
    expect(parseGuardedBackendFence(fence, parsed)).toEqual(fence);
  });
  it("requires explicit local kind and its separate custody digest", () => {
    const local = parseGuardedRuntimeManifest(manifest("local"));
    const fence = { ...common, schema: "saturn.backend-fence.local.v1", localCustodySha256: sha };
    expect(parseGuardedBackendFence(fence, local)).toEqual(fence);
    expect(() => parseGuardedBackendFence(fence, parseGuardedRuntimeManifest(manifest()))).toThrow("deployment_unqualified");
    expect(() => parseGuardedBackendFence({ ...common, schema: "saturn.backend-fence.v1", credentialSha256: sha }, local)).toThrow("deployment_unqualified");
  });
  it("refuses unknown backend, mixed credentials, final digest/identity/guard corruption", () => {
    expect(() => parseGuardedRuntimeManifest(manifest("other"))).toThrow("invalid_manifest");
    const local = parseGuardedRuntimeManifest(manifest("local"));
    const fence = { ...common, schema: "saturn.backend-fence.local.v1", localCustodySha256: sha };
    for (const patch of [{ credentialSha256: sha }, { localCustodySha256: "" }, { backendIdentity: "other" }, { generation: "00000000-0000-4000-8000-000000000002" }, { protectedAncestorsVerified: false }, { oldExecutorsDrained: false }]) {
      expect(() => parseGuardedBackendFence({ ...fence, ...patch }, local)).toThrow("deployment_unqualified");
    }
  });
});
