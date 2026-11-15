import postgres, { type Sql, type TransactionSql } from "postgres";
import type { WorkerHeartbeat } from "@saturn/contracts";
import { setTimeout as delay } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const SATURN_MAINTENANCE_LOCK = 1_397_967_206;
const backendRollbackReasons = new Set(["operation_reused", "capacity", "backend_draining", "invalid_input"]);
const backendRequestHash = (command: string, identity: string | undefined, payload: string | undefined): string =>
  createHash("sha256").update(JSON.stringify([command, identity, payload])).digest("hex");

export interface DatabaseOptions {
  readonly max?: number;
  readonly maintenanceBarrier?: boolean;
  /** Explicitly share request admission, never SQL sessions or credentials. */
  readonly maintenanceScope?: Database;
}

function maintenanceEndpoint(databaseUrl: string): string | undefined {
  try {
    const url = new URL(databaseUrl);
    // An omitted database can default to the SQL user and is not shareable.
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/") return undefined;
    url.username = "";
    url.password = "";
    if (!url.port) url.port = "5432";
    return url.toString();
  } catch { return undefined; }
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
  readonly #backendCommandSql: Sql;
  readonly #catalogCommandSql: Sql;
  readonly #maintenanceContext: AsyncLocalStorage<{ active: boolean }>;
  readonly #maintenanceEndpoint: string | undefined;
  #lockRequests = 0;
  readonly #maintenanceBarrier: boolean;
  #atomicMaintenanceAvailable: Promise<boolean> | undefined;
  readonly #backendRollbacks = new WeakMap<object, { readonly requestHash: string; readonly witness: object }>();
  readonly #backendCompoundRollbacks = new WeakMap<object, { readonly requestHash: string; readonly witness: object }>();

  constructor(databaseUrl: string, options: DatabaseOptions = {}) {
    this.#maintenanceBarrier = options.maintenanceBarrier ?? false;
    this.#maintenanceEndpoint = maintenanceEndpoint(databaseUrl);
    const owner = options.maintenanceScope;
    this.#maintenanceContext = this.#maintenanceBarrier && owner !== undefined && owner.#maintenanceBarrier &&
      this.#maintenanceEndpoint !== undefined && this.#maintenanceEndpoint === owner.#maintenanceEndpoint
      ? owner.#maintenanceContext : new AsyncLocalStorage<{ active: boolean }>();
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
    // This pool exposes only one fixed, atomic command below. No caller can
    // change its session defaults or borrow it for an unrelated transaction.
    // Startup parameters also apply to replacement connections after a failure.
    // postgres accepts max_pipeline at runtime, but omits it from its option types.
    const noCommandPipelining = { max_pipeline: 0 };
    this.#backendCommandSql = postgres(databaseUrl, {
      max: Math.min(options.max ?? 4, 4), idle_timeout: 20, connect_timeout: 10,
      max_lifetime: 60 * 30, prepare: true, ...noCommandPipelining, transform: { undefined: null },
      connection: { plan_cache_mode: "force_generic_plan", statement_timeout: 3000, lock_timeout: 2000, default_transaction_isolation: "read committed", application_name: "saturn_backend_command" },
    });
    // A batch/group is one atomic statement. This private pool cannot be
    // borrowed to change session settings or keep an application transaction open.
    this.#catalogCommandSql = postgres(databaseUrl, {
      max: Math.min(options.max ?? 4, 4), idle_timeout: 20, connect_timeout: 10,
      max_lifetime: 60 * 30, prepare: true, ...noCommandPipelining, transform: { undefined: null },
      connection: { plan_cache_mode: "force_generic_plan", statement_timeout: 2000, lock_timeout: 2000, idle_in_transaction_session_timeout: 2000, default_transaction_isolation: "read committed", application_name: "saturn_catalog_command" },
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

  /** One independent PostgreSQL statement, including the function's complete
   * transaction. Deadlines belong to its private pool, not a borrowed session.
   * Maintenance admission is acquired before a command can consume that pool. */
  async backendCommand(command: string, identity: unknown, payload: unknown, rollbackWitness?: object): Promise<unknown> {
    if (this.#maintenanceBarrier && this.#maintenanceContext.getStore()?.active !== true) {
      if (await this.#supportsAtomicMaintenance()) return this.#backendStatement(command, identity, payload, true, rollbackWitness);
      return this.#withMaintenanceAdmission(this.#queryAdmissionSql, () => this.backendCommand(command, identity, payload, rollbackWitness));
    }
    return this.#backendStatement(command, identity, payload, false, rollbackWitness);
  }

  /** Evidence belongs to this exact SQL invocation, not to error properties or
   * a later maintenance-unlock failure. The caller retains its opaque witness. */
  confirmsBackendRollback(error: unknown, command: string, identity: unknown, payload: unknown, witness: object): boolean {
    if (typeof error !== "object" || error === null) return false;
    const proof = this.#backendRollbacks.get(error);
    if (!proof || proof.witness !== witness) return false;
    try { return proof.requestHash === backendRequestHash(command, JSON.stringify(identity), JSON.stringify(payload)); }
    catch { return false; }
  }

  async #backendStatement(command: string, identity: unknown, payload: unknown, atomicMaintenance: boolean, witness?: object): Promise<unknown> {
    const identityJson = JSON.stringify(identity), payloadJson = JSON.stringify(payload);
    const query = atomicMaintenance ? this.#backendCommandSql<{ value: unknown }[]>`
      SELECT public.sync_maintenance_command('backend',${command},${identityJson}::text::jsonb,${payloadJson}::text::jsonb) AS value`
      : this.#backendCommandSql<{ value: unknown }[]>`
      SELECT public.sync_backend_command(${command},${identityJson}::text::jsonb,${payloadJson}::text::jsonb) AS value`;
    // Catch only rejection of the fixed atomic statement. Preserve the actual
    // driver error; successful results and outer cleanup cannot mint evidence.
    const rows = await query.catch((error: unknown) => {
      if (witness && ["submit", "submit-once"].includes(command) && error instanceof postgres.PostgresError
        && error.severity === "ERROR" && error.code === "P0001" && backendRollbackReasons.has(error.message)) {
        this.#backendRollbacks.set(error, { requestHash: backendRequestHash(command, identityJson, payloadJson), witness });
      }
      throw error;
    });
    return rows[0]?.value;
  }

  /** One atomic statement: a local owner may submit and observe one ordinary
   * durable claim. The caller must have an actual free worker; returned state
   * alone is never permission to execute a physical task. */
  async backendSubmitAndClaim(command: string, identity: unknown, payload: unknown, witness?: object): Promise<unknown> {
    if (!["submit", "submit-once"].includes(command)) throw Error("invalid_input");
    if (this.#maintenanceBarrier && this.#maintenanceContext.getStore()?.active !== true) {
      if (await this.#supportsAtomicMaintenance()) return this.#backendSubmitAndClaimStatement(command, identity, payload, true, witness);
      return this.#withMaintenanceAdmission(this.#queryAdmissionSql, () => this.backendSubmitAndClaim(command, identity, payload, witness));
    }
    return this.#backendSubmitAndClaimStatement(command, identity, payload, false, witness);
  }

  /** Claim observer evidence only, not authority to delete a payload. */
  confirmsBackendSubmitClaimRollback(error: unknown, command: string, identity: unknown, payload: unknown, witness: object): boolean {
    if (typeof error !== "object" || error === null) return false;
    const proof = this.#backendCompoundRollbacks.get(error);
    if (!proof || proof.witness !== witness) return false;
    try { return proof.requestHash === backendRequestHash(command, JSON.stringify(identity), JSON.stringify(payload)); }
    catch { return false; }
  }

  async #backendSubmitAndClaimStatement(command: string, identity: unknown, payload: unknown, atomicMaintenance: boolean, witness?: object): Promise<unknown> {
    const identityJson = JSON.stringify(identity), payloadJson = JSON.stringify(payload);
    const query = atomicMaintenance
      ? this.#backendCommandSql<{ value: unknown }[]>`
      WITH submitted AS MATERIALIZED (
        SELECT public.sync_maintenance_command('backend',${command},${identityJson}::text::jsonb,${payloadJson}::text::jsonb) AS value
      )
      SELECT jsonb_build_object('submitted',submitted.value,'task',CASE WHEN submitted.value->>'state'='QUEUED'
        THEN public.sync_maintenance_command('backend','claim',${identityJson}::text::jsonb,'{}'::jsonb) ELSE NULL::jsonb END) AS value
      FROM submitted`
      : this.#backendCommandSql<{ value: unknown }[]>`
      WITH submitted AS MATERIALIZED (
        SELECT public.sync_backend_command(${command},${identityJson}::text::jsonb,${payloadJson}::text::jsonb) AS value
      )
      SELECT jsonb_build_object('submitted',submitted.value,'task',CASE WHEN submitted.value->>'state'='QUEUED'
        THEN public.sync_backend_command('claim',${identityJson}::text::jsonb,'{}'::jsonb) ELSE NULL::jsonb END) AS value
      FROM submitted`;
    const rows = await query.catch((error: unknown) => {
      if (witness && error instanceof postgres.PostgresError && error.severity === "ERROR") {
        const proof = { requestHash: backendRequestHash(command, identityJson, payloadJson), witness };
        if (error.code === "P0001" && backendRollbackReasons.has(error.message)) {
          this.#backendRollbacks.set(error, proof);
          this.#backendCompoundRollbacks.set(error, proof);
        } else if (error.code === "55P03") {
          // As for an ordinary claim, this exact statement rolled back.
          // Deliberately do not extend fresh-payload deletion authority.
          this.#backendCompoundRollbacks.set(error, proof);
        }
      }
      throw error;
    });
    return rows[0]?.value;
  }

  async withSharedMaintenance<T>(action: () => Promise<T>): Promise<T> {
    return this.#withMaintenanceAdmission(this.#maintenanceSql, action);
  }
  /** An operation that outlives its HTTP response must own its lease instead
   * of inheriting the request's AsyncLocalStorage admission. */
  withDetachedSharedMaintenance<T>(action: () => Promise<T>): Promise<T> {
    return this.#maintenanceContext.run({ active: false }, () => this.withSharedMaintenance(action));
  }

  /** Fixed catalog entry points; PostgreSQL commits the entire function before
   * returning its result. An ambiguous response remains the caller's original. */
  async catalogUploadBatch(command: "batch" | "verify-claim-group" | "claim-set" | "publish-set" | "claim-cas-set" | "publish-cas-set" | "accept-job" | "start-job" | "status-job" | "execute-job", credential: unknown, payload: unknown): Promise<unknown> {
    if (this.#maintenanceBarrier && this.#maintenanceContext.getStore()?.active !== true) {
      if (await this.#supportsAtomicMaintenance()) return (await this.#catalogCommandSql<{ value: unknown }[]>`
        SELECT public.sync_maintenance_command('catalog',${command},${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]?.value;
      return this.#withMaintenanceAdmission(this.#queryAdmissionSql, () => this.catalogUploadBatch(command, credential, payload));
    }
    return (await this.#catalogCommandSql<{ value: unknown }[]>`
      SELECT public.catalog_upload_command(${command},'{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]?.value;
  }

  #supportsAtomicMaintenance(): Promise<boolean> {
    // An offline migration changes this capability; replacement runtimes probe
    // again. Never retry a mutation on a failed/ambiguous command response.
    return this.#atomicMaintenanceAvailable ??= this.#backendCommandSql<{ available: boolean }[]>`
      SELECT to_regprocedure('public.sync_maintenance_command(text,text,jsonb,jsonb)') IS NOT NULL AS available`
      .then(rows => rows[0]?.available === true)
      .catch((error: unknown) => { this.#atomicMaintenanceAvailable = undefined; throw error; });
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

  async withExclusiveMaintenance<T>(action: (sql: Sql) => Promise<T>, nonBlockingWaitMs?: number): Promise<T> {
    if (!this.#maintenanceBarrier) throw new Error("Database maintenance barrier is not enabled");
    if (nonBlockingWaitMs !== undefined && (!Number.isSafeInteger(nonBlockingWaitMs) || nonBlockingWaitMs < 1 || nonBlockingWaitMs > 120_000)) {
      throw new Error("Maintenance wait deadline is invalid");
    }
    const deadline = nonBlockingWaitMs === undefined ? undefined : Date.now() + nonBlockingWaitMs;
    const connection = await this.#maintenanceSql.reserve();
    try {
      if (deadline === undefined) {
        await connection`SELECT pg_advisory_lock(${SATURN_MAINTENANCE_LOCK})`;
      } else {
        // Startup cleanup must let an already admitted request finish through
        // its independent backend process. A queued exclusive advisory lock
        // would block that backend's new shared claim behind the request itself.
        let acquired = false;
        while (Date.now() < deadline) {
          const rows = await connection<{ acquired: boolean }[]>`SELECT pg_try_advisory_lock(${SATURN_MAINTENANCE_LOCK}) AS acquired`;
          if (rows[0]?.acquired) { acquired = true; break; }
          await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        }
        if (!acquired) throw new Error("Maintenance admission deadline exceeded");
      }
      try {
        // Queries made through this Database inside the exclusive callback
        // already hold admission. Taking a second shared lock would deadlock.
        const scope = { active: true };
        try { return await this.#maintenanceContext.run(scope, () => action(connection)); }
        finally { scope.active = false; }
      } finally {
        await connection`SELECT pg_advisory_unlock(${SATURN_MAINTENANCE_LOCK})`;
      }
    } finally {
      connection.release();
    }
  }

  async withExclusiveTransaction<T>(action: (sql: Sql) => Promise<T>, nonBlockingWaitMs?: number): Promise<T> {
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
    }, nonBlockingWaitMs);
  }

  async close(): Promise<void> {
    await Promise.all([this.#sql.end({ timeout: 5 }), this.#lockSql.end({ timeout: 5 }), this.#maintenanceSql.end({ timeout: 5 }), this.#queryAdmissionSql.end({ timeout: 5 }), this.#backendCommandSql.end({ timeout: 5 }), this.#catalogCommandSql.end({ timeout: 5 })]);
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
    }, 30_000);
  }
}

export { migrate, rollback, listMigrationPairs } from "./migrate.js";
export type { Sql } from "postgres";
