import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { StorageAdapter } from "@saturn/storage";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "@saturn/database";
import type { LogicalDatabaseToolchain } from "./types.js";
import { RecoveryCommitUncertainError } from "./types.js";
import { runPgProcess } from "./pg-process.js";

interface DatabaseConnectionArguments {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

export const RECOVERY_TRANSIENT_TABLES = [
  "web_sessions",
  "login_sessions",
  "operation_locks",
  "upload_sessions",
  // The journal can reference upload_sessions. Keeping its rows while
  // excluding upload session rows produces a dump that cannot satisfy its
  // foreign key when pg_restore recreates constraints.
  "operation_journal",
  "backup_runs",
  "recovery_runs",
  "auth_attempts",
  "drop_challenges",
  "drop_sessions",
  "drop_uploads",
  "drop_attempts",
  "share_sessions",
  "share_password_attempts",
  "share_packages",
  "device_delete_events",
  // Saved catalog reports and worker leases are reproducible operational state.
  "storage_catalog_jobs",
] as const;

function connectionArguments(databaseUrl: string): DatabaseConnectionArguments {
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error("Unsupported database URL protocol");
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("Database URL must select a database");
  return {
    args: [
      "--host", parsed.hostname,
      "--port", parsed.port || "5432",
      "--username", decodeURIComponent(parsed.username),
      "--dbname", database,
    ],
    environment: {
      ...process.env,
      ...(parsed.password ? { PGPASSWORD: decodeURIComponent(parsed.password) } : {}),
    },
  };
}

export class PostgresCommandToolchain implements LogicalDatabaseToolchain {
  readonly #databaseUrl: string;
  readonly #database: Database;
  readonly #pgDumpExecutable: string;
  readonly #pgRestoreExecutable: string;
  readonly #pgDumpPrefixArgs: readonly string[];
  readonly #pgRestorePrefixArgs: readonly string[];
  readonly #commandConnectionArgs: readonly string[] | undefined;
  readonly #maximumDumpBytes: number;
  readonly #commandTimeoutMs: number;
  readonly #dumpIdleTimeoutMs: number;
  #replacementSchema: string | undefined;

  constructor(input: {
    readonly databaseUrl: string;
    readonly database: Database;
    readonly pgDumpExecutable?: string;
    readonly pgRestoreExecutable?: string;
    readonly pgDumpPrefixArgs?: readonly string[];
    readonly pgRestorePrefixArgs?: readonly string[];
    readonly commandConnectionArgs?: readonly string[];
    readonly maximumDumpBytes: number;
    readonly commandTimeoutMs?: number;
    readonly dumpIdleTimeoutMs?: number;
  }) {
    this.#databaseUrl = input.databaseUrl;
    this.#database = input.database;
    this.#pgDumpExecutable = input.pgDumpExecutable ?? "pg_dump";
    this.#pgRestoreExecutable = input.pgRestoreExecutable ?? "pg_restore";
    this.#pgDumpPrefixArgs = input.pgDumpPrefixArgs ?? [];
    this.#pgRestorePrefixArgs = input.pgRestorePrefixArgs ?? [];
    this.#commandConnectionArgs = input.commandConnectionArgs;
    this.#maximumDumpBytes = input.maximumDumpBytes;
    this.#commandTimeoutMs = input.commandTimeoutMs ?? 15 * 60_000;
    this.#dumpIdleTimeoutMs = input.dumpIdleTimeoutMs ?? 2 * 60_000;
    for (const timeout of [this.#commandTimeoutMs,this.#dumpIdleTimeoutMs]) if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("PostgreSQL deadline is invalid");
  }

  async createDump(outputPath: string, signal?: AbortSignal): Promise<void> {
    const connection = connectionArguments(this.#databaseUrl);
    await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    try { await runPgProcess({ executable: this.#pgDumpExecutable, args: [
      ...this.#pgDumpPrefixArgs,
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--no-acl",
      "--schema=public",
      ...RECOVERY_TRANSIENT_TABLES.map((table) => `--exclude-table-data=${table}`),
      ...(this.#commandConnectionArgs ?? connection.args),
    ], environment: { ...connection.environment, PGCONNECT_TIMEOUT: "10" }, timeoutMs: this.#commandTimeoutMs,
      idleTimeoutMs: this.#dumpIdleTimeoutMs, outputPath, maximumBytes: this.#maximumDumpBytes, ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      await fs.rm(outputPath, { force: true });
      throw error;
    }
  }

  restoreDump(dumpPath: string, mode: "clean" | "replace", signal?: AbortSignal): Promise<void> {
    if (mode === "replace" && this.#replacementSchema === undefined) throw new Error("Replacement restore must preserve the original schema first");
    const connection = connectionArguments(this.#databaseUrl);
    return runPgProcess({ executable: this.#pgRestoreExecutable, args: [
      ...this.#pgRestorePrefixArgs,
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      ...(mode === "replace" ? ["--clean", "--if-exists"] : []),
      ...(this.#commandConnectionArgs ?? connection.args),
    ], environment: { ...connection.environment, PGCONNECT_TIMEOUT: "10", PGOPTIONS: `-c statement_timeout=${String(this.#commandTimeoutMs)} -c lock_timeout=${String(Math.min(this.#commandTimeoutMs,30_000))}` },
      inputPath: dumpPath, timeoutMs: this.#commandTimeoutMs, ...(signal === undefined ? {} : { signal }) });
  }

  async checkReady(): Promise<void> {
    await this.#database.withSql(async sql => {
      const rows = await sql<{ pending: boolean }[]>`SELECT to_regnamespace('_saturn_restore_guard') IS NOT NULL AS pending`;
      if (rows[0]?.pending) throw new Error("Interrupted restore: original database is preserved; run recovery-cli rollback-interrupted before resuming");
    });
    const connection = connectionArguments(this.#databaseUrl);
    await Promise.all([
      runPgProcess({ executable: this.#pgDumpExecutable, args: [...this.#pgDumpPrefixArgs,"--version"],environment: connection.environment,timeoutMs: Math.min(this.#commandTimeoutMs,10_000) }),
      runPgProcess({ executable: this.#pgRestoreExecutable, args: [...this.#pgRestorePrefixArgs,"--version"],environment: connection.environment,timeoutMs: Math.min(this.#commandTimeoutMs,10_000) }),
    ]);
  }

  async beginReplacement(): Promise<void> {
    const original = `_saturn_original_${randomUUID().replaceAll("-", "")}`;
    await this.#database.transaction(async sql => {
      const extensions = await sql`SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE n.nspname='public'`;
      if (extensions.length > 0) throw new Error("Replacement restore requires extensions outside the public schema");
      // Creating the guard fails if another replacement or an interrupted one exists.
      await sql`CREATE SCHEMA _saturn_restore_guard`;
      await sql`CREATE TABLE _saturn_restore_guard.state (original_schema text PRIMARY KEY)`;
      await sql`INSERT INTO _saturn_restore_guard.state VALUES (${original})`;
      await sql.unsafe(`ALTER SCHEMA public RENAME TO "${original}"`);
      await sql`CREATE SCHEMA public`;
    });
    this.#replacementSchema = original;
  }

  async commitReplacement(): Promise<void> {
    if (this.#replacementSchema === undefined) throw new Error("No replacement restore is active");
    const original = this.#replacementSchema;
    try {
      await this.#database.transaction(async sql => {
        await sql.unsafe(`DROP SCHEMA "${original}" CASCADE`);
        await sql`DROP SCHEMA _saturn_restore_guard CASCADE`;
      });
    } catch (error) {
      // COMMIT can succeed while its acknowledgement is lost. Rolling back the
      // storage profile then would pair the new catalog with the old storage.
      let status: { guard: boolean; original: boolean } | undefined;
      try {
        status = (await this.#database.withSql(sql => sql<{ guard: boolean; original: boolean }[]>`
          SELECT to_regnamespace('_saturn_restore_guard') IS NOT NULL AS guard,
                 to_regnamespace(${original}) IS NOT NULL AS original
        `))[0];
      } catch (inspectionError) {
        throw new RecoveryCommitUncertainError(new AggregateError([error, inspectionError]));
      }
      if (status === undefined || status.guard !== status.original) throw new RecoveryCommitUncertainError(error);
      if (status.guard) throw error;
    }
    this.#replacementSchema = undefined;
  }

  async rollbackReplacement(): Promise<void> {
    await this.#database.transaction(async sql => {
      const rows = await sql<{ original_schema: string }[]>`SELECT original_schema FROM _saturn_restore_guard.state`;
      const original = rows[0]?.original_schema;
      if (rows.length !== 1 || original === undefined || !/^_saturn_original_[a-f0-9]{32}$/.test(original)) throw new Error("Invalid restore guard; original schema has been preserved");
      await sql`DROP SCHEMA public CASCADE`;
      await sql.unsafe(`ALTER SCHEMA "${original}" RENAME TO public`);
      await sql`DROP SCHEMA _saturn_restore_guard CASCADE`;
    });
    this.#replacementSchema = undefined;
  }

  verifyRestoredDatabase(): Promise<Record<string, number>> {
    return this.#database.withSql(async (sql) => {
      const [resources, versions, audit, migrations] = await Promise.all([
        sql<{ count: string }[]>`SELECT count(*)::text AS count FROM resources`,
        sql<{ count: string }[]>`SELECT count(*)::text AS count FROM file_versions`,
        sql<{ count: string }[]>`SELECT count(*)::text AS count FROM audit_events`,
        sql<{ count: string }[]>`SELECT count(*)::text AS count FROM _vault_migrations`,
      ]);
      return {
        resources: Number(resources[0]?.count ?? -1),
        versions: Number(versions[0]?.count ?? -1),
        auditEvents: Number(audit[0]?.count ?? -1),
        migrations: Number(migrations[0]?.count ?? -1),
      };
    });
  }

  async verifyStorage(storage: StorageAdapter): Promise<void> {
    let cursor = "";
    for (;;) {
      const rows = await this.#database.withSql(sql => sql<{ id: string; storage_path: string; sha256: string; size_bytes: string }[]>`
        SELECT id::text, storage_path, sha256, size_bytes::text FROM file_versions
        WHERE id::text > ${cursor} AND state = 'active'
        ORDER BY id::text LIMIT 100
      `);
      for (const row of rows) {
        const hash = createHash('sha256');
        let bytes = 0;
        try {
          for await (const raw of await storage.openRead(row.storage_path)) {
            const chunk = Buffer.from(raw as Uint8Array); bytes += chunk.length; hash.update(chunk);
          }
        } catch (cause) { throw new Error(`Restored catalog cannot read stored file version ${row.id}`, { cause }); }
        if (bytes !== Number(row.size_bytes) || hash.digest('hex') !== row.sha256) throw new Error(`Restored catalog does not match stored file version ${row.id}`);
        cursor = row.id;
      }
      if (rows.length < 100) return;
    }
  }
}
