import { createHash } from "node:crypto";
import { validateNamespaceDescriptor, type NamespaceDescriptor } from "./current-namespace.js";

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export class CatalogFolderError extends Error {
  constructor(readonly code:"invalid_input"|"authority_invalid"|"authorization_changed"|"binding_invalid"|"operation_reused"|"membership_changed"|"conflict"|"reconciliation_required"|"admission_full"|"cancelled"|"projection_mismatch"|"counter_exhausted"|"invalid_name"|"backend_draining"|"capacity"|"unsupported",options?:ErrorOptions) { super(code,options); }
}
export interface CatalogFolderActor {readonly type:"device_token"|"owner_web"|"owner_bootstrap";readonly id:string}
export interface CatalogFolderRequest {
  readonly operationId:string;readonly idempotencyKey:string;readonly rootId:string;readonly epoch:string;
  readonly bindingVersion:string;readonly parentId:string;readonly name:string;readonly mode:"create"|"ensure";
}
export interface CatalogFolderIntent extends CatalogFolderRequest {
  readonly schema:"saturn.catalog-folder-intent.v1";readonly kind:"folder.create";
  readonly nodeId:string;readonly backendIdentity:string;readonly actor:CatalogFolderActor;
}
export interface CatalogFolderResult {
  readonly schema:"saturn.catalog-folder-result.v1";readonly operationId:string;readonly intentHash:string;
  readonly rootId:string;readonly status:"CREATED"|"EXISTING";readonly description:NamespaceDescriptor;
}
export interface CatalogFolderOutcome {readonly replayed:boolean;readonly result:CatalogFolderResult}

export function validateCatalogFolderRequest(request:unknown):asserts request is CatalogFolderRequest {
  if(typeof request!=="object"||request===null||Array.isArray(request)||Object.values(request).some(value=>typeof value!=="string"))throw new CatalogFolderError("invalid_input");
  const candidate=request as Record<string,string>;
  for(const value of [candidate.operationId,candidate.rootId,candidate.epoch,candidate.bindingVersion,candidate.parentId])if(typeof value!=="string"||!UUID.test(value))throw new CatalogFolderError("invalid_input");
  if(typeof candidate.operationId!=="string"||typeof candidate.name!=="string"||typeof candidate.bindingVersion!=="string")throw new CatalogFolderError("invalid_input");
  // Use the descriptor validator for exact scalar/name bounds, never a loose path.
  validateNamespaceDescriptor({node_id:candidate.operationId,parent_id:null,name:candidate.name,type:"folder",size_bytes:"0",
    content_sha256:null,content_version_id:null,version:candidate.bindingVersion,availability:"UNKNOWN"});
  if(typeof candidate.idempotencyKey!=="string"||!/^[A-Za-z\d._:-]{8,128}$/.test(candidate.idempotencyKey)||typeof candidate.mode!=="string"||!["create","ensure"].includes(candidate.mode)
    ||Object.keys(request).some(key=>!["operationId","idempotencyKey","rootId","epoch","bindingVersion","parentId","name","mode"].includes(key)))throw new CatalogFolderError("invalid_input");
}
export function parseCatalogFolderIntent(value:unknown):CatalogFolderIntent {
  if(typeof value!=="object"||value===null||Array.isArray(value))throw new CatalogFolderError("invalid_input");
  const item=value as Record<string,unknown>;
  const {schema,kind,nodeId,backendIdentity,actor,...request}=item;
  validateCatalogFolderRequest(request);
  if(schema!=="saturn.catalog-folder-intent.v1"||kind!=="folder.create"||typeof nodeId!=="string"||!UUID.test(nodeId)||typeof backendIdentity!=="string"
    ||typeof actor!=="object"||actor===null||Array.isArray(actor)||Object.keys(actor).length!==2)throw new CatalogFolderError("invalid_input");
  const principal=actor as Record<string,unknown>;
  if(typeof principal.id!=="string"||typeof principal.type!=="string"||!["device_token","owner_web","owner_bootstrap"].includes(principal.type)
    ||(principal.type==="device_token"?!UUID.test(principal.id):principal.id!=="owner")
    ||!/^[A-Za-z\d._:-]{1,128}$/.test(backendIdentity)||Buffer.byteLength(JSON.stringify(item))>8192)throw new CatalogFolderError("invalid_input");
  return value as CatalogFolderIntent;
}
export function catalogFolderIntentHash(value:CatalogFolderIntent):string {
  const i=parseCatalogFolderIntent(value);
  return createHash("sha256").update(JSON.stringify([i.schema,i.kind,i.operationId,i.idempotencyKey,i.rootId,i.epoch,i.bindingVersion,
    i.backendIdentity,i.parentId,i.name,i.mode,i.nodeId,i.actor.type,i.actor.id])).digest("hex");
}
export function sameCatalogFolderRequest(intent:CatalogFolderIntent,request:CatalogFolderRequest,actor:CatalogFolderActor):boolean {
  return intent.operationId===request.operationId&&intent.idempotencyKey===request.idempotencyKey&&intent.rootId===request.rootId
    &&intent.epoch===request.epoch&&intent.bindingVersion===request.bindingVersion&&intent.parentId===request.parentId
    &&intent.name===request.name&&intent.mode===request.mode&&intent.actor.type===actor.type&&intent.actor.id===actor.id;
}
export function parseCatalogFolderResult(value:unknown,intent:CatalogFolderIntent):CatalogFolderResult {
  if(typeof value!=="object"||value===null||Array.isArray(value))throw new CatalogFolderError("projection_mismatch");
  const result=value as CatalogFolderResult;
  try {validateNamespaceDescriptor(result.description);}catch(error){throw new CatalogFolderError("projection_mismatch",{cause:error});}
  if(Object.keys(result).length!==6||Object.keys(result).some(key=>!["schema","operationId","intentHash","rootId","status","description"].includes(key))
    ||!["saturn.catalog-folder-result.v1"].includes(result.schema)||result.operationId!==intent.operationId
    ||result.intentHash!==catalogFolderIntentHash(intent)||result.rootId!==intent.rootId||!["CREATED","EXISTING"].includes(result.status)
    ||result.description.type!=="folder"||result.description.parent_id!==intent.parentId||(result.status==="CREATED"&&result.description.name!==intent.name)
    ||(result.status==="CREATED"&&result.description.node_id!==intent.nodeId))throw new CatalogFolderError("projection_mismatch");
  return result;
}
