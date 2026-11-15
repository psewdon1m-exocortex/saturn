/** Shared wire contract. A hash match is never a backend ownership proof. */
export const STORAGE_VERIFY_SCHEMA = "saturn.storage-verify.v1";
export const STORAGE_VERIFY_RESULT_SCHEMA = "saturn.storage-verify-result.v1";
export const STORAGE_VERIFY_MAX_BODY_BYTES = 65536;
export interface StorageVerifyIdentity {
  readonly requestId: string;
  readonly backendIdentity: string;
  readonly backendGeneration: string;
  readonly ownerId: string;
  readonly fencingToken: string;
  readonly rootId: string;
  readonly operationId: string;
  readonly intentSha256: string;
  readonly contentVersionId: string;
}
export interface StorageVerifyRequest extends StorageVerifyIdentity {
  readonly schema: typeof STORAGE_VERIFY_SCHEMA;
  readonly relativePath: string;
  readonly sizeBytes: string;
  readonly sha256: string;
  readonly maximumBytes: string;
  readonly timeoutMs: number;
  readonly requireDurability: "readback" | "file-sync";
}
export interface StorageVerifyResult extends StorageVerifyIdentity {
  readonly schema: typeof STORAGE_VERIFY_RESULT_SCHEMA;
  readonly status: "VERIFIED";
  readonly sizeBytes: string;
  readonly sha256: string;
  readonly durability: "readback" | "file-sync";
  readonly checkedAt: string;
}
export type StorageVerifyErrorCode = "unsupported" | "unauthorized" | "scope_denied" | "identity_mismatch"
  | "source_changed" | "verification_failed" | "capacity" | "cancelled" | "verifier_unavailable" | "invalid_input";
export class StorageVerifyError extends Error {
  constructor(readonly code: StorageVerifyErrorCode, options?: ErrorOptions) { super(code, options); }
}
export const STORAGE_VERIFY_IDENTITY_KEYS = ["requestId", "backendIdentity", "backendGeneration", "ownerId", "fencingToken", "rootId", "operationId", "intentSha256", "contentVersionId"] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new StorageVerifyError("invalid_input");
  return value as Record<string, unknown>;
}
function identity(row: Record<string, unknown>): void {
  for (const key of STORAGE_VERIFY_IDENTITY_KEYS) {
    const pattern = key === "backendIdentity" ? /^[A-Za-z0-9._:-]{1,128}$/ : key === "intentSha256" ? sha : uuid;
    if (typeof row[key] !== "string" || !pattern.test(row[key])) throw new StorageVerifyError("invalid_input");
  }
}
function bytes(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value) || BigInt(value) > 9007199254740991n) throw new StorageVerifyError("invalid_input");
  return BigInt(value);
}
export function parseStorageVerifyRequest(value: unknown): StorageVerifyRequest {
  const row = exact(value, ["schema", ...STORAGE_VERIFY_IDENTITY_KEYS, "relativePath", "sizeBytes", "sha256", "maximumBytes", "timeoutMs", "requireDurability"]);
  identity(row);
  if (row.schema !== STORAGE_VERIFY_SCHEMA || typeof row.sha256 !== "string" || !sha.test(row.sha256)
    || typeof row.relativePath !== "string" || row.relativePath.length > 4096 || /[\\\p{Cc}\p{Cs}]/u.test(row.relativePath)
    || row.relativePath.split("/").some(p => !p || p === "." || p === "..")
    || bytes(row.sizeBytes) > bytes(row.maximumBytes) || !Number.isInteger(row.timeoutMs) || Number(row.timeoutMs) < 1 || Number(row.timeoutMs) > 86400000
    || !["readback", "file-sync"].includes(String(row.requireDurability))) throw new StorageVerifyError("invalid_input");
  return Object.freeze({ ...row }) as unknown as StorageVerifyRequest;
}
export function parseStorageVerifyResult(value: unknown, request: StorageVerifyRequest): StorageVerifyResult {
  const row = exact(value, ["schema", ...STORAGE_VERIFY_IDENTITY_KEYS, "status", "sizeBytes", "sha256", "durability", "checkedAt"]);
  identity(row); bytes(row.sizeBytes);
  if (row.schema !== STORAGE_VERIFY_RESULT_SCHEMA || row.status !== "VERIFIED" || STORAGE_VERIFY_IDENTITY_KEYS.some(k => row[k] !== request[k])) throw new StorageVerifyError("identity_mismatch");
  if (row.sizeBytes !== request.sizeBytes || row.sha256 !== request.sha256) throw new StorageVerifyError("verification_failed");
  if (!["readback", "file-sync"].includes(String(row.durability)) || request.requireDurability === "file-sync" && row.durability !== "file-sync"
    || typeof row.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.checkedAt) || !Number.isFinite(Date.parse(row.checkedAt))) throw new StorageVerifyError("invalid_input");
  return Object.freeze({ ...row }) as unknown as StorageVerifyResult;
}
export function storageVerifyResult(request: StorageVerifyRequest, durability: StorageVerifyResult["durability"]): StorageVerifyResult {
  const identityAndContent = { ...Object.fromEntries(STORAGE_VERIFY_IDENTITY_KEYS.map(key => [key, request[key]])), sizeBytes: request.sizeBytes, sha256: request.sha256 };
  return parseStorageVerifyResult({ ...identityAndContent, schema: STORAGE_VERIFY_RESULT_SCHEMA, status: "VERIFIED", durability, checkedAt: new Date().toISOString() }, request);
}
