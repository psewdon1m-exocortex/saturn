import { randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";
import type { SyncRootBinding, SyncNodeDescriptor } from "../../contracts/src/sync-protocol.js";
import { syncInteger64, validateSyncDescriptor } from "../../contracts/src/sync-protocol.js";
import { namespaceDescriptor, validateNamespaceChanges, type NamespaceChange, type NamespaceProjectionRow } from "../../file-core/src/current-namespace.js";
import { assertGuardedNamespaceAdmission, type GuardedNamespaceBinding } from "../../file-core/src/catalog-guard-admission.js";
import type { CatalogFolderAuthorityIssuer, CatalogFolderAuthority } from "../../file-core/src/catalog-folder-authority.js";

export class SyncSnapshotStageError extends Error {
  constructor(readonly code: "invalid_input" | "stage_unavailable" | "cursor_expired" | "journal_gap" | "projection_unqualified" | "capacity" | "admission_full") { super(code); }
}
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
type TransactionSql = Parameters<Parameters<Database["transaction"]>[0]>[0];
const MAX_BYTES = 4294967296n;
interface Stage {
  id: string; root_id: string; epoch: string; binding_version: string; guard_revision: string;
  server_identity: string; policy_version: string; authority_fingerprint: string;
  state: "BASE" | "OVERLAY" | "READY" | "DISCARDED";
  start_seq: string; applied_seq: string; cut_seq: string | null;
  entry_count: string; document_bytes: string;
}
interface Clock { published_seq: string; retained_after_seq: string }
export interface SyncSnapshotProgress { readonly snapshotId: string; readonly state: Stage["state"]; readonly startSeq: string; readonly appliedSeq: string; readonly cutSeq: string | null; readonly entries: string; readonly documentBytes: string }
export interface SyncSnapshotCollection { readonly snapshotId:string|null; readonly entriesRemoved:number; readonly frontierRemoved:number; readonly headerRemoved:boolean }
function progress(s: Stage): SyncSnapshotProgress { return { snapshotId:s.id,state:s.state,startSeq:s.start_seq,appliedSeq:s.applied_seq,cutSeq:s.cut_seq,entries:s.entry_count,documentBytes:s.document_bytes }; }

/** Inactive guarded-fixture composition. Complete supported-writer coverage,
 * physical executor fencing and public activation are separate gates. Base
 * rows can be observed at different cuts in [C,D]; full contiguous (C,D]
 * overlay supplies the final D projection, including earlier-key insertions.
 * Each transaction reads/writes at most500 descriptors and performs no I/O. */
export class PostgresSyncSnapshotStage {
  #active = 0;
  readonly #scope: Readonly<{ wire:SyncRootBinding; guard:GuardedNamespaceBinding }>;
  constructor(private readonly database:Database, private readonly authority:CatalogFolderAuthorityIssuer,
    scope:{ readonly wire:SyncRootBinding; readonly guard:GuardedNamespaceBinding }) {
    const w=scope.wire,g=scope.guard;
    const raw=w as unknown as Record<string,unknown>;
    if(raw["protocol"]!=="neptune-sync/1"||raw["descriptor_schema"]!=="saturn.current-namespace.v1"||w.root_id!==g.rootId||w.server_epoch!==g.epoch||w.binding_version!==g.bindingVersion
      ||[g.rootId,g.epoch,g.bindingVersion,g.guardRevision].some(v=>!UUID.test(v))||[w.server_identity,w.policy_version].some(v=>!/^[\x21-\x7e]{1,128}$/.test(v))) throw new SyncSnapshotStageError("invalid_input");
    this.#scope=Object.freeze({wire:Object.freeze({...w}),guard:Object.freeze({...g})});
  }
  async #admit<T>(action:()=>Promise<T>):Promise<T> {
    if(this.#active>=4)throw new SyncSnapshotStageError("admission_full");
    this.#active++;try{return await action();}finally{this.#active--;}
  }
  async #clock(sql:TransactionSql,proof:CatalogFolderAuthority):Promise<{clock:Clock; fingerprint:string}> {
    await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL statement_timeout='2s'`;await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
    const clock=(await sql<Clock[]>`SELECT published_seq::text,retained_after_seq::text FROM sync_root_clock WHERE root_id=${this.#scope.guard.rootId} FOR UPDATE`)[0];
    if(!clock)throw new SyncSnapshotStageError("stage_unavailable");
    await assertGuardedNamespaceAdmission(sql,this.#scope.guard);
    const fingerprint=await this.authority.fingerprint(sql,proof,this.#scope.guard.rootId);
    return {clock,fingerprint};
  }
  async #stage(sql:TransactionSql,id:string,fingerprint:string,clock:Clock):Promise<Stage> {
    if(!UUID.test(id))throw new SyncSnapshotStageError("invalid_input");
    const s=(await sql<Stage[]>`SELECT id,root_id,epoch,binding_version,guard_revision,server_identity,policy_version,authority_fingerprint,state,
      start_seq::text,applied_seq::text,cut_seq::text,entry_count::text,document_bytes::text FROM sync_snapshot_stage WHERE id=${id} FOR UPDATE`)[0];
    const {wire:w,guard:g}=this.#scope;
    if(!s||s.root_id!==g.rootId||s.epoch!==g.epoch||s.binding_version!==g.bindingVersion||s.guard_revision!==g.guardRevision||s.authority_fingerprint!==fingerprint
      ||s.server_identity!==w.server_identity||s.policy_version!==w.policy_version||s.state==="DISCARDED")throw new SyncSnapshotStageError("stage_unavailable");
    const live=(await sql<{live:boolean}[]>`SELECT clock_timestamp()>=last_observed_at AND clock_timestamp()<lease_until AND clock_timestamp()<absolute_until AS live FROM sync_snapshot_stage WHERE id=${id}`)[0]?.live;
    if(!live||BigInt(clock.retained_after_seq)>BigInt(s.state==="READY"?s.applied_seq:s.start_seq)||BigInt(clock.published_seq)<BigInt(s.applied_seq))throw new SyncSnapshotStageError("cursor_expired");
    await sql`UPDATE sync_snapshot_stage SET last_observed_at=clock_timestamp(),lease_until=least(clock_timestamp()+interval '5 minutes',absolute_until) WHERE id=${id}`;
    return s;
  }
  async #apply(sql:TransactionSql,s:Stage,documents:ReadonlyMap<string,SyncNodeDescriptor|null>):Promise<void> {
    if(documents.size>500)throw new SyncSnapshotStageError("invalid_input");
    if(documents.size===0)return;
    const ids=[...documents.keys()],previous=await sql<{node_id:string;bytes:string}[]>`SELECT node_id,octet_length(document::text)::text AS bytes
      FROM sync_snapshot_entries WHERE snapshot_id=${s.id} AND node_id=ANY(${ids}::uuid[])`;
    const old=new Map(previous.map(r=>[r.node_id,BigInt(r.bytes)])),upserts:{node_id:string;document:SyncNodeDescriptor}[]=[],deletes:string[]=[];
    for(const [id,d] of documents){if(d===null)deletes.push(id);else{validateSyncDescriptor(d);if(d.node_id!==id||Buffer.byteLength(JSON.stringify(d))>4096)throw new SyncSnapshotStageError("projection_unqualified");upserts.push({node_id:id,document:d});}}
    if(deletes.length)await sql`DELETE FROM sync_snapshot_entries WHERE snapshot_id=${s.id} AND node_id=ANY(${deletes}::uuid[])`;
    const written=upserts.length?await sql<{node_id:string;bytes:string}[]>`INSERT INTO sync_snapshot_entries(snapshot_id,node_id,document)
      SELECT ${s.id},p.node_id,p.document FROM jsonb_to_recordset(${sql.json(upserts.map(r=>({node_id:r.node_id,document:{...r.document}})))}) AS p(node_id uuid,document jsonb)
      ON CONFLICT(snapshot_id,node_id) DO UPDATE SET document=EXCLUDED.document RETURNING node_id,octet_length(document::text)::text AS bytes`:[];
    let count=BigInt(s.entry_count),bytes=BigInt(s.document_bytes);
    for(const id of deletes)if(old.has(id)){count--;bytes-=old.get(id)??0n;}
    for(const row of written){if(!old.has(row.node_id))count++;bytes+=BigInt(row.bytes)-(old.get(row.node_id)??0n);}
    if(bytes>MAX_BYTES||count<0n||bytes<0n)throw new SyncSnapshotStageError("capacity");
    const admitted=(await sql<{admitted:boolean}[]>`SELECT pg_try_advisory_xact_lock(hashtextextended('saturn.sync.snapshot.admission.v1',0)) AS admitted`)[0]?.admitted;
    if(!admitted)throw new SyncSnapshotStageError("admission_full");
    const total=(await sql<{bytes:string}[]>`SELECT coalesce(sum(document_bytes),0)::text AS bytes FROM sync_snapshot_stage`)[0]?.bytes;
    if(total===undefined||BigInt(total)+bytes-BigInt(s.document_bytes)>MAX_BYTES)throw new SyncSnapshotStageError("capacity");
    s.entry_count=count.toString();s.document_bytes=bytes.toString();
    await sql`UPDATE sync_snapshot_stage SET entry_count=${s.entry_count},document_bytes=${s.document_bytes} WHERE id=${s.id}`;
  }
  /** A client persists this UUID before the first request. Repeating it resumes
   * the same stage after a lost admission response; it cannot extend or revive
   * an expired original stage or adopt another actor's/binding's work. */
  async start(proof:CatalogFolderAuthority,originalSnapshotId:string=randomUUID()):Promise<SyncSnapshotProgress> {
    if(!UUID.test(originalSnapshotId))throw new SyncSnapshotStageError("invalid_input");
    return this.#admit(()=>this.database.transaction(async sql=>{
      const {clock,fingerprint}=await this.#clock(sql,proof),g=this.#scope.guard,w=this.#scope.wire;
      const existing=(await sql`SELECT id FROM sync_snapshot_stage WHERE id=${originalSnapshotId}`).length>0;
      if(existing)return progress(await this.#stage(sql,originalSnapshotId,fingerprint,clock));
      const admitted=(await sql<{admitted:boolean}[]>`SELECT pg_try_advisory_xact_lock(hashtextextended('saturn.sync.snapshot.admission.v1',0)) AS admitted`)[0]?.admitted;
      if(!admitted)throw new SyncSnapshotStageError("admission_full");
      const total=(await sql<{count:number}[]>`SELECT count(*)::int AS count FROM (SELECT id FROM sync_snapshot_stage LIMIT 64) all_stages`)[0]?.count??64;
      const live=(await sql<{count:number}[]>`SELECT count(*)::int AS count FROM (SELECT id FROM sync_snapshot_stage WHERE state<>'DISCARDED'
        AND lease_until>clock_timestamp() AND absolute_until>clock_timestamp() LIMIT 16) live`)[0]?.count??16;
      if(total>=64||live>=16)throw new SyncSnapshotStageError("admission_full");
      const root=(await sql<NamespaceProjectionRow[]>`SELECT id,parent_id,CASE WHEN octet_length(name)<=1020 THEN name ELSE '' END AS name,type,size_bytes::text,
        CASE WHEN octet_length(sha256)<=64 THEN sha256 WHEN sha256 IS NULL THEN NULL ELSE '' END AS sha256,current_version_id,metadata_version,sync_availability,status FROM resources WHERE id=${g.rootId}`)[0];
      if(!root||root.type!=="folder")throw new SyncSnapshotStageError("projection_unqualified");
      const descriptor=namespaceDescriptor(root,g.rootId),id=originalSnapshotId;
      const s=(await sql<Stage[]>`INSERT INTO sync_snapshot_stage(id,root_id,epoch,binding_version,guard_revision,server_identity,policy_version,authority_fingerprint,
        state,start_seq,applied_seq,lease_until,absolute_until) VALUES(${id},${g.rootId},${g.epoch},${g.bindingVersion},${g.guardRevision},${w.server_identity},${w.policy_version},${fingerprint},
        'BASE',${clock.published_seq},${clock.published_seq},clock_timestamp()+interval '5 minutes',clock_timestamp()+interval '1 hour')
        RETURNING id,root_id,epoch,binding_version,guard_revision,server_identity,policy_version,authority_fingerprint,state,start_seq::text,applied_seq::text,cut_seq::text,entry_count::text,document_bytes::text`)[0];
      if(!s)throw new SyncSnapshotStageError("stage_unavailable");
      await this.#apply(sql,s,new Map([[descriptor.node_id,descriptor]]));
      await sql`INSERT INTO sync_snapshot_frontier(snapshot_id,parent_id,depth) VALUES(${id},${g.rootId},0)`;
      return progress(s);
    }));
  }
  async step(id:string,proof:CatalogFolderAuthority):Promise<SyncSnapshotProgress> {
    return this.#admit(()=>this.database.transaction(async sql=>{
      const {clock,fingerprint}=await this.#clock(sql,proof),s=await this.#stage(sql,id,fingerprint,clock);
      if(s.state==="READY")return progress(s);
      if(s.state==="BASE") {
        const frontier=await sql<{parent_id:string;depth:number;last_child_id:string|null}[]>`SELECT parent_id,depth,last_child_id FROM sync_snapshot_frontier
          WHERE snapshot_id=${id} AND NOT complete ORDER BY depth,parent_id LIMIT 16 FOR UPDATE`;
        if(!frontier.length){s.state="OVERLAY";await sql`UPDATE sync_snapshot_stage SET state='OVERLAY' WHERE id=${id}`;return progress(s);}
        // Distinct first/continued statements keep a generic prepared plan's
        // nullable OR from rescanning an already-consumed wide parent prefix.
        const perParent=Math.floor(500/frontier.length);
        const children=await sql<NamespaceProjectionRow[]>`WITH f AS (
          SELECT * FROM jsonb_to_recordset(${sql.json(frontier)}) p(parent_id uuid,last_child_id uuid,depth integer)
        ) SELECT r.id,r.parent_id,CASE WHEN octet_length(r.name)<=1020 THEN r.name ELSE '' END AS name,r.type,r.size_bytes::text,
          CASE WHEN octet_length(r.sha256)<=64 THEN r.sha256 WHEN r.sha256 IS NULL THEN NULL ELSE '' END AS sha256,
          r.current_version_id,r.metadata_version,r.sync_availability,r.status
          FROM f CROSS JOIN LATERAL (
            (SELECT * FROM resources WHERE f.last_child_id IS NULL AND parent_id=f.parent_id AND status='active' ORDER BY id LIMIT ${perParent+1})
            UNION ALL
            (SELECT * FROM resources WHERE f.last_child_id IS NOT NULL AND parent_id=f.parent_id AND status='active' AND id>f.last_child_id ORDER BY id LIMIT ${perParent+1})
          ) r ORDER BY r.parent_id,r.id`;
        const page:NamespaceProjectionRow[]=[],checkpoints:{parent_id:string;last_child_id:string|null;complete:boolean}[]=[],folders:{parent_id:string;depth:number}[]=[];
        for(const parent of frontier){
          const found=children.filter(row=>row.parent_id===parent.parent_id),part=found.slice(0,perParent);
          if(part.length&&parent.depth>=128)throw new SyncSnapshotStageError("projection_unqualified");
          page.push(...part);
          folders.push(...part.filter(row=>row.type==='folder').map(row=>({parent_id:row.id,depth:parent.depth+1})));
          checkpoints.push({parent_id:parent.parent_id,last_child_id:part.at(-1)?.id??parent.last_child_id,complete:found.length<=perParent});
        }
        if(page.length&&(await sql`SELECT root_id FROM sync_root_clock WHERE root_id=ANY(${page.map(row=>row.id)}::uuid[]) AND root_id<>${s.root_id} LIMIT 1`).length)throw new SyncSnapshotStageError("projection_unqualified");
        const descriptors=new Map<string,SyncNodeDescriptor|null>();
        for(const row of page)descriptors.set(row.id,namespaceDescriptor(row,s.root_id));
        await this.#apply(sql,s,descriptors);
        if(folders.length)await sql`INSERT INTO sync_snapshot_frontier(snapshot_id,parent_id,depth)
          SELECT ${id},p.parent_id,p.depth FROM jsonb_to_recordset(${sql.json(folders)}) p(parent_id uuid,depth smallint) ON CONFLICT DO NOTHING`;
        await sql`UPDATE sync_snapshot_frontier f SET last_child_id=p.last_child_id,complete=p.complete
          FROM jsonb_to_recordset(${sql.json(checkpoints)}) p(parent_id uuid,last_child_id uuid,complete boolean)
          WHERE f.snapshot_id=${id} AND f.parent_id=p.parent_id`;
        return progress(s);
      }
      const expected=BigInt(s.applied_seq)+1n,remaining=BigInt(clock.published_seq)-BigInt(s.applied_seq);
      const events=await sql<{seq:string;document:unknown}[]>`SELECT c.seq::text AS seq,CASE WHEN octet_length(c.document::text)<=4096 THEN c.document ELSE NULL END AS document FROM sync_root_changes c WHERE c.root_id=${s.root_id} AND c.epoch=${s.epoch}
        AND c.seq>${s.applied_seq} AND c.seq<=${clock.published_seq} ORDER BY c.seq LIMIT 500`;
      if(events.length!==Number(remaining>500n?500n:remaining))throw new SyncSnapshotStageError("journal_gap");
      const documents=new Map<string,SyncNodeDescriptor|null>();
      for(let i=0;i<events.length;i++){
        const event=events[i];if(!event||syncInteger64(event.seq)!==expected+BigInt(i))throw new SyncSnapshotStageError("journal_gap");
        try{const change=event.document as NamespaceChange;validateNamespaceChanges([change]);documents.set(change.nodeId,change.kind==="upsert"?change.description:null);}catch{throw new SyncSnapshotStageError("projection_unqualified");}
      }
      await this.#apply(sql,s,documents);
      s.applied_seq=events.at(-1)?.seq??s.applied_seq;
      if(s.applied_seq===clock.published_seq){s.state="READY";s.cut_seq=s.applied_seq;await sql`UPDATE sync_snapshot_stage SET state='READY',applied_seq=${s.applied_seq},cut_seq=${s.cut_seq} WHERE id=${id}`;}
      else await sql`UPDATE sync_snapshot_stage SET applied_seq=${s.applied_seq} WHERE id=${id}`;
      return progress(s);
    }));
  }
  /** Internal janitor for only expired/discarded staging, never catalogue,
   * retained original operations or client B. Each call removes at most500
   * documents and500 frontier rows. Retained capacity is released atomically.
   * Global admission is nonwaiting; stage rows are SKIP LOCKED, so this path
   * cannot invert the root-clock→stage lock order of a live reader. */
  async collectExpired():Promise<SyncSnapshotCollection> {
    return this.#admit(()=>this.database.transaction(async sql=>{
      await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL statement_timeout='2s'`;await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
      // Idle maintenance must not take capacity admission away from a live
      // snapshot. Recheck the candidate under the existing lock below.
      if(!(await sql`SELECT id FROM sync_snapshot_stage WHERE state='DISCARDED' OR lease_until<=clock_timestamp() OR absolute_until<=clock_timestamp() LIMIT 1`).length)
        return {snapshotId:null,entriesRemoved:0,frontierRemoved:0,headerRemoved:false};
      const admitted=(await sql<{admitted:boolean}[]>`SELECT pg_try_advisory_xact_lock(hashtextextended('saturn.sync.snapshot.admission.v1',0)) AS admitted`)[0]?.admitted;
      if(!admitted)throw new SyncSnapshotStageError("admission_full");
      const s=(await sql<{id:string;entry_count:string;document_bytes:string}[]>`SELECT id,entry_count::text,document_bytes::text FROM sync_snapshot_stage
        WHERE state='DISCARDED' OR lease_until<=clock_timestamp() OR absolute_until<=clock_timestamp()
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)[0];
      if(!s)return {snapshotId:null,entriesRemoved:0,frontierRemoved:0,headerRemoved:false};
      await sql`UPDATE sync_snapshot_stage SET state='DISCARDED',cut_seq=NULL WHERE id=${s.id}`;
      const removed=await sql<{bytes:string}[]>`DELETE FROM sync_snapshot_entries WHERE snapshot_id=${s.id} AND node_id IN
        (SELECT node_id FROM sync_snapshot_entries WHERE snapshot_id=${s.id} ORDER BY node_id LIMIT 500)
        RETURNING octet_length(document::text)::text AS bytes`;
      const frontier=await sql`DELETE FROM sync_snapshot_frontier WHERE snapshot_id=${s.id} AND parent_id IN
        (SELECT parent_id FROM sync_snapshot_frontier WHERE snapshot_id=${s.id} ORDER BY parent_id LIMIT 500) RETURNING parent_id`;
      const count=BigInt(s.entry_count)-BigInt(removed.length),bytes=BigInt(s.document_bytes)-removed.reduce((n,row)=>n+BigInt(row.bytes),0n);
      if(count<0n||bytes<0n)throw new SyncSnapshotStageError("projection_unqualified");
      await sql`UPDATE sync_snapshot_stage SET entry_count=${count.toString()},document_bytes=${bytes.toString()} WHERE id=${s.id}`;
      const remaining=(await sql<{entries:boolean;frontier:boolean}[]>`SELECT EXISTS(SELECT 1 FROM sync_snapshot_entries WHERE snapshot_id=${s.id}) AS entries,
        EXISTS(SELECT 1 FROM sync_snapshot_frontier WHERE snapshot_id=${s.id}) AS frontier`)[0];
      const done=remaining!==undefined&&!remaining.entries&&!remaining.frontier;
      if(done){if(count!==0n||bytes!==0n)throw new SyncSnapshotStageError("projection_unqualified");await sql`DELETE FROM sync_snapshot_stage WHERE id=${s.id}`;}
      return {snapshotId:s.id,entriesRemoved:removed.length,frontierRemoved:frontier.length,headerRemoved:done};
    }));
  }
}
