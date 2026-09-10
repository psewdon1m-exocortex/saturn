import type { Database } from "@saturn/database";
import type { ArchiveJobRepository } from "./repository.js";
import type { ArchiveFormat, ArchiveJob, ArchiveJobKind, ArchiveJobState, ArchiveRequestedState } from "./types.js";

interface ArchiveJobRow {
  readonly id: string;
  readonly kind: ArchiveJobKind;
  readonly format: ArchiveFormat;
  readonly state: ArchiveJobState;
  readonly requested_state: ArchiveRequestedState;
  readonly destination_parent_id: string;
  readonly source_resource_id: string | null;
  readonly source_resource_ids: readonly string[];
  readonly output_name: string;
  readonly total_bytes: string;
  readonly processed_bytes: string;
  readonly current_item: string | null;
  readonly result_resource_id: string | null;
  readonly failure_code: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly completed_at: Date | null;
}

function mapJob(row: ArchiveJobRow): ArchiveJob {
  return {
    id: row.id,
    kind: row.kind,
    format: row.format,
    state: row.state,
    requestedState: row.requested_state,
    destinationParentId: row.destination_parent_id,
    ...(row.source_resource_id === null ? {} : { sourceResourceId: row.source_resource_id }),
    sourceResourceIds: row.source_resource_ids,
    outputName: row.output_name,
    totalBytes: Number(row.total_bytes),
    processedBytes: Number(row.processed_bytes),
    ...(row.current_item === null ? {} : { currentItem: row.current_item }),
    ...(row.result_resource_id === null ? {} : { resultResourceId: row.result_resource_id }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

export class PostgresArchiveJobRepository implements ArchiveJobRepository {
  constructor(private readonly database: Database) {}

  create(job: ArchiveJob): Promise<ArchiveJob> {
    return this.database.withSql(async (sql) => {
      const rows = await sql<ArchiveJobRow[]>`
        INSERT INTO archive_jobs (
          id, kind, format, state, requested_state, destination_parent_id,
          source_resource_id, source_resource_ids, output_name, total_bytes,
          processed_bytes, created_at, updated_at
        ) VALUES (
          ${job.id}, ${job.kind}, ${job.format}, ${job.state}, ${job.requestedState},
          ${job.destinationParentId}, ${job.sourceResourceId ?? null}, ${job.sourceResourceIds},
          ${job.outputName}, ${job.totalBytes}, ${job.processedBytes}, ${job.createdAt}, ${job.updatedAt}
        ) RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Archive job creation failed");
      return mapJob(row);
    });
  }

  get(id: string): Promise<ArchiveJob | undefined> {
    return this.database.withSql(async (sql) => {
      const rows = await sql<ArchiveJobRow[]>`SELECT * FROM archive_jobs WHERE id = ${id} LIMIT 1`;
      return rows[0] === undefined ? undefined : mapJob(rows[0]);
    });
  }

  list(destinationParentId: string | undefined, limit: number): Promise<readonly ArchiveJob[]> {
    return this.database.withSql(async (sql) => {
      const rows = destinationParentId === undefined
        ? await sql<ArchiveJobRow[]>`SELECT * FROM archive_jobs ORDER BY created_at DESC, id DESC LIMIT ${limit}`
        : await sql<ArchiveJobRow[]>`SELECT * FROM archive_jobs WHERE destination_parent_id = ${destinationParentId} ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
      return rows.map(mapJob);
    });
  }

  claimNext(workerId: string, leaseMs: number, now: Date): Promise<ArchiveJob | undefined> {
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    return this.database.transaction(async (sql) => {
      await sql`
        UPDATE archive_jobs SET state = 'cancelled', completed_at = ${now}, updated_at = ${now},
          lease_owner = NULL, lease_expires_at = NULL
        WHERE requested_state = 'cancelled' AND state NOT IN ('completed', 'failed', 'cancelled')
      `;
      await sql`
        UPDATE archive_jobs SET state = 'paused', updated_at = ${now}, lease_owner = NULL, lease_expires_at = NULL
        WHERE requested_state = 'paused' AND state = 'queued'
      `;
      const rows = await sql<ArchiveJobRow[]>`
        SELECT * FROM archive_jobs
        WHERE requested_state = 'running'
          AND state IN ('queued', 'scanning', 'compressing', 'extracting', 'verifying', 'committing', 'paused')
          AND (lease_expires_at IS NULL OR lease_expires_at < ${now})
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      const row = rows[0];
      if (row === undefined) return undefined;
      const claimed = await sql<ArchiveJobRow[]>`
        UPDATE archive_jobs SET
          state = CASE WHEN state IN ('queued', 'paused') THEN 'scanning' ELSE state END,
          lease_owner = ${workerId}, lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}, failure_code = NULL
        WHERE id = ${row.id}
        RETURNING *
      `;
      return claimed[0] === undefined ? undefined : mapJob(claimed[0]);
    });
  }

  setState(id: string, state: ArchiveJobState, fields: {
    readonly processedBytes?: number;
    readonly totalBytes?: number;
    readonly currentItem?: string | null;
    readonly resultResourceId?: string;
    readonly failureCode?: string | null;
    readonly completedAt?: Date;
  } = {}): Promise<ArchiveJob> {
    return this.database.withSql(async (sql) => {
      const rows = await sql<ArchiveJobRow[]>`
        UPDATE archive_jobs SET state = ${state},
          processed_bytes = coalesce(${fields.processedBytes ?? null}, processed_bytes),
          total_bytes = coalesce(${fields.totalBytes ?? null}, total_bytes),
          current_item = CASE WHEN ${fields.currentItem === undefined} THEN current_item ELSE ${fields.currentItem ?? null} END,
          result_resource_id = coalesce(${fields.resultResourceId ?? null}, result_resource_id),
          failure_code = CASE WHEN ${fields.failureCode === undefined} THEN failure_code ELSE ${fields.failureCode ?? null} END,
          completed_at = coalesce(${fields.completedAt ?? null}, completed_at),
          updated_at = now(),
          lease_owner = CASE WHEN ${["completed", "failed", "cancelled", "paused"].includes(state)} THEN NULL ELSE lease_owner END,
          lease_expires_at = CASE WHEN ${["completed", "failed", "cancelled", "paused"].includes(state)} THEN NULL ELSE lease_expires_at END
        WHERE id = ${id}
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Archive job not found");
      return mapJob(row);
    });
  }

  setRequestedState(id: string, state: ArchiveRequestedState): Promise<ArchiveJob> {
    return this.database.withSql(async (sql) => {
      const rows = await sql<ArchiveJobRow[]>`
        UPDATE archive_jobs SET requested_state = ${state},
          state = CASE
            WHEN ${state} = 'running' AND state = 'paused' THEN 'queued'
            WHEN ${state} = 'paused' AND state = 'queued' THEN 'paused'
            WHEN ${state} = 'cancelled' AND state IN ('queued', 'paused') THEN 'cancelled'
            ELSE state
          END,
          completed_at = CASE WHEN ${state} = 'cancelled' AND state IN ('queued', 'paused') THEN now() ELSE completed_at END,
          updated_at = now()
        WHERE id = ${id} AND state NOT IN ('completed', 'failed', 'cancelled')
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Archive job is not controllable");
      return mapJob(row);
    });
  }

  renewLease(id: string, workerId: string, leaseMs: number, now: Date): Promise<void> {
    return this.database.withSql(async (sql) => {
      await sql`
        UPDATE archive_jobs SET lease_expires_at = ${new Date(now.getTime() + leaseMs)}, updated_at = ${now}
        WHERE id = ${id} AND lease_owner = ${workerId}
      `;
    });
  }
}
