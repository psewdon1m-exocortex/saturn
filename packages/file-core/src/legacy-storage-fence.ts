import type { Readable } from "node:stream";
import type { Database } from "@saturn/database";
import type { TransactionSql } from "postgres";
import { normalizeStoragePath, type StorageAdapter, type StorageReadOptions, type StorageWriteOptions } from "@saturn/storage";

export type LegacyStorageMutation = "write" | "truncate" | "mkdir" | "rename" | "copy" | "delete";
export interface LegacyStoragePolicy {
  /** Trusted backend-generation check, never supplied by a request. */
  assertBackend(): Promise<void>;
  assertMutation(operation: LegacyStorageMutation, paths: readonly string[]): Promise<void>;
}
export class LegacyStorageFenceError extends Error {
  constructor(readonly code: "guarded_write_refused" | "private_owner_unknown" | "guard_unavailable") {
    super(code); this.name = "LegacyStorageFenceError";
  }
}
function supportedKind(value: unknown): boolean { return value === "file" || value === "directory"; }

/** Shared API/worker legacy view. Only the fixed modern factory retains the raw adapter.
 * This cooperates with current binaries; offline credential fencing is mandatory for old executors. */
export class LegacyStorageFence implements StorageAdapter {
  constructor(private readonly storage: StorageAdapter, private readonly policy: LegacyStoragePolicy,private readonly requireCanonicalPaths=false) {}
  async assertReady(): Promise<void> { await this.policy.assertBackend(); await this.storage.assertReady?.(); }
  async #mutation<T>(operation: LegacyStorageMutation, paths: readonly string[], action: () => Promise<T>): Promise<T> {
    if(this.requireCanonicalPaths&&paths.some(p=>normalizeStoragePath(p)!==p))throw new LegacyStorageFenceError('guarded_write_refused');
    await this.policy.assertBackend(); await this.policy.assertMutation(operation, paths);
    // SQL-denied paths cause no backend call. For an allowed outside path,
    // adapter lstat checks every existing ancestor after the short SQL TX.
    // Old executors with symlink/credential access must already be fenced;
    // this check alone cannot resolve an adversarial filesystem TOCTOU race.
    for (const path of paths) {
      const parts = normalizeStoragePath(path).split("/");
      if (parts.length > 128) throw new LegacyStorageFenceError("guard_unavailable");
      for (let n = 1; n <= parts.length; n++) {
        const ancestorPath = parts.slice(0, n).join("/");
        if (!(await this.storage.exists(ancestorPath))) break;
        const ancestor = await this.storage.stat(ancestorPath);
        if (!supportedKind(ancestor.type) || n < parts.length && ancestor.type !== "directory") throw new LegacyStorageFenceError("guard_unavailable");
      }
    }
    return action();
  }
  async stat(p: string) { await this.policy.assertBackend(); return this.storage.stat(p); }
  async list(p: string, cursor: string | undefined, limit: number) { await this.policy.assertBackend(); return this.storage.list(p, cursor, limit); }
  async openRead(p: string, options?: StorageReadOptions) { await this.policy.assertBackend(); return this.storage.openRead(p, options); }
  async exists(p: string) { await this.policy.assertBackend(); return this.storage.exists(p); }
  async statFs() { await this.policy.assertBackend(); return this.storage.statFs(); }
  write(p: string, source: Readable, options: StorageWriteOptions) { return this.#mutation("write", [p], () => this.storage.write(p, source, options)); }
  truncate(p: string, size: number) { return this.#mutation("truncate", [p], () => this.storage.truncate(p, size)); }
  mkdir(p: string) { return this.#mutation("mkdir", [p], () => this.storage.mkdir(p)); }
  rename(a: string, b: string) { return this.#mutation("rename", [a, b], () => this.storage.rename(a, b)); }
  copy(a: string, b: string) { return this.#mutation("copy", [a, b], () => this.storage.copy(a, b)); }
  delete(p: string) { return this.#mutation("delete", [p], () => this.storage.delete(p)); }
  close() { return this.storage.close(); }
}

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const segment = (p: string, prefix: string) => p === prefix || (prefix !== "" && p.startsWith(prefix + "/"));
interface RootPath { root_id: string; storage_path: string; controls: string[]; valid: boolean }

/** Bounded16-root policy and private primary-key ownership checks. Unknown private objects
 * cannot be reclassified as outside merely because a public resource lookup returned no row. */
export class PostgresLegacyStoragePolicy implements LegacyStoragePolicy {
  constructor(private readonly database: Database, private readonly backend: () => Promise<void>, private readonly caseSensitive = true) {}
  assertBackend() { return this.backend(); }
  #path(p: string): string { const normalized = normalizeStoragePath(p); return this.caseSensitive ? normalized : normalized.toLowerCase(); }
  async #outside(sql: TransactionSql, id: string | null): Promise<void> {
    if (id === null || !UUID.test(id)) throw new LegacyStorageFenceError("private_owner_unknown");
    const row = (await sql<{ found: boolean; outside: boolean }[]>`SELECT EXISTS(SELECT 1 FROM public.resources WHERE id=${id}) AS found,
      cardinality(public.catalog_guard_scope(${id}::uuid))=0 AND NOT EXISTS(SELECT 1 FROM public.resources r WHERE r.id=${id}
        AND cardinality(public.catalog_guard_scope(r.trashed_from_parent_id))>0) AS outside`)[0];
    if (!row?.found) throw new LegacyStorageFenceError("private_owner_unknown");
    if (!row.outside) throw new LegacyStorageFenceError("guarded_write_refused");
  }
  async #private(sql: TransactionSql, operation: LegacyStorageMutation, raw: string): Promise<void> {
    // Private layout identifiers are canonical ASCII even on case-insensitive storage.
    const p = this.#path(raw), pieces = p.split("/");
    if (pieces[0] !== "_system") return;
    if (pieces.length < 3) {
      // Creating already-provisioned neutral parents is unnecessary; shared parent mutation may erase guarded effects.
      throw new LegacyStorageFenceError("private_owner_unknown");
    }
    // Neutral date parents contain no operation bytes themselves. Exclusive
    // mkdir is the only permitted effect; deletion/rename/copy remains closed.
    if (operation === "mkdir" && pieces[1] === "trash" && /^\d{4}$/.test(pieces[2] ?? "")
      && (pieces.length === 3 || pieces.length === 4 && /^(0[1-9]|1[0-2])$/.test(pieces[3] ?? ""))) return;
    if (pieces[1] === "versions" && UUID.test(pieces[2] ?? "")) {
      await this.#outside(sql, (pieces[2] ?? ""));
      if (pieces.length === 3 && operation === "mkdir") return;
      if (!UUID.test(pieces[3] ?? "")) throw new LegacyStorageFenceError("private_owner_unknown");
      const row = (await sql<{ found: boolean }[]>`SELECT EXISTS(SELECT 1 FROM public.file_versions WHERE id=${(pieces[3] ?? "")} AND resource_id=${(pieces[2] ?? "")}) AS found`)[0];
      if (!row?.found) throw new LegacyStorageFenceError("private_owner_unknown"); return;
    }
    if (pieces[1] === "trash" && /^\d{4}$/.test(pieces[2] ?? "") && /^\d{2}$/.test(pieces[3] ?? "") && UUID.test(pieces[4] ?? "")) {
      await this.#outside(sql, (pieces[4] ?? "")); return;
    }
    // This shared namespace holds only per-service directories, never backup
    // bytes. Permit its exclusive creation while all other mutations and
    // unknown descendants still require the exact recorded owner below.
    if (operation === "mkdir" && p === "_system/incoming/backups") return;
    if (pieces[1] === "incoming" && pieces.length === 3) {
      const match = /^([a-f\d-]{36})\.(part|restore)$/.exec((pieces[2] ?? ""));
      if (!match || !UUID.test((match[1] ?? ""))) throw new LegacyStorageFenceError("private_owner_unknown");
      if (match[2] === "part") {
        const row = (await sql<{ parent_id: string; temp_path: string }[]>`SELECT parent_id,temp_path FROM public.upload_sessions WHERE id=${(match[1] ?? "")} LIMIT 1`)[0];
        if (!row || this.#path(row.temp_path) !== p) throw new LegacyStorageFenceError("private_owner_unknown");
        await this.#outside(sql, row.parent_id); return;
      }
      const row = (await sql<{ resource_id: string | null }[]>`SELECT resource_id FROM public.operation_journal WHERE id=${(match[1] ?? "")} AND operation_type='version_restore' LIMIT 1`)[0];
      if (!row) throw new LegacyStorageFenceError("private_owner_unknown"); await this.#outside(sql, row.resource_id); return;
    }
    if (pieces[1] === "incoming" && pieces[2] === "backups" && UUID.test(pieces[3] ?? "")) {
      if (operation === "mkdir" && pieces.length === 4) {
        const row = (await sql<{ found: boolean }[]>`SELECT EXISTS(SELECT 1 FROM public.backup_services WHERE id=${(pieces[3] ?? "")}) AS found`)[0];
        if (row?.found) return;
      }
      const id = /^([a-f\d-]{36})\.part$/.exec(pieces[4] ?? "")?.[1];
      if (pieces.length === 5 && id && UUID.test(id)) {
        const row = (await sql<{ temp_path: string }[]>`SELECT temp_path FROM public.service_backup_runs WHERE id=${id} AND service_id=${(pieces[3] ?? "")} LIMIT 1`)[0];
        if (row && this.#path(row.temp_path) === p) return;
      }
      throw new LegacyStorageFenceError("private_owner_unknown");
    }
    if (pieces[1] === "packages" && UUID.test(pieces[2] ?? "")) {
      if (operation === "mkdir" && pieces.length === 3) {
        const row = (await sql<{ found: boolean }[]>`SELECT EXISTS(SELECT 1 FROM public.shares WHERE id=${(pieces[2] ?? "")}) AS found`)[0]; if (row?.found) return;
      }
      const id = /^([a-f\d-]{36})\.zip(?:\.part)?$/.exec(pieces[3] ?? "")?.[1];
      if (pieces.length === 4 && id && UUID.test(id)) {
        const row = (await sql<{ storage_path: string }[]>`SELECT storage_path FROM public.share_packages WHERE id=${id} AND share_id=${(pieces[2] ?? "")} LIMIT 1`)[0];
        if (row && (this.#path(row.storage_path) === p || this.#path(row.storage_path) + ".part" === p)) return;
      }
      // Generation paths survive package replacement until custody cleanup has
      // closed all handles. Resolve the exact stored owner; a filename alone
      // must never authorize access to private storage.
      const generation = /^([a-f\d-]{36})-([a-f\d-]{36})\.zip$/.exec(pieces[3] ?? "");
      if (pieces.length === 4 && generation && UUID.test(generation[1] ?? "") && UUID.test(generation[2] ?? "")) {
        const row = (await sql<{ storage_path: string }[]>`SELECT g.storage_path FROM public.share_package_generations g
          JOIN public.share_packages p ON p.id=g.package_id
          WHERE g.id=${generation[2] ?? ""} AND g.package_id=${generation[1] ?? ""} AND p.share_id=${pieces[2] ?? ""} LIMIT 1`)[0];
        if (row && this.#path(row.storage_path) === p) return;
      }
    }
    throw new LegacyStorageFenceError("private_owner_unknown");
  }
  async assertMutation(operation: LegacyStorageMutation, paths: readonly string[]): Promise<void> {
    if (paths.length < 1 || paths.length > 2) throw new LegacyStorageFenceError("guard_unavailable");
    const normalized = paths.map(p => this.#path(p));
    await this.database.transaction(async sql => {
      await sql`SET LOCAL statement_timeout='2s'`; await sql`SET LOCAL lock_timeout='2s'`; await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
      const roots = await sql<RootPath[]>`SELECT g.root_id,r.storage_path,
        ARRAY(SELECT x.storage_path FROM unnest(g.control_ancestor_ids) ancestor(node_id) JOIN public.resources x ON x.id=ancestor.node_id ORDER BY x.id) AS controls,
        r.type='folder' AND r.status='active' AND cardinality(g.control_ancestor_ids)=
          (SELECT count(*) FROM public.resources x WHERE x.id=ANY(g.control_ancestor_ids) AND x.type='folder' AND x.status='active') AS valid
        FROM public.catalog_guard_roots g JOIN public.resources r ON r.id=g.root_id ORDER BY g.root_id LIMIT 17`;
      if (roots.length === 0) return;
      if (roots.length > 16 || roots.some(r => !r.valid)) throw new LegacyStorageFenceError("guard_unavailable");
      for (const p of normalized) for (const r of roots) {
        const root = this.#path(r.storage_path), controls = r.controls.map(c => this.#path(c));
        if (segment(p, root) || segment(root, p) || controls.includes(p)) throw new LegacyStorageFenceError("guarded_write_refused");
      }
      // A raw new child immediately below ROOT/SYNC/OUTDOOR is not a general
      // controls bypass. Exclusive mkdir requires the live catalog+journal
      // reservation installed by fresh authenticated owner composition.
      for (const p of normalized) {
        const slash = p.lastIndexOf("/"), parentPath = slash < 0 ? "" : p.slice(0, slash);
        const control = (await sql<{ id: string }[]>`SELECT id FROM public.resources WHERE id IN
          ('00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000004','00000000-0000-7000-8000-000000000009')
          AND ${this.caseSensitive} AND storage_path=${parentPath} OR id IN
          ('00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000004','00000000-0000-7000-8000-000000000009')
          AND NOT ${this.caseSensitive} AND lower(storage_path)=${parentPath} LIMIT 1`)[0];
        if (control) {
          const known = (await sql<{ known: boolean }[]>`SELECT EXISTS(SELECT 1 FROM public.resources r WHERE r.parent_id=${control.id}
            AND r.status IN ('active','trashed','purged') AND cardinality(public.catalog_guard_scope(r.id,false))=0
            AND (${this.caseSensitive} AND r.storage_path=${p} OR NOT ${this.caseSensitive} AND lower(r.storage_path)=${p})) AS known`)[0]?.known;
          if (known) continue;
          const reserved = (await sql<{ reserved: boolean }[]>`SELECT EXISTS(SELECT 1 FROM public.resources r JOIN public.operation_journal j ON j.resource_id=r.id AND j.id=r.id
            WHERE r.parent_id=${control.id} AND r.type='folder' AND r.status='pending' AND j.operation_type='outside_folder_create' AND j.state='committing'
              AND j.payload->>'schema'='saturn.outside-folder.v1' AND j.payload->>'parentId'=r.parent_id::text AND j.payload->>'nodeId'=r.id::text
              AND j.payload->>'name'=r.name AND j.payload->>'path'=r.storage_path
              AND (${this.caseSensitive} AND r.storage_path=${p} OR NOT ${this.caseSensitive} AND lower(r.storage_path)=${p})) AS reserved`)[0]?.reserved;
          if (operation !== "mkdir" || !reserved) throw new LegacyStorageFenceError("guarded_write_refused");
        }
      }
      for (const p of normalized) await this.#private(sql, operation, p);
    });
  }
}
