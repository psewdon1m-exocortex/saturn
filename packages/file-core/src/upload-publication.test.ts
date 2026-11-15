import { randomUUID } from "node:crypto";
import { expect,it } from "vitest";
import { sameUploadPublicationRequest,uploadIntentHash,uploadPublicationIntentSchema,uploadPublicationReceiptSchema,type UploadPublicationIntent } from "./upload-publication.js";

const intent=():UploadPublicationIntent=>({schema:"saturn.upload-intent.v1",deviceKind:"windows_sync",idempotencyKey:"sync-resume-"+"a".repeat(64),
  deviceId:randomUUID(),rootId:randomUUID(),parentId:randomUUID(),requestPath:"sync/profile/name.txt",name:"name.txt",targetId:null,
  sizeBytes:"9007199254740993",sha256:"b".repeat(64),ifMatch:null,ifNoneMatch:"*",requireAbsent:true,expectedVersionId:null});
it("canonical hash seals key, actor, root, path, target and exact conditions independently of property order",()=>{
  const original=intent(),hash=uploadIntentHash(original);
  expect(uploadIntentHash(Object.fromEntries(Object.entries(original).reverse()) as unknown as UploadPublicationIntent)).toBe(hash);
  for(const change of [{idempotencyKey:"sync-resume-"+"c".repeat(64)},{deviceId:randomUUID()},{rootId:randomUUID()},{parentId:randomUUID()},
    {requestPath:"sync/profile/other.txt"},{name:"other.txt"},{sizeBytes:"9007199254740994"},{sha256:"c".repeat(64)},
    {ifNoneMatch:null},{ifMatch:"*"},{targetId:randomUUID(),requireAbsent:false},{targetId:randomUUID(),requireAbsent:false,expectedVersionId:randomUUID()}]) {
    expect(uploadIntentHash({...original,...change})).not.toBe(hash);
  }
});
it("request comparison rejects changed wire conditions before mutable target resolution",()=>{
  const original=intent(),request={deviceId:original.deviceId,rootId:original.rootId,requestPath:original.requestPath,
    sizeBytes:original.sizeBytes,sha256:original.sha256,ifMatch:original.ifMatch,ifNoneMatch:original.ifNoneMatch};
  expect(sameUploadPublicationRequest(original,request)).toBe(true);
  for(const change of [{rootId:randomUUID()},{deviceId:randomUUID()},{requestPath:"other"},{ifNoneMatch:null},{ifMatch:"*"}]) {
    expect(sameUploadPublicationRequest(original,{...request,...change})).toBe(false);
  }
});
it("intent parser rejects unknown or partial shape, invalid identifiers and inconsistent target conditions",()=>{
  const original=intent();
  for(const value of [{...original,epoch:randomUUID()},{...original,idempotencyKey:"local-work-key"},{...original,deviceId:"bad"},
    {...original,sizeBytes:Number("9007199254740993")},{...original,sizeBytes:"01"},{...original,sha256:"B".repeat(64)},
    {...original,targetId:randomUUID()},{...original,expectedVersionId:randomUUID()},{...original,ifNoneMatch:"other"}]) {
    expect(()=>uploadPublicationIntentSchema.parse(value)).toThrow();
  }
  const {ifMatch:removed,...partial}=original;expect(removed).toBeNull();expect(()=>uploadPublicationIntentSchema.parse(partial)).toThrow();
});
it("historical receipt uses the server UUID and exact decimal string; no current-CAS or epoch fields",()=>{
  const original=intent(),id=randomUUID();const receipt={schema:"saturn.upload-publication.v1",uploadId:id,operationId:id,
    intentHash:uploadIntentHash(original),rootId:original.rootId,resourceId:randomUUID(),versionId:randomUUID(),parentId:original.parentId,
    name:original.name,sizeBytes:original.sizeBytes,sha256:original.sha256,etag:`"sha256-${original.sha256}"`,publishedAt:"2026-10-12T12:00:00.000Z"};
  expect(uploadPublicationReceiptSchema.parse(receipt).sizeBytes).toBe("9007199254740993");
  for(const value of [{...receipt,operationId:"a".repeat(64)},{...receipt,operationId:randomUUID()},{...receipt,etag:'"current"'},
    {...receipt,publishedAt:"invalid"},{...receipt,epoch:randomUUID()},{...receipt,sizeBytes:Number("9007199254740993")}]) {
    expect(()=>uploadPublicationReceiptSchema.parse(value)).toThrow();
  }
});
