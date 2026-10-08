import type { AuditSink } from "@saturn/audit";
import type { Database } from "@saturn/database";
import type { StorageAdapter } from "@saturn/storage";
import { PostgresFileRepository } from "@saturn/file-core";
import { v7 as uuidv7 } from "uuid";

export interface PurgeCandidate {
  readonly kind: "version" | "trash";
  readonly id: string;
  readonly resourceId: string;
  readonly storagePath: string;
}

export interface PurgeRepository {
  listCandidates(now: Date, limit: number): Promise<readonly PurgeCandidate[]>;
  markPurged(candidate: PurgeCandidate): Promise<void>;
  withCandidate?(candidate: PurgeCandidate, now: Date, action: () => Promise<void>): Promise<boolean>;
}

export class PostgresPurgeRepository implements PurgeRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  listCandidates(now: Date, limit: number): Promise<readonly PurgeCandidate[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ kind: "version" | "trash"; id: string; resource_id: string; storage_path: string }[]>`
        WITH ranked_versions AS (
          SELECT version.id, version.resource_id, version.storage_path, version.purge_after,
            resource.current_version_id, resource.retention_class,
            row_number() OVER (
              PARTITION BY version.resource_id ORDER BY version.created_at DESC, version.id DESC
            ) AS position
          FROM file_versions AS version
          JOIN resources AS resource ON resource.id = version.resource_id
          WHERE version.state = 'active'
        ), candidates AS (
          SELECT 'version'::text AS kind, id, resource_id, storage_path
          FROM ranked_versions
          WHERE id <> current_version_id AND purge_after IS NOT NULL AND purge_after <= ${now}
            AND retention_class IN ('general', 'mastermind_markdown', 'mastermind_attachment')
            AND position > CASE WHEN retention_class = 'mastermind_markdown' THEN 100 ELSE 10 END
            AND NOT EXISTS (
              SELECT 1 FROM laboratory_assets AS asset
              WHERE asset.pinned_version_id = ranked_versions.id
                AND asset.mode = 'public_immutable' AND asset.state = 'active'
            )
          UNION ALL
          SELECT 'trash'::text AS kind, id, id AS resource_id, storage_path
          FROM resources
          WHERE status = 'trashed' AND trashed_from_parent_id IS NOT NULL AND purge_after <= ${now}
            AND retention_class <> 'keepass'
          UNION
          SELECT payload->>'kind' AS kind, (payload->>'candidateId')::uuid AS id,
            resource_id AS resource_id, payload->>'storagePath' AS storage_path
          FROM operation_journal
          WHERE operation_type = 'purge' AND state = 'storage_committing'
            AND idempotency_key LIKE 'scheduled-purge:%'
        )
        SELECT DISTINCT * FROM candidates ORDER BY kind, id LIMIT ${limit}
      `;
      return rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        resourceId: row.resource_id,
        storagePath: row.storage_path,
      }));
    });
  }

  async withCandidate(candidate: PurgeCandidate, now: Date, action: () => Promise<void>): Promise<boolean> {
    const files = new PostgresFileRepository(this.#database);
    const lockId = uuidv7();
    const tree = candidate.kind === "trash" ? await files.listTree(candidate.storagePath) : [];
    const keys = [...new Set([`resource:${candidate.resourceId}`, ...tree.map(item => `resource:${item.id}`)])];
    if (!await files.acquireLocks(lockId, keys, new Date(Date.now() + 30 * 60_000))) return false;
    try {
      const eligible = await this.#database.withSql(async sql => {
        const existing = await sql<{ state: string }[]>`SELECT state FROM operation_journal
          WHERE idempotency_key = ${`scheduled-purge:${candidate.kind}:${candidate.id}`}`;
        if (existing[0]?.state === "storage_committing") return true;
        if (candidate.kind === "trash") {
          const rows = await sql`SELECT id FROM resources WHERE id = ${candidate.id}
            AND storage_path = ${candidate.storagePath} AND status = 'trashed'
            AND trashed_from_parent_id IS NOT NULL AND purge_after <= ${now} AND retention_class <> 'keepass'`;
          return rows.length > 0;
        }
        const rows = await sql`SELECT version.id FROM file_versions AS version JOIN resources AS resource ON resource.id = version.resource_id
          WHERE version.id = ${candidate.id} AND version.resource_id = ${candidate.resourceId}
            AND version.storage_path = ${candidate.storagePath} AND version.state = 'active'
            AND version.id <> resource.current_version_id AND version.purge_after <= ${now}
            AND resource.retention_class IN ('general', 'mastermind_markdown', 'mastermind_attachment')
            AND (SELECT count(*) FROM file_versions AS newer WHERE newer.resource_id = version.resource_id AND newer.state = 'active'
              AND (newer.created_at, newer.id) > (version.created_at, version.id)) >= CASE WHEN resource.retention_class = 'mastermind_markdown' THEN 100 ELSE 10 END
            AND NOT EXISTS (SELECT 1 FROM laboratory_assets WHERE pinned_version_id = version.id AND mode = 'public_immutable' AND state = 'active')`;
        return rows.length > 0;
      });
      if (!eligible) return false;
      await this.#database.withSql(async sql => {
        await sql`INSERT INTO operation_journal (id, operation_type, idempotency_key, resource_id, state, payload)
          VALUES (${uuidv7()}, 'purge', ${`scheduled-purge:${candidate.kind}:${candidate.id}`}, ${candidate.resourceId}, 'storage_committing',
            ${sql.json({ kind: candidate.kind, candidateId: candidate.id, storagePath: candidate.storagePath })})
          ON CONFLICT (idempotency_key) DO UPDATE SET state = 'storage_committing', updated_at = now()`;
        if (candidate.kind === "version") await sql`UPDATE file_versions SET state = 'expired' WHERE id = ${candidate.id}`;
      });
      await action();
      return true;
    } finally { await files.releaseLocks(lockId); }
  }

  markPurged(candidate: PurgeCandidate): Promise<void> {
    return this.#database.transaction(async (sql) => {
      if (candidate.kind === "version") {
        await sql`UPDATE file_versions SET state = 'expired' WHERE id = ${candidate.id}`;
        await sql`UPDATE operation_journal SET state = 'active', updated_at = now() WHERE idempotency_key = ${`scheduled-purge:${candidate.kind}:${candidate.id}`}`;
        return;
      }
      await sql`
        UPDATE file_versions SET state = 'expired'
        WHERE resource_id IN (
          SELECT id FROM resources
          WHERE storage_path = ${candidate.storagePath} OR starts_with(storage_path, ${`${candidate.storagePath}/`})
        )
      `;
      await sql`UPDATE operation_journal SET state = 'active', updated_at = now() WHERE idempotency_key = ${`scheduled-purge:${candidate.kind}:${candidate.id}`}`;
      await sql`
        UPDATE resources SET status = 'purged', updated_at = now()
        WHERE storage_path = ${candidate.storagePath} OR starts_with(storage_path, ${`${candidate.storagePath}/`})
      `;
    });
  }
}

export class PurgeService {
  readonly #repository: PurgeRepository;
  readonly #storage: StorageAdapter;
  readonly #enabled: boolean;
  readonly #audit: AuditSink | undefined;

  constructor(repository: PurgeRepository, storage: StorageAdapter, enabled: boolean, audit?: AuditSink) {
    this.#repository = repository;
    this.#storage = storage;
    this.#enabled = enabled;
    this.#audit = audit;
  }

  async run(now = new Date(), limit = 100): Promise<{ readonly state: "disabled" | "complete"; readonly purged: number }> {
    if (!this.#enabled) return { state: "disabled", purged: 0 };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Purge limit is invalid");
    const candidates = await this.#repository.listCandidates(now, limit);
    let purged = 0;
    for (const candidate of candidates) {
      const perform = async () => {
      if (await this.#storage.exists(candidate.storagePath)) {
        if (candidate.kind === "trash") await this.#deleteTree(candidate.storagePath);
        else await this.#storage.delete(candidate.storagePath);
      }
      await this.#repository.markPurged(candidate);
      purged += 1;
      await this.#audit?.write({
        actorType: "system",
        actorId: "purge",
        action: `${candidate.kind}.purged`,
        resourceId: candidate.resourceId,
        outcome: "success",
        correlationId: `purge:${candidate.kind}:${candidate.id}`,
        details: { storagePath: candidate.storagePath },
      }).catch(() => undefined);
      };
      if (this.#repository.withCandidate !== undefined) await this.#repository.withCandidate(candidate, now, perform);
      else await perform();
    }
    return { state: "complete", purged };
  }

  async #deleteTree(storagePath: string): Promise<void> {
    let remaining: number;
    do {
      const page = await this.#storage.list(storagePath, undefined, 500);
      remaining = page.entries.length;
      for (const entry of page.entries) {
        if (entry.type === "directory") await this.#deleteTree(entry.path);
        else await this.#storage.delete(entry.path);
      }
    } while (remaining > 0);
    await this.#storage.delete(storagePath);
  }
}
