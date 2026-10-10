import postgres, { type Sql, type TransactionSql } from "postgres";
import type { WorkerHeartbeat } from "@saturn/contracts";
import { setTimeout as delay } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";

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
  readonly #lockSql: Sql;
  readonly #maintenanceSql: Sql;
  readonly #queryAdmissionSql: Sql;
  readonly #maintenanceContext = new AsyncLocalStorage<{ active: boolean }>();
  #lockRequests = 0;
  readonly #maintenanceBarrier: boolean;

  constructor(databaseUrl: string, options: DatabaseOptions = {}) {
    this.#maintenanceBarrier = options.maintenanceBarrier ?? false;
    this.#sql = postgres(databaseUrl, {
      max: options.max ?? 10,
      idle_timeout: 20,
      connect_timeout: 10,
      max_lifetime: 60 * 30,
      transform: { undefined: null },
      prepare: false,
    });
    // A lease must not consume the last connection used by the action it protects.
    this.#lockSql = postgres(databaseUrl, { max: 4, idle_timeout: 20, connect_timeout: 10 });
    this.#maintenanceSql = postgres(databaseUrl, { max: 8, idle_timeout: 20, connect_timeout: 10, prepare: false });
    // Status/authentication must not queue behind long filesystem leases.
    // Both admission pools acquire the same barrier before using query slots.
    this.#queryAdmissionSql = postgres(databaseUrl, { max: 8, idle_timeout: 20, connect_timeout: 10, prepare: false });
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
    if (!this.#maintenanceBarrier || this.#maintenanceContext.getStore()?.active === true) return action(this.#sql);
    // Wait for maintenance admission before using the query pool. Otherwise
    // new requests waiting behind an exclusive barrier can consume every query
    // connection needed by the admitted writers that must release that barrier.
    return this.#withMaintenanceAdmission(this.#queryAdmissionSql, () => action(this.#sql));
  }

  async transaction<T>(action: (sql: TransactionSql) => Promise<T>): Promise<T> {
    if (this.#maintenanceBarrier && this.#maintenanceContext.getStore()?.active !== true) {
      return this.#withMaintenanceAdmission(this.#queryAdmissionSql, () => this.transaction(action));
    }
    return await this.#sql.begin(action) as T;
  }

  async withSharedMaintenance<T>(action: () => Promise<T>): Promise<T> {
    return this.#withMaintenanceAdmission(this.#maintenanceSql, action);
  }

  async #withMaintenanceAdmission<T>(pool: Sql, action: () => Promise<T>): Promise<T> {
    if (!this.#maintenanceBarrier || this.#maintenanceContext.getStore()?.active === true) return action();
    const connection = await pool.reserve();
    try {
      await connection`SELECT pg_advisory_lock_shared(${SATURN_MAINTENANCE_LOCK})`;
      try {
        await this.#assertRecoveryReady(connection);
        const scope = { active: true };
        try { return await this.#maintenanceContext.run(scope, action); }
        finally { scope.active = false; }
      } finally {
        await connection`SELECT pg_advisory_unlock_shared(${SATURN_MAINTENANCE_LOCK})`;
      }
    } finally {
      connection.release();
    }
  }

  async withExclusiveMaintenance<T>(action: (sql: Sql) => Promise<T>): Promise<T> {
    if (!this.#maintenanceBarrier) throw new Error("Database maintenance barrier is not enabled");
    const connection = await this.#maintenanceSql.reserve();
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
    await Promise.all([this.#sql.end({ timeout: 5 }), this.#lockSql.end({ timeout: 5 }), this.#maintenanceSql.end({ timeout: 5 }), this.#queryAdmissionSql.end({ timeout: 5 })]);
  }

  async #assertRecoveryReady(sql: Sql): Promise<void> {
    const rows = await sql<{ pending: boolean }[]>`SELECT to_regnamespace('_saturn_restore_guard') IS NOT NULL AS pending`;
    if (rows[0]?.pending) throw new Error("Interrupted recovery: original database is preserved; operator rollback is required");
  }

  async withAdvisoryLock<T>(key: string, action: () => Promise<T>, waitMs = 30_000): Promise<T> {
    if (this.#lockRequests >= 32) throw new Error("Database operation queue is full");
    if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 120_000) throw new Error("Lock wait deadline is invalid");
    this.#lockRequests++;
    const deadline = Date.now() + waitMs;
    const reservation = { expired: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = this.#lockSql.reserve();
    // A timed-out pool reservation still has to release its eventual connection.
    void pending.then(connection => { if (reservation.expired) connection.release(); }, () => undefined);
    try {
      const connection = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reservation.expired = true; reject(new Error("Database lock queue deadline exceeded")); }, waitMs); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      let acquired = false;
      try {
        while (Date.now() < deadline) {
          const rows = await connection<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS acquired`;
          if (rows[0]?.acquired) { acquired = true; break; }
          await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        }
        if (!acquired) throw new Error("Database operation is locked");
        return await action();
      } finally {
        if (acquired) await connection`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() => undefined);
        connection.release();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (reservation.expired) void pending.finally(() => { this.#lockRequests--; }).catch(() => undefined);
      else this.#lockRequests--;
    }
  }

  async reconcileInactiveFileLocks(): Promise<void> {
    // API mutations, DAV requests and Worker jobs hold the shared maintenance
    // barrier for their entire filesystem operation. Exclusive ownership proves
    // no writer is still using a lease left behind by an interrupted process.
    // All API/Worker components must run the same coordinated release.
    await this.withExclusiveTransaction(async (sql) => {
      await sql`DELETE FROM operation_locks`;
      await sql`UPDATE operation_journal SET state='failed_retryable',error_code='verification_interrupted',updated_at=now()
        WHERE upload_id IN (SELECT id FROM upload_sessions WHERE status='verifying')`;
      await sql`UPDATE upload_sessions SET status = 'failed_retryable', updated_at = now()
        WHERE status = 'verifying'`;
      // One-shot DAV clients never receive a resumable upload ID. With no live
      // request left, incomplete attempts can only leave phantom active tasks.
      // Preserve verification/commit journals and every owner/Drop upload.
      const abandoned = await sql<{ id: string }[]>`
        UPDATE upload_sessions u SET status='abandoned', updated_at=now()
        WHERE u.audit_actor_type='device_token' AND u.idempotency_key LIKE 'dav-upload-%'
          AND u.status IN ('created','uploading','failed_retryable','failed_final')
          AND NOT EXISTS(SELECT 1 FROM operation_journal j WHERE j.upload_id=u.id
            AND j.error_code IN ('verification_interrupted','reconciliation_required'))
        RETURNING u.id
      `;
      if (abandoned.length > 0) await sql`
        UPDATE operation_journal SET state='abandoned', error_code='cleanup_pending', updated_at=now()
        WHERE upload_id IN ${sql(abandoned.map(item => item.id))}
      `;
      await sql`UPDATE reconciliation_runs SET state='failed', finished_at=now(), error_code='reconciliation_interrupted'
        WHERE state='running'`;
    });
  }
}

export { migrate, rollback, listMigrationPairs } from "./migrate.js";
export type { Sql } from "postgres";
