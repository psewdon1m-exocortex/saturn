import {describe,expect,it} from "vitest";
import {uploadIntentHash,type UploadPublicationIntent} from "./upload-publication.js";
import {catalogUploadCondition,catalogUploadPublicationIntentHash,parseCatalogUploadPrepareInput,parseUploadPublicationIntentV2,type UploadPublicationIntentV2} from "./catalog-upload-intent.js";
const a="10000000-0000-4000-8000-000000000001",b="10000000-0000-4000-8000-000000000002",c="10000000-0000-4000-8000-000000000003";
const legacy:UploadPublicationIntent={schema:"saturn.upload-intent.v1",deviceKind:"windows_sync",deviceId:a,rootId:b,requestPath:"/same.bin",idempotencyKey:"sync-resume-"+"a".repeat(64),parentId:b,name:"same.bin",targetId:null,sizeBytes:"9007199254740993",sha256:"b".repeat(64),ifMatch:null,ifNoneMatch:"*",requireAbsent:true,expectedVersionId:null};
const modern:UploadPublicationIntentV2={...legacy,schema:"saturn.upload-intent.v2",deviceKind:"pluto",condition:{kind:"absent"},parentTopology:[{nodeId:b,parentId:null,name:"Root"}]};
describe("guarded upload intent boundary",()=>{
  it("keeps original v1 byte/hash identity and exact int64 strings",()=>{
    expect(catalogUploadPublicationIntentHash(legacy)).toBe(uploadIntentHash(legacy));expect(catalogUploadCondition(legacy)).toEqual({kind:"absent"});
    expect(parseUploadPublicationIntentV2({...modern,sizeBytes:"9223372036854775807"}).sizeBytes).toBe("9223372036854775807");expect(()=>parseUploadPublicationIntentV2({...modern,sizeBytes:"9223372036854775808"})).toThrow(/overflow/);
  });
  it("domain separates kind and exact opaque metadata condition from SHA",()=>{
    expect(catalogUploadPublicationIntentHash(modern)).not.toBe(catalogUploadPublicationIntentHash(legacy));expect(catalogUploadPublicationIntentHash({...modern,deviceKind:"windows_sync"})).not.toBe(catalogUploadPublicationIntentHash(modern));
    const match={...modern,targetId:c,expectedVersionId:a,ifNoneMatch:null,requireAbsent:false,condition:{kind:"match" as const,nodeId:c,metadataVersion:b}};
    expect(parseUploadPublicationIntentV2(match).condition).toEqual(match.condition);expect(catalogUploadPublicationIntentHash({...match,condition:{...match.condition,metadataVersion:a}})).not.toBe(catalogUploadPublicationIntentHash(match));
    expect(()=>parseUploadPublicationIntentV2({...match,condition:{...match.condition,metadataVersion:modern.sha256}})).toThrow();
    expect(()=>catalogUploadCondition({...legacy,requireAbsent:false,ifNoneMatch:null,targetId:c,expectedVersionId:a})).toThrow(/explicit modern/);
  });
  it.each([{...modern,condition:{kind:"absent",extra:true}},{...modern,targetId:c},{...modern,sizeBytes:"01"},{...modern,name:"../bad"},{...modern,extra:true}])("rejects partial/ambiguous identity %j",value=>expect(()=>parseUploadPublicationIntentV2(value)).toThrow());
  it("binds execution separately without replacing original publication identity",()=>{
    const input=parseCatalogUploadPrepareInput({epoch:a,bindingVersion:b,backendIdentity:"fixture-sftp",intent:modern});expect(input.intent).toEqual(modern);expect(Object.isFrozen(input)).toBe(true);
    expect(()=>parseCatalogUploadPrepareInput({...input,bindingVersion:null})).toThrow();
  });
  it("seals exact bounded topology without aggregate metadata CAS",()=>{
    const chain={...modern,parentId:c,parentTopology:[{nodeId:c,parentId:b,name:"child"},{nodeId:b,parentId:null,name:"Root"}]};
    expect(parseUploadPublicationIntentV2(chain).parentTopology).toEqual(chain.parentTopology);
    expect(catalogUploadPublicationIntentHash({...chain,parentTopology:[{nodeId:c,parentId:b,name:"renamed"},{nodeId:b,parentId:null,name:"Root"}]})).not.toBe(catalogUploadPublicationIntentHash(chain));
    for(const parentTopology of [[],[chain.parentTopology[1],chain.parentTopology[0]],[{nodeId:c,parentId:c,name:"cycle"}],[{nodeId:c,parentId:b,name:"child"}],[{nodeId:c,parentId:b,name:"child",version:b},{nodeId:b,parentId:null,name:"Root"}],Array.from({length:130},()=>chain.parentTopology[0])])expect(()=>parseUploadPublicationIntentV2({...chain,parentTopology})).toThrow();
    expect(()=>parseUploadPublicationIntentV2({...chain,parentTopology:[{nodeId:c,parentId:b,name:"😀".repeat(256)},{nodeId:b,parentId:null,name:"Root"}]})).toThrow();
    expect(parseUploadPublicationIntentV2({...chain,parentTopology:[{nodeId:c,parentId:b,name:"😀".repeat(255)},{nodeId:b,parentId:null,name:"Root"}]}).parentTopology).toHaveLength(2);
    expect(()=>parseUploadPublicationIntentV2({...chain,parentTopology:[{nodeId:c,parentId:b,name:"\uD800"},{nodeId:b,parentId:null,name:"Root"}]})).toThrow();
  });
});
