import {randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {describe,it,expect,vi} from "vitest";
import {BrowserTreeAuthorityIssuer} from "../../../packages/file-core/src/browser-upload-tree-authority.js";
import type {BrowserTreeJobStatus} from "../../../packages/file-core/src/browser-upload-tree-database.js";
import type {BrowserTreeStreamProgressStatus} from "../../../packages/file-core/src/browser-upload-tree-stream-journal.js";
import {BrowserTreeStreamHttpService,type BrowserTreeStreamExecutionRequests} from "./browser-upload-tree-stream.service.js";

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
async function fixture(){
 const rootId=randomUUID(),treeId=randomUUID(),jobId=randomUUID(),itemId=randomUUID(),reference={treeId,jobId,itemId};
 const authority=new BrowserTreeAuthorityIssuer({ownerSession:async()=>({id:randomUUID(),tokenHash:"a".repeat(64),credentialRevision:"7"}),dropSession:async()=>({id:randomUUID(),tokenHash:"b".repeat(64),channelId:randomUUID()})});
 const proof=await authority.ownerSession({},rootId);
 const status:BrowserTreeJobStatus={treeId,jobId,intentSha256:"a".repeat(64),state:"accepted",items:[{itemId,parentItemId:null,relativePath:"large.bin",kind:"file",state:"reserved",receipt:null}]};
 const progress:BrowserTreeStreamProgressStatus={schema:"saturn.browser-tree-stream-status.v1",treeId,jobId,itemId,intentSha256:status.intentSha256,sizeBytes:262145,sha256:"b".repeat(64),sealId:randomUUID(),confirmedOffset:0,state:"receiving",sealSha256:null,lastChunk:null};
 const database={admit:vi.fn(async()=>({reference,status})),inspect:vi.fn(async()=>({reference,status})),cancelBeforeExecution:vi.fn(async()=>status)};
 const journal={inspectProgress:vi.fn(async()=>progress)};
 // Deliberately protocol doubles; these tests do not claim PostgreSQL, FS,
 // normal HTTP authentication or durable background publication evidence.
 const receiver={append:vi.fn(async()=>undefined as never),seal:vi.fn(async()=>undefined as never)};
 const execution={requestExecution:vi.fn(async()=>({...status,state:"running"})),close:vi.fn(async()=>undefined)} satisfies BrowserTreeStreamExecutionRequests;
 const service=new BrowserTreeStreamHttpService({authority,database,journal,receiver,execution,maximumFileBytes:16777216});
 const headers={contentType:"application/offset+octet-stream",contentEncoding:undefined,contentLength:"262145",offset:"0",sha256:progress.sha256};
 const body=()=>Readable.from([Buffer.alloc(262145)],{objectMode:false});
 return {service,proof,authority,database,journal,receiver,execution,rootId,treeId,jobId,itemId,reference,status,progress,headers,body};
}
describe("bounded stream HTTP service",()=>{
 it("returns closed client projections and no private original fields",async()=>{
  const f=await fixture();expect(await f.service.admit(f.proof,f.treeId,{})).toEqual({status:f.status,progress:f.progress});
  expect(await f.service.inspect(f.proof,f.treeId,f.jobId)).toEqual({status:f.status,progress:f.progress});expect(f.receiver.append).not.toHaveBeenCalled();expect(f.execution.requestExecution).not.toHaveBeenCalled();
  expect(f.service.capability()).toMatchObject({available:true,limits:{chunkBytes:4194304,metadataBytes:65536,activeClientJobs:2}});
 });
 it("validates headers before DB or consuming the source",async()=>{
  const f=await fixture(),body=f.body();await expect(f.service.append(f.proof,f.treeId,f.jobId,{...f.headers,offset:"-1"},body)).rejects.toThrow();
  expect(f.database.inspect).not.toHaveBeenCalled();expect(body.readableFlowing).toBe(null);body.destroy();
 });
 it("current original denial happens before input reads or receiver effects",async()=>{
  const f=await fixture(),body=f.body();f.database.inspect.mockRejectedValueOnce(Error("browser_tree_authorization_changed"));
  await expect(f.service.append(f.proof,f.treeId,f.jobId,f.headers,body)).rejects.toThrow("authorization_changed");expect(body.readableFlowing).toBe(null);expect(f.receiver.append).not.toHaveBeenCalled();body.destroy();
 });
 it("requires exact offset and final size before physical receiver calls",async()=>{
  const f=await fixture();for(const headers of [{...f.headers,offset:"1"},{...f.headers,contentLength:"262146"}]){const body=f.body();await expect(f.service.append(f.proof,f.treeId,f.jobId,headers,body)).rejects.toThrow();expect(body.readableFlowing).toBe(null);body.destroy();}
  await expect(f.service.append(f.proof,f.treeId,f.jobId,{...f.headers,contentLength:undefined},Readable.from([Buffer.alloc(262146)],{objectMode:false}))).rejects.toThrow();expect(f.receiver.append).not.toHaveBeenCalled();
 });
 it("returns fresh progress only after the exact receiver and its durable receipt finish",async()=>{
  const f=await fixture(),gate=deferred(),entered=deferred();f.receiver.append.mockImplementationOnce(async()=>{entered.resolve();await gate.promise;return undefined as never;});
  const result=f.service.append(f.proof,f.treeId,f.jobId,f.headers,f.body());await entered.promise;expect(f.journal.inspectProgress).toHaveBeenCalledTimes(1);
  gate.resolve();expect(await result).toBe(f.progress);expect(f.journal.inspectProgress).toHaveBeenCalledTimes(2);
  const args=f.receiver.append.mock.calls[0] as unknown as [unknown,unknown,number,string,Buffer];expect(args.slice(0,4)).toEqual([f.proof,f.reference,0,f.headers.sha256]);expect(args[4].length).toBe(262145);
 });
 it("admits only two joined body readers and retains a lane through receiver failure/abort settlement",async()=>{
  const f=await fixture(),gate=deferred(),entered=deferred();let count=0;
  f.receiver.append.mockImplementation(async()=>{if(++count===2)entered.resolve();await gate.promise;throw Error("receipt uncertain");});
  const first=f.service.append(f.proof,f.treeId,f.jobId,f.headers,f.body()),second=f.service.append(f.proof,f.treeId,randomUUID(),f.headers,f.body());
  void first.catch(()=>undefined);void second.catch(()=>undefined);await entered.promise;
  const duplicate=f.body(),third=f.body();await expect(f.service.append(f.proof,f.treeId,f.jobId,f.headers,duplicate)).rejects.toThrow("busy");await expect(f.service.append(f.proof,f.treeId,randomUUID(),f.headers,third)).rejects.toThrow("busy");
  expect(duplicate.readableFlowing).toBe(null);expect(third.readableFlowing).toBe(null);duplicate.destroy();third.destroy();
  gate.resolve();await expect(first).rejects.toThrow("uncertain");await expect(second).rejects.toThrow("uncertain");f.receiver.append.mockResolvedValueOnce(undefined as never);
  await expect(f.service.append(f.proof,f.treeId,f.jobId,f.headers,f.body())).resolves.toBe(f.progress);
 });
 it("refuses a replacement or caller-extended seal before full local read",async()=>{
  const f=await fixture();await expect(f.service.seal(f.proof,f.treeId,f.jobId,{sealId:randomUUID()})).rejects.toThrow("seal_reused");
  await expect(f.service.seal(f.proof,f.treeId,f.jobId,{sealId:f.progress.sealId,path:"private"})).rejects.toThrow();expect(f.receiver.seal).not.toHaveBeenCalled();
  expect(await f.service.seal(f.proof,f.treeId,f.jobId,{sealId:f.progress.sealId})).toBe(f.progress);expect(f.receiver.seal).toHaveBeenCalledExactlyOnceWith(f.proof,f.reference);
 });
 it("client metadata timeout does not repeatedly abandon an already started full verification",async()=>{
  const f=await fixture(),entered=deferred(),gate=deferred(),controller=new AbortController();
  f.receiver.seal.mockImplementationOnce(async()=>{entered.resolve();await gate.promise;return undefined as never;});
  let settled=false;const result=f.service.seal(f.proof,f.treeId,f.jobId,{sealId:f.progress.sealId},controller.signal).finally(()=>{settled=true;});
  await entered.promise;controller.abort(Error("metadata timeout"));await Promise.resolve();expect(settled).toBe(false);
  expect(f.receiver.seal).toHaveBeenCalledExactlyOnceWith(f.proof,f.reference);
  await expect(f.service.seal(f.proof,f.treeId,f.jobId,{sealId:f.progress.sealId})).rejects.toThrow("busy");
  gate.resolve();await expect(result).resolves.toBe(f.progress);expect(f.journal.inspectProgress).toHaveBeenCalledTimes(2);
 });
 it("an aborted seal before verification begins starts no full read",async()=>{
  const f=await fixture(),controller=new AbortController();f.database.inspect.mockImplementationOnce(async()=>{controller.abort(Error("cancelled"));return {reference:f.reference,status:f.status};});
  await expect(f.service.seal(f.proof,f.treeId,f.jobId,{sealId:f.progress.sealId},controller.signal)).rejects.toThrow("cancelled");expect(f.receiver.seal).not.toHaveBeenCalled();
 });
 it("execution requires exact full local seal and returns durable request status",async()=>{
  const f=await fixture();await expect(f.service.execute(f.proof,f.treeId,f.jobId,{})).rejects.toThrow("incomplete");expect(f.execution.requestExecution).not.toHaveBeenCalled();
  f.journal.inspectProgress.mockResolvedValue({...f.progress,state:"sealed",confirmedOffset:f.progress.sizeBytes,sealSha256:f.progress.sha256});
  await expect(f.service.execute(f.proof,f.treeId,f.jobId,{taskId:randomUUID()})).rejects.toThrow();
  expect(await f.service.execute(f.proof,f.treeId,f.jobId,{})).toEqual({status:{...f.status,state:"running"}});expect(f.execution.requestExecution).toHaveBeenCalledExactlyOnceWith(f.proof,f.reference);
 });
 it.each(["running","completed","cancelled","unknown"])("inspection of %s never creates another execution request",async state=>{
  const f=await fixture();f.database.inspect.mockResolvedValue({reference:f.reference,status:{...f.status,state}});
  expect(await f.service.execute(f.proof,f.treeId,f.jobId,{})).toEqual({status:{...f.status,state}});expect(f.execution.requestExecution).not.toHaveBeenCalled();
 });
 it("shutdown refuses new effects and joins physical work before closing durable execution",async()=>{
  const f=await fixture(),entered=deferred(),gate=deferred();f.receiver.seal.mockImplementationOnce(async()=>{entered.resolve();await gate.promise;return undefined as never;});
  const effect=f.service.seal(f.proof,f.treeId,f.jobId,{sealId:f.progress.sealId});await entered.promise;const closing=f.service.onModuleDestroy();
  expect(f.service.capability().available).toBe(false);expect(f.execution.close).not.toHaveBeenCalled();await expect(f.service.admit(f.proof,f.treeId,{})).rejects.toThrow("draining");
  gate.resolve();await effect;await closing;expect(f.execution.close).toHaveBeenCalledOnce();
 });
 it("cancellation delegates the original and does not imply spool cleanup",async()=>{
  const f=await fixture();expect(await f.service.cancel(f.proof,f.treeId,f.jobId)).toBe(f.status);expect(f.database.cancelBeforeExecution).toHaveBeenCalledExactlyOnceWith(f.proof,f.treeId,f.jobId);
  expect(f.receiver.append).not.toHaveBeenCalled();expect(f.execution.requestExecution).not.toHaveBeenCalled();
 });
});
