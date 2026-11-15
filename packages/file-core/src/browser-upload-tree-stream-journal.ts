import {randomUUID} from "node:crypto";
import type {Database} from "@saturn/database";
import type {TransactionSql} from "postgres";
import type {BrowserTreeAuthorityIssuer} from "./browser-upload-tree-authority.js";
import {type BrowserTreeAuthority,type BrowserTreePrincipal} from "./browser-upload-tree-authority.js";
import type {BrowserTreeOriginalReference} from "./browser-upload-tree-executor.js";
import {validateBrowserTreeStreamChunk} from "./browser-upload-tree-stream-contract.js";
import type {BrowserTreeSpoolChunk,BrowserTreeSpoolIdentity} from "./browser-upload-tree-stream-spool.js";
import {ROOT_RESOURCE_ID} from "./models.js";

export interface BrowserTreeStreamOriginal {
 readonly reference:BrowserTreeOriginalReference;readonly operationId:string;readonly intentSha256:string;readonly sizeBytes:number;readonly sha256:string;
 readonly receivedBytes:number;readonly state:"receiving"|"sealed";readonly spoolId:string;readonly sealId:string;
 readonly sealSha256:string|null;readonly firstWriteTaskId:string;
}
export interface BrowserTreeStreamChunkReceipt extends BrowserTreeSpoolChunk {readonly state:"reserved"|"spooled";readonly confirmedOffset:number}
export interface BrowserTreeStreamProgressStatus {
 readonly schema:"saturn.browser-tree-stream-status.v1";readonly treeId:string;readonly jobId:string;readonly itemId:string;readonly intentSha256:string;
 readonly sizeBytes:number;readonly sha256:string;readonly sealId:string;readonly confirmedOffset:number;readonly state:"receiving"|"sealed";readonly sealSha256:string|null;
 readonly lastChunk:{readonly offset:number;readonly length:number;readonly sha256:string}|null;
}
interface Row {operation_id:string;intent_sha256:string;write_task_id:string;size_bytes:string;sha256:string;received_size:string;state:"receiving"|"sealed";spool_id:string;seal_id:string;seal_sha256:string|null;parent_item_id:string|null;relative_path:string;root_id:string;item_state:string}
interface ChunkRow {offset_bytes:string;length_bytes:number;sha256:string;write_task_id:string;state:"reserved"|"spooled";spool_dev:string|null;spool_ino:string|null}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,sha=/^[a-f0-9]{64}$/;
function fail(code:string):never{throw Error(code);}
function safe(value:string):number{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)return fail("browser_tree_stream_original_invalid");return n;}

/** Fixed current-authority journal for ALREADY ADMITTED stream originals.
 * No arbitrary SQL callback, public admission, backend execution, cleanup or
 * permission to release a reservation is supplied by this adapter. */
export class PostgresBrowserTreeStreamJournal {
 readonly #options:{readonly backendIdentity:string;readonly backendGeneration:string;readonly spoolId:string;readonly maximumFileBytes:number};
 constructor(private readonly database:Database,private readonly authority:BrowserTreeAuthorityIssuer,options:{readonly backendIdentity:string;readonly backendGeneration:string;readonly spoolId:string;readonly maximumFileBytes:number}){
  if(!options.backendIdentity||!uuid.test(options.backendGeneration)||!uuid.test(options.spoolId)||!Number.isSafeInteger(options.maximumFileBytes)||options.maximumFileBytes<=262144)fail("browser_tree_stream_configuration_invalid");this.#options=Object.freeze({...options});
 }
 #reference(value:BrowserTreeOriginalReference|null|undefined):BrowserTreeOriginalReference{
  if(!value||![value.treeId,value.jobId,value.itemId].every(v=>uuid.test(v)))return fail("browser_tree_identity_invalid");return Object.freeze({...value});
 }
 withOriginalLock<T>(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,action:()=>Promise<T>):Promise<T>{
  this.authority.credentialsForDatabase(proof);const ref=this.#reference(input);
  return this.database.withAdvisoryLock(`saturn-browser-stream:${ref.treeId}:${ref.itemId}`,action);
 }
 async #authorize(sql:TransactionSql,p:BrowserTreePrincipal):Promise<void>{
  if(p.kind==="drop")await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-drop-buffer-reservation',0))`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-browser-tree-admission',0))`;
  if(p.kind==="owner"){
   const session=await sql`SELECT id FROM web_sessions WHERE id=${p.sessionId} AND token_hash=${p.tokenHash} AND state='active' AND idle_expires_at>clock_timestamp() AND expires_at>clock_timestamp() FOR SHARE`;
   const owner=await sql`SELECT owner_id FROM owner_credentials WHERE owner_id='owner' AND revision::text=${p.credentialRevision} FOR SHARE`;
   if(session.length!==1||owner.length!==1)fail("browser_tree_authorization_changed");
  }else{
   const session=await sql`SELECT id FROM drop_sessions WHERE id=${p.sessionId} AND channel_id=${p.scopeId} AND token_hash=${p.tokenHash} AND state='active' AND expires_at>clock_timestamp() FOR SHARE`;
   const channel=await sql`SELECT id FROM drop_channels WHERE id=${p.scopeId} AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`;
   if(session.length!==1||channel.length!==1)fail("browser_tree_authorization_changed");
  }
 }
 async #parent(sql:TransactionSql,ref:BrowserTreeOriginalReference,row:Row):Promise<void>{
  let parentId=row.root_id;
  if(row.parent_item_id!==null){
   const parent=(await sql<{resource_id:string;relative_path:string}[]>`SELECT resource_id,relative_path FROM browser_upload_items WHERE tree_id=${ref.treeId} AND item_id=${row.parent_item_id} AND kind='directory' AND state='published'`)[0];
   if(!parent||parent.relative_path!==row.relative_path.slice(0,row.relative_path.lastIndexOf('/')))fail("browser_tree_parent_pending");parentId=parent.resource_id;
  }
  type Node={id:string;parent_id:string|null;name:string;storage_path:string;guarded:boolean};const ancestors:Node[]=[];let cursor:string|null=parentId;
  while(cursor!==null){
   if(ancestors.length>=128||ancestors.some(n=>n.id===cursor))fail("browser_tree_parent_invalid");
   const node:Node|undefined=(await sql<Node[]>`SELECT id,parent_id,name,storage_path,cardinality(public.catalog_guard_scope(id,false))<>0 AS guarded FROM resources WHERE id=${cursor} AND type='folder' AND status='active'`)[0];
   if(!node||node.guarded)fail("browser_tree_destination_unavailable");const child=ancestors.at(-1);
   if(child&&child.storage_path!==node.storage_path+(node.storage_path===""?"":"/")+child.name)fail("browser_tree_parent_invalid");ancestors.push(node);cursor=node.parent_id;
  }
  const root=ancestors.find(n=>n.id===row.root_id),top=ancestors.at(-1),parent=ancestors[0];
  if(!root||!parent||top?.id!==ROOT_RESOURCE_ID||top.storage_path!==""||parent.storage_path+(parent.storage_path===""?"":"/")+row.relative_path.slice(row.relative_path.lastIndexOf('/')+1)!==root.storage_path+(root.storage_path===""?"":"/")+row.relative_path)fail("browser_tree_parent_invalid");
 }
 async #original(sql:TransactionSql,p:BrowserTreePrincipal,ref:BrowserTreeOriginalReference,mutation:boolean):Promise<BrowserTreeStreamOriginal>{
  await this.#authorize(sql,p);
  const tree=(await sql<{backend_identity:string;backend_generation:string}[]>`SELECT backend_identity,backend_generation FROM browser_upload_trees WHERE id=${ref.treeId} AND principal_kind=${p.kind} AND scope_id=${p.scopeId} AND root_id=${p.rootId} FOR UPDATE`)[0];
  if(!tree)fail("browser_tree_not_found");if(mutation&&(tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration))fail("browser_tree_binding_changed");
  const row=(await sql<Row[]>`SELECT i.operation_id,j.intent_sha256,i.write_task_id,i.size_bytes::text,i.sha256,i.parent_item_id,i.relative_path,i.state AS item_state,t.root_id,s.received_size::text,s.state,s.spool_id,s.seal_id,s.seal_sha256
   FROM browser_upload_streams s JOIN browser_upload_items i ON i.tree_id=s.tree_id AND i.item_id=s.item_id JOIN browser_upload_trees t ON t.id=i.tree_id JOIN browser_upload_jobs j ON j.tree_id=i.tree_id AND j.id=i.job_id
   WHERE i.tree_id=${ref.treeId} AND i.job_id=${ref.jobId} AND i.item_id=${ref.itemId} AND i.payload_mode='stream' AND j.payload_mode='stream' AND i.kind='file' AND i.size_bytes=s.expected_size AND i.sha256=s.expected_sha256 FOR UPDATE OF s,i`)[0];
  if(!row)fail("browser_tree_stream_not_found");if(mutation&&row.spool_id!==this.#options.spoolId)fail("browser_tree_spool_binding_changed");
  if(mutation){
   const backend=await sql`SELECT backend_identity FROM sync_backend_executor WHERE backend_identity=${tree.backend_identity} AND generation=${tree.backend_generation} AND state='RUNNING'`;
   if(backend.length!==1)fail("browser_tree_backend_unavailable");
   if(row.item_state!=="reserved")fail("browser_tree_reconciliation_required");await this.#parent(sql,ref,row);
   const preference=(await sql<{maximum_upload_file_gib:number}[]>`SELECT maximum_upload_file_gib FROM owner_preferences WHERE owner_id='owner' FOR SHARE`)[0];
   const current=preference?preference.maximum_upload_file_gib*1024**3:this.#options.maximumFileBytes;
   if(!Number.isSafeInteger(current)||current<1||safe(row.size_bytes)>Math.min(current,this.#options.maximumFileBytes))fail("browser_tree_file_too_large");
   if(p.kind==="drop"){
    const mapping=await sql`SELECT id FROM drop_uploads WHERE id=${row.operation_id} AND channel_id=${p.scopeId} AND browser_tree_managed AND state='reserved' AND expected_size=${row.size_bytes}::bigint AND expected_sha256=${row.sha256} AND local_path IS NULL AND continuation_until>clock_timestamp()`;
    if(mapping.length!==1)fail("browser_tree_drop_original_changed");
   }
  }
  return Object.freeze({reference:ref,operationId:row.operation_id,intentSha256:row.intent_sha256,sizeBytes:safe(row.size_bytes),sha256:row.sha256,receivedBytes:safe(row.received_size),state:row.state,spoolId:row.spool_id,sealId:row.seal_id,sealSha256:row.seal_sha256,firstWriteTaskId:row.write_task_id});
 }
 #chunk(original:BrowserTreeStreamOriginal,row:ChunkRow):BrowserTreeStreamChunkReceipt{
  return Object.freeze({spoolId:original.spoolId,operationId:original.operationId,writeTaskId:row.write_task_id,offset:safe(row.offset_bytes),length:row.length_bytes,sha256:row.sha256,state:row.state,confirmedOffset:original.receivedBytes,
   identity:row.spool_dev===null||row.spool_ino===null?null:Object.freeze({dev:row.spool_dev,ino:row.spool_ino})});
 }
 async inspect(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference):Promise<BrowserTreeStreamOriginal>{
  const p=this.authority.credentialsForDatabase(proof),ref=this.#reference(input);return this.database.transaction(sql=>this.#original(sql,p,ref,false));
 }
 /** Current authenticated client projection; no spool paths/inodes/backend
  * task IDs, no fresh effect and no claim of final backend publication. */
 async inspectProgress(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference):Promise<BrowserTreeStreamProgressStatus>{
  const p=this.authority.credentialsForDatabase(proof),ref=this.#reference(input);
  return this.database.transaction(async sql=>{
   const original=await this.#original(sql,p,ref,false);let lastChunk:BrowserTreeStreamProgressStatus["lastChunk"]=null;
   if(original.receivedBytes>0){
    const row=(await sql<{offset_bytes:string;length_bytes:number;sha256:string}[]>`SELECT offset_bytes::text,length_bytes,sha256 FROM browser_upload_stream_chunks WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND state='spooled' AND offset_bytes+length_bytes=${original.receivedBytes} LIMIT 1`)[0];
    if(!row)fail("browser_tree_stream_original_invalid");lastChunk=Object.freeze({offset:safe(row.offset_bytes),length:row.length_bytes,sha256:row.sha256});validateBrowserTreeStreamChunk(original.sizeBytes,lastChunk.offset,lastChunk.length);
   }
   return Object.freeze({schema:"saturn.browser-tree-stream-status.v1",treeId:ref.treeId,jobId:ref.jobId,itemId:ref.itemId,intentSha256:original.intentSha256,sizeBytes:original.sizeBytes,sha256:original.sha256,
    sealId:original.sealId,confirmedOffset:original.receivedBytes,state:original.state,sealSha256:original.sealSha256,lastChunk});
  });
 }
 async reserveChunk(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,value:{readonly offset:number;readonly length:number;readonly sha256:string}):Promise<BrowserTreeStreamChunkReceipt>{
  const p=this.authority.credentialsForDatabase(proof),ref=this.#reference(input),intent=Object.freeze({...value});if(!sha.test(intent.sha256))fail("browser_tree_stream_chunk_invalid");
  return this.database.transaction(async sql=>{
   const original=await this.#original(sql,p,ref,true);validateBrowserTreeStreamChunk(original.sizeBytes,intent.offset,intent.length);
   const previous=(await sql<ChunkRow[]>`SELECT offset_bytes::text,length_bytes,sha256,write_task_id,state,spool_dev,spool_ino FROM browser_upload_stream_chunks WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND offset_bytes=${intent.offset} FOR UPDATE`)[0];
   if(previous){if(previous.length_bytes!==intent.length||previous.sha256!==intent.sha256)fail("browser_tree_stream_chunk_reused");return this.#chunk(original,previous);}
   if(original.state!=="receiving"||intent.offset!==original.receivedBytes)fail("browser_tree_stream_offset_invalid");
   const task=intent.offset===0?original.firstWriteTaskId:randomUUID();
   await sql`INSERT INTO browser_upload_stream_chunks(tree_id,item_id,offset_bytes,length_bytes,sha256,write_task_id) VALUES(${ref.treeId},${ref.itemId},${intent.offset},${intent.length},${intent.sha256},${task})`;
   return this.#chunk(original,{offset_bytes:String(intent.offset),length_bytes:intent.length,sha256:intent.sha256,write_task_id:task,state:"reserved",spool_dev:null,spool_ino:null});
  });
 }
 async bindChunk(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,taskId:string,identity:BrowserTreeSpoolIdentity):Promise<void>{
  const p=this.authority.credentialsForDatabase(proof),ref=this.#reference(input),bound=Object.freeze({...identity});if(!uuid.test(taskId)||!/^\d+$/.test(bound.dev)||!/^\d+$/.test(bound.ino))fail("browser_tree_stream_chunk_invalid");
  await this.database.transaction(async sql=>{
   await this.#original(sql,p,ref,true);
   const rows=await sql`UPDATE browser_upload_stream_chunks SET spool_dev=${bound.dev},spool_ino=${bound.ino},updated_at=clock_timestamp()
    WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND write_task_id=${taskId} AND((spool_dev IS NULL AND spool_ino IS NULL) OR(spool_dev=${bound.dev} AND spool_ino=${bound.ino})) RETURNING write_task_id`;
   if(rows.length!==1)fail("browser_tree_spool_identity_changed");
  });
 }
 async recordChunk(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,taskId:string,evidence:{readonly identity:BrowserTreeSpoolIdentity;readonly bytes:number;readonly sha256:string}):Promise<BrowserTreeStreamOriginal>{
  const p=this.authority.credentialsForDatabase(proof),ref=this.#reference(input),receipt=Object.freeze({...evidence,identity:Object.freeze({...evidence.identity})});if(!uuid.test(taskId)||!Number.isSafeInteger(receipt.bytes)||!sha.test(receipt.sha256))fail("browser_tree_stream_receipt_invalid");
  return this.database.transaction(async sql=>{
   const original=await this.#original(sql,p,ref,true),chunk=(await sql<ChunkRow[]>`SELECT offset_bytes::text,length_bytes,sha256,write_task_id,state,spool_dev,spool_ino FROM browser_upload_stream_chunks WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND write_task_id=${taskId} FOR UPDATE`)[0];
   if(!chunk||chunk.length_bytes!==receipt.bytes||chunk.sha256!==receipt.sha256||chunk.spool_dev!==receipt.identity.dev||chunk.spool_ino!==receipt.identity.ino)fail("browser_tree_stream_receipt_invalid");
   if(chunk.state==="spooled"){if(original.receivedBytes<safe(chunk.offset_bytes)+chunk.length_bytes)fail("browser_tree_stream_original_invalid");return original;}
   if(original.state!=="receiving"||original.receivedBytes!==safe(chunk.offset_bytes))fail("browser_tree_stream_offset_invalid");
   await sql`UPDATE browser_upload_stream_chunks SET state='spooled',receipt_tx=pg_current_xact_id(),spooled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND write_task_id=${taskId}`;
   const received=original.receivedBytes+chunk.length_bytes;
   await sql`UPDATE browser_upload_streams SET received_size=${received},updated_at=clock_timestamp() WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId}`;
   return Object.freeze({...original,receivedBytes:received});
  });
 }
 async inspectChunk(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,offset:number):Promise<BrowserTreeStreamChunkReceipt>{
  const p=this.authority.credentialsForDatabase(proof),ref=this.#reference(input);if(!Number.isSafeInteger(offset)||offset<0)fail("browser_tree_stream_offset_invalid");
  return this.database.transaction(async sql=>{
   const original=await this.#original(sql,p,ref,true),row=(await sql<ChunkRow[]>`SELECT offset_bytes::text,length_bytes,sha256,write_task_id,state,spool_dev,spool_ino FROM browser_upload_stream_chunks WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND offset_bytes=${offset}`)[0];
   if(!row||row.state!=="spooled")fail("browser_tree_stream_chunk_unconfirmed");return this.#chunk(original,row);
  });
 }
 async recordSeal(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,evidence:{readonly sealId:string;readonly bytes:number;readonly sha256:string}):Promise<BrowserTreeStreamOriginal>{
  const p=this.authority.credentialsForDatabase(proof),ref=this.#reference(input),receipt=Object.freeze({...evidence});
  return this.database.transaction(async sql=>{
   const original=await this.#original(sql,p,ref,true);
   if(original.sealId!==receipt.sealId||original.sizeBytes!==receipt.bytes||original.sha256!==receipt.sha256||original.receivedBytes!==original.sizeBytes)fail("browser_tree_stream_seal_invalid");
   if(original.state==="sealed")return original;
   await sql`UPDATE browser_upload_streams SET state='sealed',seal_sha256=${receipt.sha256},sealed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId}`;
   return Object.freeze({...original,state:"sealed",sealSha256:receipt.sha256});
  });
 }
}
