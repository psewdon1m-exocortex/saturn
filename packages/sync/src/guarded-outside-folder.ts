import { requireDefined } from "../../contracts/src/require-defined.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID,createHash } from "node:crypto";
import type { Database } from "@saturn/database";
import type { SessionValidationInput, OwnerSession } from "@saturn/auth";
import { FileService, PostgresFileRepository, ROOT_RESOURCE_ID, SYNC_RESOURCE_ID, OUTDOOR_CONNECTIONS_RESOURCE_ID, type Resource } from "@saturn/file-core";
import { joinStoragePath, normalizeStorageName, type StorageAdapter } from "@saturn/storage";
import { CatalogFolderAuthorityIssuer, type CatalogFolderAuthority } from "../../file-core/src/catalog-folder-authority.js";
import { CatalogFolderError } from "../../file-core/src/catalog-folder-intent.js";
import type { FileServiceOptions } from "../../file-core/src/file.service.js";
import type { MoveResourceInput,CopyResourceInput,ResourceMutationInput } from "../../file-core/src/models.js";
import type { SyncRootBinding } from "../../contracts/src/sync-protocol.js";
import type { SyncMutationInput,SyncNamespacePolicy } from "../../contracts/src/sync-extensions.js";
import type { CatalogNamespaceMutations } from "../../file-core/src/catalog-namespace-mutations.js";

export type GuardedOwnerInput = Readonly<{ bootstrap: string }> | Readonly<{ session: SessionValidationInput }>;
const controls = new Set([ROOT_RESOURCE_ID, SYNC_RESOURCE_ID, OUTDOOR_CONNECTIONS_RESOURCE_ID]);
interface Identity { schema: "saturn.outside-folder.v1"; parentId: string; nodeId: string; name: string; path: string; authority: string }
type NamespaceRuntimeResolver=(rootId:string,issuer:CatalogFolderAuthorityIssuer)=>Promise<{binding:SyncRootBinding;namespace:SyncNamespacePolicy;mutations:CatalogNamespaceMutations}|undefined>;
function originalSchema(value: unknown): boolean { return value === "saturn.outside-folder.v1"; }
/** Only fresh owner-authenticated control-parent/new-child creation. It reserves a
 * pending catalog identity and the existing journal before exclusive mkdir.
 * Pending/UNKNOWN is never adopted or deleted by compensation or a later name match. */
export class GuardedOutsideFolderService extends FileService {
  readonly #context = new AsyncLocalStorage<{ input: GuardedOwnerInput; key?: string }>();
  readonly #issuer: CatalogFolderAuthorityIssuer;
  #active = 0;
  #namespaceRuntime:NamespaceRuntimeResolver|undefined;
  installNamespaceRuntime(resolve:NamespaceRuntimeResolver):void {this.#namespaceRuntime=resolve;}
  constructor(private readonly db: Database, private readonly writer: Database, private readonly backend: StorageAdapter, private readonly options: FileServiceOptions,
    validateOwnerSession?: (input: SessionValidationInput) => Promise<OwnerSession>) {
    const repository = new PostgresFileRepository(db); super(repository, backend, options);
    this.#issuer = new CatalogFolderAuthorityIssuer(db, { ...(validateOwnerSession ? { validateOwnerSession: input => validateOwnerSession(input as SessionValidationInput) } : {}) });
  }
  ownerAction<T>(input: GuardedOwnerInput, action: () => Promise<T>, key?: string): Promise<T> {
    if (key !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new CatalogFolderError("invalid_input");
    return this.#context.run({ input, ...(key === undefined ? {} : { key }) }, action);
  }
  async #proof(parentId: string): Promise<CatalogFolderAuthority> {
    const context = this.#context.getStore(); if (!context) throw new CatalogFolderError("authority_invalid");
    return "bootstrap" in context.input ? this.#issuer.ownerBootstrap(context.input.bootstrap, parentId) : this.#issuer.ownerSession(context.input.session, parentId);
  }
  async #namespace(resourceId:string,kind:"move"|"quarantine-delete"|"restore"|"clone-content",input:ResourceMutationInput&{parentId?:string;name?:string}):Promise<Resource|undefined>{
    if(!this.#namespaceRuntime)return undefined;
    const roots=await this.db.withSql(sql=>sql<{root:string}[]>`SELECT unnest(public.catalog_guard_scope(${resourceId}::uuid,false))::text AS root`);
    if(!roots.length)return undefined;
    if(roots.length!==1)throw new CatalogFolderError("membership_changed");
    const rootId=requireDefined(roots[0]).root,scope=await this.#namespaceRuntime(rootId,this.#issuer);
    if(!scope)throw new CatalogFolderError("binding_invalid");
    const proof=await this.#proof(rootId);
    const old=(await this.db.withSql(sql=>sql<{namespace_intent:{input:SyncMutationInput;namespace:SyncNamespacePolicy}}[]>`SELECT namespace_intent FROM operation_journal WHERE idempotency_key=${"namespace:"+input.idempotencyKey}`))[0];
    let operation:SyncMutationInput;
    if(old){
      operation=old.namespace_intent.input;
      const originalNode=operation.kind==="clone-content"?operation.source.nodeId:operation.expected.kind==="version"?operation.expected.node_id:undefined;
      if(originalNode!==resourceId||operation.rootId!==rootId||operation.kind!==kind||input.parentId!==undefined&&("parentId"in operation?operation.parentId:undefined)!==input.parentId
        ||input.name!==undefined&&("name"in operation?operation.name:undefined)!==input.name)throw new CatalogFolderError("operation_reused");
    }else{
      const row=(await this.db.withSql(sql=>sql<{id:string;metadata_version:string;name:string;type:string;current_version_id:string|null;sha256:string|null;size_bytes:string;trashed_from_parent_id:string|null;trashed_from_name:string|null}[]>`
        SELECT id,metadata_version,name,type,current_version_id,sha256,size_bytes::text,trashed_from_parent_id,trashed_from_name FROM resources WHERE id=${resourceId}`))[0];
      if(!row)throw new CatalogFolderError("conflict");
      const key=createHash("sha256").update(JSON.stringify([rootId,input.idempotencyKey])).digest("hex").slice(0,32);
      const base={schema:"saturn.namespace-mutation.v1"as const,operationId:`${key.slice(0,8)}-${key.slice(8,12)}-${key.slice(12,16)}-${key.slice(16,20)}-${key.slice(20)}`,
        idempotencyKey:input.idempotencyKey,rootId,epoch:scope.binding.server_epoch,bindingVersion:scope.binding.binding_version,expected:{kind:"version"as const,node_id:row.id,version:row.metadata_version}};
      if(kind==="move")operation={...base,kind,parentId:requireDefined(input.parentId),name:input.name??row.name};
      else if(kind==="quarantine-delete"){
        // The explicit owner action approves this one exact version. Persist
        // that approval before reserving or performing any physical effect.
        const items=[{nodeId:row.id,version:row.metadata_version}];
        const planDigest=createHash("sha256").update(JSON.stringify([rootId,items])).digest("hex");
        await scope.mutations.approveDeletePlan(rootId,base.epoch,base.bindingVersion,
          {schema:"saturn.delete-plan.v1",planId:base.operationId,planDigest,items},scope.namespace,proof);
        operation={...base,kind,planId:base.operationId,planDigest};
      }
      else if(kind==="restore"){
        const deletion=(await this.db.withSql(sql=>sql<{id:string}[]>`SELECT id FROM operation_journal WHERE resource_id=${resourceId} AND namespace_state='PUBLISHED' AND namespace_intent->'input'->>'kind'='quarantine-delete' ORDER BY updated_at DESC LIMIT 1`))[0];
        if(!deletion||!row.trashed_from_parent_id||!row.trashed_from_name)throw new CatalogFolderError("conflict");
        operation={...base,kind,parentId:row.trashed_from_parent_id,name:row.trashed_from_name,deletedOperationId:deletion.id};
      }else{
        if(row.type!=="file"||!row.current_version_id||!row.sha256)throw new CatalogFolderError("binding_invalid");
        operation={...base,kind,expected:{kind:"absent"},parentId:requireDefined(input.parentId),name:input.name??row.name,
          source:{nodeId:row.id,contentVersionId:row.current_version_id,metadataVersion:row.metadata_version,sizeBytes:row.size_bytes,sha256:row.sha256}};
      }
    }
    const result=await scope.mutations.execute(operation,old?.namespace_intent.namespace??scope.namespace,proof);
    if(result.state!=="PUBLISHED"||!result.result)throw new CatalogFolderError("reconciliation_required");
    return this.getResource(result.result.description.node_id);
  }
  override async moveResource(id:string,input:MoveResourceInput):Promise<Resource>{return await this.#namespace(id,"move",input)??super.moveResource(id,input);}
  override async copyResource(id:string,input:CopyResourceInput):Promise<Resource>{return await this.#namespace(id,"clone-content",input)??super.copyResource(id,input);}
  override async trashResource(id:string,input:ResourceMutationInput):Promise<Resource>{return await this.#namespace(id,"quarantine-delete",input)??super.trashResource(id,input);}
  override async restoreResource(id:string,input:ResourceMutationInput):Promise<Resource>{return await this.#namespace(id,"restore",input)??super.restoreResource(id,input);}
  override async createFolder(parentId: string, rawName: string, actor?: { readonly type: string; readonly id: string }): Promise<Resource> {
    if (!controls.has(parentId)) return super.createFolder(parentId, rawName, actor);
    // An unregistered legacy installation keeps its existing authenticated routes.
    const registered = (await this.db.withSql(sql => sql<{ registered: boolean }[]>`SELECT EXISTS(SELECT 1 FROM public.catalog_guard_roots) AS registered`))[0]?.registered;
    if (!registered) return super.createFolder(parentId, rawName, actor);
    if (this.#active >= 4) throw new CatalogFolderError("admission_full"); this.#active++;
    try {
      const name = normalizeStorageName(rawName), proof = await this.#proof(parentId), id = randomUUID();
      // Exact reserved namespace names remain unavailable to an ordinary ROOT request.
      if (parentId === ROOT_RESOURCE_ID && new Set(["# drop point", "# laboratory", "# sync inner services", "# mastermind", "# sync windows", "# volt", "# references", "# outdoor connections", "_system"]).has(name.toLowerCase())) throw new CatalogFolderError("invalid_input");
      const key = "outside-folder:" + (this.#context.getStore()?.key ?? id);
      const identity = await this.db.transaction(async sql => {
        await sql`SET LOCAL statement_timeout='2s'`; await sql`SET LOCAL lock_timeout='2s'`; await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
        await sql`SELECT root_id FROM public.sync_root_clock WHERE root_id IN (SELECT root_id FROM public.catalog_guard_roots WHERE '00000000-0000-7000-8000-000000000001'::uuid=ANY(control_ancestor_ids)) ORDER BY root_id FOR UPDATE`;
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'saturn.outside-folder:' + parentId + ':' + name.toLowerCase()},0))`;
        const fingerprint = await this.#issuer.fingerprint(sql, proof, parentId);
        const parent = (await sql<{ storage_path: string; allowed: boolean }[]>`SELECT storage_path,type='folder' AND status='active'
          AND cardinality(public.catalog_guard_scope(id,false))=0 AS allowed FROM public.resources WHERE id=${parentId} FOR SHARE`)[0];
        if (!parent?.allowed || (await sql`SELECT 1 FROM public.catalog_guard_roots WHERE '00000000-0000-7000-8000-000000000001'::uuid=ANY(control_ancestor_ids) AND runtime_role<>session_user`).length)
          throw new CatalogFolderError("binding_invalid");
        const path = joinStoragePath(parent.storage_path, name), old = (await sql<{ payload: Identity; state: string }[]>`SELECT payload,state FROM public.operation_journal WHERE idempotency_key=${key} FOR UPDATE`)[0];
        if (old) {
          if (!originalSchema(old.payload.schema) || old.payload.parentId !== parentId || old.payload.name !== name || old.payload.path !== path || old.payload.authority !== fingerprint) throw new CatalogFolderError("operation_reused");
          if (old.state !== "active") throw new CatalogFolderError("reconciliation_required");
          return { value: old.payload, published: true };
        }
        if ((await sql`SELECT id FROM public.resources WHERE parent_id=${parentId} AND lower(name)=lower(${name}) AND status<>'purged' LIMIT 1`).length) throw new CatalogFolderError("conflict");
        const value: Identity = { schema: "saturn.outside-folder.v1", parentId, nodeId: id, name, path, authority: fingerprint };
        await sql`INSERT INTO public.resources(id,type,parent_id,name,storage_path,status) VALUES(${id},'folder',${parentId},${name},${path},'pending')`;
        await sql`INSERT INTO public.operation_journal(id,operation_type,state,idempotency_key,resource_id,payload)
          VALUES(${id},'outside_folder_create','committing',${key},${id},${JSON.stringify(value)}::text::jsonb)`;
        return { value, published: false };
      });
      if (identity.published) return await this.getResource(identity.value.nodeId);
      try {
        await this.backend.mkdir(identity.value.path);
        const credential = this.#issuer.ownerCredential(proof, parentId);
        await this.writer.transaction(async sql => {
          await sql`SET LOCAL statement_timeout='2s'`; await sql`SET LOCAL lock_timeout='2s'`;
          await sql`SELECT public.outside_folder_commit(${identity.value.nodeId}::uuid,${JSON.stringify(credential)}::text::jsonb)`;
        });
        const actor = this.#issuer.actor(proof, parentId);
        await this.options.auditSink?.write({ action: "folder.created", actorType: actor.type, actorId: actor.id, resourceId: identity.value.nodeId,
          outcome: "success", correlationId: "folder:" + identity.value.nodeId, details: { parentId, name } });
        return await this.getResource(identity.value.nodeId);
      } catch (error) {
        // A lost commit ACK can already have published the original identity.
        const accepted = await this.db.transaction(async sql => {
          await this.#issuer.check(sql, proof, parentId);
          return (await sql`SELECT j.id FROM public.operation_journal j JOIN public.resources r ON r.id=j.resource_id WHERE j.id=${identity.value.nodeId}
            AND j.payload=${JSON.stringify(identity.value)}::text::jsonb AND j.state='active' AND r.status='active'`).length === 1;
        }).catch(() => false);
        if (accepted) return await this.getResource(identity.value.nodeId);
        await this.db.withSql(sql => sql`UPDATE public.operation_journal SET error_code='reconciliation_required',updated_at=now() WHERE id=${identity.value.nodeId} AND state='committing'`).catch(() => undefined);
        throw new CatalogFolderError("reconciliation_required", { cause: error });
      }
    } finally { this.#active--; }
  }
}
