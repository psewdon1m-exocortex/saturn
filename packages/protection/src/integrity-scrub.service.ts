import { createHash } from "node:crypto";
import type { Database } from "@saturn/database";
import { PostgresFileRepository } from "@saturn/file-core";
import type { StorageAdapter } from "@saturn/storage";
import { v7 as uuidv7 } from "uuid";

/** Incremental verification of current files and retained versions, with a persisted cursor. */
export class IntegrityScrubService {
  constructor(private readonly database: Database, private readonly storage: StorageAdapter) {}

  async run(limit = 10): Promise<{ checked: number; mismatched: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid scrub limit");
    return this.database.withAdvisoryLock("saturn-integrity-scrub", async () => {
      const state = await this.database.withSql(sql => sql<{ last_version_id: string }[]>`SELECT last_version_id FROM integrity_scrub_state WHERE id=true`);
      const cursor = state[0]?.last_version_id ?? "";
      const rows = await this.database.withSql(sql => sql<{ id: string; resource_id: string; storage_path: string; size_bytes: string; sha256: string }[]>`
        SELECT id::text, resource_id::text, storage_path, size_bytes::text, sha256 FROM file_versions
        WHERE state='active' AND id::text>${cursor} ORDER BY id::text LIMIT ${limit}
      `);
      const files = new PostgresFileRepository(this.database);
      let checked = 0, mismatched = 0;
      let bytes = 0;
      let next = cursor;
      for (const row of rows) {
        if (checked > 0 && bytes + Number(row.size_bytes) > 256 * 1024 * 1024) break;
        const lease = uuidv7();
        if (!(await files.acquireLocks(lease, [`resource:${row.resource_id}`], new Date(Date.now()+6*60*60_000)))) { next=row.id; continue; }
        try {
          const current = await files.getVersion(row.resource_id, row.id);
          if (current?.state !== 'active' || current.storagePath !== row.storage_path || current.sha256 !== row.sha256) { next=row.id; continue; }
          const hash = createHash('sha256');
          let size = 0;
          for await (const raw of await this.storage.openRead(row.storage_path)) {
            const chunk = Buffer.from(raw as Uint8Array); size += chunk.length; hash.update(chunk);
          }
          checked++; bytes += size;
          if (size !== Number(row.size_bytes) || hash.digest('hex') !== row.sha256) {
            await this.database.transaction(async sql => {
              await sql`UPDATE file_versions SET state='error' WHERE id=${row.id} AND state='active' AND storage_path=${row.storage_path} AND sha256=${row.sha256}`;
              await sql`UPDATE resources SET status='quarantined', updated_at=now() WHERE id=${row.resource_id} AND current_version_id=${row.id}`;
              await sql`INSERT INTO audit_events (id,actor_type,actor_id,action,outcome,correlation_id,details)
                VALUES (${uuidv7()},'worker','integrity-scrub','file.integrity.mismatch','failure',${`scrub:${row.id}:${uuidv7()}`},${sql.json({resourceId:row.resource_id,versionId:row.id,expectedSha256:row.sha256,actualSize:size})})`;
            });
            mismatched++;
          }
          next=row.id;
        } catch {
          // An unreadable object is not evidence of corruption. Record the
          // failed check and continue; the next cursor cycle retries it.
          await this.database.withSql(sql => sql`INSERT INTO audit_events (id,actor_type,actor_id,action,outcome,correlation_id,details)
            VALUES (${uuidv7()},'worker','integrity-scrub','file.integrity.unavailable','failure',${`scrub:${row.id}:${uuidv7()}`},${sql.json({resourceId:row.resource_id,versionId:row.id})})`);
          next=row.id;
        } finally { await files.releaseLocks(lease); }
      }
      if (rows.length === 0) next="";
      await this.database.withSql(async sql => { await sql`UPDATE integrity_scrub_state SET last_version_id=${next},updated_at=now() WHERE id=true`; });
      return { checked, mismatched };
    });
  }
}
