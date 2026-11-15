import { createHash } from "node:crypto";

export const BROWSER_TREE_LIMITS = Object.freeze({ itemsPerJob: 16, wireBytes: 4 * 1024 * 1024, metadataBytes: 64 * 1024, smallFileBytes: 256 * 1024, pathBytes: 4096, depth: 64 });
export class BrowserTreeInputError extends Error { constructor(message: string) { super(message); this.name = "BrowserTreeInputError"; } }
interface ItemIdentity { readonly itemId: string; readonly parentItemId: string | null; readonly relativePath: string }
export type BrowserTreeItem = ItemIdentity & ({ readonly kind: "directory" } | { readonly kind: "file"; readonly sizeBytes: number; readonly sha256: string; readonly contentBase64: string });
export interface BrowserTreeJob { readonly schema: "saturn.browser-tree-job.v1"; readonly jobId: string; readonly items: readonly BrowserTreeItem[] }
export interface ValidatedBrowserTreeJob { readonly value: BrowserTreeJob; readonly intentSha256: string; readonly metadataBytes: number; readonly wireBytes: number; readonly payloadBytes: number; readonly files: number; readonly directories: number }
const invalid = (message: string): never => { throw new BrowserTreeInputError(message); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Expected a closed object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) return invalid("Unexpected or missing field");
  return record;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) return invalid("Invalid item/job identity");
  return value;
}
export function validateBrowserTreePath(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > BROWSER_TREE_LIMITS.pathBytes || value.startsWith("/") || /%[0-9a-f]{2}/i.test(value)) return invalid("Invalid relative tree path");
  const segments = value.split("/");
  if (segments.length > BROWSER_TREE_LIMITS.depth || segments.some(name => !name || name !== name.normalize("NFC").trim() || name === "." || name === ".." || name.length > 255 || /[\\:*?"<>|\p{Cc}\p{Cs}]/u.test(name) || name.endsWith(".") || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))) return invalid("Unsafe or silently normalized tree path");
  return value;
}

/** Pure validation of EVERY item/content before admission can mutate anything.
 * Parent receipts, current authority, quota and backend fencing are separate
 * mandatory database/execution checks; this result is not an authorization. */
export function validateBrowserTreeJob(input: unknown): ValidatedBrowserTreeJob {
  const body = object(input, ["schema", "jobId", "items"]);
  if (body.schema !== "saturn.browser-tree-job.v1" || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > BROWSER_TREE_LIMITS.itemsPerJob) return invalid("Invalid bounded job envelope");
  const jobId = uuid(body.jobId), ids = new Set<string>(), paths = new Set<string>();
  let payloadBytes = 0, files = 0, directories = 0;
  const items = body.items.map((raw): BrowserTreeItem => {
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (kind !== "directory" && kind !== "file") return invalid("Invalid item kind");
    const row = object(raw, ["kind", "itemId", "parentItemId", "relativePath", ...(kind === "file" ? ["sizeBytes", "sha256", "contentBase64"] : [])]);
    const itemId = uuid(row.itemId), parentItemId = row.parentItemId === null ? null : uuid(row.parentItemId), relativePath = validateBrowserTreePath(row.relativePath);
    if (ids.has(itemId) || paths.has(relativePath.toLowerCase()) || itemId === parentItemId) return invalid("Duplicate item or path identity");
    ids.add(itemId); paths.add(relativePath.toLowerCase());
    if ((parentItemId === null) !== !relativePath.includes("/")) return invalid("Parent/path mismatch");
    const identity = { itemId, parentItemId, relativePath };
    if (kind === "directory") { directories++; return Object.freeze({ kind, ...identity }); }
    if (typeof row.sizeBytes !== "number" || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || row.sizeBytes > BROWSER_TREE_LIMITS.smallFileBytes || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) || typeof row.contentBase64 !== "string" || row.contentBase64.length > 4 * Math.ceil(BROWSER_TREE_LIMITS.smallFileBytes / 3)) return invalid("Invalid bounded file payload");
    const bytes = Buffer.from(row.contentBase64, "base64");
    if (bytes.length !== row.sizeBytes || bytes.toString("base64") !== row.contentBase64 || createHash("sha256").update(bytes).digest("hex") !== row.sha256) return invalid("File size/SHA256/representation mismatch");
    payloadBytes += bytes.length; files++;
    return Object.freeze({ kind, ...identity, sizeBytes: row.sizeBytes, sha256: row.sha256, contentBase64: row.contentBase64 });
  });
  const byId = new Map(items.map(item => [item.itemId, item]));
  for (const item of items) {
    const parent = item.parentItemId === null ? undefined : byId.get(item.parentItemId);
    if (parent !== undefined && (parent.kind !== "directory" || item.relativePath.slice(0, item.relativePath.lastIndexOf("/")) !== parent.relativePath)) return invalid("Parent is not the exact declared directory");
  }
  const value = Object.freeze({ schema: "saturn.browser-tree-job.v1" as const, jobId, items: Object.freeze(items) });
  const canonical = JSON.stringify(value), wireBytes = Buffer.byteLength(JSON.stringify(input));
  const metadataBytes = Buffer.byteLength(JSON.stringify({ ...value, items: items.map(item => item.kind === "file" ? { ...item, contentBase64: "" } : item) }));
  if (wireBytes > BROWSER_TREE_LIMITS.wireBytes || metadataBytes > BROWSER_TREE_LIMITS.metadataBytes) return invalid("Job wire/metadata bound exceeded");
  return Object.freeze({ value, intentSha256: createHash("sha256").update(canonical).digest("hex"), metadataBytes, wireBytes, payloadBytes, files, directories });
}
