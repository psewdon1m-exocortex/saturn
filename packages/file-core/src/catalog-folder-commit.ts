import { randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";
import { joinStoragePath, normalizeStorageName } from "@saturn/storage";
import type { TransactionSql } from "postgres";
import { ROOT_RESOURCE_ID } from "./models.js";
import { rootJournalJsonBound } from "./root-journal.js";
import type { CatalogCommitRoot } from "./catalog-commit.js";
import { assertNamespaceBinding,namespaceDescriptor,validateNamespaceChanges,type NamespaceChange,type NamespaceProjectionRow } from "./current-namespace.js";
import type { CatalogFolderAuthorityIssuer,CatalogFolderAuthority } from "./catalog-folder-authority.js";
import { CatalogFolderError,catalogFolderIntentHash,parseCatalogFolderIntent,parseCatalogFolderResult,sameCatalogFolderRequest,validateCatalogFolderRequest,
  type CatalogFolderIntent,type CatalogFolderRequest,type CatalogFolderOutcome,type CatalogFolderResult } from "./catalog-folder-intent.js";

interface Clock {root_id:string;epoch:string;published_seq:string}
interface Operation {id:string;idempotency_key:string;catalog_intent:unknown;catalog_effect_state:string|null;sync_result:unknown;payload:{storagePath?:string};sync_intent_hash:string|null}
interface Ancestor {id:string;parent_id:string|null;name:string;storage_path:string;type:string;status:string;hops:number}
export interface PreparedCatalogFolder {readonly intent:CatalogFolderIntent;readonly storagePath:string;readonly outcome?:CatalogFolderOutcome}
/** Fixed lifecycle boundary; implementations never expose arbitrary privileged SQL callbacks. */
export interface CatalogFolderLifecycle {
  prepare(request:CatalogFolderRequest,proof:CatalogFolderAuthority,backendIdentity:string,signal?:AbortSignal):Promise<PreparedCatalogFolder>;
  beginPhysical(prepared:PreparedCatalogFolder,proof:CatalogFolderAuthority):Promise<void>;
  commit(prepared:PreparedCatalogFolder,proof:CatalogFolderAuthority,signal?:AbortSignal):Promise<CatalogFolderOutcome>;
  accepted(prepared:PreparedCatalogFolder,proof:CatalogFolderAuthority):Promise<CatalogFolderOutcome|undefined>;
  markUnknown(prepared:PreparedCatalogFolder):Promise<void>;
}
const MAX_BIGINT=9223372036854775807n;

/** Inactive A1 only: explicit QUALIFYING fixture roots, fixed SQL, no public enrollment or feed authority. */
export class CatalogFolderCommitCoordinator {
  readonly #roots=new Map<string,CatalogCommitRoot>();
  readonly #prepared=new WeakSet<object>();
  #active=0;
  constructor(private readonly database:Database,private readonly authority:CatalogFolderAuthorityIssuer,roots:readonly CatalogCommitRoot[]) {
    if(roots.length>16)throw new CatalogFolderError("invalid_input");
    for(const root of roots) {
      if(!root.namespaceBindingVersion||this.#roots.has(root.rootId)||!/^[A-Za-z\d._:-]{1,128}$/.test(root.backendIdentity))throw new CatalogFolderError("invalid_input");
      validateCatalogFolderRequest({operationId:randomUUID(),idempotencyKey:"validation-only",rootId:root.rootId,epoch:root.epoch,
        bindingVersion:root.namespaceBindingVersion,parentId:root.rootId,name:"validation",mode:"ensure"});
      this.#roots.set(root.rootId,Object.freeze({...root}));
    }
  }
  async #admit<T>(action:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
    if(signal?.aborted)throw new CatalogFolderError("cancelled");
    if(this.#active>=4)throw new CatalogFolderError("admission_full");
    this.#active++;try{return await action();}catch(error){if(signal?.aborted)throw new CatalogFolderError("cancelled",{cause:error});throw error;}finally{this.#active--;}
  }
  async #clock(sql:TransactionSql,rootId:string):Promise<Clock> {
    await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL statement_timeout='2s'`;await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
    const clock=(await sql<Clock[]>`SELECT root_id,epoch,published_seq::text FROM sync_root_clock WHERE root_id=${rootId} FOR UPDATE`)[0];
    if(!clock)throw new CatalogFolderError("binding_invalid"); return clock;
  }
  #root(request:CatalogFolderRequest,backendIdentity:string):CatalogCommitRoot {
    validateCatalogFolderRequest(request);
    try {if(normalizeStorageName(request.name)!==request.name)throw new CatalogFolderError("invalid_input");}
    catch(error) {throw new CatalogFolderError("invalid_input",{cause:error});}
    const root=this.#roots.get(request.rootId);
    if(!root||root.epoch!==request.epoch||root.namespaceBindingVersion!==request.bindingVersion||root.backendIdentity!==backendIdentity)throw new CatalogFolderError("binding_invalid");return root;
  }
  #chain(sql:TransactionSql,parentId:string):Promise<Ancestor[]> {
    return Promise.resolve(sql<Ancestor[]>`WITH RECURSIVE chain AS (
      SELECT id,parent_id,CASE WHEN octet_length(name)<=1020 THEN name ELSE '' END AS name,
        CASE WHEN octet_length(storage_path)<=32768 THEN storage_path ELSE '' END AS storage_path,type,status,0 AS hops,ARRAY[id] AS visited FROM resources WHERE id=${parentId}
      UNION ALL SELECT r.id,r.parent_id,r.name,r.storage_path,r.type,r.status,c.hops+1,c.visited||r.id FROM chain c CROSS JOIN LATERAL (
        SELECT id,parent_id,CASE WHEN octet_length(name)<=1020 THEN name ELSE '' END AS name,
          CASE WHEN octet_length(storage_path)<=32768 THEN storage_path ELSE '' END AS storage_path,type,status FROM resources WHERE id=c.parent_id LIMIT 1
      ) r WHERE c.hops<130 AND NOT r.id=ANY(c.visited)
    ) SELECT id,parent_id,name,storage_path,type,status,hops FROM chain ORDER BY hops`);
  }
  async #ancestors(sql:TransactionSql,intent:CatalogFolderRequest,targetId?:string):Promise<readonly Ancestor[]> {
    const before=await this.#chain(sql,intent.parentId),root=before.find(row=>row.id===intent.rootId);
    if(!root||root.hops>128||before.at(-1)?.id!==ROOT_RESOURCE_ID||before.some(row=>row.type!=="folder"||row.status!=="active"||!row.name||(!row.storage_path&&row.id!==ROOT_RESOURCE_ID)))throw new CatalogFolderError("membership_changed");
    await sql`SELECT id FROM resources WHERE id=ANY(${[...before.map(row=>row.id),...(targetId===undefined?[]:[targetId])].sort()}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
    const after=await this.#chain(sql,intent.parentId);
    if(JSON.stringify(before)!==JSON.stringify(after)||(await sql`SELECT root_id FROM sync_root_clock WHERE root_id=ANY(${before.map(row=>row.id)}::uuid[]) AND root_id<>${intent.rootId}`).length)throw new CatalogFolderError("membership_changed");
    return after;
  }
  #operation(sql:TransactionSql,request:CatalogFolderRequest):Promise<Operation[]> {
    return Promise.resolve(sql<Operation[]>`SELECT id,idempotency_key,catalog_intent,catalog_effect_state,sync_result,payload,sync_intent_hash
      FROM operation_journal WHERE id=${request.operationId} OR idempotency_key=${"catalog-folder:"+request.idempotencyKey} ORDER BY id FOR UPDATE`);
  }
  #matching(operation:Operation,request:CatalogFolderRequest,proof:CatalogFolderAuthority):CatalogFolderIntent {
    const intent=parseCatalogFolderIntent(operation.catalog_intent);
    if(operation.id!==request.operationId||operation.idempotency_key!=="catalog-folder:"+request.idempotencyKey
      ||!sameCatalogFolderRequest(intent,request,this.authority.actor(proof,request.rootId))||operation.sync_intent_hash!==catalogFolderIntentHash(intent))throw new CatalogFolderError("operation_reused");return intent;
  }
  #preparedValue(intent:CatalogFolderIntent,storagePath:string,outcome?:CatalogFolderOutcome):PreparedCatalogFolder {
    const prepared=Object.freeze({intent:Object.freeze({...intent,actor:Object.freeze({...intent.actor})}),storagePath,...(outcome===undefined?{}:{outcome})});
    this.#prepared.add(prepared);return prepared;
  }
  #projection(sql:TransactionSql,id:string):Promise<NamespaceProjectionRow[]> {
    return Promise.resolve(sql<NamespaceProjectionRow[]>`SELECT id,parent_id,CASE WHEN octet_length(name)<=1020 THEN name ELSE '' END AS name,type,
      size_bytes::text,sha256,current_version_id,status,metadata_version,sync_availability FROM resources WHERE id=${id} LIMIT 1`);
  }
  async prepare(request:CatalogFolderRequest,proof:CatalogFolderAuthority,backendIdentity:string,signal?:AbortSignal):Promise<PreparedCatalogFolder> {
    request=Object.freeze({...request});const root=this.#root(request,backendIdentity),actor=this.authority.actor(proof,request.rootId);
    return this.#admit(()=>this.database.transaction(async sql=>{
      const clock=await this.#clock(sql,request.rootId);await this.authority.check(sql,proof,request.rootId);
      const candidates=await this.#operation(sql,request);
      if(candidates.length>1)throw new CatalogFolderError("operation_reused");
      const operation=candidates[0];
      let intent:CatalogFolderIntent;
      if(operation) {
        intent=this.#matching(operation,request,proof);
        // Lookup the accepted immutable result before any mutable parent/target lookup.
        if(operation.sync_result!==null) return this.#preparedValue(intent,operation.payload.storagePath??"",{replayed:true,result:parseCatalogFolderResult(operation.sync_result,intent)});
        if(operation.catalog_effect_state!=="prepared")throw new CatalogFolderError("reconciliation_required");
      } else intent={...request,schema:"saturn.catalog-folder-intent.v1",kind:"folder.create",nodeId:randomUUID(),backendIdentity,actor};
      if(clock.epoch!==root.epoch)throw new CatalogFolderError("binding_invalid");await assertNamespaceBinding(sql,root.rootId,request.bindingVersion);
      const child=(await sql<{id:string;type:string}[]>`SELECT id,type FROM resources WHERE parent_id=${request.parentId} AND lower(name)=lower(${request.name}) AND status='active' LIMIT 1`)[0];
      const ancestors=await this.#ancestors(sql,request,child?.id),parent=ancestors[0];if(!parent)throw new CatalogFolderError("membership_changed");
      const storagePath=joinStoragePath(parent.storage_path,request.name);
      if(operation&&operation.payload.storagePath!==storagePath)throw new CatalogFolderError("membership_changed");
      // Validate all scoped preimages, but never run a zero-size ancestor UPDATE.
      const scopedRoot=ancestors.find(row=>row.id===root.rootId);if(!scopedRoot)throw new CatalogFolderError("membership_changed");
      const scopedIds=ancestors.filter(row=>row.hops<=scopedRoot.hops).map(row=>row.id);
      const preimages=await sql<NamespaceProjectionRow[]>`SELECT id,parent_id,CASE WHEN octet_length(name)<=1020 THEN name ELSE '' END AS name,type,
        size_bytes::text,sha256,current_version_id,status,metadata_version,sync_availability FROM resources WHERE id=ANY(${scopedIds}::uuid[]) ORDER BY id`;
      if(preimages.length!==scopedIds.length)throw new CatalogFolderError("projection_mismatch");
      for(const projection of preimages)namespaceDescriptor(projection,root.rootId);
      const pending=await sql`SELECT id FROM operation_journal WHERE catalog_intent IS NOT NULL AND sync_root_id=${root.rootId}
        AND catalog_intent->>'parentId'=${request.parentId} AND lower(catalog_intent->>'name')=lower(${request.name})
        AND sync_result IS NULL AND id<>${request.operationId} LIMIT 1`;
      if(pending.length)throw new CatalogFolderError("reconciliation_required");
      if(child&&(child.type!=="folder"||request.mode==="create"))throw new CatalogFolderError("conflict");
      if(!operation)await sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,payload,sync_root_id,sync_epoch,sync_intent_hash,catalog_intent,catalog_effect_state)
        VALUES(${request.operationId},'folder_create','created',${"catalog-folder:"+request.idempotencyKey},${sql.json({storagePath})},${root.rootId},${root.epoch},${catalogFolderIntentHash(intent)},${rootJournalJsonBound(intent,8192)}::text::jsonb,'prepared')`;
      if(child) {
        // Keep existing PostgreSQL collation/index semantics. JavaScript lower()
        // is not equivalent for all Unicode scalars (e.g. dotted capital I).
        const projection=(await sql<NamespaceProjectionRow[]>`SELECT id,parent_id,CASE WHEN octet_length(name)<=1020 THEN name ELSE '' END AS name,type,
          size_bytes::text,sha256,current_version_id,status,metadata_version,sync_availability FROM resources
          WHERE id=${child.id} AND parent_id=${request.parentId} AND lower(name)=lower(${request.name}) AND status='active' LIMIT 1`)[0];
        if(!projection)throw new CatalogFolderError("membership_changed");
        const result:CatalogFolderResult={schema:"saturn.catalog-folder-result.v1",operationId:request.operationId,intentHash:catalogFolderIntentHash(intent),rootId:root.rootId,status:"EXISTING",description:namespaceDescriptor(projection,root.rootId)};
        parseCatalogFolderResult(result,intent);
        await sql`UPDATE operation_journal SET state='active',resource_id=${child.id},catalog_effect_state='not_required',sync_result=${rootJournalJsonBound(result,8192)}::text::jsonb,updated_at=now() WHERE id=${request.operationId}`;
        return this.#preparedValue(intent,storagePath,{replayed:false,result});
      }
      if(signal?.aborted)throw new CatalogFolderError("cancelled");return this.#preparedValue(intent,storagePath);
    }),signal);
  }
  async beginPhysical(prepared:PreparedCatalogFolder,proof:CatalogFolderAuthority):Promise<void> {
    if(!this.#prepared.has(prepared)||prepared.outcome)throw new CatalogFolderError("invalid_input");
    await this.#admit(()=>this.database.transaction(async sql=>{
      const clock=await this.#clock(sql,prepared.intent.rootId);await this.authority.check(sql,proof,prepared.intent.rootId);
      await assertNamespaceBinding(sql,prepared.intent.rootId,prepared.intent.bindingVersion);
      const operation=(await this.#operation(sql,prepared.intent))[0];if(!operation)throw new CatalogFolderError("operation_reused");this.#matching(operation,prepared.intent,proof);
      if(clock.epoch!==prepared.intent.epoch||operation.catalog_effect_state!=="prepared"||operation.sync_result!==null)throw new CatalogFolderError("reconciliation_required");
      const ancestors=await this.#ancestors(sql,prepared.intent);
      if(joinStoragePath(ancestors[0]?.storage_path??"",prepared.intent.name)!==prepared.storagePath)throw new CatalogFolderError("membership_changed");
      await sql`UPDATE operation_journal SET catalog_effect_state='physical_pending',state='committing',updated_at=now() WHERE id=${prepared.intent.operationId}`;
    }));
  }
  /** Called only by the trusted FileService after successful exclusive mkdir. No physical I/O here. */
  async commit(prepared:PreparedCatalogFolder,proof:CatalogFolderAuthority,signal?:AbortSignal):Promise<CatalogFolderOutcome> {
    if(!this.#prepared.has(prepared)||prepared.outcome)throw new CatalogFolderError("invalid_input");
    const intent=prepared.intent;
    return this.#admit(()=>this.database.transaction(async sql=>{
      const clock=await this.#clock(sql,intent.rootId);await this.authority.check(sql,proof,intent.rootId);
      const operation=(await this.#operation(sql,intent))[0];if(!operation)throw new CatalogFolderError("operation_reused");this.#matching(operation,intent,proof);
      if(operation.sync_result!==null)return {replayed:true,result:parseCatalogFolderResult(operation.sync_result,intent)};
      if(clock.epoch!==intent.epoch||operation.catalog_effect_state!=="physical_pending")throw new CatalogFolderError("reconciliation_required");
      await assertNamespaceBinding(sql,intent.rootId,intent.bindingVersion);
      const ancestors=await this.#ancestors(sql,intent);
      if(joinStoragePath(ancestors[0]?.storage_path??"",intent.name)!==prepared.storagePath||operation.payload.storagePath!==prepared.storagePath)throw new CatalogFolderError("membership_changed");
      await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status,sync_availability)
        VALUES(${intent.nodeId},'folder',${intent.parentId},${intent.name},${prepared.storagePath},'active','AVAILABLE')`;
      const row=(await this.#projection(sql,intent.nodeId))[0];if(!row)throw new CatalogFolderError("projection_mismatch");
      const description=namespaceDescriptor(row,intent.rootId),event:NamespaceChange={schema:"saturn.current-namespace-change.v1",nodeId:intent.nodeId,kind:"upsert",description,reason:"folder.create",actor:intent.actor};validateNamespaceChanges([event]);
      const seq=BigInt(clock.published_seq)+1n;if(seq>MAX_BIGINT)throw new CatalogFolderError("counter_exhausted");
      await sql`INSERT INTO sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(${intent.rootId},${intent.epoch},${seq.toString()},${intent.nodeId},${intent.operationId},${rootJournalJsonBound(event,8192)}::text::jsonb)`;
      const result:CatalogFolderResult={schema:"saturn.catalog-folder-result.v1",operationId:intent.operationId,intentHash:catalogFolderIntentHash(intent),rootId:intent.rootId,status:"CREATED",description};parseCatalogFolderResult(result,intent);
      await sql`UPDATE operation_journal SET state='active',resource_id=${intent.nodeId},catalog_effect_state='published',sync_first_seq=${seq.toString()},sync_last_seq=${seq.toString()},sync_result=${rootJournalJsonBound(result,8192)}::text::jsonb,updated_at=now() WHERE id=${intent.operationId}`;
      await sql`UPDATE sync_root_clock SET published_seq=${seq.toString()},updated_at=now() WHERE root_id=${intent.rootId}`;
      if(signal?.aborted)throw new CatalogFolderError("cancelled");return {replayed:false,result};
    }),signal);
  }
  /** Lost SQL ACK lookup cannot manufacture success from current mutable resource. */
  async accepted(prepared:PreparedCatalogFolder,proof:CatalogFolderAuthority):Promise<CatalogFolderOutcome|undefined> {
    if(!this.#prepared.has(prepared))throw new CatalogFolderError("invalid_input");
    return this.#admit(()=>this.database.transaction(async sql=>{
      await this.#clock(sql,prepared.intent.rootId);await this.authority.check(sql,proof,prepared.intent.rootId);
      const operation=(await this.#operation(sql,prepared.intent))[0];if(!operation)throw new CatalogFolderError("operation_reused");const intent=this.#matching(operation,prepared.intent,proof);
      return operation.sync_result===null?undefined:{replayed:true,result:parseCatalogFolderResult(operation.sync_result,intent)};
    }));
  }
  /** Conservative durable UNKNOWN. This is not physical takeover fencing or automated reconciliation. */
  async markUnknown(prepared:PreparedCatalogFolder):Promise<void> {
    if(!this.#prepared.has(prepared))throw new CatalogFolderError("invalid_input");
    await this.#admit(()=>this.database.transaction(async sql=>{
      await this.#clock(sql,prepared.intent.rootId);
      const operation=(await this.#operation(sql,prepared.intent))[0];if(!operation||operation.sync_intent_hash!==catalogFolderIntentHash(prepared.intent))throw new CatalogFolderError("operation_reused");
      if(operation.sync_result!==null)return;
      if(operation.catalog_effect_state!=="physical_pending"&&operation.catalog_effect_state!=="reconciliation_required")throw new CatalogFolderError("reconciliation_required");
      await sql`UPDATE operation_journal SET catalog_effect_state='reconciliation_required',error_code='reconciliation_required',updated_at=now() WHERE id=${prepared.intent.operationId}`;
      await sql`UPDATE sync_root_clock SET namespace_state='BACKEND_UNCERTAIN',updated_at=now() WHERE root_id=${prepared.intent.rootId} AND namespace_state IN ('QUALIFYING','ACTIVE')`;
    }));
  }
}
