import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";
import { assertGuardedNamespaceAdmission, type GuardedNamespaceBinding } from "../../file-core/src/catalog-guard-admission.js";
import type { CatalogFolderAuthorityIssuer, CatalogFolderAuthority } from "../../file-core/src/catalog-folder-authority.js";
import { validateNamespaceChanges, type NamespaceChange } from "../../file-core/src/current-namespace.js";
import { encodeSyncJson, validateSyncSnapshotReady, validateSyncFeedPage, type SyncRootBinding, type SyncSnapshotReady, type SyncNodeDescriptor, type SyncFeedPage } from "../../contracts/src/sync-protocol.js";
import { validateSyncSnapshotEntriesPage, type SyncSnapshotEntriesPage } from "../../contracts/src/sync-snapshot-page.js";
import { SyncCursorCodec, type SyncCursorBinding, type SyncCursorKey, type SyncCursorPosition } from "./sync-cursor.js";

type TransactionSql = Parameters<Parameters<Database["transaction"]>[0]>[0];
interface Stage {
  id:string;root_id:string;epoch:string;binding_version:string;guard_revision:string;server_identity:string;policy_version:string;authority_fingerprint:string;
  cut_seq:string;entries_cursor:string|null;changes_cursor:string|null;cursor_count:number;now_seconds:number;absolute_seconds:number;lease_seconds:number;
}
interface Cursor {snapshot_id:string;kind:"snapshot"|"feed";position:SyncCursorPosition;next_token:string|null;covered_last_node:string|null;covered_through_seq:string|null;covered_count:number|null;covered_has_more:boolean|null}
interface Context {stage:Stage;published:string;binding:SyncCursorBinding;codec:SyncCursorCodec}
type StoredStage=Omit<Stage,"now_seconds"|"absolute_seconds"|"lease_seconds">&{now_seconds:string;absolute_seconds:string;lease_seconds:string};
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export class SyncSnapshotReadError extends Error {
  constructor(readonly code:"invalid_input"|"stage_unavailable"|"cursor_expired"|"invalid_cursor"|"journal_gap"|"projection_unqualified"|"capacity"|"admission_full") {super(code);}
}
const hash=(token:string)=>createHash("sha256").update(token).digest("hex");
function inner(token:string):string {
  if(typeof token!=="string"||token.length>4096||!token.startsWith("pg1.")||!UUID.test(token.slice(4,40))||token[40]!==".")throw new SyncSnapshotReadError("invalid_cursor");
  return token.slice(41);
}
const wrap=(token:string)=>`pg1.${randomUUID()}.${token}`;
function samePosition(a:SyncCursorPosition,b:SyncCursorPosition):boolean {
  return a.kind===b.kind&&(a.kind==="feed"&&b.kind==="feed"?a.afterSeq===b.afterSeq:a.kind==="snapshot"&&b.kind==="snapshot"&&a.snapshotId===b.snapshotId&&a.cutSeq===b.cutSeq&&a.lastNodeId===b.lastNodeId);
}

/** Internal guarded-fixture reader, deliberately absent from public routes and
 * capability advertisement. HMAC position, durable token registration, current
 * authority and one immutable DB session lease are all required. A response is
 * committed before delivery and replayed exactly after a lost acknowledgement.
 * No filesystem/network I/O occurs inside these bounded transactions. */
export class PostgresSyncSnapshotReader {
  #active=0;
  readonly #scope:Readonly<{wire:SyncRootBinding;guard:GuardedNamespaceBinding}>;
  readonly #keys:readonly SyncCursorKey[];
  constructor(private readonly database:Database,private readonly authority:CatalogFolderAuthorityIssuer,
    scope:{wire:SyncRootBinding;guard:GuardedNamespaceBinding},private readonly currentKey:string,keys:readonly SyncCursorKey[]) {
    validateSyncSnapshotReady({...scope.wire,snapshot_id:randomUUID(),state:"READY",cut_seq:"0",entries_cursor:"pending",changes_cursor:"pending",lease_seconds:1,absolute_lifetime_seconds:1});
    if(scope.wire.root_id!==scope.guard.rootId||scope.wire.server_epoch!==scope.guard.epoch||scope.wire.binding_version!==scope.guard.bindingVersion||[scope.guard.rootId,scope.guard.epoch,scope.guard.bindingVersion,scope.guard.guardRevision].some(v=>!UUID.test(v)))throw new SyncSnapshotReadError("invalid_input");
    this.#scope=Object.freeze({wire:Object.freeze({...scope.wire}),guard:Object.freeze({...scope.guard})});
    this.#keys=keys.map(k=>({id:k.id,secret:Uint8Array.from(k.secret)}));this.#codec(0,3600);
  }
  #codec(now:number,remaining:number):SyncCursorCodec {
    return new SyncCursorCodec({keys:this.#keys,currentKey:this.currentKey,nowSeconds:()=>now,leaseSeconds:Math.min(300,remaining),absoluteSeconds:remaining});
  }
  async #admit<T>(action:()=>Promise<T>):Promise<T>{if(this.#active>=4)throw new SyncSnapshotReadError("admission_full");this.#active++;try{return await action();}finally{this.#active--;}}
  async #context(sql:TransactionSql,id:string,proof:CatalogFolderAuthority):Promise<Context> {
    await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL statement_timeout='2s'`;await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
    const clock=(await sql<{published:string;retained:string}[]>`SELECT published_seq::text AS published,retained_after_seq::text AS retained FROM sync_root_clock WHERE root_id=${this.#scope.guard.rootId} FOR UPDATE`)[0];
    if(!clock)throw new SyncSnapshotReadError("stage_unavailable");
    await assertGuardedNamespaceAdmission(sql,this.#scope.guard);
    const fingerprint=await this.authority.fingerprint(sql,proof,this.#scope.guard.rootId);
    const stored=(await sql<StoredStage[]>`SELECT id,root_id,epoch,binding_version,guard_revision,server_identity,policy_version,authority_fingerprint,cut_seq::text,
      entries_cursor,changes_cursor,cursor_count,floor(extract(epoch FROM clock_timestamp()))::bigint::text AS now_seconds,
      floor(extract(epoch FROM absolute_until))::bigint::text AS absolute_seconds,floor(extract(epoch FROM lease_until))::bigint::text AS lease_seconds
      FROM sync_snapshot_stage WHERE id=${id} AND state='READY' FOR UPDATE`)[0];
    const s=stored?{...stored,now_seconds:Number(stored.now_seconds),absolute_seconds:Number(stored.absolute_seconds),lease_seconds:Number(stored.lease_seconds)}:undefined;
    const {wire:w,guard:g}=this.#scope;
    if(!s||s.root_id!==g.rootId||s.epoch!==g.epoch||s.binding_version!==g.bindingVersion||s.guard_revision!==g.guardRevision||s.server_identity!==w.server_identity||s.policy_version!==w.policy_version||s.authority_fingerprint!==fingerprint)throw new SyncSnapshotReadError("stage_unavailable");
    const live=(await sql<{live:boolean}[]>`SELECT clock_timestamp()>=last_observed_at AND clock_timestamp()<lease_until AND clock_timestamp()<absolute_until AS live FROM sync_snapshot_stage WHERE id=${id}`)[0]?.live;
    if(!live||s.absolute_seconds<=s.now_seconds||BigInt(clock.retained)>BigInt(s.cut_seq)||BigInt(clock.published)<BigInt(s.cut_seq))throw new SyncSnapshotReadError("cursor_expired");
    await sql`UPDATE sync_snapshot_stage SET last_observed_at=clock_timestamp(),lease_until=least(clock_timestamp()+interval '5 minutes',absolute_until) WHERE id=${id}`;
    const binding:SyncCursorBinding={serverIdentity:s.server_identity,rootId:s.root_id,serverEpoch:s.epoch,policyVersion:s.policy_version,bindingVersion:s.binding_version,authorityFingerprint:s.authority_fingerprint};
    return {stage:s,published:clock.published,binding,codec:this.#codec(s.now_seconds,s.absolute_seconds-s.now_seconds)};
  }
  #ready(c:Context):SyncSnapshotReady {
    const s=c.stage;if(!s.entries_cursor||!s.changes_cursor)throw new SyncSnapshotReadError("stage_unavailable");
    const result:SyncSnapshotReady={...this.#scope.wire,snapshot_id:s.id,state:"READY",cut_seq:s.cut_seq,entries_cursor:s.entries_cursor,changes_cursor:s.changes_cursor,
      lease_seconds:Math.min(300,s.absolute_seconds-s.now_seconds),absolute_lifetime_seconds:s.absolute_seconds-s.now_seconds};
    validateSyncSnapshotReady(result);return result;
  }
  async #register(sql:TransactionSql,c:Context,token:string,position:SyncCursorPosition):Promise<void> {
    const admitted=(await sql<{admitted:boolean}[]>`SELECT pg_try_advisory_xact_lock(hashtextextended('saturn.sync.snapshot.admission.v1',0)) AS admitted`)[0]?.admitted;
    if(!admitted)throw new SyncSnapshotReadError("admission_full");
    const total=(await sql<{count:string}[]>`SELECT coalesce(sum(cursor_count),0)::text AS count FROM sync_snapshot_stage`)[0]?.count;
    // This session can never allocate another cursor. Retrying its tail as
    // transient capacity pressure cannot make progress; the caller must obtain
    // a new qualified snapshot. Sealed pages still replay without allocation.
    if(c.stage.cursor_count>=4096)throw new SyncSnapshotReadError("cursor_expired");
    if(total===undefined||BigInt(total)>=32768n)throw new SyncSnapshotReadError("capacity");
    await sql`INSERT INTO sync_snapshot_cursor(token_hash,snapshot_id,kind,position) VALUES(${hash(token)},${c.stage.id},${position.kind},${JSON.stringify(position)}::text::jsonb)`;
    c.stage.cursor_count++;await sql`UPDATE sync_snapshot_stage SET cursor_count=${c.stage.cursor_count} WHERE id=${c.stage.id}`;
  }
  async ready(id:string,proof:CatalogFolderAuthority):Promise<SyncSnapshotReady> {
    if(!UUID.test(id))throw new SyncSnapshotReadError("invalid_input");
    return this.#admit(()=>this.database.transaction(async sql=>{
      const c=await this.#context(sql,id,proof),s=c.stage;
      if(s.entries_cursor===null){const entries:SyncCursorPosition={kind:"snapshot",snapshotId:id,cutSeq:s.cut_seq,lastNodeId:null},changes:SyncCursorPosition={kind:"feed",afterSeq:s.cut_seq};
        s.entries_cursor=wrap(c.codec.issue(c.binding,entries));s.changes_cursor=wrap(c.codec.issue(c.binding,changes));
        await this.#register(sql,c,s.entries_cursor,entries);await this.#register(sql,c,s.changes_cursor,changes);
        await sql`UPDATE sync_snapshot_stage SET entries_cursor=${s.entries_cursor},changes_cursor=${s.changes_cursor} WHERE id=${id}`;
      }
      const entriesState=c.codec.verify(inner(s.entries_cursor),c.binding);if(!s.changes_cursor)throw new SyncSnapshotReadError("stage_unavailable");
      const changesState=c.codec.verify(inner(s.changes_cursor),c.binding);
      return {...this.#ready(c),lease_seconds:Math.min(entriesState.leaseUntilSeconds,changesState.leaseUntilSeconds)-s.now_seconds};
    }));
  }
  async #cursor(sql:TransactionSql,token:string,proof:CatalogFolderAuthority,kind:Cursor["kind"]):Promise<{context:Context;cursor:Cursor}> {
    const raw=inner(token),id=(await sql<{snapshot_id:string}[]>`SELECT snapshot_id FROM sync_snapshot_cursor WHERE token_hash=${hash(token)}`)[0]?.snapshot_id;
    if(!id)throw new SyncSnapshotReadError("invalid_cursor");
    const context=await this.#context(sql,id,proof),cursor=(await sql<Cursor[]>`SELECT snapshot_id,kind,position,next_token,covered_last_node,covered_through_seq::text,covered_count,covered_has_more FROM sync_snapshot_cursor WHERE token_hash=${hash(token)} FOR UPDATE`)[0];
    const verified=context.codec.verify(raw,context.binding);
    if(!cursor||cursor.snapshot_id!==id||cursor.kind!==kind||!samePosition(cursor.position,verified.position)
      ||verified.position.kind==="snapshot"&&(verified.position.snapshotId!==id||verified.position.cutSeq!==context.stage.cut_seq))throw new SyncSnapshotReadError("invalid_cursor");
    return {context,cursor};
  }
  async #next(sql:TransactionSql,c:Context,token:string,position:SyncCursorPosition):Promise<string>{
    // A fresh durable outer nonce prevents a same-second empty feed from
    // returning the same token forever. The full handle is DB-bound; its inner
    // signature retains the original issuedAt/absolute lifetime across pages.
    const next=wrap(c.codec.renew(c.codec.advance(inner(token),c.binding,position),c.binding));await this.#register(sql,c,next,position);return next;
  }
  async entries(token:string,proof:CatalogFolderAuthority):Promise<Uint8Array> {
    return this.#admit(()=>this.database.transaction(async sql=>{
      const {context:c,cursor:r}=await this.#cursor(sql,token,proof,"snapshot");if(r.position.kind!=="snapshot")throw new SyncSnapshotReadError("invalid_cursor");
      const after=r.position.lastNodeId;
      type Row={node_id:string;document:SyncNodeDescriptor|null};let rows:Row[];
      if(r.next_token!==null){rows=r.covered_count===0?[]:after===null?await sql<Row[]>`SELECT node_id,CASE WHEN octet_length(document::text)<=4096 THEN document ELSE NULL END AS document FROM sync_snapshot_entries WHERE snapshot_id=${c.stage.id} AND node_id<=${r.covered_last_node}::uuid ORDER BY node_id LIMIT 500`:
        await sql<Row[]>`SELECT node_id,CASE WHEN octet_length(document::text)<=4096 THEN document ELSE NULL END AS document FROM sync_snapshot_entries WHERE snapshot_id=${c.stage.id} AND node_id>${after}::uuid AND node_id<=${r.covered_last_node}::uuid ORDER BY node_id LIMIT 500`;
        if(rows.length!==r.covered_count)throw new SyncSnapshotReadError("projection_unqualified");
      }else{rows=after===null?await sql<Row[]>`SELECT node_id,CASE WHEN octet_length(document::text)<=4096 THEN document ELSE NULL END AS document FROM sync_snapshot_entries WHERE snapshot_id=${c.stage.id} ORDER BY node_id LIMIT 501`:
        await sql<Row[]>`SELECT node_id,CASE WHEN octet_length(document::text)<=4096 THEN document ELSE NULL END AS document FROM sync_snapshot_entries WHERE snapshot_id=${c.stage.id} AND node_id>${after}::uuid ORDER BY node_id LIMIT 501`;
        r.covered_has_more=rows.length>500;rows=rows.slice(0,500);r.covered_last_node=rows.at(-1)?.node_id??after;r.covered_count=rows.length;
        r.next_token=await this.#next(sql,c,token,{...r.position,lastNodeId:r.covered_last_node});
        await sql`UPDATE sync_snapshot_cursor SET next_token=${r.next_token},covered_last_node=${r.covered_last_node},covered_count=${r.covered_count},covered_has_more=${r.covered_has_more} WHERE token_hash=${hash(token)}`;
      }
      if(rows.some(row=>row.document===null||row.document.node_id!==row.node_id))throw new SyncSnapshotReadError("projection_unqualified");
      const page:SyncSnapshotEntriesPage={...this.#scope.wire,snapshot_id:c.stage.id,cut_seq:c.stage.cut_seq,after_node_id:after,last_node_id:r.covered_last_node,items:rows.map(row=>row.document as SyncNodeDescriptor),next_cursor:r.next_token,has_more:r.covered_has_more as boolean};
      validateSyncSnapshotEntriesPage(page,this.#ready(c),after);return encodeSyncJson(page);
    }));
  }
  /** Poll the original cursor without sealing an empty response. Once sealed,
   * replay must return immediately and preserve its original boundary. */
  async changesAvailable(token:string,proof:CatalogFolderAuthority):Promise<boolean>{
    return this.#admit(()=>this.database.transaction(async sql=>{
      const {context,cursor}=await this.#cursor(sql,token,proof,'feed');
      if(cursor.position.kind!=='feed')throw new SyncSnapshotReadError('invalid_cursor');
      return cursor.next_token!==null||BigInt(context.published)>BigInt(cursor.position.afterSeq);
    }));
  }
  async changes(token:string,proof:CatalogFolderAuthority):Promise<Uint8Array> {
    return this.#admit(()=>this.database.transaction(async sql=>{
      const {context:c,cursor:r}=await this.#cursor(sql,token,proof,"feed");if(r.position.kind!=="feed")throw new SyncSnapshotReadError("invalid_cursor");
      const after=BigInt(r.position.afterSeq),through=r.next_token===null?(BigInt(c.published)-after>500n?after+500n:BigInt(c.published)):BigInt(r.covered_through_seq??"-1");
      if(after<BigInt(c.stage.cut_seq)||after>BigInt(c.published)||through<after||through-after>500n)throw new SyncSnapshotReadError("invalid_cursor");
      const rows=await sql<{seq:string;operation_id:string;node_id:string;document:unknown}[]>`SELECT e.seq::text AS seq,e.operation_id,e.node_id,CASE WHEN octet_length(e.document::text)<=4096 THEN e.document ELSE NULL END AS document FROM sync_root_changes e WHERE e.root_id=${c.stage.root_id} AND e.epoch=${c.stage.epoch} AND e.seq>${after.toString()} AND e.seq<=${through.toString()} ORDER BY e.seq LIMIT 500`;
      if(rows.length!==Number(through-after))throw new SyncSnapshotReadError("journal_gap");
      const items:SyncFeedPage["items"][number][]=[];
      for(let i=0;i<rows.length;i++){const row=rows[i];if(!row||BigInt(row.seq)!==after+BigInt(i)+1n)throw new SyncSnapshotReadError("journal_gap");
        try{const change=row.document as NamespaceChange;validateNamespaceChanges([change]);if(change.nodeId!==row.node_id)throw new Error("event identity mismatch");items.push(change.kind==="tombstone"?{...change.description,seq:row.seq,kind:"tombstone",operation_id:row.operation_id,before_version:change.before_version as string}:{...change.description,seq:row.seq,kind:"upsert",operation_id:row.operation_id});}catch{throw new SyncSnapshotReadError("projection_unqualified");}
      }
      if(r.next_token===null){r.covered_through_seq=through.toString();r.covered_count=items.length;r.covered_has_more=through<BigInt(c.published);r.next_token=await this.#next(sql,c,token,{kind:"feed",afterSeq:through.toString()});
        await sql`UPDATE sync_snapshot_cursor SET next_token=${r.next_token},covered_through_seq=${r.covered_through_seq},covered_count=${r.covered_count},covered_has_more=${r.covered_has_more} WHERE token_hash=${hash(token)}`;
      }else if(r.covered_count!==items.length)throw new SyncSnapshotReadError("journal_gap");
      const page:SyncFeedPage={...this.#scope.wire,from_exclusive:after.toString(),to_inclusive:through.toString(),items,next_cursor:r.next_token,has_more:r.covered_has_more as boolean};
      validateSyncFeedPage(page,{...this.#scope.wire,after_seq:after.toString()});return encodeSyncJson(page);
    }));
  }
  /** Run until no expired cursor rows remain before the S1 stage janitor. No
   * cascading delete: at most500 opaque tokens are removed per transaction. */
  async collectExpired():Promise<{snapshotId:string|null;tokensRemoved:number}> {
    return this.#admit(()=>this.database.transaction(async sql=>{
      await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL statement_timeout='2s'`;
      if(!(await sql`SELECT id FROM sync_snapshot_stage WHERE cursor_count>0 AND (state='DISCARDED' OR lease_until<=clock_timestamp() OR absolute_until<=clock_timestamp()) LIMIT 1`).length)
        return {snapshotId:null,tokensRemoved:0};
      if(!(await sql<{admitted:boolean}[]>`SELECT pg_try_advisory_xact_lock(hashtextextended('saturn.sync.snapshot.admission.v1',0)) AS admitted`)[0]?.admitted)throw new SyncSnapshotReadError("admission_full");
      const s=(await sql<{id:string;cursor_count:number}[]>`SELECT id,cursor_count FROM sync_snapshot_stage WHERE cursor_count>0 AND (state='DISCARDED' OR lease_until<=clock_timestamp() OR absolute_until<=clock_timestamp()) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)[0];
      if(!s)return {snapshotId:null,tokensRemoved:0};
      const removed=await sql`DELETE FROM sync_snapshot_cursor WHERE token_hash IN (SELECT token_hash FROM sync_snapshot_cursor WHERE snapshot_id=${s.id} ORDER BY token_hash LIMIT 500) RETURNING token_hash`;
      if(!removed.length||removed.length>s.cursor_count)throw new SyncSnapshotReadError("projection_unqualified");
      await sql`UPDATE sync_snapshot_stage SET cursor_count=${s.cursor_count-removed.length} WHERE id=${s.id}`;return {snapshotId:s.id,tokensRemoved:removed.length};
    }));
  }
}
