import { requireTestValue } from "../../contracts/src/test-support.js";
import {randomUUID} from "node:crypto";
import type {Database} from "@saturn/database";
import type {TransactionSql} from "postgres";
import {describe,expect,it,vi} from "vitest";
import {BrowserTreeAuthorityIssuer} from "./browser-upload-tree-authority.js";
import {PostgresBrowserTreeStreamDatabase,type BrowserTreeStreamDatabaseOptions,type BrowserTreeStreamExecutionLock} from "./browser-upload-tree-stream-database.js";
import {validateBrowserTreeStreamJob} from "./browser-upload-tree-stream-contract.js";

function fixture(){
 const sessionId=randomUUID(),channelId=randomUUID(),rootId=randomUUID(),calls:string[]=[];
 const options:BrowserTreeStreamDatabaseOptions={backendIdentity:"test",backendGeneration:randomUUID(),spoolId:randomUUID(),maximumFileBytes:4194304,globalSpoolBytes:16777216,continuationTtlMs:3600000};
 const respond=vi.fn((query:string):unknown[]=>{
  if(query.includes("FROM web_sessions")||query.includes("FROM drop_sessions")||query.includes("FROM drop_channels"))return [{id:sessionId}];
  if(query.includes("FROM owner_credentials"))return [{owner_id:"owner"}];
  if(query.includes("FROM sync_backend_executor"))return [{backend_identity:"test"}];
  if(query.includes("FROM owner_preferences"))return [{upload_buffer_gib:2,maximum_upload_file_gib:1}];
  if(query.includes("FROM browser_upload_spool_budget"))return [{maximum_bytes:"16777216"}];return [];
 });
 // Deliberately limited SQL response double: verifies pre-effect refusals and
 // original replay control flow only. It does NOT execute or prove the SQL.
 const sql=(async(strings:TemplateStringsArray,..._values:unknown[])=>{void _values;const query=strings.join("?");calls.push(query);return respond(query);}) as unknown as TransactionSql;
 Object.assign(sql,{json:(value:unknown)=>value});
 const transaction=vi.fn(async(action:(sql:TransactionSql)=>Promise<unknown>)=>action(sql)),lock=vi.fn();
 const database={transaction,withAdvisoryLock:lock} as unknown as Database;
 const issuer=new BrowserTreeAuthorityIssuer({ownerSession:async()=>({id:sessionId,tokenHash:"1".repeat(64),credentialRevision:"1"}),dropSession:async()=>({id:sessionId,channelId,tokenHash:"2".repeat(64)})});
 const store=new PostgresBrowserTreeStreamDatabase(database,issuer,options),body={schema:"saturn.browser-tree-stream-job.v1",jobId:randomUUID(),item:{kind:"file",itemId:randomUUID(),parentItemId:null,relativePath:"large.bin",sizeBytes:262145,sha256:"a".repeat(64)}};
 return {database,issuer,store,body,options,transaction,lock,respond,calls,rootId,sessionId,channelId};
}
describe("fixed stream metadata admission boundaries",()=>{
 it("refuses invalid configured bounds and spool identity before opening any transaction",()=>{
  const f=fixture();for(const options of [{...f.options,spoolId:"bad"},{...f.options,maximumFileBytes:262144},{...f.options,globalSpoolBytes:262145},{...f.options,continuationTtlMs:0}])expect(()=>new PostgresBrowserTreeStreamDatabase(f.database,f.issuer,options)).toThrow("configuration_invalid");expect(f.transaction).not.toHaveBeenCalled();
 });
 it("rejects malformed path, identity, full hash and inline bytes before SQL",async()=>{
  const f=fixture(),proof=await f.issuer.ownerSession({},f.rootId);
  for(const body of [{...f.body,item:{...f.body.item,relativePath:"../large"}},{...f.body,item:{...f.body.item,contentBase64:"eA=="}},{...f.body,item:{...f.body.item,sha256:"wrong"}},{...f.body,jobId:"bad"}])await expect(f.store.admit(proof,randomUUID(),body)).rejects.toThrow();
  await expect(f.store.inspect(proof,"bad",randomUUID())).rejects.toThrow("identity_invalid");expect(f.transaction).not.toHaveBeenCalled();
 });
 it("rejects another issuer or forged proof before SQL or cancellation locks",async()=>{
  const f=fixture(),other=fixture(),proof=await other.issuer.ownerSession({},f.rootId);
  await expect(f.store.admit(proof,randomUUID(),f.body)).rejects.toThrow("authority_invalid");await expect(f.store.cancelBeforeExecution({proof:"saturn.browser-tree-authority.v1"},randomUUID(),randomUUID())).rejects.toThrow("authority_invalid");expect(f.transaction).not.toHaveBeenCalled();expect(f.lock).not.toHaveBeenCalled();
 });
 it.each(["owner","drop"])("checks current %s session under shared lock before any new metadata",async kind=>{
  const f=fixture(),proof=kind==="owner"?await f.issuer.ownerSession({},f.rootId):await f.issuer.dropSession({}),response=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes("FROM web_sessions")||query.includes("FROM drop_sessions")?[]:response(query));
  await expect(f.store.admit(proof,randomUUID(),f.body)).rejects.toThrow("authorization_changed");expect(f.calls[0]).toContain("saturn-drop-buffer-reservation");expect(f.calls[1]).toContain("saturn-browser-tree-admission");expect(f.calls.some(query=>/INSERT|UPDATE /.test(query.replaceAll("FOR UPDATE","")))).toBe(false);
 });
 it("refuses an oversized new stream before inserting a tree, job or Drop reservation",async()=>{
  const f=fixture(),proof=await f.issuer.ownerSession({},f.rootId);
  await expect(f.store.admit(proof,randomUUID(),{...f.body,item:{...f.body.item,sizeBytes:4194305}})).rejects.toThrow("file_too_large");expect(f.calls.some(query=>query.includes("INSERT"))).toBe(false);
 });
 it("includes the canonical retained-byte total before admitting any part of a new original",async()=>{
  const f=fixture(),proof=await f.issuer.ownerSession({},f.rootId),response=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes("SELECT coalesce(sum(bytes)")?[{bytes:"16777216"}]:response(query));
  await expect(f.store.admit(proof,randomUUID(),f.body)).rejects.toThrow("quota_exhausted");expect(f.calls.some(query=>query.includes("INSERT"))).toBe(false);
 });
 it("refuses unconfigured or looser-than-constructor physical budget before new effects",async()=>{
  const f=fixture(),proof=await f.issuer.ownerSession({},f.rootId),response=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes("FROM browser_upload_spool_budget")?[]:response(query));await expect(f.store.admit(proof,randomUUID(),f.body)).rejects.toThrow("quota_unconfigured");
  f.respond.mockImplementation(query=>query.includes("FROM browser_upload_spool_budget")?[{maximum_bytes:"16777217"}]:response(query));await expect(f.store.admit(proof,randomUUID(),f.body)).rejects.toThrow("configuration_invalid");expect(f.calls.some(query=>query.includes("INSERT"))).toBe(false);
 });
 it("does not disclose a tree belonging to another principal or destination",async()=>{
  const f=fixture(),proof=await f.issuer.ownerSession({},f.rootId),response=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes("SELECT * FROM browser_upload_trees")?[{principal_kind:"drop",scope_id:f.channelId,root_id:randomUUID()}]:response(query));
  await expect(f.store.inspect(proof,randomUUID(),randomUUID())).rejects.toThrow("not_found");expect(f.calls.some(query=>query.includes("FROM browser_upload_jobs"))).toBe(false);
 });
 it("returns an already admitted original without touching new-admission caps or minting IDs",async()=>{
  const f=fixture(),proof=await f.issuer.ownerSession({},f.rootId),treeId=randomUUID(),job=validateBrowserTreeStreamJob(f.body,Number.MAX_SAFE_INTEGER),response=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>{
   if(query.includes("SELECT * FROM browser_upload_trees"))return [{id:treeId,principal_kind:"owner",scope_id:"owner",root_id:f.rootId,backend_identity:"historical",backend_generation:randomUUID()}];
   if(query.includes("SELECT id,intent_sha256,state,payload_mode FROM browser_upload_jobs"))return [{id:f.body.jobId,intent_sha256:job.intentSha256,state:"accepted",payload_mode:"stream"}];
   if(query.includes("FROM browser_upload_items i JOIN browser_upload_streams"))return [{item_id:f.body.item.itemId,parent_item_id:null,relative_path:"large.bin",kind:"file",state:"reserved",receipt:null,size_bytes:"262145",drop_upload_id:null}];
   return response(query);
  });
  const result=await f.store.admit(proof,treeId,f.body);expect(result.reference).toEqual({treeId,jobId:f.body.jobId,itemId:f.body.item.itemId});expect(result.status.intentSha256).toBe(job.intentSha256);
  expect(f.calls.some(query=>query.includes("INSERT")||query.includes("FROM browser_upload_spool_budget")||query.includes("FROM sync_backend_executor"))).toBe(false);
  await expect(f.store.admit(proof,treeId,{...f.body,item:{...f.body.item,sha256:"b".repeat(64)}})).rejects.toThrow("original_reused");
 });
});

async function executionFixture(){
 const f=fixture(),treeId=randomUUID(),operationId=randomUUID(),intent=validateBrowserTreeStreamJob(f.body,Number.MAX_SAFE_INTEGER),proof=await f.issuer.ownerSession({},f.rootId);
 const base=requireTestValue(f.respond.getMockImplementation()),root="00000000-0000-7000-8000-000000000001";let ancestry=0;
 const job={id:f.body.jobId,intent_sha256:intent.intentSha256,state:"accepted",payload_mode:"stream"};
 const item={item_id:f.body.item.itemId,parent_item_id:null,relative_path:"large.bin",kind:"file",state:"reserved",receipt:null,size_bytes:"262145",drop_upload_id:null};
 const sealed={operation_id:operationId,size_bytes:"262145",sha256:f.body.item.sha256,parent_item_id:null,relative_path:"large.bin",spool_id:f.options.spoolId,state:"sealed",received_size:"262145",seal_sha256:f.body.item.sha256,reservation_state:"retained"};
 f.lock.mockImplementation(async(_key:string,action:()=>Promise<unknown>)=>action());
 f.respond.mockImplementation(query=>{
  if(query.includes("SELECT * FROM browser_upload_trees"))return [{id:treeId,principal_kind:"owner",scope_id:"owner",root_id:f.rootId,backend_identity:f.options.backendIdentity,backend_generation:f.options.backendGeneration}];
  if(query.includes("SELECT id,intent_sha256,state,payload_mode FROM browser_upload_jobs"))return [job];
  if(query.includes("SELECT i.operation_id,i.size_bytes"))return [sealed];
  if(query.includes("FROM browser_upload_items i JOIN browser_upload_streams"))return [item];
  if(query.includes("FROM resources WHERE id="))return ancestry++%2===0?[{id:f.rootId,parent_id:root,name:"scope",storage_path:"scope",guarded:false}]:[{id:root,parent_id:null,name:"root",storage_path:"",guarded:false}];
  return base(query);
 });
 return {...f,treeId,proof,reference:{treeId,jobId:f.body.jobId,itemId:f.body.item.itemId},job,item,sealed};
}
describe("durable stream execution request boundary (SQL double, not native proof)",()=>{
 it("authenticates before DB or original lock for a forged request",async()=>{
  const f=await executionFixture();await expect(f.store.requestExecution({proof:"saturn.browser-tree-authority.v1"},f.reference)).rejects.toThrow("authority_invalid");expect(f.lock).not.toHaveBeenCalled();expect(f.transaction).not.toHaveBeenCalled();
 });
 it("joins the same stream lock and commits request plus individual audit before returning accepted",async()=>{
  const f=await executionFixture(),status=await f.store.requestExecution(f.proof,f.reference);
  expect(status.state).toBe("accepted");expect(requireTestValue(f.lock.mock.calls[0])[0]).toBe(`saturn-browser-stream:${f.treeId}:${f.reference.itemId}`);
  expect(f.calls.filter(q=>q.startsWith("INSERT INTO browser_upload_stream_requests"))).toHaveLength(1);expect(f.calls.filter(q=>q.startsWith("INSERT INTO audit_events"))).toHaveLength(1);
  expect(f.calls.some(q=>q.includes("UPDATE browser_upload_jobs")||q.includes("INSERT INTO browser_upload_items"))).toBe(false);
 });
 it("a current-auth replay returns the same queued original without replacement or repeated audit",async()=>{
  const f=await executionFixture(),base=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes("FROM browser_upload_stream_requests")?[{state:"queued",request_session_id:f.sessionId,request_credential_revision:"1"}]:base(query));
  expect((await f.store.requestExecution(f.proof,f.reference)).state).toBe("accepted");expect(f.calls.some(q=>q.includes("INSERT INTO")||q.includes("UPDATE browser_upload_stream_requests"))).toBe(false);
 });
 it("explicit current reauthentication rearms only the queued/blocked original without creating an ID",async()=>{
  const f=await executionFixture(),base=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes("FROM browser_upload_stream_requests")?[{state:"blocked",request_session_id:randomUUID(),request_credential_revision:"1"}]:base(query));
  await f.store.requestExecution(f.proof,f.reference);expect(f.calls.filter(q=>q.startsWith("UPDATE browser_upload_stream_requests"))).toHaveLength(1);
  expect(f.calls.find(q=>q.startsWith("UPDATE browser_upload_stream_requests"))).toContain("authorization_generation=authorization_generation+1");expect(f.calls.some(q=>q.startsWith("INSERT INTO browser_upload_stream_requests"))).toBe(false);
 });
 it.each(["claimed","unknown","settled"])("never steals %s execution because its caller retries",async state=>{
  const f=await executionFixture(),base=requireTestValue(f.respond.getMockImplementation());f.respond.mockImplementation(query=>query.includes("FROM browser_upload_stream_requests")?[{state,request_session_id:f.sessionId,request_credential_revision:"1"}]:base(query));
  await expect(f.store.requestExecution(f.proof,f.reference)).rejects.toThrow("reconciliation_required");expect(f.calls.some(q=>q.includes("INSERT INTO")||q.includes("UPDATE browser_upload_stream_requests"))).toBe(false);
 });
 it("missing/changed full seal or released spool refuses before queue admission",async()=>{
  for(const change of [{state:"receiving"},{received_size:"262144"},{seal_sha256:"b".repeat(64)},{reservation_state:"released"},{spool_id:randomUUID()}]){
   const f=await executionFixture();Object.assign(f.sealed,change);await expect(f.store.requestExecution(f.proof,f.reference)).rejects.toThrow();expect(f.calls.some(q=>q.includes("INSERT INTO"))).toBe(false);
  }
 });
 it("the current session, current maximum and parent guard are checked before requesting execution",async()=>{
  for(const replacement of ["auth","maximum","parent"]){
   const f=await executionFixture(),base=requireTestValue(f.respond.getMockImplementation());
   f.respond.mockImplementation(query=>replacement==="auth"&&query.includes("FROM web_sessions")?[]:replacement==="maximum"&&query.includes("FROM owner_preferences")?[{maximum_upload_file_gib:1/8192}]:replacement==="parent"&&query.includes("FROM resources WHERE")?[{id:f.rootId,parent_id:null,name:"scope",storage_path:"scope",guarded:true}]:base(query));
   await expect(f.store.requestExecution(f.proof,f.reference)).rejects.toThrow();expect(f.calls.some(q=>q.includes("INSERT INTO"))).toBe(false);
  }
 });
 it("running/terminal status never queues another execution and foreign item IDs reveal nothing",async()=>{
  const f=await executionFixture();f.job.state="running";expect((await f.store.requestExecution(f.proof,f.reference)).state).toBe("running");expect(f.calls.some(q=>q.includes("FROM browser_upload_stream_requests"))).toBe(false);
  await expect(f.store.requestExecution(f.proof,{...f.reference,itemId:randomUUID()})).rejects.toThrow("not_found");
 });
});

async function claimFixture(){
 const f=await executionFixture(),request={reference:f.reference,requestId:randomUUID(),authorizationGeneration:3};
 const queued={operation_id:f.sealed.operation_id,state:"queued",request_id:request.requestId,authorization_generation:"3",request_session_id:f.sessionId,request_credential_revision:"1"};
 const base=requireTestValue(f.respond.getMockImplementation());
 f.respond.mockImplementation(query=>{
  if(query.includes('SELECT operation_id,state,request_id'))return [queued];
  if(query.startsWith('UPDATE browser_upload_jobs'))return [{id:f.reference.jobId}];
  if(query.startsWith('UPDATE browser_upload_stream_requests'))return [{request_id:request.requestId}];
  return base(query);
 });
 const identity={claimId:randomUUID(),workerId:randomUUID()};
 return {...f,request,queued,identity,run:()=>f.store.withExecutionLock(request,permit=>f.store.claimExecution(f.proof,request,permit,identity))};
}
describe("durable worker discovery/claim source (SQL double, not native proof)",()=>{
 it("claims the exact queued generation atomically after current execution checks",async()=>{
  const f=await claimFixture(),claim=await f.run();
  expect(claim).toEqual({...f.request,...f.identity,operationId:f.sealed.operation_id});
  const job=f.calls.findIndex(q=>q.startsWith('UPDATE browser_upload_jobs')),request=f.calls.findIndex(q=>q.startsWith('UPDATE browser_upload_stream_requests'));
  expect(job).toBeGreaterThan(f.calls.findIndex(q=>q.includes('FROM resources WHERE')));expect(request).toBeGreaterThan(job);
  expect(f.calls.filter(q=>q.startsWith('INSERT INTO audit_events'))).toHaveLength(1);
  expect(f.calls.some(q=>q.startsWith('INSERT INTO browser_upload_stream_requests')||q.startsWith('UPDATE browser_upload_items'))).toBe(false);
 });
 it("rejects forged, foreign and expired execution-lock permits before SQL",async()=>{
  const f=await claimFixture(),other=await claimFixture();
  await expect(f.store.claimExecution(f.proof,f.request,{} as BrowserTreeStreamExecutionLock,f.identity)).rejects.toThrow('execution_lock_invalid');
  let saved!:BrowserTreeStreamExecutionLock;
  await f.store.withExecutionLock(f.request,async permit=>{saved=permit;
   await expect(other.store.claimExecution(other.proof,other.request,permit,other.identity)).rejects.toThrow('execution_lock_invalid');
  });
  await expect(f.store.claimExecution(f.proof,f.request,saved,f.identity)).rejects.toThrow('execution_lock_invalid');
  expect(f.transaction).not.toHaveBeenCalled();expect(other.transaction).not.toHaveBeenCalled();
 });
 it.each(['claimed','unknown','blocked','settled'])("never claims a %s row by replay or age",async state=>{
  const f=await claimFixture();f.queued.state=state;await expect(f.run()).rejects.toThrow('reconciliation_required');
  expect(f.calls.some(q=>q.startsWith('UPDATE '))).toBe(false);
 });
 it("refuses a reauthorized generation or different requester before changing durable state",async()=>{
  for(const change of [{authorization_generation:'4'},{request_id:randomUUID()},{request_session_id:randomUUID()},{request_credential_revision:'2'}]){
   const f=await claimFixture();Object.assign(f.queued,change);await expect(f.run()).rejects.toThrow();expect(f.calls.some(q=>q.startsWith('UPDATE '))).toBe(false);
  }
 });
 it("refuses current auth, changed seal, released quota and guarded destination before claim",async()=>{
  for(const scenario of ['auth','seal','quota','parent']){
   const f=await claimFixture(),base=requireTestValue(f.respond.getMockImplementation());
   if(scenario==='seal')f.sealed.seal_sha256='b'.repeat(64);if(scenario==='quota')f.sealed.reservation_state='released';
   f.respond.mockImplementation(query=>scenario==='auth'&&query.includes('FROM web_sessions')?[]:scenario==='parent'&&query.includes('FROM resources WHERE')?[{id:f.rootId,parent_id:null,name:'scope',storage_path:'scope',guarded:true}]:base(query));
   await expect(f.run()).rejects.toThrow();expect(f.calls.some(q=>q.startsWith('UPDATE '))).toBe(false);
  }
 });
 it("does not acknowledge a claim if the final transaction commit is lost",async()=>{
  const f=await claimFixture(),run=requireTestValue(f.transaction.getMockImplementation());
  f.transaction.mockImplementation(async action=>{await run(action);throw Error('commit reply lost');});
  await expect(f.run()).rejects.toThrow('commit reply lost');
  expect(f.calls.filter(q=>q.startsWith('UPDATE browser_upload_stream_requests'))).toHaveLength(1);
  expect(f.calls.filter(q=>q.startsWith('INSERT INTO audit_events'))).toHaveLength(1);
 });
 it("discovers at most two exact queued references without claiming or exposing session hashes",async()=>{
  const f=await claimFixture(),base=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes('SELECT q.tree_id,q.job_id')?[{tree_id:f.reference.treeId,job_id:f.reference.jobId,item_id:f.reference.itemId,request_id:f.request.requestId,authorization_generation:'3'}]:base(query));
  expect(await f.store.listExecutionRequests()).toEqual([f.request]);
  expect(f.calls.some(q=>q.startsWith('UPDATE ')||q.includes('token_hash'))).toBe(false);
  expect(()=>f.store.listExecutionRequests(3)).toThrow('execution_capacity');
 });
 it("retains a matching uncertain claim without current session authority or quota release",async()=>{
  const f=await claimFixture(),base=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes('SELECT q.operation_id,q.state AS request_state')?[{operation_id:f.sealed.operation_id,request_state:'claimed',item_state:'materializing',job_state:'running',principal_kind:'owner',request_session_id:f.sessionId}]:base(query));
  const outcome=await f.store.withExecutionLock(f.request,permit=>f.store.retainExecutionUnknown(f.request,permit,f.identity));expect(outcome).toBe('unknown');
  expect(f.calls.filter(q=>q.startsWith('UPDATE '))).toHaveLength(3);
  expect(f.calls.some(q=>q.includes('FROM web_sessions')||q.includes('UPDATE browser_upload_spool_reservations'))).toBe(false);
  expect(f.calls.filter(q=>q.startsWith('INSERT INTO audit_events'))).toHaveLength(1);
 });
 it("does not mark a different or uncommitted claim UNKNOWN",async()=>{
  const f=await claimFixture();
  expect(await f.store.withExecutionLock(f.request,permit=>f.store.retainExecutionUnknown(f.request,permit,f.identity))).toBe('not_claimed');
  expect(f.calls.some(q=>q.startsWith('UPDATE ')||q.startsWith('INSERT '))).toBe(false);
 });
 it.each([['completed','published','claimed','terminal'],['cancelled','cancelled','settled','terminal'],['unknown','unknown','unknown','unknown']])("preserves an already %s/%s original without a repeated failure audit",async(jobState,itemState,requestState,expected)=>{
  const f=await claimFixture(),base=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes('SELECT q.operation_id,q.state AS request_state')?[{operation_id:f.sealed.operation_id,request_state:requestState,item_state:itemState,job_state:jobState,principal_kind:'owner',request_session_id:f.sessionId}]:base(query));
  expect(await f.store.withExecutionLock(f.request,permit=>f.store.retainExecutionUnknown(f.request,permit,f.identity))).toBe(expected);
  expect(f.calls.some(q=>q.startsWith('UPDATE ')||q.startsWith('INSERT '))).toBe(false);
 });
});

async function settlementFixture(){
 const f=await claimFixture(),resourceId=randomUUID(),versionId=randomUUID();
 const receipt={resourceId,versionId,kind:'file',sizeBytes:f.body.item.sizeBytes,sha256:f.body.item.sha256,relativePath:f.body.item.relativePath};
 const row={operation_id:f.sealed.operation_id,request_state:'claimed',item_state:'published',job_state:'completed',principal_kind:'owner',scope_id:'owner',request_session_id:f.sessionId,
  resource_id:resourceId,version_id:versionId,size_bytes:String(f.body.item.sizeBytes),sha256:f.body.item.sha256,relative_path:f.body.item.relativePath,parent_item_id:null,intent_sha256:f.job.intent_sha256,receipt:receipt as unknown,drop_upload_id:null as string|null};
 const base=requireTestValue(f.respond.getMockImplementation());
 f.respond.mockImplementation(query=>{
  if(query.includes('SELECT q.operation_id,q.state AS request_state'))return [row];
  if(query.includes('FROM file_versions'))return [{id:versionId}];
  if(query.includes('FROM drop_uploads'))return [{id:row.operation_id}];return base(query);
 });
 return {...f,row,receipt,settle:()=>f.store.withExecutionLock(f.request,permit=>f.store.settleExecution(f.request,permit,f.identity))};
}
describe('canonical terminal settlement and queued blocking (SQL doubles)',()=>{
 it('settles only the original committed receipt/version without releasing spool or requiring current auth',async()=>{
  const f=await settlementFixture();expect(await f.settle()).toEqual({outcome:'published',receipt:f.receipt});
  expect(f.calls.some(q=>q.includes('FROM file_versions'))).toBe(true);
  expect(f.calls.some(q=>q.includes('current_version_id')||q.includes('FROM web_sessions')||q.startsWith('UPDATE browser_upload_spool_reservations')||q.startsWith('UPDATE browser_upload_items'))).toBe(false);
  expect(f.calls.filter(q=>q.startsWith('UPDATE browser_upload_stream_requests'))).toHaveLength(1);expect(f.calls.filter(q=>q.startsWith('INSERT INTO audit_events'))).toHaveLength(1);
 });
 it('replays a settled receipt without another transition or audit',async()=>{
  const f=await settlementFixture();f.row.request_state='settled';expect(await f.settle()).toEqual({outcome:'published',receipt:f.receipt});
  expect(f.calls.some(q=>q.startsWith('UPDATE ')||q.startsWith('INSERT '))).toBe(false);
 });
 it('does not settle a claimed row whose file is merely buffered or verified',async()=>{
  for(const state of ['reserved','materializing','verified','publishing','unknown']){
   const f=await settlementFixture();f.row.item_state=state;f.row.job_state='running';f.row.receipt=null;
   await expect(f.settle()).rejects.toThrow('not_terminal');expect(f.calls.some(q=>q.startsWith('UPDATE '))).toBe(false);
  }
 });
 it('refuses missing, foreign, changed or nonclosed publication receipts before any acknowledgement',async()=>{
  for(const patch of [null,{}, {resourceId:randomUUID()},{versionId:randomUUID()},{sha256:'b'.repeat(64)},{sizeBytes:262144},{relativePath:'other.bin'},{kind:'directory'},{unexpected:'private-path'}]){
   const f=await settlementFixture();f.row.receipt=patch===null?null:{...f.receipt,...patch};
   if(patch!==null&&Object.keys(patch).length===0)f.row.receipt={};
   await expect(f.settle()).rejects.toThrow('receipt_invalid');expect(f.calls.some(q=>q.startsWith('UPDATE ')||q.startsWith('INSERT '))).toBe(false);
  }
 });
 it('requires the exact original version even if a published marker exists',async()=>{
  const f=await settlementFixture(),base=requireTestValue(f.respond.getMockImplementation());f.respond.mockImplementation(query=>query.includes('FROM file_versions')?[]:base(query));
  await expect(f.settle()).rejects.toThrow('receipt_invalid');expect(f.calls.some(q=>q.startsWith('UPDATE '))).toBe(false);
 });
 it('requires matching Drop stored state rather than counting its incoming buffer',async()=>{
  const f=await settlementFixture(),base=requireTestValue(f.respond.getMockImplementation());f.row.principal_kind='drop';f.row.scope_id=f.channelId;f.row.drop_upload_id=f.row.operation_id;
  f.respond.mockImplementation(query=>query.includes('FROM drop_uploads')?[]:base(query));
  await expect(f.settle()).rejects.toThrow('drop_original_changed');expect(f.calls.some(q=>q.startsWith('UPDATE '))).toBe(false);
  f.respond.mockImplementation(base);expect((await f.settle()).outcome).toBe('published');
 });
 it('keeps cancellation distinct from successful publication and refuses a cancelled receipt',async()=>{
  const f=await settlementFixture();f.row.job_state='cancelled';f.row.item_state='cancelled';f.row.receipt=null;
  expect(await f.settle()).toEqual({outcome:'cancelled',receipt:null});expect(f.calls.some(q=>q.includes('FROM file_versions'))).toBe(false);
  f.row.receipt=f.receipt;await expect(f.settle()).rejects.toThrow('not_terminal');
 });
 it('rechecks canonical intent and refuses a stale generation/claim before settlement',async()=>{
  const f=await settlementFixture();f.row.intent_sha256='0'.repeat(64);await expect(f.settle()).rejects.toThrow('original_invalid');
  const base=requireTestValue(f.respond.getMockImplementation());f.respond.mockImplementation(query=>query.includes('SELECT q.operation_id,q.state AS request_state')?[]:base(query));
  await expect(f.settle()).rejects.toThrow('reconciliation_required');expect(f.calls.some(q=>q.startsWith('UPDATE '))).toBe(false);
 });
 it('a lost settlement commit reply is replayed as the same receipt without another audit',async()=>{
  const f=await settlementFixture(),run=requireTestValue(f.transaction.getMockImplementation());
  f.transaction.mockImplementationOnce(async action=>{await run(action);f.row.request_state='settled';throw Error('commit reply lost');});
  await expect(f.settle()).rejects.toThrow('commit reply lost');expect(await f.settle()).toEqual({outcome:'published',receipt:f.receipt});
  expect(f.calls.filter(q=>q.startsWith('INSERT INTO audit_events'))).toHaveLength(1);
 });
 it('blocks only the exact still-queued request without changing job, item or quota',async()=>{
  const f=await claimFixture(),base=requireTestValue(f.respond.getMockImplementation());
  f.respond.mockImplementation(query=>query.includes('SELECT q.operation_id,t.principal_kind,q.request_session_id')?[{operation_id:f.sealed.operation_id,principal_kind:'owner',request_session_id:f.sessionId}]:base(query));
  expect(await f.store.withExecutionLock(f.request,permit=>f.store.blockQueuedExecution(f.request,permit,'browser_tree_authorization_changed'))).toBe(true);
  expect(f.calls.filter(q=>q.startsWith('UPDATE '))).toHaveLength(1);expect(f.calls.find(q=>q.startsWith('UPDATE '))).toContain("SET state='blocked'");
  expect(f.calls.filter(q=>q.startsWith('INSERT INTO audit_events'))).toHaveLength(1);
 });
 it('does not block a replaced, claimed or absent request or accept an arbitrary reason',async()=>{
  const f=await claimFixture();expect(await f.store.withExecutionLock(f.request,permit=>f.store.blockQueuedExecution(f.request,permit,'browser_tree_authorization_changed'))).toBe(false);
  expect(f.calls.some(q=>q.startsWith('UPDATE ')||q.startsWith('INSERT '))).toBe(false);
  const before=f.transaction.mock.calls.length;
  await expect(f.store.withExecutionLock(f.request,permit=>f.store.blockQueuedExecution(f.request,permit,'secret' as 'browser_tree_authorization_changed'))).rejects.toThrow('identity_invalid');
  expect(f.transaction.mock.calls.length).toBe(before);
 });
});
