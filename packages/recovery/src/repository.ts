import type { Database } from "@saturn/database";

export class PostgresRecoveryRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  beginBackup(id: string, kind: string): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`INSERT INTO backup_runs (id, kind, state) VALUES (${id}, ${kind}, 'preparing')`;
    });
  }

  setBackupValidating(id: string): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`UPDATE backup_runs SET state = 'validating' WHERE id = ${id} AND state = 'preparing'`;
    });
  }

  completeBackup(input: {
    readonly id: string;
    readonly archivePath: string;
    readonly archiveSha256: string;
    readonly archiveBytes: number;
    readonly memberCount: number;
    readonly databaseDumpSha256: string;
    readonly evidence: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`
        UPDATE backup_runs SET
          state = 'complete', archive_path = ${input.archivePath},
          archive_sha256 = ${input.archiveSha256}, archive_bytes = ${input.archiveBytes},
          member_count = ${input.memberCount}, database_dump_sha256 = ${input.databaseDumpSha256},
          evidence = ${sql.json(JSON.parse(JSON.stringify(input.evidence)) as never)}, finished_at = now()
        WHERE id = ${input.id}
      `;
    });
  }

  failBackup(id: string, errorCode: string): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`
        UPDATE backup_runs SET state = 'failed', error_code = ${errorCode}, finished_at = now()
        WHERE id = ${id} AND state IN ('preparing', 'validating')
      `;
    });
  }
}
