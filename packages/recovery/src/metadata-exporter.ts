import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "@saturn/database";
import type { BackupMember } from "./types.js";
import { withRecoverySnapshot, type RecoverySnapshot } from "./consistent-snapshot.js";

interface ExportDefinition {
  readonly table: string;
  readonly cursor: string;
  readonly name: string;
  readonly columns?: string;
  readonly composite?: boolean;
  readonly journal?: boolean;
}

const exports: readonly ExportDefinition[] = [
  { table: "_vault_migrations", cursor: "name", name: "migrations" },
  { table: "resources", cursor: "id", name: "resources" },
  { table: "file_versions", cursor: "id", name: "file_versions" },
  { table: "operation_journal", cursor: "id", name: "operation_journal" },
  { table: "upload_sessions", cursor: "id", name: "upload_sessions", journal: true },
  { table: "sync_root_clock", cursor: "root_id", name: "sync_root_clock", journal: true },
  { table: "catalog_guard_roots", cursor: "root_id", name: "catalog_guard_roots", journal: true },
  { table: "sync_small_batch_budget", cursor: "root_id", name: "sync_small_batch_budget", journal: true },
  { table: "sync_small_batch_operations", cursor: "id", name: "sync_small_batch_operations", journal: true },
  { table: "sync_small_batches", cursor: "id", name: "sync_small_batches", journal: true },
  { table: "sync_small_execution_jobs", cursor: "id", name: "sync_small_execution_jobs", journal: true },
  { table: "sync_root_changes", cursor: "seq", name: "sync_root_changes", composite: true, journal: true },
  { table: "audit_events", cursor: "sequence", name: "audit_events" },
  { table: "reconciliation_runs", cursor: "id", name: "reconciliation_runs" },
  { table: "reconciliation_issues", cursor: "id", name: "reconciliation_issues" },
  { table: "backup_runs", cursor: "id", name: "backup_runs" },
  { table: "recovery_runs", cursor: "id", name: "recovery_runs" },
  {
    table: "shares",
    cursor: "id",
    name: "shares",
    columns: "id, resource_id, resource_type, mode, state, expires_at, max_downloads, download_count, allowed_cidr, classification_ceiling, created_at, updated_at, revoked_at",
  },
  {
    table: "devices",
    cursor: "id",
    name: "devices",
    columns: "id, name, state, scope_ids, can_read, can_write, can_move, can_delete, expires_at, last_used_at, created_at, updated_at, revoked_at",
  },
  { table: "sync_conflicts", cursor: "id", name: "sync_conflicts" },
  {
    table: "backup_services", cursor: "id", name: "backup_services",
    columns: "id, slug, namespace_slug, deployment_id, name, state, require_encryption, mtls_cert_fingerprint, max_backup_bytes, daily_quota_bytes, stored_quota_bytes, max_concurrent_runs, freshness_sla_ms, retention_daily, retention_weekly, retention_monthly, retention_yearly, last_used_at, created_at, updated_at, revoked_at",
  },
  {
    table: "service_backup_runs", cursor: "id", name: "service_backup_runs",
    columns: "id, service_id, filename, source_created_at, backup_type, expected_size, expected_sha256, source_version, encrypted, state, received_size, final_path, receipt, failure_code, created_at, updated_at, committed_at",
  },
  { table: "service_backup_restore_tests", cursor: "id", name: "service_backup_restore_tests" },
  {
    table: "laboratory_clients", cursor: "id", name: "laboratory_clients",
    columns: "id, name, state, last_used_at, created_at, updated_at, revoked_at",
  },
  { table: "laboratory_assets", cursor: "id", name: "laboratory_assets" },
];

interface ExportRow {
  readonly cursor_value: string;
  readonly cursor_root: string | null;
  readonly cursor_epoch: string | null;
  readonly value_text: string | null;
  readonly row_bytes: string;
}

export class DatabaseMetadataExporter {
  readonly #database: Database;
  readonly #pageSize: number;
  readonly #maximumExportBytes: number | undefined;
  readonly #timeoutMs: number;

  constructor(database: Database, pageSize = 500, options: { readonly maximumExportBytes?: number; readonly timeoutMs?: number } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error("Metadata export page size is invalid");
    this.#database = database;
    this.#pageSize = pageSize;
    this.#maximumExportBytes = options.maximumExportBytes;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    if (this.#maximumExportBytes !== undefined && (!Number.isSafeInteger(this.#maximumExportBytes) || this.#maximumExportBytes < 1)
      || !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 600_000) throw new Error("Metadata export budget is invalid");
  }

  async exportTo(directory: string, signal?: AbortSignal): Promise<readonly BackupMember[]> {
    return withRecoverySnapshot(this.#database, this.#timeoutMs, signal, snapshot => this.exportFromSnapshot(directory, snapshot));
  }

  async exportFromSnapshot(directory: string, snapshot: RecoverySnapshot): Promise<readonly BackupMember[]> {
    snapshot.signal.throwIfAborted();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const members: BackupMember[] = [];
    const created: string[] = [];
    let totalBytes = 0;
    const maximumExportBytes = snapshot.exportBudget === undefined ? this.#maximumExportBytes ?? 256*1024*1024
      : Math.min(this.#maximumExportBytes ?? snapshot.exportBudget.totalBytes,snapshot.exportBudget.totalBytes);
    const maximumMemberBytes = snapshot.exportBudget?.memberBytes ?? maximumExportBytes;
    for(const bound of [maximumExportBytes,maximumMemberBytes]) if(!Number.isSafeInteger(bound)||bound<1)throw new Error('Metadata export budget is invalid');
    try {
    for (const definition of exports) {
      if (definition.journal && (snapshot.journal.shape === "legacy"
        || (definition.table === "catalog_guard_roots" && snapshot.journal.catalogGuardShape === undefined)
        || (definition.table.startsWith("sync_small_batch") && snapshot.journal.smallBatchShape === undefined)
        || (definition.table === 'sync_small_execution_jobs' && snapshot.journal.smallExecutionJobShape === undefined)
        || (definition.table === "upload_sessions" && snapshot.journal.dumpPolicy === "legacy-transient"))) continue;
      snapshot.signal.throwIfAborted();
      const bigintColumns = await snapshot.query<{ column_name: string }[]>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND data_type='bigint' ORDER BY ordinal_position
      `, [definition.table]);
      // The known table/column names come only from this static list and the catalog.
      // Top-level bigint fields, including clocks and receipts, are decimal strings.
      const bigintFields = bigintColumns.filter(row => definition.columns === undefined || definition.columns.split(", ").includes(row.column_name));
      const decimalProjection = bigintFields.length === 0 ? "" : ` || jsonb_build_object(${bigintFields
        .map(row => `'${row.column_name.replaceAll("'", "''")}',export_row."${row.column_name.replaceAll('"', '""')}"::text`).join(",")})`;
      const outputPath = path.join(directory, `${definition.name}.jsonl`);
      const handle = await fs.open(outputPath, "wx", 0o600);
      created.push(outputPath);
      let memberBytes = 0;
      try {
        let cursor: string | undefined;
        let root: string | undefined;
        let epoch: string | undefined;
        for (;;) {
          snapshot.signal.throwIfAborted();
          const order = definition.composite ? "root_id,epoch,seq" : definition.cursor;
          const where = cursor === undefined ? "" : definition.composite ? "WHERE (root_id,epoch,seq)>($1::uuid,$2::uuid,$3::bigint)" : `WHERE ${definition.cursor}>$1`;
          const parameters = cursor === undefined ? [this.#pageSize] : definition.composite ? [root, epoch, cursor, this.#pageSize] : [cursor, this.#pageSize];
          const rows = await snapshot.query<(ExportRow & Record<string, unknown>)[]>(`
            WITH page AS (
              SELECT ${definition.columns ?? "*"} FROM public.${definition.table} ${where}
              ORDER BY ${order} LIMIT $${String(parameters.length)}
            ), sized AS MATERIALIZED (
              SELECT export_row.${definition.cursor} AS cursor_value,
                ${definition.composite ? "root_id" : "NULL::uuid"} AS cursor_root,
                ${definition.composite ? "epoch" : "NULL::uuid"} AS cursor_epoch,
                octet_length((to_jsonb(export_row)${decimalProjection})::text)+1 AS row_bytes,
                row_number() OVER (ORDER BY ${order}) AS ordinal
              FROM page AS export_row
            ), bounded AS (
              SELECT *,sum(row_bytes) OVER (ORDER BY ordinal) AS cumulative_bytes FROM sized
            ) SELECT bounded.cursor_value::text,bounded.cursor_root::text,bounded.cursor_epoch::text,bounded.row_bytes::text,
              CASE WHEN row_bytes<=4194304 THEN (to_jsonb(export_row)${decimalProjection})::text ELSE NULL END AS value_text
              FROM bounded JOIN LATERAL (
                SELECT ${definition.columns ?? "*"} FROM public.${definition.table}
                WHERE ${definition.cursor}=bounded.cursor_value
                ${definition.composite ? "AND root_id=bounded.cursor_root AND epoch=bounded.cursor_epoch" : ""}
                LIMIT 1
              ) AS export_row ON true
              WHERE cumulative_bytes<=4194304 OR ordinal=1 ORDER BY ordinal
          `, parameters);
          if (rows.length === 0) break;
          for (const row of rows) {
            snapshot.signal.throwIfAborted();
            if (row.value_text === null || BigInt(row.row_bytes) > 4_194_304n) throw new Error("Metadata export row exceeds the 4 MiB page budget");
            const rowBytes = Buffer.byteLength(row.value_text, "utf8") + 1;
            totalBytes += rowBytes;memberBytes += rowBytes;
            if (totalBytes > maximumExportBytes) throw new Error("Metadata export exceeds its total byte budget");
            if (memberBytes > maximumMemberBytes) throw new Error("Metadata export exceeds its member byte budget");
            await handle.write(`${row.value_text}\n`, undefined, "utf8");
          }
          const last = rows.at(-1);
          if (last === undefined || last.cursor_value === cursor && !definition.composite) throw new Error("Metadata export cursor did not advance");
          cursor = last.cursor_value;
          root = last.cursor_root ?? undefined;
          epoch = last.cursor_epoch ?? undefined;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      members.push({ path: `metadata/${definition.name}.jsonl`, sourcePath: outputPath, mediaType: "application/x-ndjson" });
    }
    return members;
    } catch (error) {
      await Promise.all(created.map(file => fs.rm(file, { force: true })));
      throw error;
    }
  }
}
