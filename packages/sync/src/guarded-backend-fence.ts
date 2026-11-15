import { GuardedRuntimeError, type GuardedRuntimeManifest } from "./guarded-runtime-manifest.js";

type FenceReceipt = {
  readonly backendIdentity: string; readonly profileId: string; readonly profileRevision: number;
  readonly generation: string; readonly storageConfigSha256: string;
  readonly oldExecutorsDrained: true; readonly oldCredentialsRevoked: true; readonly protectedAncestorsVerified: true;
} & ({ readonly schema: "saturn.backend-fence.v1"; readonly credentialSha256: string }
  | { readonly schema: "saturn.backend-fence.local.v1"; readonly localCustodySha256: string });

export function parseGuardedBackendFence(value: unknown, manifest: GuardedRuntimeManifest): FenceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GuardedRuntimeError("deployment_unqualified");
  const local = manifest.backend.kind === "local", digest = local ? "localCustodySha256" : "credentialSha256", sha = /^[a-f\d]{64}$/;
  const r = value as Record<string, unknown>;
  const keys = ["schema", "backendIdentity", "profileId", "profileRevision", "generation", "storageConfigSha256", digest, "oldExecutorsDrained", "oldCredentialsRevoked", "protectedAncestorsVerified"];
  if (Object.keys(r).length !== keys.length || keys.some(key => !(key in r)) || r.schema !== (local ? "saturn.backend-fence.local.v1" : "saturn.backend-fence.v1")
    || r.backendIdentity !== manifest.backend.identity || r.profileId !== manifest.backend.profileId || r.profileRevision !== manifest.backend.profileRevision || r.generation !== manifest.backend.generation
    || typeof r.storageConfigSha256 !== "string" || !sha.test(r.storageConfigSha256) || typeof r[digest] !== "string" || !sha.test(r[digest])
    || r.oldExecutorsDrained !== true || r.oldCredentialsRevoked !== true || r.protectedAncestorsVerified !== true) throw new GuardedRuntimeError("deployment_unqualified");
  return Object.freeze(r) as unknown as FenceReceipt;
}
