import { createHash } from "node:crypto";

export interface UploadPublicationRequest {
  readonly deviceId:string;readonly rootId:string;readonly requestPath:string;readonly sizeBytes:string;readonly sha256:string;
  readonly ifMatch:string|null;readonly ifNoneMatch:"*"|null;
}
export interface UploadPublicationIntent extends UploadPublicationRequest {
  readonly schema:"saturn.upload-intent.v1";readonly deviceKind:"windows_sync";readonly idempotencyKey:string;
  readonly parentId:string;readonly name:string;readonly targetId:string|null;readonly requireAbsent:boolean;readonly expectedVersionId:string|null;
}
export interface UploadPublicationReceipt {
  readonly schema:"saturn.upload-publication.v1";readonly uploadId:string;readonly operationId:string;readonly intentHash:string;
  readonly rootId:string;readonly resourceId:string;readonly versionId:string;readonly parentId:string;readonly name:string;
  readonly sizeBytes:string;readonly sha256:string;readonly etag:string;readonly publishedAt:string;
}
/** Current request credential, intentionally excluded from durable intent. */
export interface UploadPublicationAuthorization {
  readonly deviceId:string;readonly rootId:string;readonly tokenHash:string;
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=/^[a-f0-9]{64}$/;
const decimal=/^(0|[1-9][0-9]*)$/;
const requestKeys=['deviceId','rootId','requestPath','sizeBytes','sha256','ifMatch','ifNoneMatch'];
const intentKeys=[...requestKeys,'schema','deviceKind','idempotencyKey','parentId','name','targetId','requireAbsent','expectedVersionId'];
const receiptKeys=['schema','uploadId','operationId','intentHash','rootId','resourceId','versionId','parentId','name','sizeBytes','sha256','etag','publishedAt'];
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(typeof value!=='object'||value===null||Array.isArray(value))throw new Error('Invalid upload publication shape');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key)))throw new Error('Invalid upload publication fields');
  return row;
}
function text(row:Record<string,unknown>,key:string,max:number,pattern?:RegExp):void{
  const value=row[key];if(typeof value!=='string'||value.length<1||value.length>max||(pattern!==undefined&&!pattern.test(value)))throw new Error('Invalid upload publication '+key);
}
function requestFields(row:Record<string,unknown>):void{
  for(const key of ['deviceId','rootId'])text(row,key,36,uuid);
  text(row,'requestPath',4096);text(row,'sizeBytes',20,decimal);text(row,'sha256',64,digest);
  if(row.ifMatch!==null&&(typeof row.ifMatch!=='string'||row.ifMatch.length>100))throw new Error('Invalid upload publication ifMatch');
  if(row.ifNoneMatch!==null&&row.ifNoneMatch!=='*')throw new Error('Invalid upload publication ifNoneMatch');
}
export const uploadPublicationRequestSchema={parse(value:unknown):UploadPublicationRequest{
  const row=object(value,requestKeys);requestFields(row);return row as unknown as UploadPublicationRequest;
}};
export const uploadPublicationIntentSchema={parse(value:unknown):UploadPublicationIntent{
  const row=object(value,intentKeys);requestFields(row);text(row,'parentId',36,uuid);text(row,'name',255);
  text(row,'idempotencyKey',200,/^sync-resume-[a-f0-9]{64}$/);
  for(const key of ['targetId','expectedVersionId'])if(row[key]!==null)text(row,key,36,uuid);
  if(row.schema!=='saturn.upload-intent.v1'||row.deviceKind!=='windows_sync'||typeof row.requireAbsent!=='boolean')throw new Error('Invalid upload publication intent');
  if((row.requireAbsent && row.targetId!==null)||(row.targetId===null && row.expectedVersionId!==null))throw new Error('Inconsistent upload publication condition');
  return row as unknown as UploadPublicationIntent;
}};
export const uploadPublicationReceiptSchema={parse(value:unknown):UploadPublicationReceipt{
  const row=object(value,receiptKeys);
  for(const key of ['uploadId','operationId','rootId','resourceId','versionId','parentId'])text(row,key,36,uuid);
  for(const key of ['intentHash','sha256'])text(row,key,64,digest);
  text(row,'name',255);text(row,'sizeBytes',20,decimal);text(row,'publishedAt',40);
  if(row.schema!=='saturn.upload-publication.v1'||row.operationId!==row.uploadId||row.etag!==`"sha256-${String(row.sha256)}"`
    ||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(String(row.publishedAt))||Number.isNaN(new Date(String(row.publishedAt)).getTime()))throw new Error('Inconsistent upload publication receipt');
  return row as unknown as UploadPublicationReceipt;
}};
/** Fixed ordered fields and explicit nulls; never hash mutable Resource/object order. */
export function uploadIntentHash(value:UploadPublicationIntent):string{
  const intent=uploadPublicationIntentSchema.parse(value);
  return createHash('sha256').update(JSON.stringify([
    intent.schema,intent.deviceKind,intent.idempotencyKey,intent.deviceId,intent.rootId,intent.requestPath,
    intent.parentId,intent.name,intent.targetId,intent.sizeBytes,intent.sha256,
    intent.ifMatch,intent.ifNoneMatch,intent.requireAbsent,intent.expectedVersionId,
  ])).digest('hex');
}
export function sameUploadPublicationRequest(intent:UploadPublicationIntent,value:UploadPublicationRequest):boolean{
  const request=uploadPublicationRequestSchema.parse(value);
  return intent.deviceId===request.deviceId&&intent.rootId===request.rootId&&intent.requestPath===request.requestPath
    &&intent.sizeBytes===request.sizeBytes&&intent.sha256===request.sha256&&intent.ifMatch===request.ifMatch&&intent.ifNoneMatch===request.ifNoneMatch;
}
