import {createHash} from "node:crypto";
import {uploadIntentHash,uploadPublicationIntentSchema,type UploadPublicationIntent,type UploadPublicationReceipt} from "./upload-publication.js";
import type {NamespaceDescriptor} from "./current-namespace.js";

/** Explicit modern condition; SHA/content identity is never a metadata CAS UUID. */
export type CatalogUploadCondition=
  |Readonly<{kind:"absent"}>
  |Readonly<{kind:"match";nodeId:string;metadataVersion:string}>;
/** Namespace topology only: sibling aggregate metadata changes do not change this witness. */
export interface CatalogParentTopologyEntry {readonly nodeId:string;readonly parentId:string|null;readonly name:string}
export interface UploadPublicationIntentV2 {
  readonly schema:"saturn.upload-intent.v2";
  readonly deviceKind:"windows_sync"|"pluto";
  readonly deviceId:string;readonly rootId:string;readonly requestPath:string;
  readonly idempotencyKey:string;readonly parentId:string;readonly name:string;
  readonly targetId:string|null;readonly sizeBytes:string;readonly sha256:string;
  /** Exact original legacy wire conditions remain independently sealed. */
  readonly ifMatch:string|null;readonly ifNoneMatch:"*"|null;
  readonly requireAbsent:boolean;readonly expectedVersionId:string|null;
  readonly condition:CatalogUploadCondition;
  readonly parentTopology:readonly CatalogParentTopologyEntry[];
}
export type CatalogUploadPublicationIntent=UploadPublicationIntent|UploadPublicationIntentV2;
export interface CatalogUploadPrepareInput {
  readonly epoch:string;readonly bindingVersion:string;readonly backendIdentity:string;
  readonly intent:CatalogUploadPublicationIntent;
}
export type CatalogUploadPhase="transport"|"verified"|"physical_pending"|"reconciliation_required"|"published"|"not_published";
export interface CatalogUploadSession {
  readonly uploadId:string;readonly operationId:string;readonly rootId:string;readonly intentHash:string;
  readonly expectedSizeBytes:string;readonly receivedSizeBytes:string;readonly phase:CatalogUploadPhase;
  /** A reserved chunk may have an unknown temp-only outcome; it cannot be sent again blindly. */
  readonly transferPending:boolean;
}
/** Historical execution evidence, not current namespace/byte/baseline authority. */
export type CatalogUploadResult=
  |Readonly<{schema:"saturn.catalog-upload-result.v2";status:"PUBLISHED";uploadId:string;operationId:string;rootId:string;intentHash:string;
      publicationReceipt:UploadPublicationReceipt;publishedDescription:NamespaceDescriptor;firstSeq:string;lastSeq:string}>
  |Readonly<{schema:"saturn.catalog-upload-result.v2";status:"NOT_PUBLISHED";uploadId:string;operationId:string;rootId:string;intentHash:string;reason:"cancelled_before_publication"}>;
export interface CatalogUploadStatus {readonly session:CatalogUploadSession;readonly result?:CatalogUploadResult;readonly replayed:boolean}

const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const digest=/^[a-f\d]{64}$/;
const maxBigint=9223372036854775807n;
const v2Keys=["schema","deviceKind","deviceId","rootId","requestPath","idempotencyKey","parentId","name","targetId","sizeBytes","sha256","ifMatch","ifNoneMatch","requireAbsent","expectedVersionId","condition","parentTopology"];
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(typeof value!=="object"||value===null||Array.isArray(value))throw new Error("Invalid catalog upload shape");
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))throw new Error("Invalid catalog upload fields");
  return row;
}
function text(row:Record<string,unknown>,key:string,max:number,pattern?:RegExp):string{
  const value=row[key];if(typeof value!=="string"||value.length<1||value.length>max||(pattern!==undefined&&!pattern.test(value)))throw new Error("Invalid catalog upload "+key);return value;
}
export function parseCatalogUploadCondition(value:unknown):CatalogUploadCondition {
  if(typeof value!=="object"||value===null||Array.isArray(value))throw new Error("Invalid catalog upload condition");
  const kind=(value as Record<string,unknown>).kind;
  if(kind==="absent"){object(value,["kind"]);return Object.freeze({kind:"absent"});}
  const row=object(value,["kind","nodeId","metadataVersion"]);if(kind!=="match")throw new Error("Invalid catalog upload condition");
  return Object.freeze({kind:"match",nodeId:text(row,"nodeId",36,uuid),metadataVersion:text(row,"metadataVersion",36,uuid)});
}
export function parseUploadPublicationIntentV2(value:unknown):UploadPublicationIntentV2 {
  const row=object(value,v2Keys);
  if(row.schema!=="saturn.upload-intent.v2"||!["windows_sync","pluto"].includes(String(row.deviceKind))||typeof row.requireAbsent!=="boolean")throw new Error("Invalid modern upload intent");
  for(const key of ["deviceId","rootId","parentId"])text(row,key,36,uuid);
  for(const key of ["targetId","expectedVersionId"])if(row[key]!==null)text(row,key,36,uuid);
  text(row,"requestPath",4096);text(row,"idempotencyKey",200,/^[A-Za-z\d._:-]{8,200}$/);text(row,"sha256",64,digest);
  const size=text(row,"sizeBytes",19,/^(0|[1-9]\d*)$/);if(BigInt(size)>maxBigint)throw new Error("Catalog upload size overflow");
  const name=text(row,"name",510);if(Array.from(name).length>255||[".",".."].includes(name)||/[/\\\p{Cc}\p{Cs}]/u.test(name))throw new Error("Invalid catalog upload name");
  if(row.ifMatch!==null&&(typeof row.ifMatch!=="string"||row.ifMatch.length>100))throw new Error("Invalid catalog upload ifMatch");
  if(row.ifNoneMatch!==null&&row.ifNoneMatch!=="*")throw new Error("Invalid catalog upload ifNoneMatch");
  const condition=parseCatalogUploadCondition(row.condition);
  if(condition.kind==="absent"){
    if(row.targetId!==null||row.expectedVersionId!==null||!row.requireAbsent||row.ifNoneMatch!=="*"||row.ifMatch!==null)throw new Error("Inconsistent absent upload condition");
  }else if(row.targetId!==condition.nodeId||row.expectedVersionId===null||row.requireAbsent||row.ifNoneMatch!==null)throw new Error("Inconsistent metadata upload condition");
  if(!Array.isArray(row.parentTopology)||row.parentTopology.length<1||row.parentTopology.length>129)throw new Error("Invalid parent topology count");
  const seen=new Set<string>();
  const parentTopology=row.parentTopology.map((value:unknown)=>{
    const entry=object(value,["nodeId","parentId","name"]),nodeId=text(entry,"nodeId",36,uuid),ancestorName=text(entry,"name",510);
    if(seen.has(nodeId)||Array.from(ancestorName).length>255||[".",".."].includes(ancestorName)||/[/\\\p{Cc}\p{Cs}]/u.test(ancestorName))throw new Error("Invalid parent topology entry");
    seen.add(nodeId);const parentId=entry.parentId===null?null:text(entry,"parentId",36,uuid);return Object.freeze({nodeId,parentId,name:ancestorName});
  });
  if(parentTopology[0]?.nodeId!==row.parentId||parentTopology.at(-1)?.nodeId!==row.rootId||parentTopology.at(-1)?.parentId!==null
    ||parentTopology.some((entry,n)=>n<parentTopology.length-1&&entry.parentId!==parentTopology[n+1]?.nodeId))throw new Error("Invalid parent topology chain");
  const parsed=Object.freeze({...row,condition,parentTopology:Object.freeze(parentTopology)}) as unknown as UploadPublicationIntentV2;
  if(Buffer.byteLength(JSON.stringify(parsed))>32768)throw new Error("Catalog upload intent byte limit");return parsed;
}
/** v1 byte/hash semantics are intentionally delegated to the unchanged parser. */
export function parseCatalogUploadPublicationIntent(value:unknown):CatalogUploadPublicationIntent {
  return typeof value==="object"&&value!==null&&"schema" in value&&value.schema==="saturn.upload-intent.v1"
    ?uploadPublicationIntentSchema.parse(value):parseUploadPublicationIntentV2(value);
}
export function catalogUploadPublicationIntentHash(value:CatalogUploadPublicationIntent):string {
  const intent=parseCatalogUploadPublicationIntent(value);
  if(intent.schema==="saturn.upload-intent.v1")return uploadIntentHash(intent);
  return createHash("sha256").update(JSON.stringify([intent.schema,intent.deviceKind,intent.idempotencyKey,intent.deviceId,intent.rootId,intent.requestPath,
    intent.parentId,intent.name,intent.targetId,intent.sizeBytes,intent.sha256,intent.ifMatch,intent.ifNoneMatch,intent.requireAbsent,intent.expectedVersionId,
    intent.condition.kind,...(intent.condition.kind==="match"?[intent.condition.nodeId,intent.condition.metadataVersion]:[]),
    intent.parentTopology.map(entry=>[entry.nodeId,entry.parentId,entry.name])])).digest("hex");
}
export function catalogUploadCondition(intent:CatalogUploadPublicationIntent):CatalogUploadCondition {
  if(intent.schema==="saturn.upload-intent.v2")return intent.condition;
  // Legacy absence has an explicit condition. A SHA ETag cannot manufacture modern overwrite CAS.
  if(!intent.requireAbsent||intent.ifNoneMatch!=="*"||intent.targetId!==null||intent.expectedVersionId!==null)throw new Error("Legacy overwrite requires explicit modern metadata condition");
  return {kind:"absent"};
}
export function parseCatalogUploadPrepareInput(value:unknown):CatalogUploadPrepareInput {
  const row=object(value,["epoch","bindingVersion","backendIdentity","intent"]);
  text(row,"epoch",36,uuid);text(row,"bindingVersion",36,uuid);text(row,"backendIdentity",128,/^[A-Za-z\d._:-]{1,128}$/);
  const intent=parseCatalogUploadPublicationIntent(row.intent);catalogUploadCondition(intent);
  if(BigInt(intent.sizeBytes)>maxBigint)throw new Error("Catalog upload size overflow");
  return Object.freeze({epoch:String(row.epoch),bindingVersion:String(row.bindingVersion),backendIdentity:String(row.backendIdentity),intent:Object.freeze({...intent})});
}
