import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {parseCatalogFolderRequestV2,parseCatalogFolderIntentV2,catalogFolderIntentHashV2,parseCatalogFolderResultV2,type CatalogFolderRequestV2} from "./catalog-folder-v2-intent.js";
import {catalogFolderIntentHash,parseCatalogFolderIntent} from "./catalog-folder-intent.js";
import {coherenceSchema} from "../../recovery/src/consistent-snapshot.js";
const root=randomUUID(),parent=randomUUID(),request:CatalogFolderRequestV2={operationId:randomUUID(),idempotencyKey:"fixture-123456",rootId:root,epoch:randomUUID(),bindingVersion:randomUUID(),parentId:parent,name:"exact😀name",mode:"ensure",parentTopology:[{nodeId:parent,parentId:root,name:"parent"},{nodeId:root,parentId:null,name:"root"}]};
const intent=()=>parseCatalogFolderIntentV2({...request,schema:"saturn.catalog-folder-intent.v2",kind:"folder.create",nodeId:randomUUID(),backendIdentity:"fixture-local",actor:{type:"device_token",id:randomUUID()}});
describe("modern folder topology contract",()=>{
  it("freezes exact topology without aggregate metadata CAS and separates v1/v2 hash domains",()=>{
    const raw={...request,parentTopology:request.parentTopology.map(e=>({...e}))},parsed=parseCatalogFolderRequestV2(raw);const first=raw.parentTopology[0];if(!first)throw new Error("Fixture topology absent");first.name="changed";
    expect(parsed.parentTopology[0]?.name).toBe("parent");expect(Object.isFrozen(parsed.parentTopology[0])).toBe(true);
    const i=intent(),{parentTopology,...rest}=i;void parentTopology;
    expect(catalogFolderIntentHashV2(i)).toMatch(/^[a-f\d]{64}$/);expect(catalogFolderIntentHashV2(i)).not.toBe(catalogFolderIntentHash(parseCatalogFolderIntent({...rest,schema:"saturn.catalog-folder-intent.v1"})));
  });
  for(const [label,change]of [
    ["extra",{extra:true}],["missing",{parentTopology:undefined}],["zero",{parentTopology:[]}],
    ["duplicate",{parentTopology:[request.parentTopology[0],request.parentTopology[0],request.parentTopology[1]]}],
    ["order",{parentTopology:[...request.parentTopology].reverse()}],["root-parent",{parentTopology:[request.parentTopology[0],{...request.parentTopology[1],parentId:parent}]}],
    ["root-id",{rootId:randomUUID()}],["gap",{parentTopology:[{...request.parentTopology[0],parentId:randomUUID()},request.parentTopology[1]]}],
    ["unknown-field",{parentTopology:[{...request.parentTopology[0],version:randomUUID()},request.parentTopology[1]]}],
    ["control",{name:"bad\u0001"}],["surrogate",{name:"bad\ud800"}],["slash",{name:"x/y"}],["256scalars",{name:"😀".repeat(256)}],
  ]as const)it("rejects "+label,()=>expect(()=>parseCatalogFolderRequestV2({...request,...change})).toThrow());
  it("accepts255 Unicode scalars but enforces rawUTF8 byte bound over deep witness",()=>{
    expect(parseCatalogFolderRequestV2({...request,name:"😀".repeat(255)}).name).toHaveLength(510);
    const ids=Array.from({length:129},()=>randomUUID()),chain=ids.map((id,n)=>({nodeId:id,parentId:ids[n+1]??null,name:"n"}));
    expect(parseCatalogFolderRequestV2({...request,parentId:ids[0],rootId:ids.at(-1),parentTopology:chain}).parentTopology).toHaveLength(129);
    expect(()=>parseCatalogFolderRequestV2({...request,parentId:ids[0],rootId:ids.at(-1),parentTopology:chain.map(e=>({...e,name:"😀".repeat(255)}))})).toThrow();
    expect(()=>parseCatalogFolderRequestV2({...request,parentTopology:[...chain,chain.at(-1)]})).toThrow();
  });
  it("strictly binds historical result to original operation/hash/root/target and preserves UNKNOWN existing descriptor",()=>{
    const i=intent(),description={node_id:i.nodeId,parent_id:i.parentId,name:i.name,type:"folder"as const,size_bytes:"0",content_sha256:null,content_version_id:null,version:randomUUID(),availability:"AVAILABLE"as const};
    const result={schema:"saturn.catalog-folder-result.v2",operationId:i.operationId,intentHash:catalogFolderIntentHashV2(i),rootId:i.rootId,status:"CREATED",description};
    expect(parseCatalogFolderResultV2(result,i).description.node_id).toBe(i.nodeId);
    expect(()=>parseCatalogFolderResultV2({...result,intentHash:"0".repeat(64)},i)).toThrow();
    expect(()=>parseCatalogFolderResultV2({...result,description:{...description,availability:"UNKNOWN"}},i)).toThrow();
    expect(parseCatalogFolderResultV2({...result,status:"EXISTING",description:{...description,node_id:randomUUID(),availability:"UNKNOWN",size_bytes:"9007199254740993"}},i).description.size_bytes).toBe("9007199254740993");
  });
  it("requires complete coherent modern schema/count group without breaking earlier manifests",()=>{
    const value={schema:"saturn.backup-coherence.v1",snapshotId:"aa-bb-1",snapshotStartedAt:"fixture",journal:{shape:"sync-root-journal.v1",registeredRoots:"1",changes:"1",boundOperations:"1",pendingOperations:"0",finalReceipts:"1",dumpPolicy:"durable-journal-with-upload-dependencies"},clockCutMember:"metadata/sync_root_clock.jsonl",databaseDumpSha256:"a".repeat(64),metadataAuthority:"diagnostic-only-same-cut",registeredRootRecovery:"blocked-requires-backend-reconciliation"};
    expect(coherenceSchema.safeParse(value).success).toBe(true);
    expect(coherenceSchema.safeParse({...value,journal:{...value.journal,catalogFolderV2Shape:"saturn.catalog-folder-intent.v2"}}).success).toBe(false);
    expect(coherenceSchema.safeParse({...value,journal:{...value.journal,catalogFolderV2Shape:"saturn.catalog-folder-intent.v2",catalogFolderV2Operations:"9007199254740993"}}).success).toBe(true);
  });
});
