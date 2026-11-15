import {createHash} from "node:crypto";
import {validateNamespaceDescriptor,type NamespaceDescriptor} from "./current-namespace.js";
import {CatalogFolderError,type CatalogFolderActor} from "./catalog-folder-intent.js";
import type {CatalogParentTopologyEntry} from "./catalog-upload-intent.js";

export interface CatalogFolderRequestV2 {
  readonly operationId:string;readonly idempotencyKey:string;readonly rootId:string;readonly epoch:string;
  readonly bindingVersion:string;readonly parentId:string;readonly name:string;readonly mode:"create"|"ensure";
  readonly parentTopology:readonly CatalogParentTopologyEntry[];
}
export interface CatalogFolderIntentV2 extends CatalogFolderRequestV2 {
  readonly schema:"saturn.catalog-folder-intent.v2";readonly kind:"folder.create";
  readonly nodeId:string;readonly backendIdentity:string;readonly actor:CatalogFolderActor;
}
export interface CatalogFolderResultV2 {
  readonly schema:"saturn.catalog-folder-result.v2";readonly operationId:string;readonly intentHash:string;
  readonly rootId:string;readonly status:"CREATED"|"EXISTING";readonly description:NamespaceDescriptor;
}
export interface CatalogFolderOutcomeV2 {readonly replayed:boolean;readonly result:CatalogFolderResultV2}
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const requestKeys=["operationId","idempotencyKey","rootId","epoch","bindingVersion","parentId","name","mode","parentTopology"];
function object(value:unknown,keys:readonly string[]):Record<string,unknown> {
  if(typeof value!=="object"||value===null||Array.isArray(value))throw new CatalogFolderError("invalid_input");
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))throw new CatalogFolderError("invalid_input");return row;
}
function text(value:unknown,pattern?:RegExp):string {
  if(typeof value!=="string"||!value||(pattern&&!pattern.test(value)))throw new CatalogFolderError("invalid_input");return value;
}
function name(value:unknown):string {
  const valueText=text(value);if(Array.from(valueText).length>255||[".",".."].includes(valueText)||/[/\\\p{Cc}\p{Cs}]/u.test(valueText))throw new CatalogFolderError("invalid_input");return valueText;
}
/** Exact topology only; aggregate metadata UUIDs are intentionally not a parent CAS. */
export function parseCatalogFolderRequestV2(value:unknown):CatalogFolderRequestV2 {
  const r=object(value,requestKeys);for(const key of ["operationId","rootId","epoch","bindingVersion","parentId"])text(r[key],uuid);
  text(r.idempotencyKey,/^[A-Za-z\d._:-]{8,128}$/);name(r.name);
  if(r.mode!=="create"&&r.mode!=="ensure")throw new CatalogFolderError("invalid_input");
  const raw:unknown=r.parentTopology;if(!Array.isArray(raw)||raw.length<1||raw.length>129)throw new CatalogFolderError("invalid_input");
  const seen=new Set<string>(),parentTopology=raw.map((item:unknown)=>{
    const e=object(item,["nodeId","parentId","name"]),nodeId=text(e.nodeId,uuid),parentId=e.parentId===null?null:text(e.parentId,uuid);
    if(seen.has(nodeId))throw new CatalogFolderError("invalid_input");seen.add(nodeId);return Object.freeze({nodeId,parentId,name:name(e.name)});
  });
  if(parentTopology[0]?.nodeId!==r.parentId||parentTopology.at(-1)?.nodeId!==r.rootId||parentTopology.at(-1)?.parentId!==null
    ||parentTopology.some((entry,n)=>n<parentTopology.length-1&&entry.parentId!==parentTopology[n+1]?.nodeId))throw new CatalogFolderError("invalid_input");
  const result=Object.freeze({...r,parentTopology:Object.freeze(parentTopology)}) as unknown as CatalogFolderRequestV2;
  if(Buffer.byteLength(JSON.stringify(result))>32768)throw new CatalogFolderError("invalid_input");return result;
}
export function parseCatalogFolderIntentV2(value:unknown):CatalogFolderIntentV2 {
  const row=object(value,[...requestKeys,"schema","kind","nodeId","backendIdentity","actor"]);
  const {schema,kind,nodeId,backendIdentity,actor,...request}=row;
  const parsed=parseCatalogFolderRequestV2(request),principal=object(actor,["type","id"]);
  if(schema!=="saturn.catalog-folder-intent.v2"||kind!=="folder.create"||principal.type!=="device_token")throw new CatalogFolderError("invalid_input");
  text(nodeId,uuid);text(principal.id,uuid);text(backendIdentity,/^[A-Za-z\d._:-]{1,128}$/);
  const intent=Object.freeze({...parsed,schema,kind,nodeId,backendIdentity,actor:Object.freeze({type:"device_token",id:principal.id})}) as CatalogFolderIntentV2;
  if(Buffer.byteLength(JSON.stringify(intent))>32768)throw new CatalogFolderError("invalid_input");return intent;
}
export function catalogFolderIntentHashV2(value:CatalogFolderIntentV2):string {
  const i=parseCatalogFolderIntentV2(value);return createHash("sha256").update(JSON.stringify([i.schema,i.kind,i.operationId,i.idempotencyKey,i.rootId,i.epoch,i.bindingVersion,
    i.backendIdentity,i.parentId,i.name,i.mode,i.nodeId,i.actor.type,i.actor.id,i.parentTopology.map(e=>[e.nodeId,e.parentId,e.name])])).digest("hex");
}
/** Historical immutable publication evidence; not current namespace/byte/baseline authority. */
export function parseCatalogFolderResultV2(value:unknown,intent:CatalogFolderIntentV2):CatalogFolderResultV2 {
  try {
    const row=object(value,["schema","operationId","intentHash","rootId","status","description"]);
    const d=row.description as NamespaceDescriptor;validateNamespaceDescriptor(d);
    if(row.schema!=="saturn.catalog-folder-result.v2"||row.operationId!==intent.operationId||row.intentHash!==catalogFolderIntentHashV2(intent)||row.rootId!==intent.rootId
      ||(row.status!=="CREATED"&&row.status!=="EXISTING")||d.type!=="folder"||d.parent_id!==intent.parentId
      ||(row.status==="CREATED"&&(d.name!==intent.name||d.node_id!==intent.nodeId||d.size_bytes!=="0"||d.availability!=="AVAILABLE")))throw new CatalogFolderError("projection_mismatch");
    return Object.freeze({...row,description:Object.freeze({...d})}) as unknown as CatalogFolderResultV2;
  }catch(error){throw new CatalogFolderError("projection_mismatch",{cause:error});}
}
