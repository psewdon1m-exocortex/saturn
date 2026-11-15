import { requiredValue } from "./required-value.js";
import {createHash,randomUUID} from "node:crypto";
import type {Database} from "@saturn/database";
import type {TransactionSql} from "postgres";
import type {BrowserTreeAuthorityIssuer} from "./browser-upload-tree-authority.js";
import {type BrowserTreeAuthority,type BrowserTreePrincipal} from "./browser-upload-tree-authority.js";
import {validateBrowserTreeJob,type ValidatedBrowserTreeJob} from "./browser-upload-tree-contract.js";
import {ROOT_RESOURCE_ID} from "./models.js";
import {SATURN_SYSTEM_DIRECTORIES,SATURN_BUSINESS_ROOT_DIRECTORIES,SATURN_LAYOUT_V2_ROOT_DIRECTORIES} from "@saturn/storage";
import {assertBrowserNamespaceCatalogPermit} from "./browser-upload-namespace-context.js";
import type {BrowserTreeOriginalReference,BrowserTreeReceipt} from "./browser-upload-tree-executor.js";

export class BrowserTreeDatabaseError extends Error {constructor(readonly code:string){super(code);this.name="BrowserTreeDatabaseError";}}
export interface BrowserTreeDatabaseOptions {
 readonly backendIdentity:string;readonly backendGeneration:string;
 readonly maximumFileBytes:number;readonly dropGlobalBytes:number;readonly continuationTtlMs:number;
}
export interface BrowserTreeJobStatus {
 readonly treeId:string;readonly jobId:string;readonly intentSha256:string;readonly state:string;
 readonly items:readonly {readonly itemId:string;readonly parentItemId:string|null;readonly relativePath:string;readonly kind:"directory"|"file";readonly state:string;readonly receipt:unknown}[];
}
interface TreeRow {id:string;principal_kind:"owner"|"drop";scope_id:string;root_id:string;backend_identity:string;backend_generation:string;item_count:number;directory_count:number}
interface JobRow {id:string;intent_sha256:string;state:string}
interface ItemRow {item_id:string;parent_item_id:string|null;relative_path:string;kind:"directory"|"file";state:string;receipt:unknown}
interface DirectoryRow extends ItemRow {operation_id:string;resource_id:string;publish_task_id:string}
export interface BrowserTreeDirectoryOriginal {
 readonly reference:BrowserTreeOriginalReference;readonly operationId:string;readonly resourceId:string;readonly publishTaskId:string;
 readonly parentId:string;readonly name:string;readonly destinationPath:string;readonly state:string;readonly receipt:BrowserTreeReceipt|null;
}
interface FileRow extends DirectoryRow {version_id:string;write_task_id:string;staging_path:string;size_bytes:number;sha256:string;content:Buffer|null}
export interface BrowserTreeFileOriginal extends BrowserTreeDirectoryOriginal {
 readonly versionId:string;readonly writeTaskId:string;readonly stagingPath:string;readonly sizeBytes:number;readonly sha256:string;readonly content:Buffer|null;
}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function refused(code:string):never{throw new BrowserTreeDatabaseError(code);}

/** Fixed admission/status/pre-effect cancellation adapter. No physical effects,
 * namespace permits or capability are supplied by this class. Execute/publish
 * must revalidate current authority and use the qualified namespace boundary. */
export class PostgresBrowserTreeDatabase {
 readonly #options:BrowserTreeDatabaseOptions;
 constructor(private readonly database:Database,private readonly authority:BrowserTreeAuthorityIssuer,options:BrowserTreeDatabaseOptions){
  if(!options.backendIdentity||options.backendIdentity.length>128||!uuid.test(options.backendGeneration)
    ||[options.maximumFileBytes,options.dropGlobalBytes,options.continuationTtlMs].some(n=>!Number.isSafeInteger(n)||n<1))refused("browser_tree_configuration_invalid");
  this.#options=Object.freeze({...options});
 }
 async #authorize(sql:TransactionSql,p:BrowserTreePrincipal):Promise<void>{
  if(p.kind==="owner"){
   const sessions=await sql`SELECT id FROM web_sessions WHERE id=${p.sessionId} AND token_hash=${p.tokenHash} AND state='active' AND idle_expires_at>clock_timestamp() AND expires_at>clock_timestamp() FOR SHARE`;
   const credentials=await sql`SELECT owner_id FROM owner_credentials WHERE owner_id='owner' AND revision::text=${p.credentialRevision} FOR SHARE`;
   if(sessions.length!==1||credentials.length!==1)refused("browser_tree_authorization_changed");
  }else{
   const sessions=await sql`SELECT id FROM drop_sessions WHERE id=${p.sessionId} AND channel_id=${p.scopeId} AND token_hash=${p.tokenHash} AND state='active' AND expires_at>clock_timestamp() FOR SHARE`;
   const channels=await sql`SELECT id FROM drop_channels WHERE id=${p.scopeId} AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`;
   if(sessions.length!==1||channels.length!==1)refused("browser_tree_authorization_changed");
  }
 }
 async #tree(sql:TransactionSql,p:BrowserTreePrincipal,treeId:string,create:boolean):Promise<TreeRow>{
  if(create)await sql`INSERT INTO browser_upload_trees(id,principal_kind,scope_id,root_id,backend_identity,backend_generation)
   VALUES(${treeId},${p.kind},${p.scopeId},${p.rootId},${this.#options.backendIdentity},${this.#options.backendGeneration}) ON CONFLICT(id) DO NOTHING`;
  const tree=(await sql<TreeRow[]>`SELECT * FROM browser_upload_trees WHERE id=${treeId} FOR UPDATE`)[0];
  if(!tree||tree.principal_kind!==p.kind||tree.scope_id!==p.scopeId||tree.root_id!==p.rootId)refused("browser_tree_not_found");
  return tree;
 }
 async #status(sql:TransactionSql,treeId:string,job:JobRow):Promise<BrowserTreeJobStatus>{
  const items=await sql<ItemRow[]>`SELECT item_id,parent_item_id,relative_path,kind,state,receipt FROM browser_upload_items WHERE tree_id=${treeId} AND job_id=${job.id} ORDER BY relative_path COLLATE "C" LIMIT 17`;
  if(items.length<1||items.length>16)refused("browser_tree_original_invalid");
  return Object.freeze({treeId,jobId:job.id,intentSha256:job.intent_sha256,state:job.state,items:Object.freeze(items.map(i=>Object.freeze({itemId:i.item_id,parentItemId:i.parent_item_id,relativePath:i.relative_path,kind:i.kind,state:i.state,receipt:i.receipt})))});
 }
 async #locks(sql:TransactionSql,p:BrowserTreePrincipal):Promise<void>{
  // Match the existing buffered Drop reservation lock BEFORE session/channel.
  if(p.kind==="drop")await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-drop-buffer-reservation',0))`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-browser-tree-admission',0))`;
 }
 async admit(proof:BrowserTreeAuthority,treeId:string,body:unknown):Promise<BrowserTreeJobStatus>{
  const p=this.authority.credentialsForDatabase(proof);if(!uuid.test(treeId))refused("browser_tree_identity_invalid");
  // Validate EVERY payload, including the final member, before any SQL effect.
  const job=validateBrowserTreeJob(body);
  if(job.value.items.some(item=>item.kind==="file"&&item.sizeBytes>this.#options.maximumFileBytes))refused("browser_tree_file_too_large");
  return this.database.transaction(async sql=>{
   await this.#locks(sql,p);await this.#authorize(sql,p);
   const tree=await this.#tree(sql,p,treeId,true);
   const existing=(await sql<JobRow[]>`SELECT id,intent_sha256,state FROM browser_upload_jobs WHERE tree_id=${treeId} AND id=${job.value.jobId}`)[0];
   if(existing){if(existing.intent_sha256!==job.intentSha256)refused("browser_tree_original_reused");return this.#status(sql,treeId,existing);}
   await this.#validateAdmission(sql,p,tree,job);
   const records=job.value.items.map(item=>{const operationId=randomUUID();return {itemId:item.itemId,parentItemId:item.parentItemId,relativePath:item.relativePath,pathKey:item.relativePath.toLowerCase(),kind:item.kind,
    operationId,resourceId:randomUUID(),versionId:item.kind==="file"?randomUUID():null,writeTaskId:item.kind==="file"?randomUUID():null,publishTaskId:randomUUID(),
    stagingPath:item.kind==="file"?`_system/incoming/${operationId}.part`:null,sizeBytes:item.kind==="file"?item.sizeBytes:0,sha256:item.kind==="file"?item.sha256:null,
    contentBase64:item.kind==="file"?item.contentBase64:null,dropUploadId:p.kind==="drop"&&item.kind==="file"?operationId:null,
    clientKeyHash:createHash("sha256").update(`saturn-browser-tree:${treeId}:${item.itemId}`).digest("hex"),name:requiredValue(item.relativePath.split("/").at(-1))};});
   await sql`INSERT INTO browser_upload_jobs(tree_id,id,intent_sha256,admitted_session_id,admitted_credential_revision,state,item_count,payload_bytes) VALUES(${treeId},${job.value.jobId},${job.intentSha256},${p.sessionId},${p.kind==="owner"?p.credentialRevision:null},'accepted',${records.length},${job.payloadBytes})`;
   if(p.kind==="drop"){
    await sql`INSERT INTO drop_uploads(id,session_id,channel_id,client_key_hash,filename,expected_size,expected_sha256,state,created_at,updated_at,continuation_until,browser_tree_managed)
     SELECT x."operationId",${p.sessionId}::uuid,${p.scopeId}::uuid,x."clientKeyHash",x.name,x."sizeBytes",x.sha256,'reserved',clock_timestamp(),clock_timestamp(),clock_timestamp()+${this.#options.continuationTtlMs}*interval '1 millisecond',true
     FROM jsonb_to_recordset(${sql.json(records)}) AS x("operationId" uuid,"clientKeyHash" text,name text,"sizeBytes" integer,sha256 text,kind text) WHERE x.kind='file'`;
    await sql`UPDATE drop_channels SET reserved_files=reserved_files+${job.files},reserved_bytes=reserved_bytes+${job.payloadBytes} WHERE id=${p.scopeId}`;
    await sql`UPDATE drop_sessions s SET reserved_files=c.reserved_files,reserved_bytes=c.reserved_bytes FROM drop_channels c WHERE c.id=${p.scopeId} AND s.channel_id=c.id`;
   }
   await sql`INSERT INTO browser_upload_items(tree_id,job_id,item_id,parent_item_id,relative_path,path_key,kind,operation_id,resource_id,version_id,write_task_id,publish_task_id,staging_path,size_bytes,sha256,content,state,drop_upload_id)
    SELECT ${treeId}::uuid,${job.value.jobId}::uuid,x."itemId",x."parentItemId",x."relativePath",x."pathKey",x.kind,x."operationId",x."resourceId",x."versionId",x."writeTaskId",x."publishTaskId",x."stagingPath",x."sizeBytes",x.sha256,decode(x."contentBase64",'base64'),'reserved',x."dropUploadId"
    FROM jsonb_to_recordset(${sql.json(records)}) AS x("itemId" uuid,"parentItemId" uuid,"relativePath" text,"pathKey" text,kind text,"operationId" uuid,"resourceId" uuid,"versionId" uuid,"writeTaskId" uuid,"publishTaskId" uuid,"stagingPath" text,"sizeBytes" integer,sha256 text,"contentBase64" text,"dropUploadId" uuid)`;
   await sql`UPDATE browser_upload_trees SET item_count=item_count+${records.length},directory_count=directory_count+${job.directories} WHERE id=${treeId}`;
   return this.#status(sql,treeId,{id:job.value.jobId,intent_sha256:job.intentSha256,state:"accepted"});
  });
 }
 async #validateAdmission(sql:TransactionSql,p:BrowserTreePrincipal,tree:TreeRow,job:ValidatedBrowserTreeJob):Promise<void>{
  if(tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration)refused("browser_tree_binding_changed");
  // Owner limits can change without restarting the API. Take the current row
  // in the reservation transaction; constructor bounds remain an upper cap.
  const preference=(await sql<{upload_buffer_gib:number;maximum_upload_file_gib:number}[]>`SELECT upload_buffer_gib,maximum_upload_file_gib FROM owner_preferences WHERE owner_id='owner' FOR SHARE`)[0];
  let dropGlobalBytes=this.#options.dropGlobalBytes,maximumFileBytes=this.#options.maximumFileBytes;
  if(preference){
   const buffer=preference.upload_buffer_gib*1024**3,maximum=preference.maximum_upload_file_gib*1024**3;
   if(!Number.isSafeInteger(buffer)||buffer<1||!Number.isSafeInteger(maximum)||maximum<1||maximum*10>buffer*9)refused("browser_tree_configuration_invalid");
   dropGlobalBytes=Math.min(dropGlobalBytes,buffer);maximumFileBytes=Math.min(maximumFileBytes,maximum);
  }
  if(job.value.items.some(item=>item.kind==='file'&&item.sizeBytes>maximumFileBytes))refused("browser_tree_file_too_large");
  const backend=await sql`SELECT backend_identity FROM sync_backend_executor WHERE backend_identity=${tree.backend_identity} AND generation=${tree.backend_generation} AND state='RUNNING'`;
  const roots=await sql<{storage_path:string;guarded:boolean}[]>`SELECT storage_path,cardinality(public.catalog_guard_scope(id,false))<>0 AS guarded FROM resources WHERE id=${tree.root_id} AND type='folder' AND status='active'`;
  if(backend.length!==1)refused("browser_tree_backend_unavailable");
  if(roots.length!==1||requiredValue(roots[0]).guarded)refused("browser_tree_destination_unavailable");
  if(tree.root_id===ROOT_RESOURCE_ID&&job.value.items.some(item=>item.parentItemId===null&&item.kind==="file"))refused("browser_tree_root_files_forbidden");
  const protectedNames=new Set<string>([...SATURN_SYSTEM_DIRECTORIES,...SATURN_BUSINESS_ROOT_DIRECTORIES,...SATURN_LAYOUT_V2_ROOT_DIRECTORIES].map(name=>name.toLowerCase()));
  if(tree.root_id===ROOT_RESOURCE_ID&&job.value.items.some(item=>item.parentItemId===null&&protectedNames.has(item.relativePath.toLowerCase())))refused("browser_tree_reserved_root");
  if(tree.item_count+job.value.items.length>20000||tree.directory_count+job.directories>10000)refused("browser_tree_capacity");
  const totals=requiredValue((await sql<{jobs:number;bytes:string;scoped:number}[]>`SELECT count(*)::int AS jobs,coalesce(sum(j.payload_bytes),0)::text AS bytes,
   count(*) FILTER(WHERE t.principal_kind=${p.kind} AND t.scope_id=${p.scopeId})::int AS scoped FROM browser_upload_jobs j JOIN browser_upload_trees t ON t.id=j.tree_id WHERE j.state NOT IN ('completed','cancelled')`)[0]);
  if(totals.jobs>=128||totals.scoped>=2||BigInt(totals.bytes)+BigInt(job.payloadBytes)>67108864n)refused("browser_tree_capacity");
  const known=new Map(job.value.items.map(item=>[item.itemId,item]));
  const external=job.value.items.flatMap(item=>item.parentItemId!==null&&!known.has(item.parentItemId)?[item.parentItemId]:[]);
  if(external.length){const parents=await sql<{item_id:string;relative_path:string;kind:string;state:string}[]>`SELECT item_id,relative_path,kind,state FROM browser_upload_items WHERE tree_id=${tree.id} AND item_id=ANY(${external}::uuid[])`;
   for(const item of job.value.items)if(item.parentItemId!==null&&!known.has(item.parentItemId)){const parent=parents.find(row=>row.item_id===item.parentItemId);if(!parent||parent.kind!=="directory"||parent.state==="cancelled"||item.relativePath.slice(0,item.relativePath.lastIndexOf("/"))!==parent.relative_path)refused("browser_tree_parent_invalid");}}
  const reused=await sql`SELECT item_id FROM browser_upload_items WHERE tree_id=${tree.id} AND (item_id=ANY(${job.value.items.map(i=>i.itemId)}::uuid[]) OR path_key=ANY(${job.value.items.map(i=>i.relativePath.toLowerCase())}::text[])) LIMIT 1`;
  if(reused.length)refused("browser_tree_item_reused");
  if(p.kind==="drop"){
   const channel=requiredValue((await sql<{reserved_files:number;reserved_bytes:string;max_files:number;max_bytes:string}[]>`SELECT reserved_files,reserved_bytes::text,max_files,max_bytes::text FROM drop_channels WHERE id=${p.scopeId}`)[0]);
   const bytes=requiredValue((await sql<{bytes:string}[]>`SELECT coalesce(sum(expected_size),0)::text AS bytes FROM drop_uploads WHERE local_path IS NOT NULL OR state='reserved'`)[0]).bytes;
   const directories=requiredValue((await sql<{n:string}[]>`SELECT coalesce(sum(directory_count),0)::text AS n FROM browser_upload_trees WHERE principal_kind='drop' AND scope_id=${p.scopeId}`)[0]).n;
   if(channel.reserved_files+job.files>channel.max_files||BigInt(channel.reserved_bytes)+BigInt(job.payloadBytes)>BigInt(channel.max_bytes)
    ||BigInt(bytes)+BigInt(job.payloadBytes)>BigInt(dropGlobalBytes)||BigInt(directories)+BigInt(job.directories)>10000n)refused("browser_tree_quota_exhausted");
  }
 }
 async inspect(proof:BrowserTreeAuthority,treeId:string,jobId:string):Promise<BrowserTreeJobStatus>{
  const p=this.authority.credentialsForDatabase(proof);if(!uuid.test(treeId)||!uuid.test(jobId))refused("browser_tree_identity_invalid");
  return this.database.transaction(async sql=>{await this.#locks(sql,p);await this.#authorize(sql,p);await this.#tree(sql,p,treeId,false);
   const job=(await sql<JobRow[]>`SELECT id,intent_sha256,state FROM browser_upload_jobs WHERE tree_id=${treeId} AND id=${jobId}`)[0];if(!job)refused("browser_tree_not_found");return this.#status(sql,treeId,job);});
 }
 async cancelBeforeExecution(proof:BrowserTreeAuthority,treeId:string,jobId:string):Promise<BrowserTreeJobStatus>{
  const p=this.authority.credentialsForDatabase(proof);if(!uuid.test(treeId)||!uuid.test(jobId))refused("browser_tree_identity_invalid");
  return this.database.transaction(async sql=>{await this.#locks(sql,p);await this.#authorize(sql,p);await this.#tree(sql,p,treeId,false);
   const job=(await sql<(JobRow&{payload_mode:string})[]>`SELECT id,intent_sha256,state,coalesce(to_jsonb(j)->>'payload_mode','inline') AS payload_mode FROM browser_upload_jobs j WHERE tree_id=${treeId} AND id=${jobId} FOR UPDATE`)[0];if(!job)refused("browser_tree_not_found");
   if(job.state==="completed"||job.state==="cancelled")return this.#status(sql,treeId,job);
   if(job.payload_mode!=="inline")refused("browser_tree_stream_route_required");
   const items=await sql<{state:string;kind:string;size_bytes:number;drop_upload_id:string|null}[]>`SELECT state,kind,size_bytes::float8 AS size_bytes,drop_upload_id FROM browser_upload_items WHERE tree_id=${treeId} AND job_id=${jobId} FOR UPDATE`;
   if(job.state!=="accepted"||items.some(item=>item.state!=="reserved"))refused("browser_tree_reconciliation_required");
   const dependent=await sql`SELECT item_id FROM browser_upload_items WHERE tree_id=${treeId} AND job_id<>${jobId} AND state<>'cancelled' AND parent_item_id IN(SELECT item_id FROM browser_upload_items WHERE tree_id=${treeId} AND job_id=${jobId}) LIMIT 1`;
   if(dependent.length)refused("browser_tree_children_pending");
   await sql`UPDATE browser_upload_items SET state='cancelled',content=NULL,drop_mutation_tx=pg_current_xact_id(),updated_at=clock_timestamp() WHERE tree_id=${treeId} AND job_id=${jobId}`;
   if(p.kind==="drop"){
    const files=items.filter(item=>item.kind==="file"),bytes=files.reduce((sum,item)=>sum+item.size_bytes,0);
    await sql`UPDATE drop_uploads SET state='cancelled',updated_at=clock_timestamp() WHERE id=ANY(${files.map(item=>requiredValue(item.drop_upload_id))}::uuid[]) AND state='reserved'`;
    await sql`UPDATE drop_channels SET reserved_files=reserved_files-${files.length},reserved_bytes=reserved_bytes-${bytes} WHERE id=${p.scopeId}`;
    await sql`UPDATE drop_sessions s SET reserved_files=c.reserved_files,reserved_bytes=c.reserved_bytes FROM drop_channels c WHERE c.id=${p.scopeId} AND s.channel_id=c.id`;
   }
   await sql`UPDATE browser_upload_jobs SET state='cancelled',updated_at=clock_timestamp() WHERE tree_id=${treeId} AND id=${jobId}`;
   return this.#status(sql,treeId,{...job,state:"cancelled"});
  });
 }

 #reference(reference:BrowserTreeOriginalReference|null|undefined):BrowserTreeOriginalReference{
  if(!reference||![reference.treeId,reference.jobId,reference.itemId].every(value=>uuid.test(value)))refused("browser_tree_identity_invalid");
  return Object.freeze({...reference});
 }
 async #directory(sql:TransactionSql,reference:BrowserTreeOriginalReference):Promise<DirectoryRow>{
  const row=(await sql<DirectoryRow[]>`SELECT item_id,parent_item_id,relative_path,kind,state,receipt,operation_id,resource_id,publish_task_id FROM browser_upload_items
   WHERE tree_id=${reference.treeId} AND job_id=${reference.jobId} AND item_id=${reference.itemId} FOR UPDATE`)[0];
  if(!row||row.kind!=="directory")refused("browser_tree_directory_not_found");
  return row;
 }
 #directoryReceipt(row:DirectoryRow):BrowserTreeReceipt|null{
  if(row.state!=="published"){if(row.receipt!==null)refused("browser_tree_original_invalid");return null;}
  const receipt=row.receipt as BrowserTreeReceipt|null;
  if(!receipt||receipt.resourceId!==row.resource_id||receipt.versionId!==null||receipt.kind!=="directory"||receipt.sizeBytes!==0||receipt.sha256!==null||receipt.relativePath!==row.relative_path)refused("browser_tree_original_invalid");
  return Object.freeze({...receipt});
 }
 async #directoryParent(sql:TransactionSql,tree:TreeRow,row:DirectoryRow):Promise<{parentId:string;path:string;ancestorIds:string[]}>{
  let parentId=tree.root_id;
  if(row.parent_item_id!==null){
   const parent=(await sql<{resource_id:string;relative_path:string}[]>`SELECT resource_id,relative_path FROM browser_upload_items WHERE tree_id=${tree.id} AND item_id=${row.parent_item_id} AND kind='directory' AND state='published'`)[0];
   if(!parent||parent.relative_path!==row.relative_path.slice(0,row.relative_path.lastIndexOf('/')))refused("browser_tree_parent_pending");
   parentId=parent.resource_id;
  }
  const ancestors: {id:string;parent_id:string|null;storage_path:string;name:string}[]=[];
  let cursor:string|null=parentId;
  while(cursor!==null){
   if(ancestors.length>=128||ancestors.some(node=>node.id===cursor))refused("browser_tree_parent_invalid");
   const node:{id:string;parent_id:string|null;storage_path:string;name:string;guarded:boolean}|undefined=(await sql<{id:string;parent_id:string|null;storage_path:string;name:string;guarded:boolean}[]>`SELECT id,parent_id,storage_path,name,cardinality(public.catalog_guard_scope(id,false))<>0 AS guarded FROM resources WHERE id=${cursor} AND type='folder' AND status='active'`)[0];
   if(!node||node.guarded)refused("browser_tree_destination_unavailable");
   const child=ancestors.at(-1);
   if(child&&child.storage_path!==node.storage_path+(node.storage_path===""?"":"/")+child.name)refused("browser_tree_parent_invalid");
   ancestors.push(node);cursor=node.parent_id;
  }
  const root=ancestors.find(node=>node.id===tree.root_id),top=ancestors.at(-1),name=requiredValue(row.relative_path.split('/').at(-1));
  if(!root||top?.id!==ROOT_RESOURCE_ID||top.storage_path!=="")refused("browser_tree_parent_invalid");
  const target=requiredValue(ancestors[0]).storage_path+(requiredValue(ancestors[0]).storage_path===""?"":"/")+name;
  if(target!==root.storage_path+(root.storage_path===""?"":"/")+row.relative_path)refused("browser_tree_parent_invalid");
  return {parentId,path:target,ancestorIds:ancestors.map(node=>node.id)};
 }
 async #directoryOriginal(sql:TransactionSql,tree:TreeRow,row:DirectoryRow,reference:BrowserTreeOriginalReference):Promise<BrowserTreeDirectoryOriginal>{
  const receipt=this.#directoryReceipt(row);
  // Completed identity is historical. A later legitimate move/trash must not
  // make a successful upload look like a new unexecuted operation.
  const parent=receipt===null?await this.#directoryParent(sql,tree,row):{parentId:tree.root_id,path:""};
  return Object.freeze({reference,operationId:row.operation_id,resourceId:row.resource_id,publishTaskId:row.publish_task_id,parentId:parent.parentId,name:requiredValue(row.relative_path.split('/').at(-1)),destinationPath:parent.path,state:row.state,receipt});
 }
 async inspectDirectory(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference):Promise<BrowserTreeDirectoryOriginal>{
  const principal=this.authority.credentialsForDatabase(proof),reference=this.#reference(input);
  return this.database.transaction(async sql=>{await this.#locks(sql,principal);await this.#authorize(sql,principal);
   const tree=await this.#tree(sql,principal,reference.treeId,false),row=await this.#directory(sql,reference);
   return this.#directoryOriginal(sql,tree,row,reference);
  });
 }
 async beginDirectory(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,operationId:string):Promise<BrowserTreeDirectoryOriginal>{
  const principal=this.authority.credentialsForDatabase(proof),reference=this.#reference(input);
  return this.database.transaction(async sql=>{
   await assertBrowserNamespaceCatalogPermit(sql,operationId);await this.#locks(sql,principal);await this.#authorize(sql,principal);
   const tree=await this.#tree(sql,principal,reference.treeId,false),row=await this.#directory(sql,reference);
   if(row.operation_id!==operationId||tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration)refused("browser_tree_binding_changed");
   if(row.state!=="reserved")refused("browser_tree_reconciliation_required");
   const original=await this.#directoryOriginal(sql,tree,row,reference);
   await sql`UPDATE browser_upload_items SET state='materializing',updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND item_id=${reference.itemId}`;
   await sql`UPDATE browser_upload_jobs SET state='running',updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND id=${reference.jobId} AND state='accepted'`;
   return Object.freeze({...original,state:"materializing"});
  });
 }
 async publishDirectory(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,operationId:string):Promise<BrowserTreeReceipt>{
  const principal=this.authority.credentialsForDatabase(proof),reference=this.#reference(input);
  return this.database.transaction(async sql=>{
   await assertBrowserNamespaceCatalogPermit(sql,operationId);await this.#locks(sql,principal);await this.#authorize(sql,principal);
   const tree=await this.#tree(sql,principal,reference.treeId,false),row=await this.#directory(sql,reference);
   if(row.operation_id!==operationId||tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration)refused("browser_tree_binding_changed");
   const receipt=this.#directoryReceipt(row);if(receipt)return receipt;
   if(row.state!=="materializing")refused("browser_tree_reconciliation_required");
   const parent=await this.#directoryParent(sql,tree,row),name=requiredValue(row.relative_path.split('/').at(-1));
   // SQL namespace trigger verifies the same-transaction permit and completed
   // physical task before allowing this catalog INSERT.
   await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status) VALUES(${row.resource_id},'folder',${parent.parentId},${name},${parent.path},'active')`;
   await sql`UPDATE resources SET updated_at=clock_timestamp() WHERE id=ANY(${parent.ancestorIds}::uuid[])`;
   const result:BrowserTreeReceipt={resourceId:row.resource_id,versionId:null,kind:"directory",sizeBytes:0,sha256:null,relativePath:row.relative_path};
   await sql`INSERT INTO audit_events(id,actor_type,actor_id,action,resource_id,outcome,correlation_id,details)
    VALUES(${randomUUID()},${principal.kind==="owner"?"web_session":"drop_session"},${principal.sessionId},'browser_tree.directory.publish',${row.resource_id},'success',${row.operation_id},${sql.json({treeId:reference.treeId,jobId:reference.jobId,itemId:reference.itemId,scopeId:principal.scopeId})})`;
   await sql`UPDATE browser_upload_items SET state='published',receipt=${sql.json({...result})},updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND item_id=${reference.itemId}`;
   await sql`UPDATE browser_upload_jobs SET state=CASE WHEN NOT EXISTS(SELECT 1 FROM browser_upload_items WHERE tree_id=${reference.treeId} AND job_id=${reference.jobId} AND state<>'published') THEN 'completed' ELSE 'running' END,updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND id=${reference.jobId}`;
   return Object.freeze(result);
  });
 }
 async #file(sql:TransactionSql,reference:BrowserTreeOriginalReference):Promise<FileRow>{
  const row=(await sql<FileRow[]>`SELECT item_id,parent_item_id,relative_path,kind,state,receipt,operation_id,resource_id,publish_task_id,version_id,write_task_id,staging_path,size_bytes::float8 AS size_bytes,sha256,content FROM browser_upload_items
   WHERE tree_id=${reference.treeId} AND job_id=${reference.jobId} AND item_id=${reference.itemId} AND coalesce(to_jsonb(browser_upload_items)->>'payload_mode','inline')='inline' FOR UPDATE`)[0];
  if(!row||row.kind!=="file")refused("browser_tree_file_not_found");
  return row;
 }
 #fileReceipt(row:FileRow):BrowserTreeReceipt|null{
  if(row.state!=="published"){if(row.receipt!==null)refused("browser_tree_original_invalid");return null;}
  const receipt=row.receipt as BrowserTreeReceipt|null;
  if(!receipt||receipt.resourceId!==row.resource_id||receipt.versionId!==row.version_id||receipt.kind!=="file"||receipt.sizeBytes!==row.size_bytes||receipt.sha256!==row.sha256||receipt.relativePath!==row.relative_path)refused("browser_tree_original_invalid");
  return Object.freeze({...receipt});
 }
 async #fileOriginal(sql:TransactionSql,tree:TreeRow,row:FileRow,reference:BrowserTreeOriginalReference):Promise<BrowserTreeFileOriginal>{
  const receipt=this.#fileReceipt(row),parent=receipt===null?await this.#directoryParent(sql,tree,row):{parentId:tree.root_id,path:""};
  if(receipt===null&&(!Buffer.isBuffer(row.content)||row.content.length!==row.size_bytes||createHash("sha256").update(row.content).digest("hex")!==row.sha256))refused("browser_tree_original_invalid");
  return Object.freeze({reference,operationId:row.operation_id,resourceId:row.resource_id,publishTaskId:row.publish_task_id,parentId:parent.parentId,name:requiredValue(row.relative_path.split('/').at(-1)),destinationPath:parent.path,state:row.state,receipt,
   versionId:row.version_id,writeTaskId:row.write_task_id,stagingPath:row.staging_path,sizeBytes:row.size_bytes,sha256:row.sha256,content:row.content===null?null:Buffer.from(row.content)});
 }
 async inspectFile(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference):Promise<BrowserTreeFileOriginal>{
  const principal=this.authority.credentialsForDatabase(proof),reference=this.#reference(input);
  return this.database.transaction(async sql=>{await this.#locks(sql,principal);await this.#authorize(sql,principal);
   const tree=await this.#tree(sql,principal,reference.treeId,false),row=await this.#file(sql,reference);return this.#fileOriginal(sql,tree,row,reference);
  });
 }
 async beginFile(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,operationId:string):Promise<BrowserTreeFileOriginal>{
  const principal=this.authority.credentialsForDatabase(proof),reference=this.#reference(input);
  return this.database.transaction(async sql=>{
   await assertBrowserNamespaceCatalogPermit(sql,operationId);await this.#locks(sql,principal);await this.#authorize(sql,principal);
   const tree=await this.#tree(sql,principal,reference.treeId,false),row=await this.#file(sql,reference);
   if(row.operation_id!==operationId||tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration)refused("browser_tree_binding_changed");
   if(row.state!=="reserved")refused("browser_tree_reconciliation_required");
   const original=await this.#fileOriginal(sql,tree,row,reference);
   await sql`UPDATE browser_upload_items SET state='materializing',updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND item_id=${reference.itemId}`;
   await sql`UPDATE browser_upload_jobs SET state='running',updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND id=${reference.jobId} AND state='accepted'`;
   return Object.freeze({...original,state:"materializing"});
  });
 }
 async recordFileVerified(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,operationId:string,evidence:{readonly sizeBytes:number;readonly sha256:string}):Promise<void>{
  const principal=this.authority.credentialsForDatabase(proof),reference=this.#reference(input),verified={...evidence};
  await this.database.transaction(async sql=>{
   await assertBrowserNamespaceCatalogPermit(sql,operationId);await this.#locks(sql,principal);await this.#authorize(sql,principal);
   const tree=await this.#tree(sql,principal,reference.treeId,false),row=await this.#file(sql,reference);
   if(row.operation_id!==operationId||tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration)refused("browser_tree_binding_changed");
   if(row.state!=="materializing"||verified.sizeBytes!==row.size_bytes||verified.sha256!==row.sha256)refused("browser_tree_verification_failed");
   await this.#directoryParent(sql,tree,row);
   await sql`UPDATE browser_upload_items SET state='verified',updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND item_id=${reference.itemId}`;
  });
 }
 async beginFilePublication(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,operationId:string):Promise<BrowserTreeFileOriginal>{
  const principal=this.authority.credentialsForDatabase(proof),reference=this.#reference(input);
  return this.database.transaction(async sql=>{
   await assertBrowserNamespaceCatalogPermit(sql,operationId);await this.#locks(sql,principal);await this.#authorize(sql,principal);
   const tree=await this.#tree(sql,principal,reference.treeId,false),row=await this.#file(sql,reference);
   if(row.operation_id!==operationId||tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration)refused("browser_tree_binding_changed");
   if(row.state!=="verified")refused("browser_tree_reconciliation_required");
   const original=await this.#fileOriginal(sql,tree,row,reference);
   await sql`UPDATE browser_upload_items SET state='publishing',updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND item_id=${reference.itemId}`;
   return Object.freeze({...original,state:"publishing"});
  });
 }
 async publishFile(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference,operationId:string):Promise<BrowserTreeReceipt>{
  const principal=this.authority.credentialsForDatabase(proof),reference=this.#reference(input);
  return this.database.transaction(async sql=>{
   await assertBrowserNamespaceCatalogPermit(sql,operationId);await this.#locks(sql,principal);await this.#authorize(sql,principal);
   const tree=await this.#tree(sql,principal,reference.treeId,false),row=await this.#file(sql,reference);
   if(row.operation_id!==operationId||tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration)refused("browser_tree_binding_changed");
   const receipt=this.#fileReceipt(row);if(receipt)return receipt;
   if(row.state!=="publishing")refused("browser_tree_reconciliation_required");
   const parent=await this.#directoryParent(sql,tree,row),name=requiredValue(row.relative_path.split('/').at(-1));
   await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status,size_bytes,sha256,mime_type,current_version_id)
    VALUES(${row.resource_id},'file',${parent.parentId},${name},${parent.path},'active',${row.size_bytes},${row.sha256},'application/octet-stream',${row.version_id})`;
   await sql`INSERT INTO file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason)
    VALUES(${row.version_id},${row.resource_id},${parent.path},${row.sha256},${row.size_bytes},'application/octet-stream','initial')`;
   await sql`UPDATE resources SET size_bytes=size_bytes+${row.size_bytes},updated_at=clock_timestamp() WHERE id=ANY(${parent.ancestorIds}::uuid[])`;
   const result:BrowserTreeReceipt={resourceId:row.resource_id,versionId:row.version_id,kind:"file",sizeBytes:row.size_bytes,sha256:row.sha256,relativePath:row.relative_path};
   await sql`INSERT INTO audit_events(id,actor_type,actor_id,action,resource_id,outcome,correlation_id,details)
    VALUES(${randomUUID()},${principal.kind==="owner"?"web_session":"drop_session"},${principal.sessionId},'browser_tree.file.publish',${row.resource_id},'success',${row.operation_id},${sql.json({treeId:reference.treeId,jobId:reference.jobId,itemId:reference.itemId,scopeId:principal.scopeId})})`;
   // Clear server payload and mark Drop stored in the SAME catalog transaction.
   // A lost response retains a complete durable receipt, never a half release.
   await sql`UPDATE browser_upload_items SET state='published',receipt=${sql.json({...result})},content=NULL,drop_mutation_tx=pg_current_xact_id(),updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND item_id=${reference.itemId}`;
   if(principal.kind==="drop"){
    const updated=await sql`UPDATE drop_uploads SET state='stored',resource_id=${row.resource_id},received_size=expected_size,actual_sha256=${row.sha256},completed_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE id=${row.operation_id} AND channel_id=${principal.scopeId} AND state='reserved' AND expected_size=${row.size_bytes} AND expected_sha256=${row.sha256} AND local_path IS NULL RETURNING id`;
    if(updated.length!==1)refused("browser_tree_drop_original_changed");
   }
   await sql`UPDATE browser_upload_jobs SET state=CASE WHEN NOT EXISTS(SELECT 1 FROM browser_upload_items WHERE tree_id=${reference.treeId} AND job_id=${reference.jobId} AND state<>'published') THEN 'completed' ELSE 'running' END,updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND id=${reference.jobId}`;
   return Object.freeze(result);
  });
 }
 /** Internal retention operation. It grants no read/publication/cancel authority
  * and is allowed after access expires so an old effect is never forgotten. */
 async markExecutionUnknown(input:BrowserTreeOriginalReference,operationId:string):Promise<void>{
  const reference=this.#reference(input);if(!uuid.test(operationId))refused("browser_tree_identity_invalid");
  await this.database.transaction(async sql=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-browser-tree-admission',0))`;
   const changed=await sql`UPDATE browser_upload_items i SET state='unknown',updated_at=clock_timestamp() FROM browser_upload_trees t
    WHERE i.tree_id=t.id AND i.tree_id=${reference.treeId} AND i.job_id=${reference.jobId} AND i.item_id=${reference.itemId} AND i.operation_id=${operationId}
      AND t.backend_identity=${this.#options.backendIdentity} AND t.backend_generation=${this.#options.backendGeneration} AND i.state NOT IN ('published','cancelled') RETURNING i.item_id`;
   if(changed.length)await sql`UPDATE browser_upload_jobs SET state='unknown',updated_at=clock_timestamp() WHERE tree_id=${reference.treeId} AND id=${reference.jobId} AND state NOT IN ('completed','cancelled')`;
  });
 }
}
