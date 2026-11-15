import { encodeSyncJson, type SyncRootBinding } from "../../contracts/src/sync-protocol.js";
import { readSmallBatchManifest, SMALL_BATCH_MAX_MANIFEST_BYTES, type SmallBatchManifest } from "../../contracts/src/sync-small-batch.js";
import { parseCatalogUploadPrepareInput, type CatalogUploadPrepareInput } from "./catalog-upload-intent.js";

/** The transport declaration supplements, rather than reconstructs, the complete
 * original catalog request. Topology, content-version and metadata CAS witnesses
 * therefore retain exactly the same meaning as individual guarded uploads. */
export interface SmallBatchPlan {
  readonly manifest: SmallBatchManifest;
  readonly inputs: readonly CatalogUploadPrepareInput[];
}
export class SmallBatchPlanError extends Error {
  constructor(readonly code = "invalid_input", options?: ErrorOptions) { super(code, options); }
}

export function readSmallBatchPlan(value: unknown, binding: SyncRootBinding): SmallBatchPlan {
  const bad = (): never => { throw new SmallBatchPlanError(); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || !Object.hasOwn(row, "manifest") || !Object.hasOwn(row, "inputs")) return bad();
  const wire = encodeSyncJson(value);
  if (wire.byteLength > SMALL_BATCH_MAX_MANIFEST_BYTES) throw new SmallBatchPlanError("page_limit");
  const manifest = readSmallBatchManifest(encodeSyncJson(row.manifest), binding);
  if (!Array.isArray(row.inputs) || row.inputs.length !== manifest.items.length) return bad();
  const inputs = row.inputs.map((raw: unknown, index) => {
    let input: CatalogUploadPrepareInput;
    try { input = parseCatalogUploadPrepareInput(raw); } catch { return bad(); }
    const intent = input.intent, item = manifest.items[index];
    if (!item || intent.schema !== "saturn.upload-intent.v2"
      || input.epoch !== manifest.server_epoch || input.bindingVersion !== manifest.binding_version
      || intent.rootId !== manifest.root_id || intent.idempotencyKey !== item.operation_id
      || intent.parentId !== item.parent_id || intent.name !== item.name
      || intent.sizeBytes !== item.size_bytes || intent.sha256 !== item.sha256) return bad();
    const expected = item.expected, condition = intent.condition;
    if (expected.kind === "absent" ? condition.kind !== "absent"
      : condition.kind !== "match" || condition.nodeId !== expected.node_id || condition.metadataVersion !== expected.version) return bad();
    return input;
  });
  return Object.freeze({ manifest, inputs: Object.freeze(inputs) });
}
