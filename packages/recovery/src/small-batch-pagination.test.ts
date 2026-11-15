import { expect, it } from "vitest";
import { inspectSmallBatchRegistry } from "./small-batch-coherence.js";

const schema = {
  sync_small_batch_budget: { root_id: "uuid", operation_count: "bigint", batch_count: "bigint", metadata_bytes: "bigint" },
  sync_small_batch_operations: { id: "uuid", operation_key: "text", root_id: "uuid", device_id: "uuid", declaration: "jsonb", created_at: "timestamp with time zone" },
  sync_small_batches: { id: "uuid", root_id: "uuid", device_id: "uuid", batch_key: "text", plan: "jsonb", created_at: "timestamp with time zone" },
};
const columns = Object.entries(schema).flatMap(([table_name, fields]) => Object.entries(fields).map(([column_name, data_type]) => ({ table_name, column_name, data_type })));
type Page = { valid: boolean; count: number; last_id: string | null };
const page = (count: number, last_id: string | null, valid = true): Page => ({ valid, count, last_id });
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function fixture(batches: Page[], operations: Page[], counts = { batches: "33", operations: "33" }) {
  const queries: { table: string; cursor: unknown }[] = [];
  const sql = { unsafe: async (query: string, parameters: readonly unknown[] = []) => {
    if (query.includes("AS ready")) return [{ ready: true }];
    if (query.includes("operation_totals AS MATERIALIZED")) return [{ valid: true, ...counts, bytes: "42" }];
    const table = query.includes("FROM candidates b") ? "batches" : "operations";
    queries.push({ table, cursor: parameters[0] });
    const next = (table === "batches" ? batches : operations).shift();
    if (!next) throw new Error("Unexpected extra validation page");
    return [next];
  } };
  return { sql: sql as unknown as Parameters<typeof inspectSmallBatchRegistry>[0], queries };
}
it.each(["batches", "operations"] as const)("rejects an invalid %s original beyond the first page", async table => {
  const batches = [page(32, id(32)), page(1, id(33), table !== "batches")];
  const operations = [page(32, id(32)), page(1, id(33), table !== "operations")];
  const f = fixture(batches, operations);
  await expect(inspectSmallBatchRegistry(f.sql, columns)).rejects.toThrow("Incoherent small batch originals/counters");
  expect(f.queries.some(q => q.table === table && q.cursor === id(32))).toBe(true);
});
it("validates all pages with independent cursors and keeps exact original totals", async () => {
  const f = fixture([page(32, id(32)), page(1, id(33))], [page(32, id(32)), page(1, id(33))]);
  await expect(inspectSmallBatchRegistry(f.sql, columns)).resolves.toEqual({ smallBatchShape: "saturn.small-file-batch.v1", smallBatches: "33", smallBatchOperations: "33", smallBatchMetadataBytes: "42" });
  expect(f.queries).toEqual([{ table: "batches", cursor: null }, { table: "batches", cursor: id(32) }, { table: "operations", cursor: null }, { table: "operations", cursor: id(32) }]);
});
it("refuses an incomplete validation even when every returned original is valid", async () => {
  const f = fixture([page(1, id(1))], [], { batches: "2", operations: "0" });
  await expect(inspectSmallBatchRegistry(f.sql, columns)).rejects.toThrow("Incomplete small batch validation");
});
it("handles empty registries and exact full-page boundaries without skipping the final probe", async () => {
  const f = fixture([page(0, null)], [page(32, id(32)), page(0, null)], { batches: "0", operations: "32" });
  await expect(inspectSmallBatchRegistry(f.sql, columns)).resolves.toMatchObject({ smallBatches: "0", smallBatchOperations: "32" });
  expect(f.queries.at(-1)).toEqual({ table: "operations", cursor: id(32) });
});
