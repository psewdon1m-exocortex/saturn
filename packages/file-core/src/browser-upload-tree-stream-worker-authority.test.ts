import { requireTestValue } from "../../contracts/src/test-support.js";
import {randomUUID} from "node:crypto";
import type {Database} from "@saturn/database";
import type {TransactionSql} from "postgres";
import {expect,it,vi} from "vitest";
import {BrowserTreeStreamWorkerAuthority} from "./browser-upload-tree-stream-worker-authority.js";
import {DROP_POINT_RESOURCE_ID} from "./models.js";

function fixture(kind:"owner"|"drop"="owner"){
 const sessionId=randomUUID(),channelId=randomUUID(),rootId=kind==="owner"?randomUUID():DROP_POINT_RESOURCE_ID;
 const request={reference:{treeId:randomUUID(),jobId:randomUUID(),itemId:randomUUID()},requestId:randomUUID(),authorizationGeneration:7};
 const options={backendIdentity:"local:test",backendGeneration:randomUUID(),spoolId:randomUUID()};
 const row={principal_kind:kind,scope_id:kind==="owner"?"owner":channelId,root_id:rootId,request_session_id:sessionId,request_credential_revision:kind==="owner"?"4":null};
 const calls:{query:string;values:unknown[]}[]=[],respond=vi.fn((query:string):unknown[]=>{
  if(query.includes("FROM browser_upload_stream_requests"))return [row];
  if(query.includes("FROM web_sessions")||query.includes("FROM drop_sessions"))return [{id:sessionId,token_hash:"a".repeat(64)}];
  if(query.includes("FROM owner_credentials"))return [{owner_id:"owner"}];
  if(query.includes("FROM drop_channels"))return [{id:channelId}];return [];
 });
 // SQL double: these cases prove issuance/control-flow boundaries, not actual
 // PostgreSQL locking, auth schema predicates or races between real sessions.
 const sql=(async(strings:TemplateStringsArray,...values:unknown[])=>{const query=strings.join('?');calls.push({query,values});return respond(query);}) as unknown as TransactionSql;
 const transaction=vi.fn(async(action:(sql:TransactionSql)=>Promise<unknown>)=>action(sql));
 const worker=new BrowserTreeStreamWorkerAuthority({transaction} as unknown as Database,options);
 return {worker,request,options,row,calls,respond,transaction,sessionId,channelId,rootId};
}

it("issues an opaque owner proof only from a current exact queued request",async()=>{
 const f=fixture(),proof=await f.worker.forQueuedRequest(f.request);
 expect(f.worker.authority.credentialsForDatabase(proof)).toEqual({kind:"owner",scopeId:"owner",rootId:f.rootId,sessionId:f.sessionId,tokenHash:"a".repeat(64),credentialRevision:"4"});
 expect(JSON.stringify(proof)).toBe('{"proof":"saturn.browser-tree-authority.v1"}');
 expect(requireTestValue(f.calls[0]).query).toContain('saturn-drop-buffer-reservation');expect(requireTestValue(f.calls[1]).query).toContain('saturn-browser-tree-admission');
 const lookup=requireTestValue(f.calls.find(c=>c.query.includes('FROM browser_upload_stream_requests')));
 for(const value of [...Object.values(f.request.reference),f.request.requestId,f.request.authorizationGeneration,...Object.values(f.options)])expect(lookup.values).toContain(value);
 expect(f.calls.some(c=>/INSERT|UPDATE |DELETE/.test(c.query))).toBe(false);
});
it("issues a Drop proof only for the retained channel and fixed Drop root",async()=>{
 const f=fixture("drop"),proof=await f.worker.forQueuedRequest(f.request);
 expect(f.worker.authority.credentialsForDatabase(proof)).toEqual({kind:"drop",scopeId:f.channelId,rootId:DROP_POINT_RESOURCE_ID,sessionId:f.sessionId,tokenHash:"a".repeat(64)});
 expect(requireTestValue(f.calls.find(c=>c.query.includes('FROM drop_sessions'))).values).toEqual([f.sessionId,f.channelId]);
 expect(f.calls.some(c=>c.query.includes('FROM owner_credentials'))).toBe(false);
});
it("rejects malformed request identity or generation before SQL",async()=>{
 const f=fixture();
 for(const request of [{...f.request,requestId:"bad"},{...f.request,reference:{...f.request.reference,itemId:"../escape"}},...[0,1.5,Number.MAX_SAFE_INTEGER+1].map(authorizationGeneration=>({...f.request,authorizationGeneration}))]){
  await expect(f.worker.forQueuedRequest(request)).rejects.toThrow('identity_invalid');
 }
 expect(f.transaction).not.toHaveBeenCalled();
});
it("cannot issue from a caller-supplied principal, session object or copied proof",async()=>{
 const f=fixture(),raw={id:f.sessionId,tokenHash:"a".repeat(64),credentialRevision:"4",channelId:f.channelId};
 await expect(f.worker.authority.ownerSession(raw,f.rootId)).rejects.toThrow('authorization_changed');
 await expect(f.worker.authority.dropSession(raw)).rejects.toThrow('authorization_changed');
 expect(()=>f.worker.authority.credentialsForDatabase({proof:"saturn.browser-tree-authority.v1"})).toThrow('authority_invalid');
 expect(f.transaction).not.toHaveBeenCalled();
});
it.each(["owner","drop"] as const)("refuses an expired or revoked %s request session",async kind=>{
 const f=fixture(kind),base=requireTestValue(f.respond.getMockImplementation());
 f.respond.mockImplementation(query=>query.includes('FROM web_sessions')||query.includes('FROM drop_sessions')?[]:base(query));
 await expect(f.worker.forQueuedRequest(f.request)).rejects.toThrow('authorization_changed');
});
it("refuses a changed owner credential revision",async()=>{
 const f=fixture(),base=requireTestValue(f.respond.getMockImplementation());f.respond.mockImplementation(query=>query.includes('FROM owner_credentials')?[]:base(query));
 await expect(f.worker.forQueuedRequest(f.request)).rejects.toThrow('authorization_changed');
});
it("refuses a revoked or expired Drop channel",async()=>{
 const f=fixture("drop"),base=requireTestValue(f.respond.getMockImplementation());f.respond.mockImplementation(query=>query.includes('FROM drop_channels')?[]:base(query));
 await expect(f.worker.forQueuedRequest(f.request)).rejects.toThrow('authorization_changed');
});
it("does not turn a missing or concurrently changed queued request into fresh authority",async()=>{
 const f=fixture(),base=requireTestValue(f.respond.getMockImplementation());f.respond.mockImplementation(query=>query.includes('FROM browser_upload_stream_requests')?[]:base(query));
 await expect(f.worker.forQueuedRequest(f.request)).rejects.toThrow('authorization_changed');
 expect(f.calls.some(c=>c.query.includes('FROM web_sessions'))).toBe(false);
});
it("refuses a changed Drop root, invalid principal and owner scope before reading session hashes",async()=>{
 for(const [kind,change] of [["drop",{root_id:randomUUID()}],["drop",{request_credential_revision:"4"}],["owner",{scope_id:randomUUID()}],["owner",{principal_kind:"device"}]] as const){
  const f=fixture(kind);Object.assign(f.row,change);await expect(f.worker.forQueuedRequest(f.request)).rejects.toThrow('authorization_changed');
  expect(f.calls.some(c=>c.query.includes('FROM web_sessions')||c.query.includes('FROM drop_sessions'))).toBe(false);
 }
});
it("re-reads authorization on each issuance and rejects a different issuer's proof",async()=>{
 const f=fixture(),other=fixture(),proof=await f.worker.forQueuedRequest(f.request);
 expect(()=>other.worker.authority.credentialsForDatabase(proof)).toThrow('authority_invalid');
 const base=requireTestValue(f.respond.getMockImplementation());f.respond.mockImplementation(query=>query.includes('FROM web_sessions')?[]:base(query));
 await expect(f.worker.forQueuedRequest(f.request)).rejects.toThrow('authorization_changed');expect(f.transaction).toHaveBeenCalledTimes(2);
});
