import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { StorageAdapter } from "@saturn/storage";
import fs from "node:fs/promises";
import path from "node:path";
import type { Database } from "@saturn/database";
import type { BackupMember, LogicalDatabaseToolchain, MetadataExporter, MetadataExportBudget } from "./types.js";
import { RecoveryCommitUncertainError } from "./types.js";
import { runPgProcess } from "./pg-process.js";
import { assertUnregisteredRecovery, guardRecoveryMutation, inspectJournal, withRecoverySnapshot, type RecoverySnapshot } from "./consistent-snapshot.js";

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
  readonly #snapshotTimeoutMs: number;
  #snapshotActive = false;
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
    readonly snapshotTimeoutMs?: number;
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
    this.#snapshotTimeoutMs = input.snapshotTimeoutMs ?? Math.min(input.commandTimeoutMs ?? 60_000,600_000);
    for (const timeout of [this.#commandTimeoutMs,this.#dumpIdleTimeoutMs]) if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("PostgreSQL deadline is invalid");
    if (!Number.isSafeInteger(this.#snapshotTimeoutMs) || this.#snapshotTimeoutMs < 1 || this.#snapshotTimeoutMs > 600_000) throw new Error("PostgreSQL snapshot deadline is invalid");
  }

  async createDump(outputPath: string, signal?: AbortSignal): Promise<void> {
    await this.#withSnapshot(signal, snapshot => this.#dumpFromSnapshot(outputPath, snapshot));
  }

  async createCoherentBackup(outputPath: string, metadataDirectory: string, metadata: MetadataExporter, signal?: AbortSignal, budget?: MetadataExportBudget): Promise<readonly BackupMember[]> {
    const exportSnapshot = metadata.exportFromSnapshot?.bind(metadata);
    if (exportSnapshot === undefined) throw new Error("Coherent PostgreSQL backup requires a snapshot-aware metadata exporter");
    const created: string[] = [];
    try {
      return await this.#withSnapshot(signal, async snapshot => {
        // The same exported MVCC snapshot controls dump policy and every JSONL page.
        await this.#dumpFromSnapshot(outputPath, snapshot);
        created.push(outputPath);
        const remainingMetadataBytes = budget === undefined ? undefined : budget.totalBytes-(await fs.stat(outputPath)).size-65_536;
        if(remainingMetadataBytes!==undefined && remainingMetadataBytes<1)throw new Error('Backup dump exceeds the remaining extracted byte budget');
        const members = await exportSnapshot(metadataDirectory, budget === undefined ? snapshot : {
          ...snapshot, exportBudget: {totalBytes:remainingMetadataBytes ?? 0,memberBytes:budget.memberBytes},
        });
        created.push(...members.map(member => member.sourcePath));
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(outputPath)) { snapshot.signal.throwIfAborted(); hash.update(Buffer.from(chunk as Uint8Array)); }
        const manifestPath = path.join(metadataDirectory, "coherence.json");
        await fs.writeFile(manifestPath, `${JSON.stringify({
          schema: "saturn.backup-coherence.v1", snapshotId: snapshot.snapshotId, snapshotStartedAt: snapshot.startedAt,
          journal: snapshot.journal, clockCutMember: snapshot.journal.shape === "legacy" ? null : "metadata/sync_root_clock.jsonl",
          databaseDumpSha256: hash.digest("hex"), metadataAuthority: "diagnostic-only-same-cut",
          registeredRootRecovery: "blocked-requires-backend-reconciliation",
        }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        created.push(manifestPath);
        return [...members, { path: "metadata/coherence.json", sourcePath: manifestPath, mediaType: "application/json" }];
      });
    } catch (error) { await Promise.all(created.map(file => fs.rm(file, { force: true }))); throw error; }
  }

  async #withSnapshot<T>(signal: AbortSignal | undefined, action: (snapshot: RecoverySnapshot) => Promise<T>): Promise<T> {
    if (this.#snapshotActive) throw new Error("A consistent backup snapshot is already running in this toolchain");
    this.#snapshotActive = true;
    try { return await withRecoverySnapshot(this.#database, this.#snapshotTimeoutMs, signal, action); }
    finally { this.#snapshotActive = false; }
  }

  async #dumpFromSnapshot(outputPath: string, snapshot: RecoverySnapshot): Promise<void> {
    const connection = connectionArguments(this.#databaseUrl);
    await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    if (await fs.stat(outputPath).then(() => true, (error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; })) {
      throw new Error("Database dump destination already exists");
    }
    try { await runPgProcess({ executable: this.#pgDumpExecutable, args: [
      ...this.#pgDumpPrefixArgs,
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--no-acl",
      "--schema=public",
      `--snapshot=${snapshot.snapshotId}`,
      ...RECOVERY_TRANSIENT_TABLES.filter(table => snapshot.journal.dumpPolicy === "legacy-transient"
        || table !== "operation_journal" && table !== "upload_sessions").map((table) => `--exclude-table-data=public.${table}`),
      ...(this.#commandConnectionArgs ?? connection.args),
    ], environment: { ...connection.environment, PGCONNECT_TIMEOUT: "10" }, timeoutMs: this.#commandTimeoutMs,
      idleTimeoutMs: this.#dumpIdleTimeoutMs, outputPath, maximumBytes: this.#maximumDumpBytes, signal: snapshot.signal });
    } catch (error) {
      await fs.rm(outputPath, { force: true });
      throw error;
    }
  }

  async restoreDump(dumpPath: string, mode: "clean" | "replace", signal?: AbortSignal): Promise<void> {
    if (mode === "replace" && this.#replacementSchema === undefined) throw new Error("Replacement restore must preserve the original schema first");
    if (mode === "clean" && this.#replacementSchema === undefined) await this.beginCleanRestore();
    const connection = connectionArguments(this.#databaseUrl);
    await runPgProcess({ executable: this.#pgRestoreExecutable, args: [
      ...this.#pgRestorePrefixArgs,
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      "--clean",
      "--if-exists",
      ...(this.#commandConnectionArgs ?? connection.args),
    ], environment: { ...connection.environment, PGCONNECT_TIMEOUT: "10", PGOPTIONS: `-c statement_timeout=${String(this.#commandTimeoutMs)} -c lock_timeout=${String(Math.min(this.#commandTimeoutMs,30_000))}` },
      inputPath: dumpPath, timeoutMs: this.#commandTimeoutMs, ...(signal === undefined ? {} : { signal }) });
  }

  async beginCleanRestore(): Promise<void> {
    if (this.#replacementSchema !== undefined) throw new Error("A replacement restore is already active");
    await this.#beginReplacement(true);
  }

  async #assertEmptySchema(sql: Parameters<Parameters<Database["transaction"]>[0]>[0], schema: string): Promise<void> {
        const rows = await sql<{ readonly occupied: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema}
            UNION ALL
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${schema}
            UNION ALL
            SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE n.nspname = ${schema} AND t.typtype IN ('d', 'e', 'r')
            UNION ALL
            SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE n.nspname=${schema}
          ) AS occupied
        `;
      if (rows[0]?.occupied !== false) throw new Error("Clean restore target must have an empty public schema");
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
    await this.#beginReplacement(false);
  }

  async #beginReplacement(clean: boolean): Promise<void> {
    const original = `_saturn_original_${randomUUID().replaceAll("-", "")}`;
    await this.#database.transaction(async sql => {
      await sql.unsafe(`SET LOCAL lock_timeout='${String(Math.min(this.#commandTimeoutMs, 10_000))}ms'`);
      await guardRecoveryMutation(sql);
      if (clean) await this.#assertEmptySchema(sql,"public");
      const originalNamespace = (await sql<{ namespace_id: string }[]>`SELECT to_regnamespace('public')::oid::text AS namespace_id`)[0]?.namespace_id;
      if(originalNamespace===undefined)throw new Error('Recovery source namespace is unavailable');
      const extensions = await sql`SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE n.nspname='public'`;
      if (extensions.length > 0) throw new Error("Replacement restore requires extensions outside the public schema");
      // Creating the guard fails if another replacement or an interrupted one exists.
      await sql`CREATE SCHEMA _saturn_restore_guard`;
      await sql`CREATE TABLE _saturn_restore_guard.state (original_schema text PRIMARY KEY)`;
      await sql`INSERT INTO _saturn_restore_guard.state VALUES (${original})`;
      await sql.unsafe(`ALTER SCHEMA public RENAME TO "${original}"`);
      const renamedNamespace = (await sql<{ namespace_id: string }[]>`SELECT to_regnamespace(${original})::oid::text AS namespace_id`)[0]?.namespace_id;
      if(renamedNamespace!==originalNamespace)throw new Error('Recovery preserved namespace identity changed');
      if(clean)await this.#assertEmptySchema(sql,original);
      await sql`CREATE SCHEMA public`;
    });
    this.#replacementSchema = original;
  }

  async commitReplacement(): Promise<void> {
    if (this.#replacementSchema === undefined) throw new Error("No replacement restore is active");
    const original = this.#replacementSchema;
    try {
      await this.#database.transaction(async sql => {
        await guardRecoveryMutation(sql);
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
      assertUnregisteredRecovery(await inspectJournal(sql));
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
