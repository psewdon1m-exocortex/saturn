import { randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";
import type { TransactionSql } from "postgres";

export const CURRENT_NAMESPACE_SCHEMA = "saturn.current-namespace.v1";
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const MAX = 9223372036854775807n;
function scalarName(value:string):boolean {
  for(let i=0;i<value.length;i++) { const c=value.charCodeAt(i);if(c>=0xd800 && c<=0xdbff) {
    const next=value.charCodeAt(++i);if(!(next>=0xdc00 && next<=0xdfff))return false;
  }else if(c>=0xdc00 && c<=0xdfff)return false; }
  return true;
}
export type NamespaceAvailability = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
export interface NamespaceDescriptor {
  readonly node_id: string; readonly parent_id: string | null; readonly name: string;
  readonly type: "file" | "folder"; readonly size_bytes: string;
  readonly content_sha256: string | null; readonly content_version_id: string | null;
  readonly version: string; readonly availability: NamespaceAvailability;
}
export interface NamespaceChange {
  readonly schema: "saturn.current-namespace-change.v1";
  readonly nodeId: string; readonly kind: "upsert" | "tombstone";
  readonly description: NamespaceDescriptor;
  readonly before_version?: string;
  readonly reason: string; readonly actor: { readonly type: string; readonly id: string };
}
export interface NamespaceProjectionRow {
  readonly id: string; readonly parent_id: string | null; readonly name: string;
  readonly type: "file" | "folder"; readonly size_bytes: string; readonly sha256: string | null;
  readonly current_version_id: string | null; readonly metadata_version: string | null;
  readonly sync_availability: NamespaceAvailability | null; readonly status: string;
}
export class CurrentNamespaceError extends Error {
  constructor(readonly code: "invalid_input" | "binding_invalid" | "projection_unqualified" | "admission_full" | "read_timeout") { super(code); }
}
export function namespaceDescriptor(row: NamespaceProjectionRow, rootId: string): NamespaceDescriptor {
  if (row.status !== "active" || row.metadata_version === null) throw new CurrentNamespaceError("projection_unqualified");
  const result: NamespaceDescriptor = { node_id: row.id,parent_id: row.id === rootId ? null : row.parent_id,name: row.name,
    type: row.type,size_bytes: row.size_bytes,content_sha256: row.type === "folder" ? null : row.sha256,
    content_version_id: row.type === "folder" ? null : row.current_version_id,version: row.metadata_version,
    availability: row.sync_availability ?? "UNKNOWN" };
  validateNamespaceDescriptor(result); return result;
}
export function validateNamespaceDescriptor(d: NamespaceDescriptor): void {
  if (Object.keys(d).some(key=>!["node_id","parent_id","name","type","size_bytes","content_sha256","content_version_id","version","availability"].includes(key))
    || !UUID.test(d.node_id) || !UUID.test(d.version) || (d.parent_id !== null && (!UUID.test(d.parent_id) || d.parent_id === d.node_id))
    || !d.name || !scalarName(d.name) || d.name.includes("\0") || /[/\\]/.test(d.name) || Buffer.byteLength(d.name)>1020 || !["file","folder"].includes(d.type)
    || !/^(0|[1-9]\d{0,18})$/.test(d.size_bytes) || BigInt(d.size_bytes)>MAX
    || !["AVAILABLE","UNAVAILABLE","UNKNOWN"].includes(d.availability)
    || (d.content_sha256!==null && !/^[a-f\d]{64}$/.test(d.content_sha256))
    || (d.content_version_id!==null && !UUID.test(d.content_version_id))
    || (d.type==="folder" && (d.content_sha256!==null || d.content_version_id!==null))
    || (d.type==="file" && d.availability==="AVAILABLE" && (d.content_sha256===null || d.content_version_id===null))) throw new CurrentNamespaceError("invalid_input");
}
export function validateNamespaceChanges(events: readonly NamespaceChange[]): void {
  if (events.length<1 || events.length>500 || new Set(events.map(e=>e.nodeId)).size!==events.length) throw new CurrentNamespaceError("invalid_input");
  for (const e of events) {
    validateNamespaceDescriptor(e.description);
    if (Object.keys(e).some(key=>!["schema","nodeId","kind","description","before_version","reason","actor"].includes(key))
      || Object.keys(e.actor).some(key=>!["type","id"].includes(key))
      || !["saturn.current-namespace-change.v1"].includes(e.schema) || e.nodeId!==e.description.node_id
      || !["upsert","tombstone"].includes(e.kind) || (e.kind==="tombstone" ? !e.before_version || !UUID.test(e.before_version)
        || e.before_version===e.description.version : e.before_version!==undefined)
      || [e.reason,e.actor.type,e.actor.id].some(v=>!v || Buffer.byteLength(v)>128)
      || Buffer.byteLength(JSON.stringify(e))>4096) throw new CurrentNamespaceError("invalid_input");
  }
  if (Buffer.byteLength(JSON.stringify(events))>4*1024*1024) throw new CurrentNamespaceError("invalid_input");
}
/** Requires a retained scoped preimage and an actual confirmed namespace deletion.
 * Backend failure, missing stat, hidden membership and UNKNOWN never call this helper. */
export function namespaceTombstone(before: NamespaceDescriptor, reason: string, actor: NamespaceChange["actor"],
  proof: "confirmed_sql_namespace_removal"): NamespaceChange {
  if (!["confirmed_sql_namespace_removal"].includes(proof)) throw new CurrentNamespaceError("invalid_input");
  const event: NamespaceChange = { schema:"saturn.current-namespace-change.v1",nodeId:before.node_id,kind:"tombstone",
    description:{...before,version:randomUUID()},before_version:before.version,reason,actor:{...actor} };
  validateNamespaceChanges([event]); return event;
}
export async function assertNamespaceBinding(sql: TransactionSql, rootId: string, bindingVersion: string): Promise<void> {
  if (!UUID.test(bindingVersion)) throw new CurrentNamespaceError("invalid_input");
  const row=(await sql<{ ready:boolean }[]>`SELECT EXISTS(SELECT 1 FROM sync_root_clock
    WHERE root_id=${rootId} AND namespace_state='QUALIFYING' AND binding_version=${bindingVersion}
      AND descriptor_schema=${CURRENT_NAMESPACE_SCHEMA}) AS ready`)[0];
  if (!row?.ready) throw new CurrentNamespaceError("binding_invalid");
}
/** Explicit fixture-only inactive composition. No ACTIVE admission or usable public CAS. */
export class PostgresCurrentNamespace {
  #reads=0;
  constructor(private readonly database: Database) {}
  async qualifyFixture(rootId: string, nodeIds: readonly string[]): Promise<string> {
    if (!UUID.test(rootId) || nodeIds.length>500 || !nodeIds.includes(rootId) || nodeIds.some(id=>!UUID.test(id)) || new Set(nodeIds).size!==nodeIds.length) throw new CurrentNamespaceError("invalid_input");
    return this.database.transaction(async sql=>{
      await sql`SET LOCAL statement_timeout='2s'`; await sql`SET LOCAL lock_timeout='2s'`;
      const roots=await sql`SELECT root_id FROM sync_root_clock WHERE root_id=${rootId} AND namespace_state IN ('LEGACY','QUALIFYING','BACKEND_UNCERTAIN') FOR UPDATE`;
      if (roots.length!==1) throw new CurrentNamespaceError("binding_invalid");
      await sql`SELECT id FROM resources WHERE id=ANY(${[...nodeIds]}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
      const scoped=await sql<{node_id:string}[]>`WITH RECURSIVE chain AS (
        SELECT id AS node_id,id,parent_id,type,status,0 AS hops,ARRAY[id] AS visited FROM resources WHERE id=ANY(${[...nodeIds]}::uuid[]) AND status='active'
        UNION ALL SELECT c.node_id,r.id,r.parent_id,r.type,r.status,c.hops+1,c.visited||r.id FROM chain c CROSS JOIN LATERAL (
          SELECT id,parent_id,type,status FROM resources WHERE id=c.parent_id AND type='folder' AND status='active' LIMIT 1
        ) r WHERE c.id<>${rootId} AND c.hops<128 AND NOT r.id=ANY(c.visited)
      ), blocked AS (SELECT DISTINCT c.node_id FROM chain c CROSS JOIN LATERAL (
        SELECT root_id FROM sync_root_clock WHERE root_id=c.id LIMIT 1
      ) nested WHERE c.id<>${rootId})
      SELECT DISTINCT node_id FROM chain WHERE id=${rootId} AND type='folder' AND node_id NOT IN (SELECT node_id FROM blocked)`;
      if(scoped.length!==nodeIds.length) throw new CurrentNamespaceError("projection_unqualified");
      // Exact bounded IDs, no inferred AVAILABLE and no synthesized event/history.
      await sql`UPDATE resources SET metadata_version=coalesce(metadata_version,gen_random_uuid()) WHERE id=ANY(${[...nodeIds]}::uuid[])`;
      const row=(await sql<{binding_version:string}[]>`UPDATE sync_root_clock SET namespace_state='QUALIFYING',descriptor_schema=${CURRENT_NAMESPACE_SCHEMA},updated_at=now()
        WHERE root_id=${rootId} RETURNING binding_version`)[0];
      if (!row) throw new CurrentNamespaceError("binding_invalid"); return row.binding_version;
    });
  }
  async markBackendUncertain(rootId: string, expectedBinding: string): Promise<string> {
    if (!UUID.test(rootId) || !UUID.test(expectedBinding)) throw new CurrentNamespaceError("invalid_input");
    return this.database.transaction(async sql=>{
      await sql`SET LOCAL statement_timeout='2s'`; await sql`SET LOCAL lock_timeout='2s'`;
      const row=(await sql<{binding_version:string}[]>`UPDATE sync_root_clock SET namespace_state='BACKEND_UNCERTAIN',updated_at=now()
        WHERE root_id=${rootId} AND namespace_state='QUALIFYING' AND binding_version=${expectedBinding} RETURNING binding_version`)[0];
      if (!row) throw new CurrentNamespaceError("binding_invalid"); return row.binding_version;
    });
  }
  async read(rootId: string, bindingVersion: string, nodeIds: readonly string[]): Promise<readonly ({status:"FOUND";descriptor:NamespaceDescriptor}|{status:"UNKNOWN";nodeId:string})[]> {
    if (!UUID.test(rootId) || !UUID.test(bindingVersion) || nodeIds.length>500 || nodeIds.some(id=>!UUID.test(id)) || new Set(nodeIds).size!==nodeIds.length) throw new CurrentNamespaceError("invalid_input");
    // Single statement MVCC cut: binding and complete bounded ancestor proof cannot tear.
    // Four fixed in-flight reads per instance/process, no unbounded queue.
    if(this.#reads>=4)throw new CurrentNamespaceError("admission_full");
    this.#reads++;
    let rows:NamespaceProjectionRow[];
    try { rows=await this.database.withSql(async sql=>{
    const query=sql<NamespaceProjectionRow[]>`WITH RECURSIVE binding AS (
      SELECT c.root_id FROM sync_root_clock c JOIN resources root ON root.id=c.root_id AND root.type='folder' AND root.status='active'
        WHERE c.root_id=${rootId} AND c.binding_version=${bindingVersion}
        AND c.namespace_state='QUALIFYING' AND c.descriptor_schema=${CURRENT_NAMESPACE_SCHEMA}
    ), chain AS (
      SELECT r.id AS node_id,r.id,r.parent_id,r.status,0 AS hops,ARRAY[r.id] AS visited FROM resources r,binding WHERE r.id=ANY(${[...nodeIds]}::uuid[]) AND r.status='active'
      UNION ALL SELECT c.node_id,r.id,r.parent_id,r.status,c.hops+1,c.visited||r.id FROM chain c CROSS JOIN LATERAL (
        SELECT id,parent_id,status FROM resources WHERE id=c.parent_id AND type='folder' AND status='active' LIMIT 1
      ) r WHERE c.id<>${rootId} AND c.hops<128 AND NOT r.id=ANY(c.visited)
    ), blocked AS (SELECT DISTINCT c.node_id FROM chain c CROSS JOIN LATERAL (
      SELECT root_id FROM sync_root_clock WHERE root_id=c.id LIMIT 1
    ) nested WHERE c.id<>${rootId}),
    valid AS (SELECT DISTINCT node_id FROM chain WHERE id=${rootId} AND node_id NOT IN (SELECT node_id FROM blocked))
    SELECT r.* FROM valid v CROSS JOIN LATERAL (
      SELECT r.id,r.parent_id,CASE WHEN octet_length(r.name)<=1020 THEN r.name ELSE '' END AS name,r.type,r.size_bytes::text,r.sha256,r.current_version_id,r.metadata_version,r.sync_availability,r.status
      FROM resources r WHERE r.id=v.node_id LIMIT 1
    ) r ORDER BY r.id`;
    const deadline=new AbortController(),timer=setTimeout(()=>{deadline.abort();query.cancel();},2000);
    try {const result=await query;if(deadline.signal.aborted)throw new CurrentNamespaceError("read_timeout");return result;}
    catch(error){if(deadline.signal.aborted)throw new CurrentNamespaceError("read_timeout");throw error;}
    finally{clearTimeout(timer);}
    }); }finally{this.#reads--;}
    // A separate check after an empty result would claim a different cut. Include
    // no ABSENT assertion: invalidated scope and unavailable membership are UNKNOWN.
    const found=new Map(rows.filter(r=>r.metadata_version!==null).map(r=>[r.id,namespaceDescriptor(r,rootId)]));
    return nodeIds.map(nodeId=>{const descriptor=found.get(nodeId);return descriptor?{status:"FOUND",descriptor}:{status:"UNKNOWN",nodeId};});
  }
}
