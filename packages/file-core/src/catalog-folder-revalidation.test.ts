import {randomUUID} from "node:crypto";
import {describe,expect,it,vi} from "vitest";
import type {Database} from "@saturn/database";
import type {CatalogFolderAuthority,CatalogFolderAuthorityIssuer} from "./catalog-folder-authority.js";
import {CatalogFolderRevalidationOperator,FolderRevalidationEvidenceIssuer,folderRevalidationTreeSha256,parseFolderRevalidationIntent,
  type FolderRevalidationIntent,type FolderRevalidationBackendLease,type FolderRevalidationTreeEntry} from "./catalog-folder-revalidation.js";
function required<T>(v:T|undefined):T{if(v===undefined)throw Error("Fixture entry missing");return v;}

function fixture():FolderRevalidationIntent{
  const root=randomUUID(),operationId=randomUUID(),tree:FolderRevalidationTreeEntry[]=[{description:{node_id:root,parent_id:null,name:"root",type:"folder",size_bytes:"0",
    content_sha256:null,content_version_id:null,version:randomUUID(),availability:"UNKNOWN"},storagePath:"root"}],now=Date.now();
  return {schema:"saturn.catalog-folder-revalidation-intent.v1",operationId,idempotencyKey:"folder-revalidate-"+operationId,binding:{protocol:"neptune-sync/1",descriptor_schema:"saturn.current-namespace.v1",server_identity:randomUUID(),root_id:root,server_epoch:randomUUID(),policy_version:"policy-1",binding_version:randomUUID()},
    guardRevision:randomUUID(),backendIdentity:"private-local",deviceId:randomUUID(),expectedSeq:"9007199254740993",observedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),
    custody:{backendGeneration:randomUUID(),bootstrapSha256:"a".repeat(64),drainSha256:"b".repeat(64),backupSha256:"c".repeat(64),treeSha256:folderRevalidationTreeSha256(tree)},tree,folders:[root]};
}
describe("private offline folder revalidation",()=>{
  it("bounds a complete populated repair preimage at1024 distinct nodes",()=>{
    const i=fixture(),root=required(i.tree[0]);
    const tree=[root,...Array.from({length:1023},(_,n)=>({storagePath:root.storagePath+"/child-"+String(n),description:{...root.description,node_id:randomUUID(),parent_id:root.description.node_id,name:"child-"+String(n),availability:"AVAILABLE" as const}}))];
    const input={...i,tree,custody:{...i.custody,treeSha256:folderRevalidationTreeSha256(tree)}};
    expect(parseFolderRevalidationIntent(input).tree).toHaveLength(1024);
    const extra={...required(tree[1]),storagePath:root.storagePath+"/extra",description:{...required(tree[1]).description,node_id:randomUUID(),name:"extra"}};
    const oversized=[...tree,extra];
    expect(()=>parseFolderRevalidationIntent({...input,tree:oversized,custody:{...input.custody,treeSha256:folderRevalidationTreeSha256(oversized)}})).toThrow("invalid_input");
  });
  it("seals the original decimal preimage and excludes caller mutation",()=>{
    const input=fixture(),parsed=parseFolderRevalidationIntent(input);expect(parsed.expectedSeq).toBe("9007199254740993");expect(Object.isFrozen(parsed.tree[0]?.description)).toBe(true);
    (input.tree[0]?.description as {name:string}).name="changed";expect(parsed.tree[0]?.description.name).toBe("root");
  });
  it.each(["9223372036854775808","9007199254740993.0","1e3","-1","01"])("rejects invalid exact sequence %s",expectedSeq=>{expect(()=>parseFolderRevalidationIntent({...fixture(),expectedSeq})).toThrow("invalid_input");});
  it("rejects omitted ownership evidence, changed bytes and unrelated path projections",()=>{
    const i=fixture();expect(()=>parseFolderRevalidationIntent({...i,custody:{...i.custody,bootstrapSha256:undefined}})).toThrow();
    const child={description:{...required(i.tree[0]).description,node_id:randomUUID(),parent_id:i.binding.root_id,name:"child",availability:"AVAILABLE" as const},storagePath:"somewhere/child"};
    const tree=[...i.tree,child];expect(()=>parseFolderRevalidationIntent({...i,tree,custody:{...i.custody,treeSha256:folderRevalidationTreeSha256(tree)}})).toThrow();
    expect(()=>parseFolderRevalidationIntent({...i,tree:[{...i.tree[0],storagePath:"other"}]})).toThrow();
  });
  it("rejects a validly hashed cycle and depth129 before any physical read",()=>{
    const i=fixture(),tree=[...i.tree];let parent=required(tree[0]);
    for(let n=0;n<129;n++){const child={description:{...parent.description,node_id:randomUUID(),parent_id:parent.description.node_id,name:"a",availability:"AVAILABLE" as const},storagePath:parent.storagePath+"/a"};tree.push(child);parent=child;}
    expect(()=>parseFolderRevalidationIntent({...i,tree,custody:{...i.custody,treeSha256:folderRevalidationTreeSha256(tree)}})).toThrow();
    const cycle=[...tree.slice(0,3)];cycle[1]={...required(cycle[1]),description:{...required(cycle[1]).description,parent_id:required(cycle[2]).description.node_id}};
    expect(()=>parseFolderRevalidationIntent({...i,tree:cycle,custody:{...i.custody,treeSha256:folderRevalidationTreeSha256(cycle)}})).toThrow();
  });
  it("does not accept serialized proof or proof from another issuer",async()=>{
    const i=fixture(),lease={custody:i.custody,assertCurrent:vi.fn(async()=>{}),close:vi.fn(async()=>{})},a=new FolderRevalidationEvidenceIssuer({acquire:async()=>lease}),b=new FolderRevalidationEvidenceIssuer({acquire:async()=>lease});
    const proof=await a.acquire(i);
    try{await expect(a.assertCurrent({...proof},i)).rejects.toThrow("authority_invalid");await expect(b.assertCurrent(proof,i)).rejects.toThrow("authority_invalid");await expect(a.acquire(i)).rejects.toThrow("admission_full");}
    finally{await a.release(proof);}expect(lease.close).toHaveBeenCalledOnce();await expect(a.assertCurrent(proof,i)).rejects.toThrow("authority_invalid");
  });
  it("closes held handles on custody drift and admission becomes available again",async()=>{
    const i=fixture(),close=vi.fn(async()=>{}),verifier={acquire:vi.fn(async()=>({custody:{...i.custody,backendGeneration:randomUUID()},assertCurrent:async()=>{},close}))},issuer=new FolderRevalidationEvidenceIssuer(verifier);
    await expect(issuer.acquire(i)).rejects.toThrow("custody_changed");await expect(issuer.acquire(i)).rejects.toThrow("custody_changed");expect(close).toHaveBeenCalledTimes(2);
  });
  it("checks held custody again immediately before SQL and refuses its expiry",async()=>{
    const i=fixture(),assertCurrent=vi.fn(async()=>{}),issuer=new FolderRevalidationEvidenceIssuer({acquire:async()=>({custody:i.custody,assertCurrent,close:async()=>{}})}),proof=await issuer.acquire(i);
    try{await issuer.assertCurrent(proof,i);expect(assertCurrent).toHaveBeenCalledTimes(2);vi.spyOn(Date,"now").mockReturnValue(Date.parse(i.expiresAt)+1);await expect(issuer.assertCurrent(proof,i)).rejects.toThrow("evidence_expired");}
    finally{vi.restoreAllMocks();await issuer.release(proof);}
  });
  it.each(["protocol","descriptor_schema","server_identity","root_id","server_epoch","policy_version","binding_version"] as const)("compares trusted full binding field %s before SQL or evidence",async key=>{
    const i=fixture(),transaction=vi.fn(),acquire=vi.fn(),database={transaction} as unknown as Database;
    const issuer=new FolderRevalidationEvidenceIssuer({acquire}),authority={} as CatalogFolderAuthorityIssuer;
    const operator=new CatalogFolderRevalidationOperator(database,authority,issuer,{...i.binding,[key]:"other"},i.guardRevision,i.backendIdentity);
    await expect(operator.reconcile(i,{} as CatalogFolderAuthority)).rejects.toThrow("binding_invalid");expect(transaction).not.toHaveBeenCalled();expect(acquire).not.toHaveBeenCalled();
  });
  it("performs physical callbacks outside SQL and releases custody after commit failure",async()=>{
    const i=fixture();let inSql=false,calls=0;
    const closed=vi.fn(async()=>{expect(inSql).toBe(false);}),lease:FolderRevalidationBackendLease={custody:i.custody,assertCurrent:vi.fn(async()=>{expect(inSql).toBe(false);}),close:closed};
    const sql=async(strings:TemplateStringsArray)=>{if(strings.join("").includes("catalog_folder_revalidation_command")){if(++calls===2)throw Error("lost SQL acknowledgement");return [{value:{replayed:false,result:null},intent_hash:"d".repeat(64)}];}return [];};
    const database={transaction:async(action:(sql:unknown)=>Promise<unknown>)=>{inSql=true;try{return await action(sql);}finally{inSql=false;}}} as unknown as Database;
    const authority={deviceCredential:()=>({deviceId:i.deviceId,tokenHash:"e".repeat(64),deviceKind:"pluto"})} as unknown as CatalogFolderAuthorityIssuer;
    const operator=new CatalogFolderRevalidationOperator(database,authority,new FolderRevalidationEvidenceIssuer({acquire:async()=>{expect(inSql).toBe(false);return lease;}}),i.binding,i.guardRevision,i.backendIdentity);
    await expect(operator.reconcile(i,{} as CatalogFolderAuthority)).rejects.toThrow("lost SQL acknowledgement");expect(closed).toHaveBeenCalledOnce();expect(calls).toBe(2);expect(i.operationId).toBe(i.idempotencyKey.slice("folder-revalidate-".length));
  });
  it("replays an expired original without attempting another physical scan",async()=>{
    const fresh=fixture(),i={...fresh,observedAt:"2020-01-01T00:00:00.000Z",expiresAt:"2020-01-01T00:00:01.000Z"},acquire=vi.fn();
    const result={schema:"saturn.catalog-folder-revalidation-result.v1",operationId:i.operationId,intentHash:"d".repeat(64),rootId:i.binding.root_id,status:"REVALIDATED",firstSeq:"9007199254740994",lastSeq:"9007199254740994",descriptions:[{...required(i.tree[0]).description,availability:"AVAILABLE",version:randomUUID()}]};
    const sql=async(strings:TemplateStringsArray)=>strings.join("").includes("catalog_folder_revalidation_command")?[{value:{replayed:true,result},intent_hash:"d".repeat(64)}]:[];
    const database={transaction:async(action:(sql:unknown)=>Promise<unknown>)=>action(sql)} as unknown as Database;
    const authority={deviceCredential:()=>({deviceId:i.deviceId,tokenHash:"e".repeat(64),deviceKind:"pluto"})} as unknown as CatalogFolderAuthorityIssuer;
    const operator=new CatalogFolderRevalidationOperator(database,authority,new FolderRevalidationEvidenceIssuer({acquire}),i.binding,i.guardRevision,i.backendIdentity);
    expect(await operator.reconcile(i,{} as CatalogFolderAuthority)).toEqual({replayed:true,result});expect(acquire).not.toHaveBeenCalled();
  });
});
