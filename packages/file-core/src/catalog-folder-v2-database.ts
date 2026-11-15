import {randomUUID} from "node:crypto";
import type {Database} from "@saturn/database";
import {normalizeStoragePath,validateExactStoragePath} from "@saturn/storage";
import type {CatalogFolderAuthority,CatalogFolderAuthorityIssuer} from "./catalog-folder-authority.js";
import {CatalogFolderError} from "./catalog-folder-intent.js";
import {parseCatalogFolderRequestV2,parseCatalogFolderIntentV2,parseCatalogFolderResultV2,
  type CatalogFolderRequestV2,type CatalogFolderIntentV2,type CatalogFolderOutcomeV2} from "./catalog-folder-v2-intent.js";

type Credential=Readonly<{deviceId:string;tokenHash:string;deviceKind:string}>;
type Phase="prepared"|"physical_pending"|"reconciliation_required"|"published"|"not_required";
interface Stored {intent:unknown;storagePath:string;phase:Phase;claimToken:string|null;replayed:boolean;result?:unknown}
/** Private original-operation handle. Storage paths and claim token must never be serialized on wire. */
export interface PreparedCatalogFolderV2 {
  readonly intent:CatalogFolderIntentV2;readonly storagePath:string;readonly phase:Phase;
  readonly claimToken:string|null;readonly outcome?:CatalogFolderOutcomeV2;
}
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const requestKeys=["operationId","idempotencyKey","rootId","epoch","bindingVersion","parentId","name","mode"] as const;
/** Inactive fixed SQL-only lifecycle. Offline composition pins all granted SD functions and roles.
 * Four commands per adapter, no queue, 2s SQL/lock deadlines, no physical callback under clock lock. */
export class CatalogFolderV2DatabaseCoordinator {
  readonly #prepared=new WeakMap<object,Credential>();#active=0;
  constructor(private readonly writer:Database,private readonly authority:CatalogFolderAuthorityIssuer,private readonly exactPaths=false){}
  async #run(command:string,intent:CatalogFolderIntentV2,credential:Credential,payload:Readonly<Record<string,unknown>>,signal?:AbortSignal):Promise<Stored> {
    if(signal?.aborted)throw new CatalogFolderError("cancelled");if(this.#active>=4)throw new CatalogFolderError("admission_full");this.#active++;
    try{return await this.writer.transaction(async sql=>{
      await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL statement_timeout='2s'`;await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
      const value=(await sql<{value:Stored}[]>`SELECT public.catalog_folder_v2_command(${command},${JSON.stringify(intent)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]?.value;
      if(signal?.aborted)throw new CatalogFolderError("cancelled");if(!value||Buffer.byteLength(JSON.stringify(value))>128*1024)throw new CatalogFolderError("projection_mismatch");return value;
    });}catch(error){
      if(error instanceof CatalogFolderError)throw error;
      if(error instanceof Error&&["invalid_input","authority_invalid","authorization_changed","binding_invalid","operation_reused","membership_changed","conflict","reconciliation_required","projection_mismatch","counter_exhausted","invalid_name","backend_draining","capacity"].includes(error.message))throw new CatalogFolderError(error.message as CatalogFolderError["code"],{cause:error});throw error;
    }finally{this.#active--;}
  }
  #seal(expected:CatalogFolderIntentV2,stored:Stored,credential:Credential):PreparedCatalogFolderV2 {
    const intent=parseCatalogFolderIntentV2(stored.intent);
    if(Object.keys(stored).length!==(stored.result===undefined?5:6)||Object.keys(stored).some(k=>!["intent","storagePath","phase","claimToken","replayed","result"].includes(k)))throw new CatalogFolderError("projection_mismatch");
    if(requestKeys.some(key=>intent[key]!==expected[key])||JSON.stringify(intent.parentTopology)!==JSON.stringify(expected.parentTopology)
      ||intent.backendIdentity!==expected.backendIdentity||intent.actor.type!==expected.actor.type||intent.actor.id!==expected.actor.id
      ||typeof stored.replayed!=="boolean"||typeof stored.storagePath!=="string"||Buffer.byteLength(stored.storagePath)>4096||(this.exactPaths?validateExactStoragePath:normalizeStoragePath)(stored.storagePath)!==stored.storagePath
      ||!["prepared","physical_pending","reconciliation_required","published","not_required"].includes(stored.phase)
      ||(stored.claimToken!==null&&(typeof stored.claimToken!=="string"||!uuid.test(stored.claimToken)))
      ||["physical_pending","reconciliation_required","published"].includes(stored.phase)!==(stored.claimToken!==null))throw new CatalogFolderError("projection_mismatch");
    const outcome=stored.result===undefined?undefined:Object.freeze({replayed:stored.replayed,result:parseCatalogFolderResultV2(stored.result,intent)});
    if(["published","not_required"].includes(stored.phase)!==(outcome!==undefined)
      ||(outcome!==undefined&&(outcome.result.status==="CREATED")!==(stored.phase==="published")))throw new CatalogFolderError("projection_mismatch");
    const prepared=Object.freeze({intent,storagePath:stored.storagePath,phase:stored.phase,claimToken:stored.claimToken,...(outcome?{outcome}:{})});this.#prepared.set(prepared,credential);return prepared;
  }
  #credential(prepared:PreparedCatalogFolderV2,proof?:CatalogFolderAuthority):Credential {
    const sealed=this.#prepared.get(prepared);if(!sealed)throw new CatalogFolderError("invalid_input");
    if(proof){const current=this.authority.deviceCredential(proof,prepared.intent.rootId);if(JSON.stringify(current)!==JSON.stringify(sealed))throw new CatalogFolderError("authority_invalid");}return sealed;
  }
  async prepare(request:CatalogFolderRequestV2,proof:CatalogFolderAuthority,backendIdentity:string,signal?:AbortSignal):Promise<PreparedCatalogFolderV2> {
    const parsed=parseCatalogFolderRequestV2(request),credential=this.authority.deviceCredential(proof,parsed.rootId);
    const intent=parseCatalogFolderIntentV2({...parsed,schema:"saturn.catalog-folder-intent.v2",kind:"folder.create",nodeId:randomUUID(),backendIdentity,actor:this.authority.actor(proof,parsed.rootId)});
    return this.#seal(intent,await this.#run("reserve",intent,credential,{},signal),credential);
  }
  async inspect(prepared:PreparedCatalogFolderV2,proof:CatalogFolderAuthority):Promise<PreparedCatalogFolderV2> {
    const c=this.#credential(prepared,proof);return this.#seal(prepared.intent,await this.#run("inspect",prepared.intent,c,{}),c);
  }
  async claim(prepared:PreparedCatalogFolderV2,proof:CatalogFolderAuthority,claimToken:string):Promise<PreparedCatalogFolderV2> {
    if(!uuid.test(claimToken))throw new CatalogFolderError("invalid_input");const c=this.#credential(prepared,proof);return this.#seal(prepared.intent,await this.#run("claim",prepared.intent,c,{claimToken}),c);
  }
  async commit(prepared:PreparedCatalogFolderV2,proof:CatalogFolderAuthority,signal?:AbortSignal):Promise<PreparedCatalogFolderV2> {
    if(!prepared.claimToken)throw new CatalogFolderError("invalid_input");const c=this.#credential(prepared,proof);return this.#seal(prepared.intent,await this.#run("commit",prepared.intent,c,{claimToken:prepared.claimToken},signal),c);
  }
  async markUnknown(prepared:PreparedCatalogFolderV2):Promise<PreparedCatalogFolderV2> {
    if(!prepared.claimToken)throw new CatalogFolderError("invalid_input");const c=this.#credential(prepared);return this.#seal(prepared.intent,await this.#run("unknown",prepared.intent,c,{claimToken:prepared.claimToken}),c);
  }
}
