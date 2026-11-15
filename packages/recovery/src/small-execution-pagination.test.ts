import { expect, it } from "vitest";
import { inspectSmallExecutionJobs } from "./small-execution-coherence.js";

const fields = { id: "uuid", root_id: "uuid", device_id: "uuid", job_key: "text", plan_bytes: "text", manifest_sha256: "text", members: "ARRAY", created_at: "timestamp with time zone" };
const columns = [
  ...Object.entries(fields).map(([column_name, data_type]) => ({ table_name: "sync_small_execution_jobs", column_name, data_type })),
  { table_name: "operation_journal", column_name: "upload_execution_job", data_type: "uuid" },
  { table_name: "sync_small_batch_budget", column_name: "execution_metadata_bytes", data_type: "bigint" },
];
const id = "00000000-0000-0000-0000-000000000032";
type Page = { valid: boolean; count: number; last_id: string | null };
function fixture(pages: Page[], jobs = "33", validCounters = true) {
  const cursors: unknown[] = [];
  const sql = { unsafe: async (query: string, parameters: readonly unknown[] = []) => {
    if (query.includes("AS present")) return [{ present: true }];
    if (query.includes("AS ready")) return [{ ready: true }];
    if (query.includes("AS jobs")) return [{ valid: validCounters, jobs, members: "42" }];
    cursors.push(parameters[0]);
    const page = pages.shift();
    if (!page) throw new Error("Unexpected extra validation page");
    return [page];
  } };
  return { sql: sql as unknown as Parameters<typeof inspectSmallExecutionJobs>[0], cursors };
}
it("rejects a malformed immutable job beyond the first page", async () => {
  const f = fixture([{ valid: true, count: 32, last_id: id }, { valid: false, count: 1, last_id: id + "1" }]);
  await expect(inspectSmallExecutionJobs(f.sql, columns)).rejects.toThrow("Incoherent execution job originals");
  expect(f.cursors).toEqual([null, id]);
});
it("requires every retained original to be validated", async () => {
  const f = fixture([{ valid: true, count: 1, last_id: id }], "2");
  await expect(inspectSmallExecutionJobs(f.sql, columns)).rejects.toThrow("Incomplete execution job validation");
});
it("still refuses broken global member/budget coherence before page checks", async () => {
  const f = fixture([], "33", false);
  await expect(inspectSmallExecutionJobs(f.sql, columns)).rejects.toThrow("Incoherent execution job originals");
  expect(f.cursors).toEqual([]);
});
it("keeps exact same-cut totals after the last page", async () => {
  const f = fixture([{ valid: true, count: 32, last_id: id }, { valid: true, count: 0, last_id: null }], "32");
  await expect(inspectSmallExecutionJobs(f.sql, columns)).resolves.toEqual({ smallExecutionJobShape: "saturn.small-execution-job.v1", smallExecutionJobs: "32", smallExecutionMembers: "42" });
  expect(f.cursors).toEqual([null, id]);
});
