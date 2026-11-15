import {createHash} from "node:crypto";
import type {Database} from "@saturn/database";
import type {CatalogFolderAuthority,CatalogFolderAuthorityIssuer} from "./catalog-folder-authority.js";
import {validateNamespaceDescriptor,type NamespaceDescriptor} from "./current-namespace.js";

const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const SHA=/^[a-f\d]{64}$/;
const ID=/^[A-Za-z\d._:-]{1,128}$/;
const MAX=9223372036854775807n;
export class FolderRevalidationError extends Error {
  constructor(readonly code:string,options?:ErrorOptions){super(code,options);}
}
export interface FolderRevalidationBinding {
  readonly protocol:"neptune-sync/1";readonly descriptor_schema:"saturn.current-namespace.v1";
  readonly server_identity:string;readonly root_id:string;readonly server_epoch:string;readonly policy_version:string;readonly binding_version:string;
}
export interface FolderRevalidationTreeEntry {readonly description:NamespaceDescriptor;readonly storagePath:string}
export interface FolderRevalidationCustody {
  readonly backendGeneration:string;readonly bootstrapSha256:string;readonly drainSha256:string;readonly backupSha256:string;readonly treeSha256:string;
}
export interface FolderRevalidationIntent {
  readonly schema:"saturn.catalog-folder-revalidation-intent.v1";readonly operationId:string;readonly idempotencyKey:string;
  readonly binding:FolderRevalidationBinding;readonly guardRevision:string;readonly backendIdentity:string;readonly deviceId:string;readonly expectedSeq:string;
  readonly observedAt:string;readonly expiresAt:string;readonly custody:FolderRevalidationCustody;
  readonly tree:readonly FolderRevalidationTreeEntry[];readonly folders:readonly string[];
}
export interface FolderRevalidationResult {
  readonly schema:"saturn.catalog-folder-revalidation-result.v1";readonly operationId:string;readonly intentHash:string;readonly rootId:string;
  readonly status:"REVALIDATED";readonly firstSeq:string;readonly lastSeq:string;readonly descriptions:readonly NamespaceDescriptor[];
}
export interface FolderRevalidationOutcome {readonly replayed:boolean;readonly result:FolderRevalidationResult}
function fail(code="invalid_input"):never{throw new FolderRevalidationError(code);}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))return fail();
  return value as Record<string,unknown>;
}
function text(value:unknown,pattern:RegExp):string{if(typeof value!=="string"||!pattern.test(value))return fail();return value;}
function freeze<T>(value:T):T{if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function stable(value:unknown):string{
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return "["+value.map(stable).join(",")+"]";
  return "{"+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+":"+stable(v)).join(",")+"}";
}
export function folderRevalidationTreeSha256(tree:readonly FolderRevalidationTreeEntry[]):string{
  return createHash("sha256").update(stable([...tree].sort((a,b)=>a.description.node_id<b.description.node_id?-1:1))).digest("hex");
}
/** An immutable bounded preimage. All bigint/cursor values remain decimal text. */
export function parseFolderRevalidationIntent(value:unknown):FolderRevalidationIntent{
  let encoded:string;
  try{encoded=JSON.stringify(value);}catch{return fail();}
  if(!encoded||Buffer.byteLength(encoded)>4*1024*1024)return fail();
  const v=object(JSON.parse(encoded),["schema","operationId","idempotencyKey","binding","guardRevision","backendIdentity","deviceId","expectedSeq","observedAt","expiresAt","custody","tree","folders"]);
  if(v["schema"]!=="saturn.catalog-folder-revalidation-intent.v1")return fail();
  for(const key of ["operationId","guardRevision","deviceId"])text(v[key],UUID);
  text(v["backendIdentity"],ID);
  if(v["idempotencyKey"]!=="folder-revalidate-"+String(v["operationId"]))return fail();
  const seq=text(v["expectedSeq"],/^(0|[1-9]\d{0,18})$/);if(BigInt(seq)>MAX)return fail();
  const b=object(v["binding"],["protocol","descriptor_schema","server_identity","root_id","server_epoch","policy_version","binding_version"]);
  if(b["protocol"]!=="neptune-sync/1"||b["descriptor_schema"]!=="saturn.current-namespace.v1")return fail();
  for(const key of ["root_id","server_epoch","binding_version"])text(b[key],UUID);
  for(const key of ["server_identity","policy_version"])text(b[key],ID);
  for(const key of ["observedAt","expiresAt"]){const time=text(v[key],/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);if(!Number.isFinite(Date.parse(time))||new Date(time).toISOString()!==time)return fail();}
  const observed=Date.parse(String(v["observedAt"])),expires=Date.parse(String(v["expiresAt"]));if(expires<=observed||expires-observed>30000)return fail();
  const custody=object(v["custody"],["backendGeneration","bootstrapSha256","drainSha256","backupSha256","treeSha256"]);
  text(custody["backendGeneration"],UUID);for(const key of ["bootstrapSha256","drainSha256","backupSha256","treeSha256"])text(custody[key],SHA);
  if(!Array.isArray(v["tree"])||v["tree"].length<1||v["tree"].length>1024||!Array.isArray(v["folders"])||v["folders"].length<1||v["folders"].length>1024)return fail();
  const nodes=new Map<string,FolderRevalidationTreeEntry>();
  for(const item of v["tree"]){
    const e=object(item,["description","storagePath"]),d=object(e["description"],["node_id","parent_id","name","type","size_bytes","content_sha256","content_version_id","version","availability"]);
    try{validateNamespaceDescriptor(d as unknown as NamespaceDescriptor);}catch{return fail();}
    const storagePath=e["storagePath"];
    // eslint-disable-next-line no-control-regex -- Physical paths must reject every control byte.
    if(typeof storagePath!=="string"||Buffer.byteLength(storagePath)>4096||storagePath.split("/").some(p=>!p||p==="."||p==="..")||/[\\\u0000-\u001f\u007f]/u.test(storagePath))return fail();
    const entry=e as unknown as FolderRevalidationTreeEntry;if(nodes.has(entry.description.node_id))return fail();nodes.set(entry.description.node_id,entry);
  }
  const root=nodes.get(String(b["root_id"]));if(!root||root.description.type!=="folder"||root.description.parent_id!==null)return fail();
  for(const e of nodes.values()){
    let current=e;const seen=new Set<string>();
    while(current!==root){
      if(seen.has(current.description.node_id)||seen.size>=128)return fail();seen.add(current.description.node_id);
      const parent=nodes.get(current.description.parent_id??"");
      if(!parent||parent.description.type!=="folder"||current.storagePath!==parent.storagePath+"/"+current.description.name)return fail();current=parent;
    }
  }
  const selected=new Set<string>();for(const id of v["folders"]){text(id,UUID);const e=nodes.get(String(id));if(selected.has(String(id))||e?.description.type!=="folder"||e.description.availability!=="UNKNOWN")return fail();selected.add(String(id));}
  for(const e of nodes.values())if(!selected.has(e.description.node_id)&&e.description.availability!=="AVAILABLE")return fail();
  if(custody["treeSha256"]!==folderRevalidationTreeSha256([...nodes.values()]))return fail();
  return freeze(v as unknown as FolderRevalidationIntent);
}

/** Trusted offline composition supplies this lease after independently proving
 * bootstrap ownership, writer drain, coherent backup and complete physical tree.
 * It holds no-follow ancestry/file handles until close. No stat-only fallback. */
export interface FolderRevalidationBackendLease {
  readonly custody:FolderRevalidationCustody;
  assertCurrent(signal?:AbortSignal):Promise<void>;
  close():Promise<void>;
}
export interface FolderRevalidationBackendVerifier {
  acquire(intent:FolderRevalidationIntent,signal?:AbortSignal):Promise<FolderRevalidationBackendLease>;
}
export interface FolderRevalidationEvidence {readonly proof:"saturn.folder-revalidation-evidence.v1"}
export class FolderRevalidationEvidenceIssuer {
  readonly #proofs=new WeakMap<object,{intent:string;lease:FolderRevalidationBackendLease}>();
  #active=false;
  constructor(private readonly verifier:FolderRevalidationBackendVerifier){}
  async acquire(intent:FolderRevalidationIntent,signal?:AbortSignal):Promise<FolderRevalidationEvidence>{
    if(this.#active)throw new FolderRevalidationError("admission_full");this.#active=true;
    let lease:FolderRevalidationBackendLease|undefined;
    try{
      if(signal?.aborted)fail("cancelled");const parsed=parseFolderRevalidationIntent(intent);
      lease=await this.verifier.acquire(parsed,signal);
      if(stable(lease.custody)!==stable(parsed.custody))fail("custody_changed");
      await lease.assertCurrent(signal);
      if(signal?.aborted)fail("cancelled");
      const proof=Object.freeze({proof:"saturn.folder-revalidation-evidence.v1" as const});this.#proofs.set(proof,{intent:stable(parsed),lease});return proof;
    }catch(error){try{await lease?.close();}finally{this.#active=false;}throw error;}
  }
  async assertCurrent(proof:FolderRevalidationEvidence,intent:FolderRevalidationIntent,signal?:AbortSignal):Promise<void>{
    const held=this.#proofs.get(proof);if(!held||held.intent!==stable(intent))fail("authority_invalid");
    if(signal?.aborted)fail("cancelled");if(Date.now()<Date.parse(intent.observedAt)-1000||Date.now()>Date.parse(intent.expiresAt))fail("evidence_expired");
    await held.lease.assertCurrent(signal);if(signal?.aborted)fail("cancelled");
  }
  async release(proof:FolderRevalidationEvidence):Promise<void>{
    const held=this.#proofs.get(proof);if(!held)fail("authority_invalid");this.#proofs.delete(proof);
    try{await held.lease.close();}finally{this.#active=false;}
  }
}

/** Private offline operator only. The original intent must be durably persisted
 * before entry. A SQL/ACK failure preserves that intent for inspect on restart.
 * No verifier/filesystem/network callback runs inside the SQL transaction. */
export class CatalogFolderRevalidationOperator {
  #active=false;
  readonly #binding:Readonly<FolderRevalidationBinding>;
  constructor(private readonly writer:Database,private readonly authority:CatalogFolderAuthorityIssuer,
    private readonly evidence:FolderRevalidationEvidenceIssuer,binding:FolderRevalidationBinding,
    private readonly guardRevision:string,private readonly backendIdentity:string){this.#binding=freeze({...binding});}
  async #run(command:"inspect"|"commit",intent:FolderRevalidationIntent,proof:CatalogFolderAuthority,signal?:AbortSignal):Promise<FolderRevalidationOutcome|null>{
    const credential=this.authority.deviceCredential(proof,intent.binding.root_id);if(credential.deviceId!==intent.deviceId)fail("authority_invalid");
    if(signal?.aborted)fail("cancelled");
    return this.writer.transaction(async sql=>{
      await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL statement_timeout='2s'`;await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
      const row=(await sql<{value:unknown;intent_hash:string}[]>`SELECT
        public.catalog_folder_revalidation_command(${command},${JSON.stringify(intent)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb) AS value,
        public.catalog_folder_revalidation_hash(${JSON.stringify(intent)}::text::jsonb) AS intent_hash`)[0];
      if(signal?.aborted)fail("cancelled");if(!row)fail("projection_mismatch");
      const outcome=object(row.value,["replayed","result"]);if(typeof outcome["replayed"]!=="boolean")fail("projection_mismatch");
      if(outcome["result"]===null){if(command!=="inspect"||outcome["replayed"])fail("projection_mismatch");return null;}
      const r=object(outcome["result"],["schema","operationId","intentHash","rootId","status","firstSeq","lastSeq","descriptions"]);
      if(r["schema"]!=="saturn.catalog-folder-revalidation-result.v1"||r["status"]!=="REVALIDATED"||r["operationId"]!==intent.operationId||r["rootId"]!==intent.binding.root_id
        ||r["intentHash"]!==row.intent_hash||!SHA.test(row.intent_hash)||r["firstSeq"]!==(BigInt(intent.expectedSeq)+1n).toString()||r["lastSeq"]!==(BigInt(intent.expectedSeq)+BigInt(intent.folders.length)).toString()
        ||!Array.isArray(r["descriptions"])||r["descriptions"].length!==intent.folders.length)fail("projection_mismatch");
      const seen=new Set<string>();
      for(const value of r["descriptions"]){
        const d=object(value,["node_id","parent_id","name","type","size_bytes","content_sha256","content_version_id","version","availability"]) as unknown as NamespaceDescriptor;
        validateNamespaceDescriptor(d);const old=intent.tree.find(e=>e.description.node_id===d.node_id)?.description;
        if(!old||seen.has(d.node_id)||!intent.folders.includes(d.node_id)||d.availability!=="AVAILABLE"||d.version===old.version
          ||stable({...d,version:old.version,availability:old.availability})!==stable(old))fail("projection_mismatch");seen.add(d.node_id);
      }
      return freeze(outcome as unknown as FolderRevalidationOutcome);
    });
  }
  async reconcile(original:FolderRevalidationIntent,authority:CatalogFolderAuthority,signal?:AbortSignal):Promise<FolderRevalidationOutcome>{
    if(this.#active)fail("admission_full");this.#active=true;
    try{
      const intent=parseFolderRevalidationIntent(original);
      if(stable(intent.binding)!==stable(this.#binding)||intent.guardRevision!==this.guardRevision||intent.backendIdentity!==this.backendIdentity)fail("binding_invalid");
      const replay=await this.#run("inspect",intent,authority,signal);if(replay)return replay;
      const proof=await this.evidence.acquire(intent,signal);
      try{await this.evidence.assertCurrent(proof,intent,signal);const result=await this.#run("commit",intent,authority,signal);if(!result)fail("projection_mismatch");return result;}
      finally{await this.evidence.release(proof);}
    }finally{this.#active=false;}
  }
}
