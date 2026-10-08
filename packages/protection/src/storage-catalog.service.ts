import { randomUUID } from "node:crypto";
import type { AuditSink } from "@saturn/audit";
import type { Database, Sql } from "@saturn/database";
import { MASTERMIND_RESOURCE_ID, VOLT_RESOURCE_ID } from "@saturn/file-core";
import type { RuntimeStorageManager } from "@saturn/storage";
import { buildCatalogPlan, catalogStamp, scanStorageCatalog, type CatalogPlan, type CatalogResource } from "./storage-catalog.js";

export class StorageCatalogError extends Error {
  constructor(readonly code: string) { super(code); }
}
interface JobRow {
  id: string; profile_id: string; profile_revision: string; state: string;
  scanned_entries: string; scanned_bytes: string; current_path: string | null;
  counts: CatalogPlan["counts"]; failure_code: string | null;
  created_at: Date; updated_at: Date; completed_at: Date | null; plan?: CatalogPlan | null;
}

function jobStatus(row: JobRow) {
  return { id: row.id, profileId: row.profile_id, profileRevision: Number(row.profile_revision), state: row.state,
    scannedEntries: Number(row.scanned_entries), scannedBytes: Number(row.scanned_bytes), currentPath: row.current_path,
    counts: row.counts, failureCode: row.failure_code, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
    canSynchronize: row.state === "ready" && row.counts.blocked === 0 && row.counts.added + row.counts.changed + row.counts.missing > 0 };
}

async function resources(sql: Sql): Promise<CatalogResource[]> {
  const rows = await sql<Array<{ id: string; parent_id: string | null; name: string; storage_path: string;
    type: "file" | "folder"; status: string; size_bytes: string; sha256: string | null;
    current_version_id: string | null; retention_class: string; security_classification: string; updated_at: Date }>>`
    SELECT id,parent_id,name,storage_path,type,status,size_bytes,sha256,current_version_id,retention_class,security_classification,updated_at
    FROM resources WHERE left(storage_path,8)<>'_system/' AND left(storage_path,10)<>'_detached/'
    ORDER BY id LIMIT 100001`;
  if (rows.length > 100_000) throw new StorageCatalogError("storage_analysis_entry_limit");
  return rows.map(row => ({ id: row.id, parentId: row.parent_id, name: row.name, storagePath: row.storage_path,
    type: row.type, status: row.status, sizeBytes: Number(row.size_bytes), sha256: row.sha256,
    currentVersionId: row.current_version_id, retentionClass: row.retention_class, securityClassification: row.security_classification, updatedAt: row.updated_at.toISOString() }));
}

function mimeType(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase();
  return ({ txt: "text/plain", md: "text/markdown", json: "application/json", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", zip: "application/zip" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

export class StorageCatalogService {
  constructor(private readonly database: Database, private readonly storage: RuntimeStorageManager, private readonly audit?: AuditSink) {}

  async start() {
    await this.storage.refresh();
    const profile = this.storage.current();
    const row = await this.database.transaction(async tx => {
      const sql = tx as unknown as Sql;
      await sql`SELECT pg_advisory_xact_lock(1397967207)`;
      const active = await sql<JobRow[]>`SELECT * FROM storage_catalog_jobs WHERE state IN ('queued','analyzing','sync_queued','syncing') LIMIT 1`;
      if (active[0] !== undefined) throw new StorageCatalogError("storage_analysis_in_progress");
      // Reports are operational records; retain a bounded history, including before/after evidence.
      await sql`DELETE FROM storage_catalog_jobs WHERE id IN (
        SELECT id FROM storage_catalog_jobs WHERE state NOT IN ('queued','analyzing','sync_queued','syncing')
        ORDER BY created_at DESC OFFSET 9)`;
      const created = await sql<JobRow[]>`INSERT INTO storage_catalog_jobs (id,profile_id,profile_revision,state)
        VALUES (${randomUUID()},${profile.profileId},${profile.revision},'queued') RETURNING *`;
      const result = created[0];
      if (result === undefined) throw new Error("storage_analysis_start_failed");
      return result;
    });
    await this.event("storage.analysis.requested", row.id, "success", {});
    return jobStatus(row);
  }

  async latest(offset = 0) {
    await this.storage.refresh();
    const profile = this.storage.current();
    return this.database.withSql(async sql => {
      const rows = await sql<JobRow[]>`SELECT id,profile_id,profile_revision,state,scanned_entries,scanned_bytes,current_path,counts,failure_code,created_at,updated_at,completed_at
        FROM storage_catalog_jobs WHERE profile_id=${profile.profileId} AND profile_revision=${profile.revision} ORDER BY created_at DESC LIMIT 1`;
      const row = rows[0];
      if (row === undefined) return { job: null, items: [], offset, hasMore: false };
      const items = await sql<Array<{ change: CatalogPlan["changes"][number] }>>`
        SELECT entry.value AS change FROM storage_catalog_jobs,
        LATERAL jsonb_array_elements(plan->'changes') WITH ORDINALITY AS entry(value,number)
        WHERE id=${row.id} ORDER BY entry.number OFFSET ${offset} LIMIT 100`;
      const total = Object.values(row.counts).reduce((sum, value) => sum + value, 0);
      return { job: jobStatus(row), items: items.map(item => ({ kind: item.change.kind, storagePath: item.change.storagePath,
        reason: item.change.reason, previousBytes: item.change.before?.sizeBytes ?? null, actualBytes: item.change.after?.sizeBytes ?? null })), offset, hasMore: offset + items.length < total };
    });
  }

  async synchronize(id: string) {
    await this.storage.refresh();
    const profile = this.storage.current();
    const row = await this.database.transaction(async tx => {
      const sql = tx as unknown as Sql;
      await sql`SELECT pg_advisory_xact_lock(1397967207)`;
      const active = await sql<JobRow[]>`SELECT id FROM storage_catalog_jobs WHERE state IN ('queued','analyzing','sync_queued','syncing') LIMIT 1`;
      if (active[0] !== undefined) {
        if (active[0].id === id) return (await sql<JobRow[]>`SELECT * FROM storage_catalog_jobs WHERE id=${id}`)[0];
        throw new StorageCatalogError("storage_analysis_in_progress");
      }
      const rows = await sql<JobRow[]>`UPDATE storage_catalog_jobs SET state='sync_queued',updated_at=now(),failure_code=NULL
        WHERE id=${id} AND profile_id=${profile.profileId} AND profile_revision=${profile.revision} AND state='ready'
          AND (counts->>'blocked')::int=0 AND (counts->>'added')::int+(counts->>'changed')::int+(counts->>'missing')::int>0 RETURNING *`;
      if (rows[0] === undefined) throw new StorageCatalogError("storage_analysis_not_applicable");
      return rows[0];
    });
    if (row === undefined) throw new StorageCatalogError("storage_analysis_not_applicable");
    return jobStatus(row);
  }

  async runNext(): Promise<void> {
    const lease = randomUUID();
    const row = await this.database.withSql(async sql => (await sql<JobRow[]>`UPDATE storage_catalog_jobs SET
      state=CASE WHEN state IN ('queued','analyzing') THEN 'analyzing' ELSE 'syncing' END,
      lease_token=${lease},lease_expires_at=now()+interval '2 minutes',updated_at=now()
      WHERE id=(SELECT id FROM storage_catalog_jobs WHERE state IN ('queued','sync_queued')
        OR (state IN ('analyzing','syncing') AND lease_expires_at<now()) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`)[0]);
    if (row === undefined) return;
    let leaseLost = false;
    const timer = setInterval(() => {
      void this.database.withSql(async sql => {
        const renewed = await sql`UPDATE storage_catalog_jobs SET lease_expires_at=now()+interval '2 minutes'
          WHERE id=${row.id} AND lease_token=${lease} AND state IN ('analyzing','syncing') RETURNING id`;
        if (renewed.length === 0) leaseLost = true;
      }).catch(() => { leaseLost = true; });
    }, 15_000);
    timer.unref();
    let plan: CatalogPlan | undefined;
    try {
      await this.database.withSharedMaintenance(async () => {
        await this.storage.refresh();
        const profile = this.storage.current();
        if (profile.profileId !== row.profile_id || profile.revision !== Number(row.profile_revision)) throw new StorageCatalogError("storage_analysis_stale");
        const before = await this.database.withSql(resources);
        let lastProgress = 0;
        const started = Date.now();
        const inventory = await scanStorageCatalog(this.storage, async progress => {
          if (leaseLost) throw new StorageCatalogError("storage_analysis_lease_lost");
          if (Date.now() - started > 60 * 60_000) throw new StorageCatalogError("storage_analysis_time_limit");
          if (Date.now() - lastProgress < 1_000) return;
          lastProgress = Date.now();
          await this.database.withSql(async sql => { await sql`UPDATE storage_catalog_jobs SET scanned_entries=${progress.entries},
            scanned_bytes=${progress.bytes},current_path=${progress.currentPath},updated_at=now() WHERE id=${row.id} AND lease_token=${lease}`; });
        });
        if (catalogStamp(await this.database.withSql(resources)) !== catalogStamp(before)) throw new StorageCatalogError("storage_analysis_stale");
        const nextPlan = buildCatalogPlan(before, inventory);
        if (before.length + nextPlan.counts.added > 100_000) throw new StorageCatalogError("storage_analysis_entry_limit");
        plan = nextPlan;
        if (Buffer.byteLength(JSON.stringify(nextPlan)) > 64 * 1024 * 1024) throw new StorageCatalogError("storage_analysis_metadata_limit");
        if (row.state === "syncing") {
          if (row.plan === undefined || row.plan === null || row.plan.catalogStamp !== plan.catalogStamp
            || row.plan.inventoryStamp !== plan.inventoryStamp || plan.counts.blocked > 0) throw new StorageCatalogError("storage_analysis_stale");
        } else {
          await this.database.withSql(async sql => { await sql`UPDATE storage_catalog_jobs SET state='ready',plan=${sql.json(nextPlan as never)},
            counts=${sql.json(nextPlan.counts)},scanned_entries=${inventory.entries.length},
            scanned_bytes=${inventory.entries.filter(item => item.type==='file').reduce((sum,item)=>sum+item.sizeBytes,0)},
            current_path=NULL,completed_at=now(),updated_at=now(),lease_token=NULL,lease_expires_at=NULL
            WHERE id=${row.id} AND lease_token=${lease}`; });
        }
      });
      clearInterval(timer);
      if (plan === undefined) throw new StorageCatalogError("storage_analysis_failed");
      if (row.state === "syncing") {
        await this.apply(row, lease, plan);
        await this.event("storage.catalog.synchronized", row.id, "success", plan.counts);
      } else await this.event("storage.analysis.completed", row.id, "success", plan.counts);
    } catch (error) {
      const code = error instanceof Error && /^storage_[a-z_]+$/.test(error.message) ? error.message
        : error instanceof Error && /symbolic|unsupported storage entry/i.test(error.message) ? "storage_analysis_unsupported_entry" : "storage_analysis_failed";
      await this.database.withSql(async sql => { await sql`UPDATE storage_catalog_jobs SET
        state=${code==='storage_analysis_stale' ? 'stale' : 'failed'},failure_code=${code},current_path=NULL,
        updated_at=now(),completed_at=now(),lease_token=NULL,lease_expires_at=NULL WHERE id=${row.id} AND lease_token=${lease}`; });
      await this.event("storage.analysis.failed", row.id, "failure", { reason: code });
    } finally { clearInterval(timer); }
  }

  private async apply(row: JobRow, lease: string, plan: CatalogPlan): Promise<void> {
    await this.database.withExclusiveTransaction(async sql => {
      await this.storage.refresh();
      const profile = this.storage.current();
      const owned = await sql`SELECT id FROM storage_catalog_jobs WHERE id=${row.id} AND state='syncing' AND lease_token=${lease} FOR UPDATE`;
      if (owned.length !== 1) throw new StorageCatalogError("storage_analysis_lease_lost");
      const current = await resources(sql);
      if (profile.profileId !== row.profile_id || profile.revision !== Number(row.profile_revision)
        || catalogStamp(current) !== plan.catalogStamp) throw new StorageCatalogError("storage_analysis_stale");
      const byPath = new Map(current.map(resource => [resource.storagePath, resource]));
      const byId = new Map(current.map(resource => [resource.id, resource]));
      const affected = new Set<string>();
      const ordered = [...plan.changes].sort((a,b) => a.storagePath.split('/').length-b.storagePath.split('/').length || a.storagePath.localeCompare(b.storagePath));
      for (const change of ordered) {
        if (change.after !== null) {
          const stat = await this.storage.stat(change.storagePath);
          if (stat.modifiedAt.toISOString() !== change.after.modifiedAt || (stat.type==='file' && stat.size!==change.after.sizeBytes)) throw new StorageCatalogError("storage_analysis_stale");
        } else if (change.kind==='missing' && await this.storage.exists(change.storagePath)) throw new StorageCatalogError("storage_analysis_stale");
      }
      for (const change of ordered) {
        if (change.kind === "blocked") throw new StorageCatalogError("storage_analysis_not_applicable");
        const before = change.before;
        if (before !== null) affected.add(before.id);
        if (change.kind === "missing" && before !== null) {
          await sql`UPDATE resources SET status='missing',updated_at=now() WHERE id=${before.id}`;
          await sql`UPDATE file_versions SET state='missing' WHERE resource_id=${before.id} AND storage_path=${before.storagePath}`;
          continue;
        }
        const after = change.after;
        if (after === null) throw new StorageCatalogError("storage_analysis_not_applicable");
        const parentPath = after.storagePath.includes('/') ? after.storagePath.slice(0, after.storagePath.lastIndexOf('/')) : '';
        const parent = byPath.get(parentPath);
        if (parent === undefined || parent.type !== 'folder') throw new StorageCatalogError("storage_analysis_not_applicable");
        affected.add(parent.id);
        const id = before?.id ?? randomUUID();
        let ancestor: CatalogResource | undefined = parent;
        let inVolt = false; let inMastermind = false;
        for (let depth=0;ancestor!==undefined&&depth<=128;depth++) {
          inVolt ||= ancestor.id===VOLT_RESOURCE_ID; inMastermind ||= ancestor.id===MASTERMIND_RESOURCE_ID;
          ancestor=ancestor.parentId===null?undefined:byId.get(ancestor.parentId);
        }
        const inheritedRetention = inVolt && after.type==='file' && after.name.toLowerCase().endsWith('.kdbx') ? 'keepass'
          : inMastermind && after.type==='file' ? (after.name.toLowerCase().endsWith('.md') ? 'mastermind_markdown' : 'mastermind_attachment') : 'general';
        const retention = before?.retentionClass ?? inheritedRetention;
        const classification = inVolt ? 'confidential' : before?.securityClassification ?? parent.securityClassification;
        const mime = after.type==='file' ? mimeType(after.name) : null;
        if (before === null) {
          await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,mime_type,size_bytes,sha256,status,retention_class,security_classification)
            VALUES (${id},${after.type},${parent.id},${after.name},${after.storagePath},${mime},${after.sizeBytes},${after.sha256},'active',${retention},${classification})`;
        } else await sql`UPDATE resources SET size_bytes=${after.sizeBytes},sha256=${after.sha256},mime_type=${mime},status='active',updated_at=now() WHERE id=${id}`;
        if (after.type==='file') {
          const existing = await sql<Array<{ id:string; sha256:string }>>`SELECT id,sha256 FROM file_versions WHERE resource_id=${id} AND storage_path=${after.storagePath}`;
          if (existing[0]?.sha256 === after.sha256) {
            await sql`UPDATE file_versions SET state='active',size_bytes=${after.sizeBytes} WHERE id=${existing[0].id}`;
            await sql`UPDATE resources SET current_version_id=${existing[0].id} WHERE id=${id}`;
          } else {
            // External overwrites cannot supply the old bytes. Preserve their metadata as unavailable history.
            if (existing[0] !== undefined) await sql`UPDATE file_versions SET storage_path=${`_system/catalog-history/${row.id}/${existing[0].id}`},state='missing',archived_at=now() WHERE id=${existing[0].id}`;
            const versionId = randomUUID();
            await sql`INSERT INTO file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason)
              VALUES (${versionId},${id},${after.storagePath},${after.sha256},${after.sizeBytes},${mime ?? 'application/octet-stream'},${before===null?'initial':'overwrite'})`;
            await sql`UPDATE resources SET current_version_id=${versionId} WHERE id=${id}`;
          }
        }
        const appliedResource:CatalogResource = { id,parentId:before===null?parent.id:before.parentId,name:after.name,storagePath:after.storagePath,type:after.type,status:'active',sizeBytes:after.sizeBytes,
          sha256:after.sha256,currentVersionId:null,retentionClass:retention,securityClassification:classification,updatedAt:new Date().toISOString() };
        byPath.set(after.storagePath, appliedResource);byId.set(id,appliedResource);
      }
      // Recompute aggregate sizes including folders that became empty or unavailable.
      await sql`WITH RECURSIVE tree AS (
        SELECT id AS file_id,parent_id,size_bytes FROM resources WHERE type='file' AND status='active'
        UNION ALL SELECT tree.file_id,parent.parent_id,tree.size_bytes FROM tree JOIN resources parent ON parent.id=tree.parent_id WHERE parent.status='active'
      ), totals AS (SELECT parent_id,sum(size_bytes) AS bytes FROM tree WHERE parent_id IS NOT NULL GROUP BY parent_id)
      UPDATE resources folder SET size_bytes=coalesce((SELECT bytes FROM totals WHERE parent_id=folder.id),0),updated_at=now()
        WHERE folder.type='folder' AND folder.status='active'`;
      for (const id of [...affected]) {
        let parent = byId.get(id);
        let depth = 0;
        while (parent?.parentId !== null && parent?.parentId !== undefined && depth++ < 128) {
          affected.add(parent.parentId); parent = byId.get(parent.parentId);
        }
      }
      if (affected.size > 0) await sql`UPDATE shares SET state='revoked',revoked_at=now(),updated_at=now() WHERE state='active' AND resource_id=ANY(${[...affected]}::uuid[])`;
      await sql`UPDATE storage_catalog_jobs SET state='synchronized',current_path=NULL,completed_at=now(),updated_at=now(),lease_token=NULL,lease_expires_at=NULL
        WHERE id=${row.id} AND lease_token=${lease}`;
    });
  }

  private async event(action: string, id: string, outcome: "success" | "failure", details: Record<string, unknown>) {
    await this.audit?.write({ actorType: "owner", actorId: "owner", action, outcome, correlationId: `storage-catalog:${id}:${action}`, details }).catch(() => undefined);
  }
}
