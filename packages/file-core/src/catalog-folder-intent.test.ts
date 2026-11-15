import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { catalogFolderIntentHash,parseCatalogFolderIntent,parseCatalogFolderResult,sameCatalogFolderRequest,validateCatalogFolderRequest,type CatalogFolderIntent } from "./catalog-folder-intent.js";
const intent=():CatalogFolderIntent=>({schema:"saturn.catalog-folder-intent.v1",kind:"folder.create",operationId:randomUUID(),idempotencyKey:"fixture-key-123",rootId:randomUUID(),epoch:randomUUID(),bindingVersion:randomUUID(),parentId:randomUUID(),name:"folder",mode:"ensure",nodeId:randomUUID(),backendIdentity:"fixture-local",actor:{type:"device_token",id:randomUUID()}});
const request=(i:CatalogFolderIntent)=>{const {schema:_,kind:__,nodeId:___,backendIdentity:____,actor:_____,...r}=i;void _;void __;void ___;void ____;void _____;return r;};
describe("typed catalog folder identity/result",()=>{
  it("seals exact root, epoch, binding, parent, name, mode, key, reserved identity and actor",()=>{
    const i=intent(),fingerprint=catalogFolderIntentHash(i);expect(parseCatalogFolderIntent(i)).toEqual(i);
    expect(sameCatalogFolderRequest(i,request(i),i.actor)).toBe(true);
    for(const changed of [{...i,mode:"create" as const},{...i,bindingVersion:randomUUID()},{...i,nodeId:randomUUID()},{...i,idempotencyKey:"other-key-123"},{...i,actor:{type:"owner_web" as const,id:"owner"}}])expect(catalogFolderIntentHash(changed)).not.toBe(fingerprint);
    expect(sameCatalogFolderRequest(i,{...request(i),epoch:randomUUID()},i.actor)).toBe(false);
  });
  it.each([null,[],{bogus:true},{...intent(),backendIdentity:123},{...intent(),actor:[]},{...intent(),extra:"spoof"}])("rejects unknown intent shape %j",value=>expect(()=>parseCatalogFolderIntent(value)).toThrow());
  it("rejects unbounded or extra request data before SQL",()=>{
    const r=request(intent());expect(()=>validateCatalogFolderRequest({...r,name:"x".repeat(1021)})).toThrow();
    expect(()=>validateCatalogFolderRequest({...r,idempotencyKey:"!invalid"})).toThrow();
    expect(()=>validateCatalogFolderRequest({...r,extra:"permit"})).toThrow();
  });
  it("requires a typed immutable result and exact CREATED node",()=>{
    const i=intent(),result={schema:"saturn.catalog-folder-result.v1" as const,operationId:i.operationId,intentHash:catalogFolderIntentHash(i),rootId:i.rootId,status:"CREATED" as const,description:{node_id:i.nodeId,parent_id:i.parentId,name:i.name,type:"folder" as const,size_bytes:"0",content_sha256:null,content_version_id:null,version:randomUUID(),availability:"AVAILABLE" as const}};
    expect(parseCatalogFolderResult(result,i)).toEqual(result);
    for(const bad of [null,{...result,description:undefined},{...result,extra:"active"},{...result,intentHash:"f".repeat(64)},{...result,description:{...result.description,node_id:randomUUID()}}])expect(()=>parseCatalogFolderResult(bad,i)).toThrow("projection_mismatch");
    expect(parseCatalogFolderResult({...result,status:"EXISTING",description:{...result.description,node_id:randomUUID(),size_bytes:"9007199254740993",availability:"UNKNOWN"}},i).description.size_bytes).toBe("9007199254740993");
  });
});
