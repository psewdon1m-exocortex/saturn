import { randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";
import { normalizeStorageName } from "@saturn/storage";
import type { CatalogFolderAuthority,CatalogFolderAuthorityIssuer } from "./catalog-folder-authority.js";
import type { CatalogFolderLifecycle,PreparedCatalogFolder } from "./catalog-folder-commit.js";
import { CatalogFolderError,parseCatalogFolderIntent,parseCatalogFolderResult,validateCatalogFolderRequest,
  type CatalogFolderRequest,type CatalogFolderIntent,type CatalogFolderOutcome } from "./catalog-folder-intent.js";
import type { CatalogCommitRoot } from "./catalog-commit.js";

interface Stored {intent:unknown;storagePath:string;outcome?:{replayed:boolean;result:unknown}}
/** Explicit inactive device-folder fixture adapter. Separate qualified writer-login connection required.
 * Only the pinned fixed SECURITY DEFINER lifecycle is callable. No SQL/storage callback privilege. */
export class CatalogFolderDatabaseCoordinator implements CatalogFolderLifecycle {
  readonly #roots=new Map<string,CatalogCommitRoot>();readonly #prepared=new WeakMap<object,Readonly<{deviceId:string;tokenHash:string;deviceKind:string}>>();
  #active=0;
  constructor(private readonly writer:Database,private readonly authority:CatalogFolderAuthorityIssuer,roots:readonly CatalogCommitRoot[]) {
    if(roots.length>16)throw new CatalogFolderError("invalid_input");
    for(const root of roots) {
      if(!root.namespaceBindingVersion||this.#roots.has(root.rootId)||!/^[A-Za-z\d._:-]{1,128}$/.test(root.backendIdentity))throw new CatalogFolderError("invalid_input");
      validateCatalogFolderRequest({operationId:randomUUID(),idempotencyKey:"validation-only",rootId:root.rootId,epoch:root.epoch,bindingVersion:root.namespaceBindingVersion,parentId:root.rootId,name:"validation",mode:"ensure"});
      this.#roots.set(root.rootId,Object.freeze({...root}));
    }
  }
  async #command(command:string,intent:CatalogFolderIntent,credential:Readonly<{deviceId:string;tokenHash:string;deviceKind:string}>,signal?:AbortSignal):Promise<Stored|null> {
    if(signal?.aborted)throw new CatalogFolderError("cancelled");
    if(this.#active>=4)throw new CatalogFolderError("admission_full");this.#active++;
    try{return await this.writer.transaction(async sql=>{
      await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL statement_timeout='2s'`;await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
      const value=(await sql<{value:Stored|null}[]>`SELECT public.catalog_folder_command(${command},${JSON.stringify(intent)}::text::jsonb,${sql.json(credential)}) AS value`)[0]?.value??null;
      if(signal?.aborted)throw new CatalogFolderError("cancelled");return value;
    });}catch(error) {
      if(error instanceof CatalogFolderError)throw error;
      if(typeof error==="object"&&error!==null&&"message" in error) {
        const code=String(error.message);
        if(["invalid_input","authority_invalid","authorization_changed","binding_invalid","operation_reused","membership_changed","conflict","reconciliation_required","projection_mismatch","counter_exhausted"].includes(code))
          throw new CatalogFolderError(code as CatalogFolderError["code"],{cause:error});
      }
      throw error;
    }finally{this.#active--;}
  }
  #outcome(stored:Stored):CatalogFolderOutcome|undefined {
    const intent=parseCatalogFolderIntent(stored.intent);
    if(stored.outcome===undefined)return undefined;
    if(typeof stored.outcome.replayed!=="boolean")throw new CatalogFolderError("projection_mismatch");
    return Object.freeze({replayed:stored.outcome.replayed,result:parseCatalogFolderResult(stored.outcome.result,intent)});
  }
  async prepare(request:CatalogFolderRequest,proof:CatalogFolderAuthority,backendIdentity:string,signal?:AbortSignal):Promise<PreparedCatalogFolder> {
    request=Object.freeze({...request});validateCatalogFolderRequest(request);
    const root=this.#roots.get(request.rootId);
    if(!root||root.epoch!==request.epoch||root.namespaceBindingVersion!==request.bindingVersion||root.backendIdentity!==backendIdentity)throw new CatalogFolderError("binding_invalid");
    if(normalizeStorageName(request.name)!==request.name)throw new CatalogFolderError("invalid_input");
    const credential=this.authority.deviceCredential(proof,request.rootId);
    const candidate:CatalogFolderIntent={...request,schema:"saturn.catalog-folder-intent.v1",kind:"folder.create",nodeId:randomUUID(),backendIdentity,actor:this.authority.actor(proof,request.rootId)};
    const stored=await this.#command("reserve",candidate,credential,signal);
    if(!stored||typeof stored.storagePath!=="string"||Buffer.byteLength(stored.storagePath)>32768)throw new CatalogFolderError("projection_mismatch");
    const outcome=this.#outcome(stored),intent=parseCatalogFolderIntent(stored.intent);
    const prepared=Object.freeze({intent:Object.freeze({...intent,actor:Object.freeze({...intent.actor})}),storagePath:stored.storagePath,...(outcome===undefined?{}:{outcome})});
    this.#prepared.set(prepared,credential);return prepared;
  }
  #credential(prepared:PreparedCatalogFolder,proof?:CatalogFolderAuthority):Readonly<{deviceId:string;tokenHash:string;deviceKind:string}> {
    const sealed=this.#prepared.get(prepared);if(!sealed)throw new CatalogFolderError("invalid_input");
    if(proof){const current=this.authority.deviceCredential(proof,prepared.intent.rootId);if(JSON.stringify(current)!==JSON.stringify(sealed))throw new CatalogFolderError("authority_invalid");}
    return sealed;
  }
  async beginPhysical(prepared:PreparedCatalogFolder,proof:CatalogFolderAuthority):Promise<void> {
    if(prepared.outcome)throw new CatalogFolderError("invalid_input");await this.#command("claim",prepared.intent,this.#credential(prepared,proof));
  }
  async commit(prepared:PreparedCatalogFolder,proof:CatalogFolderAuthority,signal?:AbortSignal):Promise<CatalogFolderOutcome> {
    if(prepared.outcome)throw new CatalogFolderError("invalid_input");const stored=await this.#command("commit",prepared.intent,this.#credential(prepared,proof),signal);
    const outcome=stored&&this.#outcome(stored);if(!outcome)throw new CatalogFolderError("projection_mismatch");return outcome;
  }
  async accepted(prepared:PreparedCatalogFolder,proof:CatalogFolderAuthority):Promise<CatalogFolderOutcome|undefined> {
    const stored=await this.#command("accepted",prepared.intent,this.#credential(prepared,proof));return stored===null?undefined:this.#outcome(stored);
  }
  async markUnknown(prepared:PreparedCatalogFolder):Promise<void> {await this.#command("unknown",prepared.intent,this.#credential(prepared));}
}
