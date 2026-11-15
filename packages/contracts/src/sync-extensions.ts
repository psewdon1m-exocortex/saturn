import { validateSyncExpected, type SyncExpected, type SyncNodeDescriptor } from "./sync-protocol.js";

export const SYNC_EXTENSION_REVISIONS = Object.freeze({ K1: 2, K2: 2, K3: 2, K4: 1 });
export interface SyncDeletePlan {
  readonly schema:"saturn.delete-plan.v1";readonly planId:string;readonly planDigest:string;
  readonly items:readonly {readonly nodeId:string;readonly version:string}[];
}
export function parseSyncDeletePlan(value:unknown):SyncDeletePlan{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new SyncExtensionError('invalid_input');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).length!==4||v.schema!=='saturn.delete-plan.v1'||typeof v.planId!=='string'||!uuid.test(v.planId)
    ||typeof v.planDigest!=='string'||!sha.test(v.planDigest)||!Array.isArray(v.items)||!v.items.length||v.items.length>500)throw new SyncExtensionError('invalid_input');
  const items=v.items.map((x:unknown)=>{
    if(!x||typeof x!=='object'||Array.isArray(x))throw new SyncExtensionError('invalid_input');
    const r=x as Record<string,unknown>;
    if(Object.keys(r).length!==2||typeof r.nodeId!=='string'||!uuid.test(r.nodeId)||typeof r.version!=='string'||!uuid.test(r.version))throw new SyncExtensionError('invalid_input');
    return Object.freeze({nodeId:r.nodeId,version:r.version});
  });
  if(new Set(items.map(i=>i.nodeId)).size!==items.length)throw new SyncExtensionError('invalid_input');
  return Object.freeze({schema:'saturn.delete-plan.v1',planId:v.planId,planDigest:v.planDigest,items:Object.freeze(items)});
}
export interface SyncCapabilityExtensions {
  readonly revisions: typeof SYNC_EXTENSION_REVISIONS;
  readonly namespace: SyncNamespacePolicy;
  readonly minimum_writer: "saturn.namespace-mutation.v1";
  readonly backend_policy: "managed-exclusive";
  readonly limits: { readonly metadata_items: 500; readonly metadata_bytes: 4194304; readonly long_poll_ms: 25000;
    readonly gzip_threshold_bytes: 16384; readonly stream_chunk_bytes: 4194304; readonly stream_maximum_chunks: 256 | 2147483648 };
}
export type SyncNameCodec = "legacy" | "portable_v1";
export interface SyncNamespacePolicy { readonly codec: SyncNameCodec; readonly policyHash: string }
export interface SyncContentReference {
  readonly nodeId: string; readonly contentVersionId: string; readonly metadataVersion: string;
  readonly sizeBytes: string; readonly sha256: string;
}
interface MutationBase {
  readonly schema: "saturn.namespace-mutation.v1";
  readonly operationId: string; readonly idempotencyKey: string;
  readonly rootId: string; readonly epoch: string; readonly bindingVersion: string;
  readonly expected: SyncExpected;
}
export type SyncMutationInput = MutationBase & (
  | { readonly kind: "move"; readonly parentId: string; readonly name: string }
  | { readonly kind: "quarantine-delete"; readonly planId: string | null; readonly planDigest: string | null }
  | { readonly kind: "restore"; readonly parentId: string; readonly name: string; readonly deletedOperationId: string }
  | { readonly kind: "metadata-patch"; readonly contentVersionId: string; readonly sha256: string; readonly modifiedAt: string }
  | { readonly kind: "create-empty"; readonly parentId: string; readonly name: string }
  | { readonly kind: "clone-content"; readonly parentId: string; readonly name: string; readonly source: SyncContentReference }
  | { readonly kind: "availability"; readonly availability: "UNAVAILABLE" | "UNKNOWN"; readonly reason: "integrity_scrub"; readonly contentVersionId:string; readonly sha256:string }
);
export interface SyncMutationStatus {
  readonly schema: "saturn.namespace-mutation-status.v1";
  readonly operationId: string; readonly intentHash: string;
  readonly state: "QUEUED" | "PREPARED" | "PHYSICAL_PENDING" | "UNKNOWN" | "PUBLISHED" | "NOT_PUBLISHED";
  readonly result?: { readonly description: SyncNodeDescriptor; readonly firstSeq: string; readonly lastSeq: string; readonly tombstone: boolean };
}
export class SyncExtensionError extends Error { constructor(readonly code: string) { super(code); } }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
export function syncNameKey(value: string, codec: unknown): string {
  if (!value || Array.from(value).length > 255 || new TextEncoder().encode(value).length > 1020 || [".", ".."].includes(value) || /[/\\\p{Cc}\p{Cs}]/u.test(value)) throw new SyncExtensionError("invalid_name");
  if (codec === "legacy") return value;
  if (codec !== "portable_v1" || value !== value.normalize("NFC") || /[<>:"|?*]/.test(value) || /[. ]$/.test(value)
    || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value)) throw new SyncExtensionError("invalid_name");
  return value.replace(/[A-Z]/g, c => c.toLowerCase());
}
export function parseSyncNamespacePolicy(value: unknown): SyncNamespacePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !("codec" in value) || !("policyHash" in value)
    || !["legacy", "portable_v1"].includes(String(value.codec)) || typeof value.policyHash !== "string" || !sha.test(value.policyHash)) throw new SyncExtensionError("invalid_input");
  return Object.freeze({ codec: value.codec as SyncNameCodec, policyHash: value.policyHash });
}
export function parseSyncMutationInput(value: unknown): SyncMutationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncExtensionError("invalid_input");
  const row = value as Record<string, unknown>;
  const extra: Record<string, readonly string[]> = { move: ["parentId", "name"], "quarantine-delete": ["planId", "planDigest"], restore: ["parentId", "name", "deletedOperationId"],
    "metadata-patch": ["contentVersionId", "sha256", "modifiedAt"], "create-empty": ["parentId", "name"], "clone-content": ["parentId", "name", "source"], availability: ["availability", "reason","contentVersionId","sha256"] };
  const fields = typeof row.kind === "string" ? extra[row.kind] : undefined;
  const keys = ["schema", "operationId", "idempotencyKey", "rootId", "epoch", "bindingVersion", "expected", "kind", ...(fields ?? [])];
  if (!fields || Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k)) || row.schema !== "saturn.namespace-mutation.v1") throw new SyncExtensionError("invalid_input");
  for (const key of ["operationId", "rootId", "epoch", "bindingVersion", ...fields.filter(k => ["parentId", "deletedOperationId", "contentVersionId"].includes(k))]) {
    if (typeof row[key] !== "string" || !uuid.test(row[key])) throw new SyncExtensionError("invalid_input");
  }
  if (typeof row.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(row.idempotencyKey)) throw new SyncExtensionError("invalid_input");
  validateSyncExpected(row.expected);
  if (!["create-empty", "clone-content"].includes(String(row.kind)) && row.expected.kind !== "version") throw new SyncExtensionError("invalid_input");
  if (fields.includes("name")) { if (typeof row.name !== "string") throw new SyncExtensionError("invalid_input"); syncNameKey(row.name, "legacy"); }
  if (row.kind === "quarantine-delete" && !((row.planId === null && row.planDigest === null) || (typeof row.planId === "string" && uuid.test(row.planId) && typeof row.planDigest === "string" && sha.test(row.planDigest)))) throw new SyncExtensionError("invalid_input");
  if (row.kind === "metadata-patch" && (typeof row.sha256 !== "string" || !sha.test(row.sha256) || typeof row.modifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.modifiedAt) || !Number.isFinite(Date.parse(row.modifiedAt)))) throw new SyncExtensionError("invalid_input");
  if (row.kind === "availability" && (row.reason !== "integrity_scrub" || typeof row.sha256!=="string"||!sha.test(row.sha256)||!["UNAVAILABLE", "UNKNOWN"].includes(String(row.availability)))) throw new SyncExtensionError("invalid_input");
  if (row.kind === "clone-content") {
    if (!row.source || typeof row.source !== "object" || Array.isArray(row.source)) throw new SyncExtensionError("invalid_input");
    const source = row.source as Record<string, unknown>;
    if (Object.keys(source).length !== 5
      || ["nodeId", "contentVersionId", "metadataVersion"].some(k => typeof source[k] !== "string" || !uuid.test(source[k]))
      || typeof source.sha256 !== "string" || !sha.test(source.sha256) || typeof source.sizeBytes !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(source.sizeBytes) || BigInt(source.sizeBytes) > 9223372036854775807n) throw new SyncExtensionError("invalid_input");
  }
  return Object.freeze({ ...row, expected: Object.freeze({ ...row.expected }), ...(row.kind === "clone-content" ? { source: Object.freeze({ ...(row.source as SyncContentReference) }) } : {}) }) as unknown as SyncMutationInput;
}
