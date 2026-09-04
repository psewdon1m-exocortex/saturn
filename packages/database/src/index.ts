import postgres, { type Sql, type TransactionSql } from "postgres";
import type { WorkerHeartbeat } from "@saturn/contracts";

const SATURN_MAINTENANCE_LOCK = 1_397_967_206;

export interface DatabaseOptions {
  readonly max?: number;
  readonly maintenanceBarrier?: boolean;
}

interface HeartbeatRow {
  readonly role: string;
  readonly instance_id: string;
  readonly last_seen_at: Date;
}

export class Database {
  readonly #sql: Sql;
  readonly #maintenanceBarrier: boolean;

  constructor(databaseUrl: string, options: DatabaseOptions = {}) {
    this.#maintenanceBarrier = options.maintenanceBarrier ?? false;
    this.#sql = postgres(databaseUrl, {
      max: options.max ?? 10,
      idle_timeout: 20,
      connect_timeout: 10,
      max_lifetime: 60 * 30,
      transform: { undefined: null },
    });
  }

  async ping(): Promise<number> {
    const started = performance.now();
    await this.withSql(async (sql) => { await sql`SELECT 1 AS healthy`; });
    return performance.now() - started;
  }

  async upsertWorkerHeartbeat(input: {
    readonly role: string;
    readonly instanceId: string;
    readonly startedAt: Date;
    readonly seenAt?: Date;
  }): Promise<void> {
    const seenAt = input.seenAt ?? new Date();
    await this.withSql(async (sql) => {
      await sql`
        INSERT INTO worker_heartbeats (role, instance_id, last_seen_at, started_at)
        VALUES (${input.role}, ${input.instanceId}, ${seenAt}, ${input.startedAt})
        ON CONFLICT (role) DO UPDATE SET
          instance_id = EXCLUDED.instance_id,
          last_seen_at = EXCLUDED.last_seen_at,
          started_at = EXCLUDED.started_at
      `;
    });
  }

  async getWorkerHeartbeat(role: string): Promise<WorkerHeartbeat | undefined> {
    const rows = await this.withSql((sql) => sql<HeartbeatRow[]>`
        SELECT role, instance_id, last_seen_at
        FROM worker_heartbeats
        WHERE role = ${role}
        LIMIT 1
      `);
    const row = rows[0];
    return row === undefined
      ? undefined
      : { role: row.role, instanceId: row.instance_id, lastSeenAt: row.last_seen_at };
  }

  async withSql<T>(action: (sql: Sql) => Promise<T>): Promise<T> {
    if (!this.#maintenanceBarrier) return action(this.#sql);
    return await this.#sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock_shared(${SATURN_MAINTENANCE_LOCK})`;
      return action(sql as unknown as Sql);
    }) as T;
  }

  async transaction<T>(action: (sql: TransactionSql) => Promise<T>): Promise<T> {
    return await this.#sql.begin(async (sql) => {
      if (this.#maintenanceBarrier) await sql`SELECT pg_advisory_xact_lock_shared(${SATURN_MAINTENANCE_LOCK})`;
      return action(sql);
    }) as T;
  }

  async withSharedMaintenance<T>(action: () => Promise<T>): Promise<T> {
    if (!this.#maintenanceBarrier) return action();
    const connection = await this.#sql.reserve();
    try {
      await connection`SELECT pg_advisory_lock_shared(${SATURN_MAINTENANCE_LOCK})`;
      try {
        return await action();
      } finally {
        await connection`SELECT pg_advisory_unlock_shared(${SATURN_MAINTENANCE_LOCK})`;
      }
    } finally {
      connection.release();
    }
  }

  async withExclusiveMaintenance<T>(action: (sql: Sql) => Promise<T>): Promise<T> {
    if (!this.#maintenanceBarrier) throw new Error("Database maintenance barrier is not enabled");
    const connection = await this.#sql.reserve();
    try {
      await connection`SELECT pg_advisory_lock(${SATURN_MAINTENANCE_LOCK})`;
      try {
        return await action(connection);
      } finally {
        await connection`SELECT pg_advisory_unlock(${SATURN_MAINTENANCE_LOCK})`;
      }
    } finally {
      connection.release();
    }
  }

  async withExclusiveTransaction<T>(action: (sql: Sql) => Promise<T>): Promise<T> {
    return this.withExclusiveMaintenance(async (connection) => {
      await connection.unsafe("BEGIN");
      try {
        const result = await action(connection);
        await connection.unsafe("COMMIT");
        return result;
      } catch (error) {
        await connection.unsafe("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }
}

export { migrate, rollback } from "./migrate.js";
