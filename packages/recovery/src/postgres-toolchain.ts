import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Database } from "@saturn/database";
import type { LogicalDatabaseToolchain } from "./types.js";

interface DatabaseConnectionArguments {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}

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

class ByteLimitTransform extends Transform {
  readonly #maximumBytes: number;
  #bytes = 0;

  constructor(maximumBytes: number) {
    super();
    this.#maximumBytes = maximumBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.#bytes += chunk.length;
    if (this.#bytes > this.#maximumBytes) {
      callback(new Error("PostgreSQL dump exceeds configured spool limit"));
      return;
    }
    callback(null, chunk);
  }
}

function runCommand(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  standardInputPath?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      windowsHide: true,
      stdio: [standardInputPath === undefined ? "ignore" : "pipe", "ignore", "pipe"],
    });
    let standardError = "";
    if (child.stderr === null) {
      child.kill("SIGKILL");
      reject(new Error(`${executable} did not expose stderr`));
      return;
    }
    child.stderr.on("data", (chunk: Buffer) => {
      standardError = `${standardError}${chunk.toString("utf8")}`.slice(-32_768);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited with code ${String(code)}: ${standardError.trim().slice(-2_000)}`));
    });
    if (standardInputPath !== undefined) {
      if (child.stdin === null) {
        child.kill("SIGKILL");
        reject(new Error(`${executable} did not expose stdin`));
        return;
      }
      const source = createReadStream(standardInputPath);
      source.on("error", (error) => {
        child.stdin?.destroy(error);
        child.kill("SIGKILL");
      });
      source.pipe(child.stdin);
    }
  });
}

export class PostgresCommandToolchain implements LogicalDatabaseToolchain {
  readonly #databaseUrl: string;
  readonly #database: Database;
  readonly #pgDumpExecutable: string;
  readonly #pgRestoreExecutable: string;
  readonly #pgDumpPrefixArgs: readonly string[];
  readonly #pgRestorePrefixArgs: readonly string[];
  readonly #maximumDumpBytes: number;

  constructor(input: {
    readonly databaseUrl: string;
    readonly database: Database;
    readonly pgDumpExecutable?: string;
    readonly pgRestoreExecutable?: string;
    readonly pgDumpPrefixArgs?: readonly string[];
    readonly pgRestorePrefixArgs?: readonly string[];
    readonly maximumDumpBytes: number;
  }) {
    this.#databaseUrl = input.databaseUrl;
    this.#database = input.database;
    this.#pgDumpExecutable = input.pgDumpExecutable ?? "pg_dump";
    this.#pgRestoreExecutable = input.pgRestoreExecutable ?? "pg_restore";
    this.#pgDumpPrefixArgs = input.pgDumpPrefixArgs ?? [];
    this.#pgRestorePrefixArgs = input.pgRestorePrefixArgs ?? [];
    this.#maximumDumpBytes = input.maximumDumpBytes;
  }

  async createDump(outputPath: string): Promise<void> {
    const connection = connectionArguments(this.#databaseUrl);
    await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    const child = spawn(this.#pgDumpExecutable, [
      ...this.#pgDumpPrefixArgs,
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--no-acl",
      "--exclude-table-data=web_sessions",
      "--exclude-table-data=login_sessions",
      "--exclude-table-data=operation_locks",
      "--exclude-table-data=upload_sessions",
      "--exclude-table-data=backup_runs",
      "--exclude-table-data=recovery_runs",
      "--exclude-table-data=auth_attempts",
      "--exclude-table-data=telegram_link_challenges",
      "--exclude-table-data=drop_challenges",
      "--exclude-table-data=drop_sessions",
      "--exclude-table-data=drop_uploads",
      "--exclude-table-data=drop_attempts",
      "--exclude-table-data=telegram_updates",
      "--exclude-table-data=share_sessions",
      "--exclude-table-data=share_password_attempts",
      "--exclude-table-data=share_packages",
      "--exclude-table-data=device_delete_events",
      ...connection.args,
    ], { env: connection.environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let standardError = "";
    child.stderr.on("data", (chunk: Buffer) => { standardError = `${standardError}${chunk.toString("utf8")}`.slice(-32_768); });
    const childFinished = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => code === 0
        ? resolve()
        : reject(new Error(`pg_dump failed with code ${String(code)}: ${standardError.trim().slice(-2_000)}`)));
    });
    try {
      await Promise.all([
        pipeline(child.stdout, new ByteLimitTransform(this.#maximumDumpBytes), createWriteStream(outputPath, { flags: "wx", mode: 0o600 })),
        childFinished,
      ]);
    } catch (error) {
      child.kill("SIGKILL");
      await fs.rm(outputPath, { force: true });
      throw error;
    }
  }

  restoreDump(dumpPath: string, mode: "clean" | "replace"): Promise<void> {
    const connection = connectionArguments(this.#databaseUrl);
    return runCommand(this.#pgRestoreExecutable, [
      ...this.#pgRestorePrefixArgs,
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      ...(mode === "replace" ? ["--clean", "--if-exists"] : []),
      ...connection.args,
    ], connection.environment, dumpPath);
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
}
