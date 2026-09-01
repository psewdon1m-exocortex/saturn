import type { Database } from "@saturn/database";
import { BACKUPS_RESOURCE_ID, LABORATORY_RESOURCE_ID, ROOT_RESOURCE_ID, type ResourceStatus } from "@saturn/file-core";
import type {
  InterruptedOperation,
  ReconciliationIssue,
  ReconciliationMode,
  ReconciliationRepository,
  ReconciliationRun,
  TrackedFile,
} from "./types.js";

interface RunRow {
  id: string;
  mode: ReconciliationMode;
  state: ReconciliationRun["state"];
  started_at: Date;
  finished_at: Date | null;
  scanned_resources: string;
  scanned_storage_entries: string;
  issue_count: string;
  error_code: string | null;
}

interface IssueRow {
  id: string;
  run_id: string;
  issue_type: ReconciliationIssue["issueType"];
  resource_id: string | null;
  storage_path: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  resolution: string;
}

function run(row: RunRow): ReconciliationRun {
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    scannedResources: Number(row.scanned_resources),
    scannedStorageEntries: Number(row.scanned_storage_entries),
    issueCount: Number(row.issue_count),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}

function issue(row: IssueRow): ReconciliationIssue {
  return {
    id: row.id,
    runId: row.run_id,
    issueType: row.issue_type,
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    storagePath: row.storage_path,
    expected: row.expected,
    actual: row.actual,
    resolution: row.resolution,
  };
}

export class PostgresReconciliationRepository implements ReconciliationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  startRun(id: string, mode: ReconciliationMode): Promise<ReconciliationRun> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<RunRow[]>`
        INSERT INTO reconciliation_runs (id, mode, state) VALUES (${id}, ${mode}, 'running') RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Reconciliation run insert returned no row");
      return run(row);
    });
  }

  finishRun(id: string, result: { readonly state: "complete" | "failed"; readonly scannedResources: number; readonly scannedStorageEntries: number; readonly issueCount: number; readonly errorCode?: string }): Promise<ReconciliationRun> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<RunRow[]>`
        UPDATE reconciliation_runs SET state = ${result.state}, finished_at = now(),
          scanned_resources = ${result.scannedResources}, scanned_storage_entries = ${result.scannedStorageEntries},
          issue_count = ${result.issueCount}, error_code = ${result.errorCode ?? null}
        WHERE id = ${id} RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Reconciliation run was not found");
      return run(row);
    });
  }

  listActiveFiles(afterId: string | undefined, limit: number): Promise<readonly TrackedFile[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ id: string; storage_path: string; size_bytes: string; sha256: string | null; status: ResourceStatus }[]>`
        SELECT id, storage_path, size_bytes, sha256, status FROM resources
        WHERE type = 'file' AND status = 'active' AND (${afterId ?? null}::uuid IS NULL OR id > ${afterId ?? null})
        ORDER BY id LIMIT ${limit}
      `;
      return rows.map((row) => ({
        id: row.id,
        storagePath: row.storage_path,
        sizeBytes: Number(row.size_bytes),
        ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
        status: row.status,
      }));
    });
  }

  listManagedRootPaths(): Promise<readonly string[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ storage_path: string }[]>`
        SELECT storage_path FROM resources
        WHERE parent_id = ${ROOT_RESOURCE_ID}
          AND type = 'folder'
          AND status = 'active'
          AND id NOT IN (${LABORATORY_RESOURCE_ID}, ${BACKUPS_RESOURCE_ID})
        ORDER BY storage_path
      `;
      return rows.map((row) => row.storage_path);
    });
  }

  hasResourceAtPath(storagePath: string): Promise<boolean> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ found: boolean }[]>`SELECT EXISTS (SELECT 1 FROM resources WHERE storage_path = ${storagePath}) AS found`;
      return rows[0]?.found ?? false;
    });
  }

  setResourceStatus(id: string, status: ResourceStatus): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`UPDATE resources SET status = ${status}, updated_at = now() WHERE id = ${id}`;
    });
  }

  listInterruptedOperations(): Promise<readonly InterruptedOperation[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ id: string; resource_id: string | null; state: string; payload: Record<string, unknown> }[]>`
        SELECT id, resource_id, state, payload FROM operation_journal
        WHERE state IN ('committing', 'storage_committing', 'storage_committed', 'rollback_failed')
          AND updated_at < now() - interval '5 minutes'
        ORDER BY updated_at LIMIT 1000
      `;
      return rows.map((row) => ({
        id: row.id,
        ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
        storagePath: typeof row.payload.newPath === "string"
          ? row.payload.newPath
          : typeof row.payload.targetPath === "string" ? row.payload.targetPath : "_system/unknown",
        state: row.state,
      }));
    });
  }

  addIssue(record: ReconciliationIssue): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`
        INSERT INTO reconciliation_issues (
          id, run_id, issue_type, resource_id, storage_path, expected, actual, resolution
        ) VALUES (${record.id}, ${record.runId}, ${record.issueType}, ${record.resourceId ?? null},
          ${record.storagePath}, ${sql.json(record.expected as never)}, ${sql.json(record.actual as never)}, ${record.resolution})
      `;
    });
  }

  listRuns(limit: number): Promise<readonly ReconciliationRun[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<RunRow[]>`SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT ${limit}`;
      return rows.map(run);
    });
  }

  listIssues(runId: string, limit: number): Promise<readonly ReconciliationIssue[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<IssueRow[]>`
        SELECT * FROM reconciliation_issues WHERE run_id = ${runId} ORDER BY created_at, id LIMIT ${limit}
      `;
      return rows.map(issue);
    });
  }
}
