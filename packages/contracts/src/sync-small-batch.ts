import {
  parseSyncJson, syncInteger64, validateSyncExpected,
  SYNC_PROTOCOL, SYNC_DESCRIPTOR_SCHEMA, SyncProtocolError,
  type SyncExpected, type SyncRootBinding,
} from "./sync-protocol.js";

export const SMALL_BATCH_SCHEMA = "saturn.small-file-batch.v1";
export const SMALL_BATCH_MAX_ITEMS = 500;
export const SMALL_BATCH_MAX_FILE_BYTES = 256 * 1024;
export const SMALL_BATCH_MAX_DATA_BYTES = 32 * 1024 * 1024;
export const SMALL_BATCH_MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const EMPTY_CONTENT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface SmallBatchItem {
  readonly operation_id: string;
  readonly source_generation: string;
  readonly source_identity: string;
  readonly parent_id: string;
  readonly name: string;
  readonly size_bytes: string;
  readonly sha256: string;
  readonly expected: SyncExpected;
}
export interface SmallBatchManifest extends SyncRootBinding {
  readonly schema: typeof SMALL_BATCH_SCHEMA;
  readonly batch_id: string;
  readonly rules_version: string;
  readonly items: readonly SmallBatchItem[];
}

const bindingKeys = ["protocol", "descriptor_schema", "server_identity", "root_id", "server_epoch", "policy_version", "binding_version"] as const;
const manifestKeys = [...bindingKeys, "schema", "batch_id", "rules_version", "items"];
const itemKeys = ["operation_id", "source_generation", "source_identity", "parent_id", "name", "size_bytes", "sha256", "expected"];
const token = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const opaque = /^[\x21-\x7e]{1,128}$/;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const bad = (): never => { throw new SyncProtocolError("invalid_contract"); };
function strict(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return bad();
  return row;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return bad();
  return value;
}
function rootBinding(value: Record<string, unknown>): SyncRootBinding {
  if (value.protocol !== SYNC_PROTOCOL || value.descriptor_schema !== SYNC_DESCRIPTOR_SCHEMA) return bad();
  return {
    protocol: SYNC_PROTOCOL, descriptor_schema: SYNC_DESCRIPTOR_SCHEMA,
    server_identity: text(value.server_identity, opaque), root_id: text(value.root_id, opaque),
    server_epoch: text(value.server_epoch, opaque), policy_version: text(value.policy_version, opaque),
    binding_version: text(value.binding_version, uuid),
  };
}

/** Strict request parsing only: no capability, current authority, receipt or
 * permission to publish is established by a well-formed transport manifest. */
export function readSmallBatchManifest(bytes: Uint8Array, expectedBinding: SyncRootBinding): SmallBatchManifest {
  const value = strict(parseSyncJson(bytes, SMALL_BATCH_MAX_MANIFEST_BYTES), manifestKeys);
  const binding = rootBinding(value), expected = rootBinding(expectedBinding as unknown as Record<string, unknown>);
  if (bindingKeys.some(key => binding[key] !== expected[key])) throw new SyncProtocolError("binding_mismatch");
  if (value.schema !== SMALL_BATCH_SCHEMA) return bad();
  const batchId = text(value.batch_id, token), rules = text(value.rules_version, opaque);
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > SMALL_BATCH_MAX_ITEMS) throw new SyncProtocolError("page_limit");
  const operations = new Set<string>(), destinations = new Set<string>(), items: SmallBatchItem[] = [];
  let total = 0n;
  for (const raw of value.items) {
    const item = strict(raw, itemKeys), operation = text(item.operation_id, token), parent = text(item.parent_id, opaque);
    const identity = text(item.source_identity, opaque), generation = syncInteger64(item.source_generation), size = syncInteger64(item.size_bytes);
    if (generation < 1n || size > BigInt(SMALL_BATCH_MAX_FILE_BYTES)) return bad();
    const sha = text(item.sha256, /^[a-f\d]{64}$/);
    if (size === 0n && sha !== EMPTY_CONTENT_SHA256) return bad();
    if (typeof item.name !== "string" || item.name === "" || item.name === "." || item.name === ".."
      || /[/\\\p{Cc}]/u.test(item.name) || Array.from(item.name).length > 255 || new TextEncoder().encode(item.name).length > 1020) return bad();
    const destination = JSON.stringify([parent, item.name]);
    if (operations.has(operation) || destinations.has(destination)) return bad();
    operations.add(operation); destinations.add(destination);
    validateSyncExpected(item.expected);
    total += size;
    if (total > BigInt(SMALL_BATCH_MAX_DATA_BYTES)) throw new SyncProtocolError("page_limit");
    const precondition: SyncExpected = item.expected.kind === "absent" ? { kind: "absent" }
      : { kind: "version", node_id: item.expected.node_id, version: item.expected.version };
    items.push(Object.freeze({ operation_id: operation, source_generation: generation.toString(), source_identity: identity,
      parent_id: parent, name: item.name, size_bytes: size.toString(), sha256: sha, expected: Object.freeze(precondition) }));
  }
  return Object.freeze({ ...binding, schema: SMALL_BATCH_SCHEMA, batch_id: batchId, rules_version: rules, items: Object.freeze(items) });
}
