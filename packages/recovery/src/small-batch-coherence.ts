import type { Database } from "@saturn/database";
type RecoverySql = Parameters<Parameters<Database["transaction"]>[0]>[0];
export const smallBatchTables = ["sync_small_batch_budget", "sync_small_batch_operations", "sync_small_batches"] as const;
const columns: Record<string, Record<string, string>> = {
  sync_small_batch_budget: { root_id: "uuid", operation_count: "bigint", batch_count: "bigint", metadata_bytes: "bigint" },
  sync_small_batch_operations: { id: "uuid", operation_key: "text", root_id: "uuid", device_id: "uuid", declaration: "jsonb", created_at: "timestamp with time zone" },
  sync_small_batches: { id: "uuid", root_id: "uuid", device_id: "uuid", batch_key: "text", plan: "jsonb", created_at: "timestamp with time zone" },
};
export interface SmallBatchCoherence {
  readonly smallBatchShape: "saturn.small-file-batch.v1";
  readonly smallBatchOperations: string;
  readonly smallBatches: string;
  readonly smallBatchMetadataBytes: string;
}
/** Runs only inside the bounded consistent backup snapshot, never on ingress. */
export async function inspectSmallBatchRegistry(sql: Pick<RecoverySql, "unsafe">, actual: readonly { table_name: string; column_name: string; data_type: string }[]): Promise<SmallBatchCoherence> {
  const selected = actual.filter(row => Object.hasOwn(columns, row.table_name));
  const hasJobs=selected.some(row=>row.table_name==='sync_small_batch_budget'&&row.column_name==='execution_metadata_bytes'&&row.data_type==='bigint');
  if (selected.length !== (hasJobs?17:16) || selected.some(row => columns[row.table_name]?.[row.column_name] !== row.data_type
    && !(hasJobs&&row.table_name==='sync_small_batch_budget'&&row.column_name==='execution_metadata_bytes'&&row.data_type==='bigint'))) throw new Error("Unknown small batch registry schema; recovery is blocked");
  const shape = (await sql.unsafe<{ ready: boolean }[]>(`SELECT
    (SELECT count(*)=6 FROM pg_trigger WHERE tgrelid IN ('public.sync_small_batch_budget'::regclass,'public.sync_small_batch_operations'::regclass,'public.sync_small_batches'::regclass)
      AND tgname IN ('sync_small_batch_budget_guard','sync_small_batch_operations_guard','sync_small_batches_guard','sync_small_batch_budget_no_truncate','sync_small_batch_operations_no_truncate','sync_small_batches_no_truncate') AND tgenabled IN ('O','A'))
    AND (SELECT count(*)=5 FROM pg_constraint WHERE conrelid IN ('public.sync_small_batch_budget'::regclass,'public.sync_small_batch_operations'::regclass,'public.sync_small_batches'::regclass) AND contype='f' AND convalidated)
    AND (SELECT count(*)=5 FROM pg_constraint WHERE conrelid IN ('public.sync_small_batch_budget'::regclass,'public.sync_small_batch_operations'::regclass,'public.sync_small_batches'::regclass) AND contype IN ('p','u') AND convalidated)
    AND (SELECT count(*)=${String(hasJobs?7:6)} FROM pg_constraint WHERE conrelid IN ('public.sync_small_batch_budget'::regclass,'public.sync_small_batch_operations'::regclass,'public.sync_small_batches'::regclass) AND contype='c' AND convalidated)
    AND to_regprocedure('public.sync_small_batch_plan_valid(jsonb)') IS NOT NULL
    AND to_regprocedure('public.sync_small_batch_binding(jsonb)') IS NOT NULL AS ready`))[0];
  if (!shape?.ready) throw new Error("Incomplete small batch registry guards; recovery is blocked");
  const state = (await sql.unsafe<{ valid: boolean; operations: string; batches: string; bytes: string }[]>(`
    WITH operation_totals AS MATERIALIZED (
      SELECT root_id,count(*) AS count,sum(octet_length(declaration::text)) AS bytes FROM public.sync_small_batch_operations GROUP BY root_id
    ), batch_totals AS MATERIALIZED (
      SELECT root_id,count(*) AS count,sum(octet_length(plan::text)) AS bytes FROM public.sync_small_batches GROUP BY root_id
    ) SELECT
      NOT EXISTS(SELECT 1 FROM public.sync_small_batch_budget b FULL JOIN operation_totals o USING(root_id) FULL JOIN batch_totals m USING(root_id)
        WHERE b.root_id IS NULL OR b.operation_count<>coalesce(o.count,0) OR b.batch_count<>coalesce(m.count,0) OR b.metadata_bytes<>coalesce(o.bytes,0)+coalesce(m.bytes,0))
      AS valid,
      (SELECT count(*)::text FROM public.sync_small_batch_operations) AS operations,
      (SELECT count(*)::text FROM public.sync_small_batches) AS batches,
      (SELECT coalesce(sum(metadata_bytes${hasJobs?'+execution_metadata_bytes':''}),0)::text FROM public.sync_small_batch_budget) AS bytes
  `))[0];
  if (!state?.valid) throw new Error("Incoherent small batch originals/counters; recovery is blocked");
  // Expensive immutable declaration checks must not turn the whole retained
  // registry into one statement. Keep the same snapshot/deadline and every
  // predicate, but advance through a bounded primary-key page at a time.
  const invalidBatch = `NOT public.sync_small_batch_plan_valid(b.plan)
        OR b.plan->'manifest'->>'root_id' IS DISTINCT FROM b.root_id::text OR b.plan->'manifest'->>'batch_id' IS DISTINCT FROM b.batch_key
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.plan->'inputs') i WHERE i->'intent'->>'deviceId' IS DISTINCT FROM b.device_id::text)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.plan->'manifest'->'items') i LEFT JOIN public.sync_small_batch_operations o ON o.operation_key=i->>'operation_id' WHERE o.id IS NULL)`;
  const invalidOperation = `
        jsonb_typeof(o.declaration) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(o.declaration))<>3
        OR o.declaration->'item'->>'operation_id' IS DISTINCT FROM o.operation_key
        OR o.declaration->'input'->'intent'->>'rootId' IS DISTINCT FROM o.root_id::text
        OR o.declaration->'input'->'intent'->>'deviceId' IS DISTINCT FROM o.device_id::text
        OR NOT public.sync_small_batch_plan_valid(jsonb_build_object('manifest',jsonb_build_object(
          'schema','saturn.small-file-batch.v1','protocol','neptune-sync/1','descriptor_schema','saturn.current-namespace.v1',
          'root_id',o.root_id,'server_epoch',o.declaration->'input'->>'epoch','binding_version',o.declaration->'input'->>'bindingVersion',
          'server_identity','validation','policy_version','validation','batch_id','validation','rules_version',o.declaration->>'rulesVersion',
          'items',jsonb_build_array(o.declaration->'item')),'inputs',jsonb_build_array(o.declaration->'input')))`;
  for (const [table, alias, predicate, expected] of [
    ["sync_small_batches", "b", invalidBatch, state.batches],
    ["sync_small_batch_operations", "o", invalidOperation, state.operations],
  ] as const) {
    let cursor: string | null = null, checked = 0n;
    for (;;) {
      const page: { valid: boolean; count: number; last_id: string | null } | undefined = (await sql.unsafe<{ valid: boolean; count: number; last_id: string | null }[]>(`
        WITH candidates AS MATERIALIZED (
          SELECT * FROM public.${table} WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 32
        ) SELECT NOT EXISTS(SELECT 1 FROM candidates ${alias} WHERE ${predicate}) AS valid,
          (SELECT count(*)::int FROM candidates) AS count,
          (SELECT id::text FROM candidates ORDER BY id DESC LIMIT 1) AS last_id
      `, [cursor]))[0];
      if (!page?.valid) throw new Error("Incoherent small batch originals/counters; recovery is blocked");
      if (!Number.isInteger(page.count) || page.count < 0 || page.count > 32
        || (page.count === 0 ? page.last_id !== null : page.last_id === null || page.last_id === cursor)) {
        throw new Error("Invalid small batch validation page; recovery is blocked");
      }
      checked += BigInt(page.count);
      if (page.count < 32) break;
      cursor = page.last_id;
    }
    if (checked !== BigInt(expected)) throw new Error("Incomplete small batch validation; recovery is blocked");
  }
  return { smallBatchShape: "saturn.small-file-batch.v1", smallBatchOperations: state.operations, smallBatches: state.batches, smallBatchMetadataBytes: state.bytes };
}
