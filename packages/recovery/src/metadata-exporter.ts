import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "@saturn/database";
import type { BackupMember } from "./types.js";

interface ExportDefinition {
  readonly table: string;
  readonly cursor: string;
  readonly name: string;
  readonly columns?: string;
}

const exports: readonly ExportDefinition[] = [
  { table: "_vault_migrations", cursor: "name", name: "migrations" },
  { table: "resources", cursor: "id", name: "resources" },
  { table: "file_versions", cursor: "id", name: "file_versions" },
  { table: "operation_journal", cursor: "id", name: "operation_journal" },
  { table: "audit_events", cursor: "sequence", name: "audit_events" },
  { table: "reconciliation_runs", cursor: "id", name: "reconciliation_runs" },
  { table: "reconciliation_issues", cursor: "id", name: "reconciliation_issues" },
  { table: "backup_runs", cursor: "id", name: "backup_runs" },
  { table: "recovery_runs", cursor: "id", name: "recovery_runs" },
  { table: "telegram_binding", cursor: "owner_id", name: "telegram_binding" },
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
    columns: "id, slug, name, state, require_encryption, mtls_cert_fingerprint, max_backup_bytes, daily_quota_bytes, stored_quota_bytes, max_concurrent_runs, freshness_sla_ms, retention_daily, retention_weekly, retention_monthly, retention_yearly, last_used_at, created_at, updated_at, revoked_at",
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
  readonly cursor_value: string | number;
  readonly value: Record<string, unknown>;
}

export class DatabaseMetadataExporter {
  readonly #database: Database;
  readonly #pageSize: number;

  constructor(database: Database, pageSize = 500) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 2_000) throw new Error("Metadata export page size is invalid");
    this.#database = database;
    this.#pageSize = pageSize;
  }

  async exportTo(directory: string): Promise<readonly BackupMember[]> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const members: BackupMember[] = [];
    for (const definition of exports) {
      const outputPath = path.join(directory, `${definition.name}.jsonl`);
      const handle = await fs.open(outputPath, "wx", 0o600);
      try {
        let cursor: string | number | undefined;
        for (;;) {
          const rows = await this.#database.withSql((sql) => {
            const where = cursor === undefined ? "" : `WHERE ${definition.cursor} > $1`;
            const parameters = cursor === undefined ? [this.#pageSize] : [cursor, this.#pageSize];
            const limitParameter = cursor === undefined ? "$1" : "$2";
            return sql.unsafe<ExportRow[]>(`
              SELECT export_row.${definition.cursor} AS cursor_value, to_jsonb(export_row) AS value
              FROM (
                SELECT ${definition.columns ?? "*"} FROM ${definition.table}
                ${where}
                ORDER BY ${definition.cursor}
                LIMIT ${limitParameter}
              ) AS export_row
              ORDER BY export_row.${definition.cursor}
            `, parameters);
          });
          for (const row of rows) await handle.write(`${JSON.stringify(row.value)}\n`, undefined, "utf8");
          if (rows.length < this.#pageSize) break;
          cursor = rows.at(-1)?.cursor_value;
          if (cursor === undefined) throw new Error("Metadata export cursor is missing");
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      members.push({ path: `metadata/${definition.name}.jsonl`, sourcePath: outputPath, mediaType: "application/x-ndjson" });
    }
    return members;
  }
}
