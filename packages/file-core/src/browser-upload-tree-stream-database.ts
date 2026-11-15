import { requiredValue } from "./required-value.js";
import {createHash,randomUUID} from "node:crypto";
import type {Database} from "@saturn/database";
import type {TransactionSql} from "postgres";
import type {BrowserTreeAuthorityIssuer} from "./browser-upload-tree-authority.js";
import {type BrowserTreeAuthority,type BrowserTreePrincipal} from "./browser-upload-tree-authority.js";
import {BrowserTreeDatabaseError,type BrowserTreeJobStatus} from "./browser-upload-tree-database.js";
import {validateBrowserTreeStreamJob,type ValidatedBrowserTreeStreamJob} from "./browser-upload-tree-stream-contract.js";
import type {BrowserTreeOriginalReference,BrowserTreeReceipt} from "./browser-upload-tree-executor.js";
import {ROOT_RESOURCE_ID} from "./models.js";

export interface BrowserTreeStreamDatabaseOptions {
 readonly backendIdentity:string;readonly backendGeneration:string;readonly spoolId:string;
 readonly maximumFileBytes:number;readonly globalSpoolBytes:number;readonly continuationTtlMs:number;
}
export interface BrowserTreeStreamJobOriginal {readonly reference:BrowserTreeOriginalReference;readonly status:BrowserTreeJobStatus}
export interface BrowserTreeStreamQueuedRequest {readonly reference:BrowserTreeOriginalReference;readonly requestId:string;readonly authorizationGeneration:number}
export interface BrowserTreeStreamExecutionClaim extends BrowserTreeStreamQueuedRequest {readonly operationId:string;readonly claimId:string;readonly workerId:string}
export type BrowserTreeStreamSettlement={readonly outcome:"published";readonly receipt:BrowserTreeReceipt}|{readonly outcome:"cancelled";readonly receipt:null};
export type BrowserTreeStreamBlockedReason="browser_tree_authorization_changed"|"browser_tree_file_too_large"|"browser_tree_destination_unavailable"|"browser_tree_drop_original_changed";
declare const streamExecutionLock:unique symbol;
export interface BrowserTreeStreamExecutionLock {readonly [streamExecutionLock]:true}
interface TreeRow {id:string;principal_kind:string;scope_id:string;root_id:string;backend_identity:string;backend_generation:string;item_count:number;directory_count:number}
interface JobRow {id:string;intent_sha256:string;state:string;payload_mode:string}
interface ItemRow {item_id:string;parent_item_id:string|null;relative_path:string;kind:"file";state:string;receipt:unknown;size_bytes:string;drop_upload_id:string|null}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function fail(code:string):never{throw new BrowserTreeDatabaseError(code);}

/** Fixed stream metadata admission. Requires qualified0113+shared spool quota
 * schema/roles. No physical writes, backend permits or public capability are
 * supplied here. Both owner and Drop reserve the SAME canonical disk budget. */
export class PostgresBrowserTreeStreamDatabase {
 readonly #options:BrowserTreeStreamDatabaseOptions;
 readonly #executionLocks=new WeakMap<object,string>();
 constructor(private readonly database:Database,private readonly authority:BrowserTreeAuthorityIssuer,options:BrowserTreeStreamDatabaseOptions){
  if(!options.backendIdentity||options.backendIdentity.length>128||!uuid.test(options.backendGeneration)||!uuid.test(options.spoolId)
   ||[options.maximumFileBytes,options.globalSpoolBytes,options.continuationTtlMs].some(n=>!Number.isSafeInteger(n)||n<1)
   ||options.maximumFileBytes<=262144||options.maximumFileBytes>options.globalSpoolBytes)fail("browser_tree_configuration_invalid");this.#options=Object.freeze({...options});
 }
 #ids(treeId:string,jobId?:string):void{if(!uuid.test(treeId)||jobId!==undefined&&!uuid.test(jobId))fail("browser_tree_identity_invalid");}
 #request(input:unknown):BrowserTreeStreamQueuedRequest{
  if(input===null||typeof input!=="object")fail("browser_tree_identity_invalid");
  const value=input as Partial<BrowserTreeStreamQueuedRequest>;
  if(!value.reference||typeof value.requestId!=="string"||![value.reference.treeId,value.reference.jobId,value.reference.itemId,value.requestId].every(v=>uuid.test(v))
   ||typeof value.authorizationGeneration!=="number"||!Number.isSafeInteger(value.authorizationGeneration)||value.authorizationGeneration<1)fail("browser_tree_identity_invalid");
  return Object.freeze({reference:Object.freeze({...value.reference}),requestId:value.requestId,authorizationGeneration:value.authorizationGeneration});
 }
 #assertExecutionLock(permit:BrowserTreeStreamExecutionLock,reference:BrowserTreeOriginalReference):void{
  if(this.#executionLocks.get(permit)!==[reference.treeId,reference.jobId,reference.itemId].join(':'))fail("browser_tree_execution_lock_invalid");
 }
 /** Internal worker boundary. The permit cannot be serialized, reused after
  * exit, or supplied by an HTTP route. Durable claims/backend fencing remain
  * necessary because a PG session lock alone is not physical closure proof. */
 withExecutionLock<T>(input:BrowserTreeStreamQueuedRequest,action:(permit:BrowserTreeStreamExecutionLock)=>Promise<T>):Promise<T>{
  const request=this.#request(input),ref=request.reference;
  return this.database.withAdvisoryLock(`saturn-browser-stream:${ref.treeId}:${ref.itemId}`,async()=>{
   const permit=Object.freeze({}) as BrowserTreeStreamExecutionLock;
   this.#executionLocks.set(permit,[ref.treeId,ref.jobId,ref.itemId].join(':'));
   try{return await action(permit);}finally{this.#executionLocks.delete(permit);}
  });
 }
 /** Bounded discovery only. No row claim, token, physical work or age-based
  * reassignment. Concurrent workers may discover the same original; only one
  * exact queued-generation claim can commit. */
 listExecutionRequests(limit:number=2):Promise<readonly BrowserTreeStreamQueuedRequest[]>{
  if(limit!==1&&limit!==2)fail("browser_tree_execution_capacity");
  return this.database.transaction(async sql=>{
   const rows=await sql<{tree_id:string;job_id:string;item_id:string;request_id:string;authorization_generation:string}[]>`
    SELECT q.tree_id,q.job_id,q.item_id,q.request_id,q.authorization_generation::text
    FROM browser_upload_stream_requests q JOIN browser_upload_trees t ON t.id=q.tree_id
    JOIN browser_upload_jobs j ON j.tree_id=q.tree_id AND j.id=q.job_id
    JOIN browser_upload_items i ON i.tree_id=q.tree_id AND i.item_id=q.item_id AND i.job_id=q.job_id
    JOIN browser_upload_streams s ON s.tree_id=q.tree_id AND s.item_id=q.item_id
    WHERE q.state='queued' AND j.state='accepted' AND i.state='reserved' AND i.operation_id=q.operation_id
     AND t.backend_identity=${this.#options.backendIdentity} AND t.backend_generation=${this.#options.backendGeneration} AND s.spool_id=${this.#options.spoolId}
    ORDER BY q.created_at,q.tree_id,q.item_id LIMIT ${limit}`;
   if(rows.length>limit)fail("browser_tree_stream_original_invalid");
   return Object.freeze(rows.map(row=>this.#request({reference:{treeId:row.tree_id,jobId:row.job_id,itemId:row.item_id},requestId:row.request_id,authorizationGeneration:Number(row.authorization_generation)})));
  });
 }
 async #authorize(sql:TransactionSql,p:BrowserTreePrincipal):Promise<void>{
  // All stream producers, including owner, precede browser/session/channel
  // locks with the shared budget domain. Old producers fail fast in its guard.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-drop-buffer-reservation',0))`;
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
 async #tree(sql:TransactionSql,p:BrowserTreePrincipal,treeId:string):Promise<TreeRow|undefined>{
  const tree=(await sql<TreeRow[]>`SELECT * FROM browser_upload_trees WHERE id=${treeId} FOR UPDATE`)[0];
  if(tree&&(tree.principal_kind!==p.kind||tree.scope_id!==p.scopeId||tree.root_id!==p.rootId))fail("browser_tree_not_found");return tree;
 }
 async #original(sql:TransactionSql,treeId:string,job:JobRow):Promise<BrowserTreeStreamJobOriginal>{
  if(job.payload_mode!=="stream")fail("browser_tree_original_reused");
  const items=await sql<ItemRow[]>`SELECT i.item_id,i.parent_item_id,i.relative_path,i.kind,i.state,i.receipt,i.size_bytes::text,i.drop_upload_id
   FROM browser_upload_items i JOIN browser_upload_streams s ON s.tree_id=i.tree_id AND s.item_id=i.item_id
   JOIN browser_upload_spool_reservations r ON r.tree_id=i.tree_id AND r.item_id=i.item_id
   WHERE i.tree_id=${treeId} AND i.job_id=${job.id} AND i.payload_mode='stream' AND i.kind='file'
    AND i.operation_id=r.operation_id AND i.size_bytes=r.expected_size AND i.size_bytes=s.expected_size AND i.sha256=s.expected_sha256 AND s.spool_id=r.spool_id
   LIMIT 2`;
  const item=items[0];if(items.length!==1||!item)fail("browser_tree_stream_original_invalid");
  const reference=Object.freeze({treeId,jobId:job.id,itemId:item.item_id});
  const status=Object.freeze({treeId,jobId:job.id,intentSha256:job.intent_sha256,state:job.state,items:Object.freeze([Object.freeze({itemId:item.item_id,parentItemId:item.parent_item_id,relativePath:item.relative_path,kind:item.kind,state:item.state,receipt:item.receipt})])});
  return Object.freeze({reference,status});
 }
 async #destination(sql:TransactionSql,p:BrowserTreePrincipal,treeId:string,job:ValidatedBrowserTreeStreamJob):Promise<void>{
  const item=job.value.item;if(p.rootId===ROOT_RESOURCE_ID&&item.parentItemId===null)fail("browser_tree_root_files_forbidden");
  let parentId=p.rootId;
  if(item.parentItemId!==null){
   const parent=(await sql<{resource_id:string;relative_path:string;kind:string;state:string}[]>`SELECT resource_id,relative_path,kind,state FROM browser_upload_items WHERE tree_id=${treeId} AND item_id=${item.parentItemId}`)[0];
   if(!parent||parent.kind!=="directory"||parent.relative_path!==item.relativePath.slice(0,item.relativePath.lastIndexOf('/')))fail("browser_tree_parent_invalid");
   if(parent.state!=="published")fail("browser_tree_parent_pending");parentId=parent.resource_id;
  }
  type Node={id:string;parent_id:string|null;name:string;storage_path:string;guarded:boolean};const ancestors:Node[]=[];let cursor:string|null=parentId;
  while(cursor!==null){
   if(ancestors.length>=128||ancestors.some(node=>node.id===cursor))fail("browser_tree_parent_invalid");
   const node:Node|undefined=(await sql<Node[]>`SELECT id,parent_id,name,storage_path,cardinality(public.catalog_guard_scope(id,false))<>0 AS guarded FROM resources WHERE id=${cursor} AND type='folder' AND status='active'`)[0];
   if(!node||node.guarded)fail("browser_tree_destination_unavailable");const child=ancestors.at(-1);
   if(child&&child.storage_path!==node.storage_path+(node.storage_path===""?"":"/")+child.name)fail("browser_tree_parent_invalid");ancestors.push(node);cursor=node.parent_id;
  }
  const root=ancestors.find(node=>node.id===p.rootId),parent=ancestors[0],top=ancestors.at(-1);
  if(!root||!parent||top?.id!==ROOT_RESOURCE_ID||top.storage_path!==""
   ||parent.storage_path+(parent.storage_path===""?"":"/")+item.relativePath.slice(item.relativePath.lastIndexOf('/')+1)!==root.storage_path+(root.storage_path===""?"":"/")+item.relativePath)fail("browser_tree_parent_invalid");
 }
 async #newAdmission(sql:TransactionSql,p:BrowserTreePrincipal,tree:TreeRow|undefined,treeId:string,job:ValidatedBrowserTreeStreamJob):Promise<void>{
  if(tree&&(tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration))fail("browser_tree_binding_changed");
  const backend=await sql`SELECT backend_identity FROM sync_backend_executor WHERE backend_identity=${this.#options.backendIdentity} AND generation=${this.#options.backendGeneration} AND state='RUNNING'`;
  if(backend.length!==1)fail("browser_tree_backend_unavailable");
  const preference=(await sql<{upload_buffer_gib:number;maximum_upload_file_gib:number}[]>`SELECT upload_buffer_gib,maximum_upload_file_gib FROM owner_preferences WHERE owner_id='owner' FOR SHARE`)[0];
  const budget=(await sql<{maximum_bytes:string}[]>`SELECT maximum_bytes::text FROM browser_upload_spool_budget WHERE owner_id='owner'`)[0];
  if(!preference||!budget)fail("browser_spool_quota_unconfigured");
  const configured=Number(budget.maximum_bytes),buffer=preference.upload_buffer_gib*1024**3,maximum=preference.maximum_upload_file_gib*1024**3;
  if([configured,buffer,maximum].some(value=>!Number.isSafeInteger(value)||value<1)||configured>this.#options.globalSpoolBytes||maximum*10>buffer*9)fail("browser_tree_configuration_invalid");
  if(job.value.item.sizeBytes>Math.min(maximum,this.#options.maximumFileBytes))fail("browser_tree_file_too_large");
  const global=(await sql<{bytes:string}[]>`SELECT coalesce(sum(bytes),0)::text AS bytes FROM(
   SELECT r.expected_size::numeric AS bytes FROM browser_upload_spool_reservations r WHERE r.state='retained'
   UNION ALL SELECT d.expected_size::numeric FROM drop_uploads d WHERE(d.local_path IS NOT NULL OR d.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM browser_upload_spool_reservations r WHERE r.drop_upload_id=d.id AND r.state='retained')
  ) retained`)[0];
  if(!global||BigInt(global.bytes)+BigInt(job.value.item.sizeBytes)>BigInt(Math.min(configured,buffer,this.#options.globalSpoolBytes)))fail("browser_tree_quota_exhausted");
  const totals=(await sql<{jobs:number;scoped:number;bytes:string}[]>`SELECT count(*)::int AS jobs,coalesce(sum(j.payload_bytes),0)::text AS bytes,
   count(*) FILTER(WHERE t.principal_kind=${p.kind} AND t.scope_id=${p.scopeId})::int AS scoped FROM browser_upload_jobs j JOIN browser_upload_trees t ON t.id=j.tree_id WHERE j.state NOT IN ('completed','cancelled')`)[0];
  if(!totals||totals.jobs>=128||totals.scoped>=2||BigInt(totals.bytes)>67108864n||(tree?.item_count??0)>=20000)fail("browser_tree_capacity");
  if(p.kind==="drop"){
   const channel=(await sql<{reserved_files:number;reserved_bytes:string;max_files:number;max_bytes:string}[]>`SELECT reserved_files,reserved_bytes::text,max_files,max_bytes::text FROM drop_channels WHERE id=${p.scopeId}`)[0];
   if(!channel||channel.reserved_files+1>channel.max_files||BigInt(channel.reserved_bytes)+BigInt(job.value.item.sizeBytes)>BigInt(channel.max_bytes))fail("browser_tree_quota_exhausted");
  }
  const reused=await sql`SELECT item_id FROM browser_upload_items WHERE tree_id=${treeId} AND(item_id=${job.value.item.itemId} OR path_key=${job.value.item.relativePath.toLowerCase()}) LIMIT 1`;
  if(reused.length)fail("browser_tree_item_reused");await this.#destination(sql,p,treeId,job);
 }
 async admit(proof:BrowserTreeAuthority,treeId:string,body:unknown):Promise<BrowserTreeStreamJobOriginal>{
  const p=this.authority.credentialsForDatabase(proof);this.#ids(treeId);
  // Closed metadata validation precedes any SQL. Live/configured size caps are
  // checked for NEW admission; a previously admitted original stays inspectable.
  const job=validateBrowserTreeStreamJob(body,Number.MAX_SAFE_INTEGER),item=job.value.item;
  return this.database.transaction(async sql=>{
   await this.#authorize(sql,p);const tree=await this.#tree(sql,p,treeId);
   const existing=(await sql<JobRow[]>`SELECT id,intent_sha256,state,payload_mode FROM browser_upload_jobs WHERE tree_id=${treeId} AND id=${job.value.jobId}`)[0];
   if(existing){if(existing.intent_sha256!==job.intentSha256)fail("browser_tree_original_reused");return this.#original(sql,treeId,existing);}
   await this.#newAdmission(sql,p,tree,treeId,job);
   if(!tree)await sql`INSERT INTO browser_upload_trees(id,principal_kind,scope_id,root_id,backend_identity,backend_generation) VALUES(${treeId},${p.kind},${p.scopeId},${p.rootId},${this.#options.backendIdentity},${this.#options.backendGeneration})`;
   const operationId=randomUUID(),resourceId=randomUUID(),versionId=randomUUID(),writeTaskId=randomUUID(),publishTaskId=randomUUID(),sealId=randomUUID(),cleanupTaskId=randomUUID();
   await sql`INSERT INTO browser_upload_jobs(tree_id,id,intent_sha256,admitted_session_id,admitted_credential_revision,state,item_count,payload_bytes,payload_mode)
    VALUES(${treeId},${job.value.jobId},${job.intentSha256},${p.sessionId},${p.kind==="owner"?p.credentialRevision:null},'accepted',1,0,'stream')`;
   if(p.kind==="drop"){
    const clientKeyHash=createHash("sha256").update(`saturn-browser-tree:${treeId}:${item.itemId}`).digest("hex");
    await sql`INSERT INTO drop_uploads(id,session_id,channel_id,client_key_hash,filename,expected_size,expected_sha256,state,created_at,updated_at,continuation_until,browser_tree_managed)
     VALUES(${operationId},${p.sessionId},${p.scopeId},${clientKeyHash},${requiredValue(item.relativePath.slice(item.relativePath.lastIndexOf('/')+1))},${item.sizeBytes},${item.sha256},'reserved',clock_timestamp(),clock_timestamp(),clock_timestamp()+${this.#options.continuationTtlMs}*interval '1 millisecond',true)`;
   }
   await sql`INSERT INTO browser_upload_items(tree_id,job_id,item_id,parent_item_id,relative_path,path_key,kind,operation_id,resource_id,version_id,write_task_id,publish_task_id,staging_path,size_bytes,sha256,state,drop_upload_id,payload_mode)
    VALUES(${treeId},${job.value.jobId},${item.itemId},${item.parentItemId},${item.relativePath},${item.relativePath.toLowerCase()},'file',${operationId},${resourceId},${versionId},${writeTaskId},${publishTaskId},${'_system/incoming/'+operationId+'.part'},${item.sizeBytes},${item.sha256},'reserved',${p.kind==="drop"?operationId:null},'stream')`;
   await sql`INSERT INTO browser_upload_streams(tree_id,item_id,spool_id,seal_id,expected_size,expected_sha256) VALUES(${treeId},${item.itemId},${this.#options.spoolId},${sealId},${item.sizeBytes},${item.sha256})`;
   await sql`INSERT INTO browser_upload_spool_reservations(tree_id,item_id,operation_id,principal_kind,scope_id,backend_identity,backend_generation,spool_id,expected_size,drop_upload_id,cleanup_task_id)
    VALUES(${treeId},${item.itemId},${operationId},${p.kind},${p.scopeId},${this.#options.backendIdentity},${this.#options.backendGeneration},${this.#options.spoolId},${item.sizeBytes},${p.kind==="drop"?operationId:null},${cleanupTaskId})`;
   if(p.kind==="drop"){
    await sql`UPDATE drop_channels SET reserved_files=reserved_files+1,reserved_bytes=reserved_bytes+${item.sizeBytes} WHERE id=${p.scopeId}`;
    await sql`UPDATE drop_sessions s SET reserved_files=c.reserved_files,reserved_bytes=c.reserved_bytes FROM drop_channels c WHERE c.id=${p.scopeId} AND s.channel_id=c.id`;
   }
   await sql`UPDATE browser_upload_trees SET item_count=item_count+1 WHERE id=${treeId}`;
   return this.#original(sql,treeId,{id:job.value.jobId,intent_sha256:job.intentSha256,state:"accepted",payload_mode:"stream"});
  });
 }
 async inspect(proof:BrowserTreeAuthority,treeId:string,jobId:string):Promise<BrowserTreeStreamJobOriginal>{
  const p=this.authority.credentialsForDatabase(proof);this.#ids(treeId,jobId);
  return this.database.transaction(async sql=>{
   await this.#authorize(sql,p);if(!await this.#tree(sql,p,treeId))fail("browser_tree_not_found");
   const job=(await sql<JobRow[]>`SELECT id,intent_sha256,state,payload_mode FROM browser_upload_jobs WHERE tree_id=${treeId} AND id=${jobId}`)[0];if(!job)fail("browser_tree_not_found");return this.#original(sql,treeId,job);
  });
 }
 async #executionReady(sql:TransactionSql,p:BrowserTreePrincipal,tree:TreeRow,ref:BrowserTreeOriginalReference,job:JobRow,original:BrowserTreeStreamJobOriginal){
   if(requiredValue(original.status.items[0]).state!=="reserved")fail("browser_tree_reconciliation_required");
   if(tree.backend_identity!==this.#options.backendIdentity||tree.backend_generation!==this.#options.backendGeneration)fail("browser_tree_binding_changed");
   const backend=await sql`SELECT backend_identity FROM sync_backend_executor WHERE backend_identity=${this.#options.backendIdentity} AND generation=${this.#options.backendGeneration} AND state='RUNNING'`;
   if(backend.length!==1)fail("browser_tree_backend_unavailable");
   const row=(await sql<{operation_id:string;size_bytes:string;sha256:string;parent_item_id:string|null;relative_path:string;spool_id:string;state:string;received_size:string;seal_sha256:string|null;reservation_state:string}[]>`SELECT i.operation_id,i.size_bytes::text,i.sha256,i.parent_item_id,i.relative_path,s.spool_id,s.state,s.received_size::text,s.seal_sha256,r.state AS reservation_state
    FROM browser_upload_items i JOIN browser_upload_streams s ON s.tree_id=i.tree_id AND s.item_id=i.item_id JOIN browser_upload_spool_reservations r ON r.tree_id=i.tree_id AND r.item_id=i.item_id
    WHERE i.tree_id=${ref.treeId} AND i.item_id=${ref.itemId} AND i.job_id=${ref.jobId} AND r.operation_id=i.operation_id FOR UPDATE OF i,s,r`)[0];
   if(!row||row.spool_id!==this.#options.spoolId||row.reservation_state!=="retained")fail("browser_tree_spool_binding_changed");
   if(row.state!=="sealed"||row.received_size!==row.size_bytes||row.seal_sha256!==row.sha256)fail("browser_tree_stream_incomplete");
   const preference=(await sql<{maximum_upload_file_gib:number}[]>`SELECT maximum_upload_file_gib FROM owner_preferences WHERE owner_id='owner' FOR SHARE`)[0];
   const maximum=preference?.maximum_upload_file_gib!==undefined?preference.maximum_upload_file_gib*1024**3:0;
   if(!Number.isSafeInteger(maximum)||maximum<1)fail("browser_tree_configuration_invalid");
   const value=validateBrowserTreeStreamJob({schema:"saturn.browser-tree-stream-job.v1",jobId:ref.jobId,item:{kind:"file",itemId:ref.itemId,parentItemId:row.parent_item_id,relativePath:row.relative_path,sizeBytes:Number(row.size_bytes),sha256:row.sha256}},Number.MAX_SAFE_INTEGER);
   if(value.value.item.sizeBytes>Math.min(maximum,this.#options.maximumFileBytes))fail("browser_tree_file_too_large");
   if(value.intentSha256!==job.intent_sha256)fail("browser_tree_stream_original_invalid");await this.#destination(sql,p,ref.treeId,value);
   if(p.kind==="drop"){
    const mapping=await sql`SELECT id FROM drop_uploads WHERE id=${row.operation_id} AND channel_id=${p.scopeId} AND browser_tree_managed AND state='reserved' AND expected_size=${row.size_bytes}::bigint AND expected_sha256=${row.sha256} AND local_path IS NULL AND continuation_until>clock_timestamp()`;
    if(mapping.length!==1)fail("browser_tree_drop_original_changed");
   }
   return row;
 }
 /** Commits a bounded execution request and returns current status. This does
  * not start a Promise, write backend bytes or claim that publication occurred.
  * The fixed worker must rediscover queued rows and hold the SAME original
  * lock through all effects. Claimed/unknown work is never reclaimed by TTL. */
 async requestExecution(proof:BrowserTreeAuthority,input:BrowserTreeOriginalReference):Promise<BrowserTreeJobStatus>{
  const p=this.authority.credentialsForDatabase(proof),ref=Object.freeze({...input});this.#ids(ref.treeId,ref.jobId);if(!uuid.test(ref.itemId))fail("browser_tree_identity_invalid");
  return this.database.withAdvisoryLock(`saturn-browser-stream:${ref.treeId}:${ref.itemId}`,()=>this.database.transaction(async sql=>{
   await this.#authorize(sql,p);const tree=await this.#tree(sql,p,ref.treeId);if(!tree)fail("browser_tree_not_found");
   const job=(await sql<JobRow[]>`SELECT id,intent_sha256,state,payload_mode FROM browser_upload_jobs WHERE tree_id=${ref.treeId} AND id=${ref.jobId} FOR UPDATE`)[0];if(!job)fail("browser_tree_not_found");
   const original=await this.#original(sql,ref.treeId,job);if(original.reference.itemId!==ref.itemId)fail("browser_tree_not_found");
   if(job.state!=="accepted")return original.status;
   const row=await this.#executionReady(sql,p,tree,ref,job,original);
   const requested=(await sql<{state:string;request_session_id:string;request_credential_revision:string|null}[]>`SELECT state,request_session_id,request_credential_revision::text FROM browser_upload_stream_requests WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} FOR UPDATE`)[0];
   if(requested&&!["queued","blocked"].includes(requested.state))fail("browser_tree_reconciliation_required");
   if(requested?.state==="queued"&&requested.request_session_id===p.sessionId&&requested.request_credential_revision===(p.kind==="owner"?p.credentialRevision:null))return original.status;
   if(requested){
    await sql`UPDATE browser_upload_stream_requests SET state='queued',request_session_id=${p.sessionId},request_credential_revision=${p.kind==="owner"?p.credentialRevision:null},authorization_generation=authorization_generation+1,claim_id=NULL,worker_id=NULL,updated_at=clock_timestamp() WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId}`;
   }else{
    await sql`INSERT INTO browser_upload_stream_requests(tree_id,item_id,job_id,operation_id,request_id,request_session_id,request_credential_revision) VALUES(${ref.treeId},${ref.itemId},${ref.jobId},${row.operation_id},${randomUUID()},${p.sessionId},${p.kind==="owner"?p.credentialRevision:null})`;
   }
   await sql`INSERT INTO audit_events(id,actor_type,actor_id,action,resource_id,outcome,correlation_id,details)
    VALUES(${randomUUID()},${p.kind==="owner"?"web_session":"drop_session"},${p.sessionId},'browser_tree.stream.execution.request',NULL,'success',${row.operation_id},${sql.json({treeId:ref.treeId,jobId:ref.jobId,itemId:ref.itemId,revalidation:requested!==undefined})})`;
   return original.status;
  }));
 }
 /** Exactly one queued authorization generation becomes claimed. The fixed
  * worker chooses claimId once BEFORE this call and keeps the original lock
  * through its entire joined execution. Lost commit acknowledgement retains
  * the claimed row; it cannot grant a second execution on a later retry. */
 async claimExecution(proof:BrowserTreeAuthority,input:BrowserTreeStreamQueuedRequest,permit:BrowserTreeStreamExecutionLock,identity:{readonly claimId:string;readonly workerId:string}):Promise<BrowserTreeStreamExecutionClaim>{
  const p=this.authority.credentialsForDatabase(proof),request=this.#request(input),ref=request.reference;
  this.#assertExecutionLock(permit,ref);
  const claimId=identity.claimId,workerId=identity.workerId;if(!uuid.test(claimId)||!uuid.test(workerId))fail("browser_tree_identity_invalid");
  return this.database.transaction(async sql=>{
   await this.#authorize(sql,p);const tree=await this.#tree(sql,p,ref.treeId);if(!tree)fail("browser_tree_not_found");
   const job=(await sql<JobRow[]>`SELECT id,intent_sha256,state,payload_mode FROM browser_upload_jobs WHERE tree_id=${ref.treeId} AND id=${ref.jobId} FOR UPDATE`)[0];
   if(!job)fail("browser_tree_not_found");const original=await this.#original(sql,ref.treeId,job);
   if(original.reference.itemId!==ref.itemId)fail("browser_tree_not_found");
   if(job.state!=="accepted")fail("browser_tree_reconciliation_required");
   const queued=(await sql<{operation_id:string;state:string;request_id:string;authorization_generation:string;request_session_id:string;request_credential_revision:string|null}[]>`
    SELECT operation_id,state,request_id,authorization_generation::text,request_session_id,request_credential_revision::text
    FROM browser_upload_stream_requests WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND job_id=${ref.jobId} FOR UPDATE`)[0];
   if(!queued||queued.state!=="queued"||queued.request_id!==request.requestId||queued.authorization_generation!==String(request.authorizationGeneration))fail("browser_tree_reconciliation_required");
   if(queued.request_session_id!==p.sessionId||queued.request_credential_revision!==(p.kind==="owner"?p.credentialRevision:null))fail("browser_tree_authorization_changed");
   const row=await this.#executionReady(sql,p,tree,ref,job,original);
   if(queued.operation_id!==row.operation_id)fail("browser_tree_stream_original_invalid");
   const jobRows=await sql`UPDATE browser_upload_jobs SET state='running',updated_at=clock_timestamp() WHERE tree_id=${ref.treeId} AND id=${ref.jobId} AND state='accepted' RETURNING id`;
   if(jobRows.length!==1)fail("browser_tree_reconciliation_required");
   const claimed=await sql`UPDATE browser_upload_stream_requests SET state='claimed',claim_id=${claimId},worker_id=${workerId},updated_at=clock_timestamp()
    WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND request_id=${request.requestId} AND authorization_generation=${request.authorizationGeneration} AND state='queued' RETURNING request_id`;
   if(claimed.length!==1)fail("browser_tree_reconciliation_required");
   await sql`INSERT INTO audit_events(id,actor_type,actor_id,action,resource_id,outcome,correlation_id,details)
    VALUES(${randomUUID()},${p.kind==="owner"?"web_session":"drop_session"},${p.sessionId},'browser_tree.stream.execution.claim',NULL,'success',${row.operation_id},${sql.json({treeId:ref.treeId,jobId:ref.jobId,itemId:ref.itemId,requestId:request.requestId,authorizationGeneration:request.authorizationGeneration,claimId,workerId})})`;
   this.#assertExecutionLock(permit,ref);
   return Object.freeze({...request,operationId:row.operation_id,claimId,workerId});
  });
 }
 /** Internal retention after an uncertain commit/effect, including after the
  * initiating session expires. This grants NO retry or publication authority.
  * Matching the same claim/worker/generation is mandatory; quota stays charged.
  * "terminal" only means do not downgrade those rows; it is NOT a publication
  * receipt. Completion still requires separately verifying the stored receipt. */
 async retainExecutionUnknown(input:BrowserTreeStreamQueuedRequest,permit:BrowserTreeStreamExecutionLock,identity:{readonly claimId:string;readonly workerId:string}):Promise<"not_claimed"|"terminal"|"unknown">{
  const request=this.#request(input),ref=request.reference;this.#assertExecutionLock(permit,ref);
  const claimId=identity.claimId,workerId=identity.workerId;if(!uuid.test(claimId)||!uuid.test(workerId))fail("browser_tree_identity_invalid");
  return this.database.transaction(async sql=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-browser-tree-admission',0))`;
   const row=(await sql<{operation_id:string;request_state:string;item_state:string;job_state:string;principal_kind:string;request_session_id:string}[]>`
    SELECT q.operation_id,q.state AS request_state,i.state AS item_state,j.state AS job_state,t.principal_kind,q.request_session_id
    FROM browser_upload_stream_requests q JOIN browser_upload_trees t ON t.id=q.tree_id
    JOIN browser_upload_items i ON i.tree_id=q.tree_id AND i.item_id=q.item_id AND i.job_id=q.job_id
    JOIN browser_upload_jobs j ON j.tree_id=q.tree_id AND j.id=q.job_id
    JOIN browser_upload_streams s ON s.tree_id=q.tree_id AND s.item_id=q.item_id
    WHERE q.tree_id=${ref.treeId} AND q.item_id=${ref.itemId} AND q.job_id=${ref.jobId} AND q.request_id=${request.requestId}
     AND q.authorization_generation=${request.authorizationGeneration} AND q.claim_id=${claimId} AND q.worker_id=${workerId}
     AND q.operation_id=i.operation_id AND t.backend_identity=${this.#options.backendIdentity} AND t.backend_generation=${this.#options.backendGeneration}
     AND s.spool_id=${this.#options.spoolId} AND i.payload_mode='stream' AND j.payload_mode='stream'
    FOR UPDATE OF q,i,j`)[0];
   if(!row)return "not_claimed";
   if(row.job_state==="completed"&&row.item_state==="published"||row.job_state==="cancelled"&&row.item_state==="cancelled")return "terminal";
   if(!["claimed","unknown"].includes(row.request_state)||!["running","unknown"].includes(row.job_state)
    ||!["reserved","materializing","verified","publishing","unknown"].includes(row.item_state))fail("browser_tree_reconciliation_required");
   if(row.request_state==="unknown"&&row.job_state==="unknown"&&row.item_state==="unknown")return "unknown";
   await sql`UPDATE browser_upload_items SET state='unknown',updated_at=clock_timestamp() WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND operation_id=${row.operation_id}`;
   await sql`UPDATE browser_upload_jobs SET state='unknown',updated_at=clock_timestamp() WHERE tree_id=${ref.treeId} AND id=${ref.jobId}`;
   await sql`UPDATE browser_upload_stream_requests SET state='unknown',updated_at=clock_timestamp() WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND claim_id=${claimId} AND worker_id=${workerId}`;
   await sql`INSERT INTO audit_events(id,actor_type,actor_id,action,resource_id,outcome,correlation_id,details)
    VALUES(${randomUUID()},${row.principal_kind==="owner"?"web_session":"drop_session"},${row.request_session_id},'browser_tree.stream.execution.unknown',NULL,'failure',${row.operation_id},${sql.json({treeId:ref.treeId,jobId:ref.jobId,itemId:ref.itemId,requestId:request.requestId,authorizationGeneration:request.authorizationGeneration,claimId,workerId})})`;
   this.#assertExecutionLock(permit,ref);return "unknown";
  });
 }
 /** Read the committed original receipt, never an executor's return value.
  * This maintenance step is allowed after session expiry; it neither creates
  * a version nor changes publication, payload or retained spool accounting. */
 async settleExecution(input:BrowserTreeStreamQueuedRequest,permit:BrowserTreeStreamExecutionLock,identity:{readonly claimId:string;readonly workerId:string}):Promise<BrowserTreeStreamSettlement>{
  const request=this.#request(input),ref=request.reference;this.#assertExecutionLock(permit,ref);
  const claimId=identity.claimId,workerId=identity.workerId;if(!uuid.test(claimId)||!uuid.test(workerId))fail("browser_tree_identity_invalid");
  return this.database.transaction(async sql=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-browser-tree-admission',0))`;
   const row=(await sql<{operation_id:string;request_state:string;item_state:string;job_state:string;principal_kind:string;scope_id:string;request_session_id:string;resource_id:string;version_id:string;size_bytes:string;sha256:string;relative_path:string;parent_item_id:string|null;intent_sha256:string;receipt:unknown;drop_upload_id:string|null}[]>`
    SELECT q.operation_id,q.state AS request_state,i.state AS item_state,j.state AS job_state,t.principal_kind,t.scope_id,q.request_session_id,
     i.resource_id,i.version_id,i.size_bytes::text,i.sha256,i.relative_path,i.parent_item_id,j.intent_sha256,i.receipt,i.drop_upload_id
    FROM browser_upload_stream_requests q JOIN browser_upload_trees t ON t.id=q.tree_id
    JOIN browser_upload_items i ON i.tree_id=q.tree_id AND i.item_id=q.item_id AND i.job_id=q.job_id
    JOIN browser_upload_jobs j ON j.tree_id=q.tree_id AND j.id=q.job_id
    JOIN browser_upload_streams s ON s.tree_id=q.tree_id AND s.item_id=q.item_id
    JOIN browser_upload_spool_reservations r ON r.tree_id=q.tree_id AND r.item_id=q.item_id
    WHERE q.tree_id=${ref.treeId} AND q.item_id=${ref.itemId} AND q.job_id=${ref.jobId} AND q.request_id=${request.requestId}
     AND q.authorization_generation=${request.authorizationGeneration} AND q.claim_id=${claimId} AND q.worker_id=${workerId}
     AND q.operation_id=i.operation_id AND t.backend_identity=${this.#options.backendIdentity} AND t.backend_generation=${this.#options.backendGeneration}
     AND s.spool_id=${this.#options.spoolId} AND i.payload_mode='stream' AND j.payload_mode='stream'
     AND s.state='sealed' AND s.expected_size=i.size_bytes AND s.received_size=i.size_bytes AND s.expected_sha256=i.sha256 AND s.seal_sha256=i.sha256
     AND r.operation_id=i.operation_id AND r.spool_id=s.spool_id AND r.expected_size=i.size_bytes
     AND r.backend_identity=t.backend_identity AND r.backend_generation=t.backend_generation AND r.principal_kind=t.principal_kind AND r.scope_id=t.scope_id
    FOR UPDATE OF q,i,j`)[0];
   if(!row||!["claimed","unknown","settled"].includes(row.request_state))fail("browser_tree_reconciliation_required");
   const body=validateBrowserTreeStreamJob({schema:"saturn.browser-tree-stream-job.v1",jobId:ref.jobId,item:{kind:"file",itemId:ref.itemId,parentItemId:row.parent_item_id,relativePath:row.relative_path,sizeBytes:Number(row.size_bytes),sha256:row.sha256}},Number.MAX_SAFE_INTEGER);
   if(body.intentSha256!==row.intent_sha256||!uuid.test(row.resource_id)||!uuid.test(row.version_id))fail("browser_tree_stream_original_invalid");
   let result:BrowserTreeStreamSettlement;
   if(row.job_state==="completed"&&row.item_state==="published"){
    const value=row.receipt;if(!value||typeof value!=="object"||Array.isArray(value))fail("browser_tree_publication_receipt_invalid");
    const receipt=value as Record<string,unknown>,keys=["resourceId","versionId","kind","sizeBytes","sha256","relativePath"];
    if(Object.keys(receipt).length!==keys.length||keys.some(key=>!Object.hasOwn(receipt,key))
     ||receipt.resourceId!==row.resource_id||receipt.versionId!==row.version_id||receipt.kind!=="file"||receipt.sizeBytes!==body.value.item.sizeBytes
     ||receipt.sha256!==row.sha256||receipt.relativePath!==row.relative_path)fail("browser_tree_publication_receipt_invalid");
    // Verify the original version, not resources.current_version_id: a later
    // legitimate overwrite does not undo this original publication receipt.
    const version=await sql`SELECT id FROM file_versions WHERE id=${row.version_id} AND resource_id=${row.resource_id} AND size_bytes=${row.size_bytes}::bigint AND sha256=${row.sha256} FOR SHARE`;
    if(version.length!==1)fail("browser_tree_publication_receipt_invalid");
    result=Object.freeze({outcome:"published",receipt:Object.freeze({resourceId:row.resource_id,versionId:row.version_id,kind:"file",sizeBytes:body.value.item.sizeBytes,sha256:row.sha256,relativePath:row.relative_path})});
   }else if(row.job_state==="cancelled"&&row.item_state==="cancelled"&&row.receipt===null)result=Object.freeze({outcome:"cancelled",receipt:null});
   else fail("browser_tree_execution_not_terminal");
   if(row.principal_kind==="drop"){
    if(row.drop_upload_id!==row.operation_id)fail("browser_tree_drop_original_changed");
    const drop=result.outcome==="published"?await sql`SELECT id FROM drop_uploads WHERE id=${row.operation_id} AND channel_id=${row.scope_id} AND browser_tree_managed AND state='stored' AND resource_id=${row.resource_id}
     AND expected_size=${row.size_bytes}::bigint AND received_size=expected_size AND expected_sha256=${row.sha256} AND actual_sha256=expected_sha256 AND local_path IS NULL`
     :await sql`SELECT id FROM drop_uploads WHERE id=${row.operation_id} AND channel_id=${row.scope_id} AND browser_tree_managed AND state='cancelled' AND local_path IS NULL`;
    if(drop.length!==1)fail("browser_tree_drop_original_changed");
   }else if(row.principal_kind!=="owner"||row.scope_id!=="owner"||row.drop_upload_id!==null)fail("browser_tree_stream_original_invalid");
   if(row.request_state!=="settled"){
    const updated=await sql`UPDATE browser_upload_stream_requests SET state='settled',updated_at=clock_timestamp()
     WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND request_id=${request.requestId} AND claim_id=${claimId} AND worker_id=${workerId} AND state IN ('claimed','unknown') RETURNING request_id`;
    if(updated.length!==1)fail("browser_tree_reconciliation_required");
    await sql`INSERT INTO audit_events(id,actor_type,actor_id,action,resource_id,outcome,correlation_id,details)
     VALUES(${randomUUID()},${row.principal_kind==="owner"?"web_session":"drop_session"},${row.request_session_id},'browser_tree.stream.execution.settle',${result.outcome==="published"?row.resource_id:null},'success',${row.operation_id},${sql.json({treeId:ref.treeId,jobId:ref.jobId,itemId:ref.itemId,requestId:request.requestId,claimId,workerId,result:result.outcome})})`;
   }
   this.#assertExecutionLock(permit,ref);return result;
  });
 }
 /** Stop repeatedly selecting a queued request whose current auth/destination
  * refuses execution. Only explicit reauthorization can rearm this same row. */
 async blockQueuedExecution(input:BrowserTreeStreamQueuedRequest,permit:BrowserTreeStreamExecutionLock,reason:BrowserTreeStreamBlockedReason):Promise<boolean>{
  const request=this.#request(input),ref=request.reference;this.#assertExecutionLock(permit,ref);
  if(!["browser_tree_authorization_changed","browser_tree_file_too_large","browser_tree_destination_unavailable","browser_tree_drop_original_changed"].includes(reason))fail("browser_tree_identity_invalid");
  return this.database.transaction(async sql=>{
   await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-browser-tree-admission',0))`;
   const row=(await sql<{operation_id:string;principal_kind:string;request_session_id:string}[]>`
    SELECT q.operation_id,t.principal_kind,q.request_session_id FROM browser_upload_stream_requests q JOIN browser_upload_trees t ON t.id=q.tree_id
    JOIN browser_upload_items i ON i.tree_id=q.tree_id AND i.item_id=q.item_id AND i.job_id=q.job_id
    JOIN browser_upload_jobs j ON j.tree_id=q.tree_id AND j.id=q.job_id JOIN browser_upload_streams s ON s.tree_id=q.tree_id AND s.item_id=q.item_id
    WHERE q.tree_id=${ref.treeId} AND q.item_id=${ref.itemId} AND q.job_id=${ref.jobId} AND q.request_id=${request.requestId} AND q.authorization_generation=${request.authorizationGeneration}
     AND q.state='queued' AND q.claim_id IS NULL AND q.worker_id IS NULL AND j.state='accepted' AND i.state='reserved' AND q.operation_id=i.operation_id
     AND t.backend_identity=${this.#options.backendIdentity} AND t.backend_generation=${this.#options.backendGeneration} AND s.spool_id=${this.#options.spoolId}
    FOR UPDATE OF q,i,j`)[0];if(!row)return false;
   const changed=await sql`UPDATE browser_upload_stream_requests SET state='blocked',updated_at=clock_timestamp() WHERE tree_id=${ref.treeId} AND item_id=${ref.itemId} AND state='queued' RETURNING request_id`;
   if(changed.length!==1)fail("browser_tree_reconciliation_required");
   await sql`INSERT INTO audit_events(id,actor_type,actor_id,action,resource_id,outcome,correlation_id,details)
    VALUES(${randomUUID()},${row.principal_kind==="owner"?"web_session":"drop_session"},${row.request_session_id},'browser_tree.stream.execution.block',NULL,'denied',${row.operation_id},${sql.json({treeId:ref.treeId,jobId:ref.jobId,itemId:ref.itemId,requestId:request.requestId,authorizationGeneration:request.authorizationGeneration,reason})})`;
   this.#assertExecutionLock(permit,ref);return true;
  });
 }
 async cancelBeforeExecution(proof:BrowserTreeAuthority,treeId:string,jobId:string):Promise<BrowserTreeJobStatus>{
  const p=this.authority.credentialsForDatabase(proof);this.#ids(treeId,jobId);const observed=await this.inspect(proof,treeId,jobId);
  return this.database.withAdvisoryLock(`saturn-browser-stream:${treeId}:${observed.reference.itemId}`,()=>this.database.transaction(async sql=>{
   await this.#authorize(sql,p);if(!await this.#tree(sql,p,treeId))fail("browser_tree_not_found");
   const job=(await sql<JobRow[]>`SELECT id,intent_sha256,state,payload_mode FROM browser_upload_jobs WHERE tree_id=${treeId} AND id=${jobId} FOR UPDATE`)[0];if(!job)fail("browser_tree_not_found");
   const original=await this.#original(sql,treeId,job);if(job.state==="completed"||job.state==="cancelled")return original.status;
   if(original.reference.itemId!==observed.reference.itemId||job.state!=="accepted"||requiredValue(original.status.items[0]).state!=="reserved")fail("browser_tree_reconciliation_required");
   const item=(await sql<{size_bytes:string;drop_upload_id:string|null}[]>`SELECT size_bytes::text,drop_upload_id FROM browser_upload_items WHERE tree_id=${treeId} AND item_id=${original.reference.itemId} FOR UPDATE`)[0];if(!item)fail("browser_tree_stream_original_invalid");
   await sql`UPDATE browser_upload_items SET state='cancelled',drop_mutation_tx=pg_current_xact_id(),updated_at=clock_timestamp() WHERE tree_id=${treeId} AND item_id=${original.reference.itemId}`;
   if(p.kind==="drop"){
    if(item.drop_upload_id===null)fail("browser_tree_stream_original_invalid");
    const updated=await sql`UPDATE drop_uploads SET state='cancelled',updated_at=clock_timestamp() WHERE id=${item.drop_upload_id} AND channel_id=${p.scopeId} AND browser_tree_managed AND state='reserved' AND local_path IS NULL RETURNING id`;
    if(updated.length!==1)fail("browser_tree_drop_original_changed");
    const counter=await sql`UPDATE drop_channels SET reserved_files=reserved_files-1,reserved_bytes=reserved_bytes-${item.size_bytes}::bigint WHERE id=${p.scopeId} AND reserved_files>=1 AND reserved_bytes>=${item.size_bytes}::bigint RETURNING id`;
    if(counter.length!==1)fail("browser_tree_quota_original_changed");
    await sql`UPDATE drop_sessions s SET reserved_files=c.reserved_files,reserved_bytes=c.reserved_bytes FROM drop_channels c WHERE c.id=${p.scopeId} AND s.channel_id=c.id`;
   }
   await sql`UPDATE browser_upload_jobs SET state='cancelled',updated_at=clock_timestamp() WHERE tree_id=${treeId} AND id=${jobId}`;
   // The full disk promise is deliberately STILL retained. Only exact terminal
   // cleanup can release it after all physical chunks are gone.
   return (await this.#original(sql,treeId,{...job,state:"cancelled"})).status;
  }));
 }
}
