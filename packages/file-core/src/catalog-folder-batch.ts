import { parseCatalogFolderRequestV2, type CatalogFolderRequestV2, type CatalogFolderOutcomeV2 } from "./catalog-folder-v2-intent.js";
import { CatalogFolderError } from "./catalog-folder-intent.js";

export interface CatalogFolderBatchItem { readonly ref: string; readonly input: CatalogFolderRequestV2; readonly parentRef?: string }
export interface CatalogFolderBatchOutcome { readonly ref: string; readonly outcome?: CatalogFolderOutcomeV2; readonly code?: string }
export function parseCatalogFolderBatch(value: unknown): readonly CatalogFolderBatchItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500 || Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new CatalogFolderError("invalid_input");
  const refs = new Set<string>(), operations = new Set<string>(), keys = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CatalogFolderError("invalid_input");
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some(k => !["ref", "input", "parentRef"].includes(k)) || typeof row.ref !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(row.ref)
      || refs.has(row.ref) || row.parentRef !== undefined && (typeof row.parentRef !== "string" || !refs.has(row.parentRef))) throw new CatalogFolderError("invalid_input");
    const input = parseCatalogFolderRequestV2(row.input);
    if (operations.has(input.operationId) || keys.has(input.idempotencyKey)) throw new CatalogFolderError("invalid_input");
    refs.add(row.ref); operations.add(input.operationId); keys.add(input.idempotencyKey);
    return Object.freeze({ ref: row.ref, input, ...(row.parentRef === undefined ? {} : { parentRef: row.parentRef }) });
  });
}
/** Ordered dependencies, independent outcomes, no sibling enumeration. Durable
 * original operations provide replay even if an HTTP response is lost halfway. */
export async function executeCatalogFolderBatch(items: readonly CatalogFolderBatchItem[],
  ensure: (input: CatalogFolderRequestV2) => Promise<CatalogFolderOutcomeV2>): Promise<readonly CatalogFolderBatchOutcome[]> {
  const resolved = new Map<string, { input: CatalogFolderRequestV2; outcome: CatalogFolderOutcomeV2 }>();
  const results: CatalogFolderBatchOutcome[] = [];
  for (const item of items) {
    let input = item.input;
    try {
    if (item.parentRef !== undefined) {
      const parent = resolved.get(item.parentRef);
      if (!parent) { results.push({ ref: item.ref, code: "dependency_failed" }); continue; }
      const descriptor = parent.outcome.result.description;
      input = parseCatalogFolderRequestV2({ ...input, parentId: descriptor.node_id,
        parentTopology: [{ nodeId: descriptor.node_id, parentId: descriptor.parent_id, name: descriptor.name }, ...parent.input.parentTopology] });
    }
      const outcome = await ensure(input);
      resolved.set(item.ref, { input, outcome }); results.push({ ref: item.ref, outcome });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "sync_internal_error";
      results.push({ ref: item.ref, code: /^[a-z_]{1,64}$/.test(code) ? code : "sync_internal_error" });
    }
  }
  return results;
}
