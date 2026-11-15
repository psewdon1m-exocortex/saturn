import { fixtureValue } from './test-values.fixture.js';
import "reflect-metadata";
import {randomUUID} from "node:crypto";
import {EventEmitter} from "node:events";
import {describe,it,expect,vi,beforeAll,afterAll} from "vitest";
import fastify from "fastify";
import {fastifyCookie} from "@fastify/cookie";
import type {Database} from "@saturn/database";
import type {SaturnConfig} from "@saturn/config";
import type {OwnerSession,SessionValidationInput} from "@saturn/auth";
import type {DropSession,DropSessionValidationInput} from "@saturn/drop";
import type {FastifyRequest,FastifyReply} from "fastify";
import {createBrowserTreeHttpAuthority,BrowserTreeHttpService} from "./browser-upload-tree.service.js";
import {OwnerBrowserTreeController,DropBrowserTreeController,withBrowserTreeRequest,browserTreeHttpError} from "./browser-upload-tree.controller.js";
import {OWNER_SESSION,type AuthenticatedOwnerRequest} from "./owner-token.guard.js";
import {DROP_SESSION,type AuthenticatedDropRequest} from "./drop-session.guard.js";
import {BrowserTreeInputError} from "../../../packages/file-core/src/browser-upload-tree-contract.js";
import type {BrowserTreeJobStatus} from "../../../packages/file-core/src/browser-upload-tree-database.js";
import type {BrowserTreeRunResult} from "../../../packages/file-core/src/browser-upload-tree-runner.js";

// The real cookie plugin initializes its parser during registration, as main.ts
// does. Do not replace authentication parsing with a permissive test mock.
const cookieHost=fastify();
beforeAll(async()=>{await cookieHost.register(fastifyCookie);await cookieHost.ready();});
afterAll(async()=>{await cookieHost.close();});

function fixture(){
 const sessionId=randomUUID(),channelId=randomUUID(),rootId=randomUUID(),treeId=randomUUID(),jobId=randomUUID();
 const ownerSession={id:sessionId,tokenHash:"1".repeat(64)} as OwnerSession,dropSession={id:sessionId,channelId,tokenHash:"2".repeat(64)} as DropSession;
 const validateOwner=vi.fn<(input:SessionValidationInput)=>Promise<OwnerSession>>(async()=>ownerSession),validateDrop=vi.fn<(input:DropSessionValidationInput)=>Promise<DropSession>>(async()=>dropSession);
 const unsafe=vi.fn(async()=>[{revision:"7"}]),database={withSql:vi.fn(async(action:(sql:unknown)=>Promise<unknown>)=>action({unsafe}))} as unknown as Database;
 const authority=createBrowserTreeHttpAuthority({config:{environment:"development"} as SaturnConfig,database,owner:{validateSession:validateOwner},drop:{validateSession:validateDrop}});
 const common={method:"POST",headers:{"user-agent":"test","origin":"https://example.test","x-vault-csrf":"csrf"},raw:Object.assign(new EventEmitter(),{aborted:false})};
 const owner={...common,headers:{...common.headers,cookie:"vault_session_dev=owner-token; vault_csrf_dev=csrf"},[OWNER_SESSION]:{...ownerSession,id:randomUUID()}} as unknown as AuthenticatedOwnerRequest;
 const drop={...common,headers:{...common.headers,cookie:"vault_drop_session_dev=drop-token; vault_drop_csrf_dev=csrf","x-saturn-drop-channel":channelId},[DROP_SESSION]:dropSession} as unknown as AuthenticatedDropRequest;
 const status:BrowserTreeJobStatus={treeId,jobId,intentSha256:"a".repeat(64),state:"accepted",items:[]};
 const store={admit:vi.fn(async()=>status),inspect:vi.fn(async()=>status),cancelBeforeExecution:vi.fn(async()=>status)};
 const runResult:BrowserTreeRunResult={status,outcome:"pending",failures:[]},runner={run:vi.fn(async()=>runResult),close:vi.fn(async()=>undefined)};
 const service=new BrowserTreeHttpService({authority,database:store,runner});
 return {authority,service,store,runner,owner,drop,rootId,treeId,jobId,sessionId,channelId,validateOwner,validateDrop,unsafe};
}
describe("browser tree HTTP boundaries",()=>{
 it("requires a real guarded owner session then revalidates cookie/CSRF and fresh credential revision",async()=>{
  const f=fixture();await expect(f.authority.ownerSession({id:f.sessionId},f.rootId)).rejects.toThrow();
  await expect(f.authority.ownerSession({...f.owner,[OWNER_SESSION]:undefined},f.rootId)).rejects.toThrow();
  const proof=await f.authority.ownerSession(f.owner,f.rootId);expect(f.authority.credentialsForDatabase(proof)).toEqual({kind:"owner",scopeId:"owner",rootId:f.rootId,sessionId:f.sessionId,tokenHash:"1".repeat(64),credentialRevision:"7"});
  expect(f.validateOwner).toHaveBeenCalledExactlyOnceWith({token:"owner-token",userAgent:"test",isMutation:true,origin:"https://example.test",csrfCookie:"csrf",csrfHeader:"csrf"});
  expect(f.unsafe).toHaveBeenCalledTimes(1);expect(JSON.stringify(proof)).not.toContain("tokenHash");
 });
 it("never grants authority from a stale guard marker when current normal authentication refuses",async()=>{
  const f=fixture();f.validateOwner.mockRejectedValueOnce(Object.assign(Error("denied"),{code:"csrf_rejected"}));
  await expect(f.service.owner(f.owner,f.rootId)).rejects.toThrow("denied");expect(f.unsafe).not.toHaveBeenCalled();
  f.validateDrop.mockRejectedValueOnce(Object.assign(Error("expired"),{code:"invalid_session"}));await expect(f.service.drop(f.drop)).rejects.toThrow("expired");
 });
 it("Drop proof binds the current channel and fixed inbox; it never enables expired-upload continuation",async()=>{
  const f=fixture();const proof=await f.service.drop(f.drop),principal=f.authority.credentialsForDatabase(proof);
  expect(principal.kind).toBe("drop");expect(principal.scopeId).toBe(f.channelId);expect(principal.rootId).toBe("00000000-0000-7000-8000-000000000002");
  expect(fixtureValue(f.validateDrop.mock.calls[0])[0]).not.toHaveProperty("allowExpiredUploadId");
  await expect(f.service.drop({...f.drop,headers:{...f.drop.headers,"x-saturn-drop-channel":randomUUID()}})).rejects.toThrow();
  await expect(f.service.drop({...f.drop,headers:{cookie:f.drop.headers.cookie}})).rejects.toThrow();
 });
 it("status authenticates as a read; mutation/CSRF classification comes from actual HTTP method",async()=>{
  const f=fixture();await f.service.owner({...f.owner,method:"GET"},f.rootId);expect(fixtureValue(f.validateOwner.mock.calls[0])[0].isMutation).toBe(false);
  await f.service.drop({...f.drop,method:"DELETE"});expect(fixtureValue(f.validateDrop.mock.calls[0])[0].isMutation).toBe(true);
 });
 it("unqualified production composition advertises no capability and cannot admit work",async()=>{
  const f=fixture(),owner=new OwnerBrowserTreeController(null),drop=new DropBrowserTreeController(null);
  expect(owner.capability(f.owner)).toEqual({schema:"saturn.browser-tree-capability.v1",available:false});expect(drop.capability(f.drop).available).toBe(false);
  expect(()=>owner.capability({} as AuthenticatedOwnerRequest)).toThrow();expect(()=>drop.capability({} as AuthenticatedDropRequest)).toThrow();
  await expect(owner.admit(f.rootId,f.treeId,{},f.owner)).rejects.toMatchObject({status:503});await expect(drop.admit(f.treeId,{},f.drop)).rejects.toMatchObject({status:503});
 });
 it("admission/status do not start effects; execute accepts no caller-chosen task options",async()=>{
  const f=fixture(),owner=new OwnerBrowserTreeController(f.service),drop=new DropBrowserTreeController(f.service);
  await owner.admit(f.rootId,f.treeId,{jobId:f.jobId},f.owner);await drop.inspect(f.treeId,f.jobId,f.drop);expect(f.runner.run).not.toHaveBeenCalled();
  const reply={raw:Object.assign(new EventEmitter(),{writableFinished:false,destroyed:false})} as unknown as FastifyReply;
  await expect(owner.execute(f.rootId,f.treeId,f.jobId,{taskId:randomUUID()},f.owner,reply)).rejects.toMatchObject({status:400});expect(f.runner.run).not.toHaveBeenCalled();
  await owner.execute(f.rootId,f.treeId,f.jobId,{},f.owner,reply);expect(f.runner.run).toHaveBeenCalledTimes(1);
  const call=f.runner.run.mock.calls[0] as unknown as [unknown,string,string,AbortSignal];expect(call.slice(1,3)).toEqual([f.treeId,f.jobId]);expect(call[3]).toBeInstanceOf(AbortSignal);
 });
 it("disconnect aborts new work but joins the execution promise and removes listeners",async()=>{
  const raw=Object.assign(new EventEmitter(),{aborted:false}),socket=Object.assign(new EventEmitter(),{writableFinished:false,destroyed:false});
  let release!:()=>void,observed!:AbortSignal,settled=false;const wait=new Promise<void>(resolve=>{release=resolve;});
  const result=withBrowserTreeRequest({raw} as FastifyRequest,{raw:socket} as unknown as FastifyReply,async signal=>{observed=signal;await wait;return 9;}).finally(()=>{settled=true;});
  socket.emit("close");expect(observed.aborted).toBe(true);await Promise.resolve();expect(settled).toBe(false);release();expect(await result).toBe(9);
  expect(raw.listenerCount("aborted")).toBe(0);expect(socket.listenerCount("close")).toBe(0);
 });
 it.each([true,false])("keeps a completed request eligible after its incoming stream is destroyed, complete=%s",async complete=>{
  const raw=Object.assign(new EventEmitter(),{destroyed:true,complete}),socket=Object.assign(new EventEmitter(),{writableFinished:false,destroyed:false});
  const aborted=await withBrowserTreeRequest({raw} as FastifyRequest,{raw:socket} as unknown as FastifyReply,signal=>Promise.resolve(signal.aborted));
  expect(aborted).toBe(!complete);expect(raw.listenerCount("aborted")).toBe(0);expect(socket.listenerCount("close")).toBe(0);
 });
 it("maps safe capacity/quota/auth errors without disclosing backend paths or SQL",()=>{
  expect(browserTreeHttpError(Error("browser_tree_capacity"))).toEqual({status:429,code:"browser_tree_capacity"});
  expect(browserTreeHttpError(Error("browser_tree_quota_exhausted")).status).toBe(413);
  expect(browserTreeHttpError(Error("browser_tree_authorization_changed")).status).toBe(401);
  expect(browserTreeHttpError(new BrowserTreeInputError("unsafe filename private value"))).toEqual({status:400,code:"browser_tree_input_invalid"});
  expect(browserTreeHttpError(Error("postgres secret /backend/private"))).toEqual({status:500,code:"browser_tree_internal_error"});
 });
 it.each(["browser_tree_spool_custody_retained","browser_tree_spool_custody_changed","browser_tree_spool_close_unconfirmed"])("retains %s for reconciliation without suggesting a timed retry",code=>{
  expect(browserTreeHttpError(Error(code))).toEqual({status:409,code:"browser_tree_reconciliation_required"});
 });
});

