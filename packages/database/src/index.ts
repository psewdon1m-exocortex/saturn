import postgres, { type Sql, type TransactionSql } from "postgres";
import type { WorkerHeartbeat } from "@saturn/contracts";

interface HeartbeatRow {
  readonly role: string;
  readonly instance_id: string;
  readonly last_seen_at: Date;
}

export class Database {
  readonly #sql: Sql;

  constructor(databaseUrl: string, options: { readonly max?: number } = {}) {
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
    await this.#sql`SELECT 1 AS healthy`;
    return performance.now() - started;
  }

  async upsertWorkerHeartbeat(input: {
    readonly role: string;
    readonly instanceId: string;
    readonly startedAt: Date;
    readonly seenAt?: Date;
  }): Promise<void> {
    const seenAt = input.seenAt ?? new Date();
    await this.#sql`
      INSERT INTO worker_heartbeats (role, instance_id, last_seen_at, started_at)
      VALUES (${input.role}, ${input.instanceId}, ${seenAt}, ${input.startedAt})
      ON CONFLICT (role) DO UPDATE SET
        instance_id = EXCLUDED.instance_id,
        last_seen_at = EXCLUDED.last_seen_at,
        started_at = EXCLUDED.started_at
    `;
  }

  async getWorkerHeartbeat(role: string): Promise<WorkerHeartbeat | undefined> {
    const rows = await this.#sql<HeartbeatRow[]>`
      SELECT role, instance_id, last_seen_at
      FROM worker_heartbeats
      WHERE role = ${role}
      LIMIT 1
    `;
    const row = rows[0];
    return row === undefined
      ? undefined
      : { role: row.role, instanceId: row.instance_id, lastSeenAt: row.last_seen_at };
  }

  withSql<T>(action: (sql: Sql) => Promise<T>): Promise<T> {
    return action(this.#sql);
  }

  async transaction<T>(action: (sql: TransactionSql) => Promise<T>): Promise<T> {
    return await this.#sql.begin(action) as T;
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }
}

export { migrate, rollback } from "./migrate.js";
