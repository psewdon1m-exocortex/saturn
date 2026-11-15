import { requireTestValue } from "../../contracts/src/test-support.js";
import {randomUUID} from "node:crypto";
import {afterEach,expect,it,vi} from "vitest";
import type {BrowserTreeAuthority} from "./browser-upload-tree-authority.js";
import type {BrowserTreeStreamExecutionClaim,BrowserTreeStreamExecutionLock,BrowserTreeStreamQueuedRequest,BrowserTreeStreamSettlement} from "./browser-upload-tree-stream-database.js";
import {BrowserTreeStreamWorker} from "./browser-upload-tree-stream-worker.js";

const workers:BrowserTreeStreamWorker[]=[],releases:(()=>void)[]=[];
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});releases.push(release);return {promise,release};}
afterEach(async()=>{for(const release of releases.splice(0))release();await Promise.allSettled(workers.splice(0).map(worker=>worker.close()));vi.useRealTimers();});
function fixture(count=1){
 const requests:Array<BrowserTreeStreamQueuedRequest>=Array.from({length:count},()=>({reference:{treeId:randomUUID(),jobId:randomUUID(),itemId:randomUUID()},requestId:randomUUID(),authorizationGeneration:1}));
 const states=new Map(requests.map(q=>[q.requestId,'queued'])),published=new Set<string>(),proof:BrowserTreeAuthority={proof:"saturn.browser-tree-authority.v1"};
 const receipts=new Map(requests.map(q=>[q.requestId,{resourceId:randomUUID(),versionId:randomUUID(),kind:'file' as const,sizeBytes:262145,sha256:'a'.repeat(64),relativePath:'large.bin'}]));
 let locks=0;
 // Lifecycle/control-flow doubles only. Native SQL, backend fencing and actual
 // CLOSE are separate mandatory qualification; these are not throughput tests.
 const worker={
  listExecutionRequests:vi.fn(async(limit?:1|2)=>{expect(limit).toBe(2);return requests.filter(q=>states.get(q.requestId)==='queued').slice(0,2);}),
  withExecutionLock:async<T>(_request:BrowserTreeStreamQueuedRequest,action:(permit:BrowserTreeStreamExecutionLock)=>Promise<T>):Promise<T>=>{locks++;try{return await action({} as BrowserTreeStreamExecutionLock);}finally{locks--;}} ,
  claimExecution:vi.fn(async(_proof:BrowserTreeAuthority,q:BrowserTreeStreamQueuedRequest,_permit:BrowserTreeStreamExecutionLock,identity:{claimId:string;workerId:string}):Promise<BrowserTreeStreamExecutionClaim>=>{void _permit;void _proof;states.set(q.requestId,'claimed');return {...q,...identity,operationId:randomUUID()};}),
  settleExecution:vi.fn(async(q:BrowserTreeStreamQueuedRequest,_permit:BrowserTreeStreamExecutionLock,_identity:{claimId:string;workerId:string}):Promise<BrowserTreeStreamSettlement>=>{void _identity;void _permit;if(!published.has(q.requestId))throw Error('browser_tree_execution_not_terminal');states.set(q.requestId,'settled');return {outcome:'published',receipt:requireTestValue(receipts.get(q.requestId))};}),
  retainExecutionUnknown:vi.fn(async(q:BrowserTreeStreamQueuedRequest,_permit:BrowserTreeStreamExecutionLock,_identity:{claimId:string;workerId:string}):Promise<'not_claimed'|'terminal'|'unknown'>=>{void _identity;void _permit;if(published.has(q.requestId))return 'terminal';if(states.get(q.requestId)==='queued')return 'not_claimed';states.set(q.requestId,'unknown');return 'unknown';}),
  blockQueuedExecution:vi.fn(async(q:BrowserTreeStreamQueuedRequest)=>{if(states.get(q.requestId)!=='queued')return false;states.set(q.requestId,'blocked');return true;}),
 };
 const authority={forQueuedRequest:vi.fn(async()=>proof)},executor={execute:vi.fn(async(claim:BrowserTreeStreamExecutionClaim,_proof:BrowserTreeAuthority,_signal:AbortSignal):Promise<unknown>=>{void _signal;void _proof;published.add(claim.requestId);return {notAReceipt:true};})};
 const status={treeId:requireTestValue(requests[0]).reference.treeId,jobId:requireTestValue(requests[0]).reference.jobId,intentSha256:'b'.repeat(64),state:'accepted',items:[]};
 const admission={requestExecution:vi.fn(async()=>status)},dependencies={admission,worker,authority,executor,workerId:randomUUID()};
 const service=new BrowserTreeStreamWorker(dependencies);workers.push(service);
 return {service,dependencies,worker,authority,executor,requests,states,published,proof,admission,status,locks:()=>locks};
}

it("commits a bounded admission before a wake and does not start work by construction",async()=>{
 const f=fixture(),commit=gate();f.admission.requestExecution.mockImplementationOnce(async()=>{await commit.promise;return f.status;});
 const request=f.service.requestExecution(f.proof,requireTestValue(f.requests[0]).reference);
 await vi.waitFor(()=>expect(f.admission.requestExecution).toHaveBeenCalledTimes(1));
 expect(f.worker.listExecutionRequests).not.toHaveBeenCalled();expect(f.executor.execute).not.toHaveBeenCalled();
 commit.release();await expect(request).resolves.toEqual(f.status);
 expect(f.executor.execute).not.toHaveBeenCalled();await f.service.tick();await vi.waitFor(()=>expect(f.worker.settleExecution).toHaveBeenCalledTimes(1));
});
it("joins concurrent discovery and never starts a third physical lane",async()=>{
 const f=fixture(3),physical=gate();f.executor.execute.mockImplementation(async claim=>{await physical.promise;f.published.add(claim.requestId);});
 await Promise.all([f.service.tick(),f.service.tick(),f.service.tick()]);await vi.waitFor(()=>expect(f.executor.execute).toHaveBeenCalledTimes(2));
 expect(f.worker.listExecutionRequests).toHaveBeenCalledTimes(1);expect(f.service.inspect().active).toBe(2);
 await f.service.tick();expect(f.executor.execute).toHaveBeenCalledTimes(2);expect(f.worker.listExecutionRequests).toHaveBeenCalledTimes(1);
});
it("refills a finished lane while a different large transfer is still running",async()=>{
 const f=fixture(3),gates=f.requests.map(()=>gate());
 f.executor.execute.mockImplementation(async claim=>{await requireTestValue(gates[f.requests.findIndex(q=>q.requestId===claim.requestId)]).promise;f.published.add(claim.requestId);});
 f.service.start();await vi.waitFor(()=>expect(f.executor.execute).toHaveBeenCalledTimes(2));
 requireTestValue(gates[0]).release();await vi.waitFor(()=>expect(f.executor.execute).toHaveBeenCalledTimes(3));
 expect(f.states.get(requireTestValue(f.requests[1]).requestId)).toBe('claimed');expect(f.service.inspect().active).toBe(2);
});
it("does not start a late discovery result after shutdown begins",async()=>{
 const f=fixture(),read=gate();f.worker.listExecutionRequests.mockImplementationOnce(async()=>{await read.promise;return f.requests;});
 const polling=f.service.tick();await vi.waitFor(()=>expect(f.worker.listExecutionRequests).toHaveBeenCalledTimes(1));
 const closed=f.service.close();read.release();await polling;await closed;expect(f.executor.execute).not.toHaveBeenCalled();expect(f.worker.claimExecution).not.toHaveBeenCalled();
});
it("blocks a queued request with expired authority without claiming or executing it",async()=>{
 const f=fixture();f.authority.forQueuedRequest.mockRejectedValueOnce(Error('browser_tree_authorization_changed'));
 await f.service.tick();await vi.waitFor(()=>expect(f.worker.blockQueuedExecution).toHaveBeenCalledTimes(1));
 expect(f.worker.claimExecution).not.toHaveBeenCalled();expect(f.executor.execute).not.toHaveBeenCalled();expect(f.states.get(requireTestValue(f.requests[0]).requestId)).toBe('blocked');
});
it("retains the exact attempted claim after a lost commit ACK and never retries its executor",async()=>{
 const f=fixture();f.worker.claimExecution.mockImplementationOnce(async(_proof,q)=>{void _proof;f.states.set(q.requestId,'claimed');throw Error('commit reply lost /private/database');});
 await f.service.tick();await vi.waitFor(()=>expect(f.worker.retainExecutionUnknown).toHaveBeenCalledTimes(1));
 expect(f.executor.execute).not.toHaveBeenCalled();expect(f.states.get(requireTestValue(f.requests[0]).requestId)).toBe('unknown');
 expect(requireTestValue(f.worker.retainExecutionUnknown.mock.calls[0])[2]).toEqual(requireTestValue(f.worker.claimExecution.mock.calls[0])[3]);
 await f.service.tick();expect(f.worker.claimExecution).toHaveBeenCalledTimes(1);expect(f.service.inspect().lastFailure).toBe('browser_tree_execution_failed');
});
it("recovers a lost publication reply only by observing the terminal database receipt",async()=>{
 const f=fixture();f.executor.execute.mockImplementationOnce(async claim=>{f.published.add(claim.requestId);throw Error('reply lost');});
 await f.service.tick();await vi.waitFor(()=>expect(f.states.get(requireTestValue(f.requests[0]).requestId)).toBe('settled'));
 expect(f.executor.execute).toHaveBeenCalledTimes(1);expect(f.worker.settleExecution).toHaveBeenCalledTimes(1);expect(f.worker.retainExecutionUnknown).not.toHaveBeenCalled();
 await f.service.tick();expect(f.executor.execute).toHaveBeenCalledTimes(1);
});
it("retries only settlement metadata after its commit ACK is lost",async()=>{
 const f=fixture(),settle=requireTestValue(f.worker.settleExecution.getMockImplementation());
 f.worker.settleExecution.mockImplementationOnce(async(...args)=>{await settle(...args);throw Error('settle reply lost');});
 await f.service.tick();await vi.waitFor(()=>expect(f.worker.settleExecution).toHaveBeenCalledTimes(2));
 expect(f.executor.execute).toHaveBeenCalledTimes(1);expect(f.worker.retainExecutionUnknown).not.toHaveBeenCalled();
 expect(requireTestValue(f.worker.settleExecution.mock.calls[0])[2]).toEqual(requireTestValue(f.worker.settleExecution.mock.calls[1])[2]);
});
it("does not accept an executor's invented receipt when the DB has no terminal publication",async()=>{
 const f=fixture();f.executor.execute.mockResolvedValueOnce({outcome:'published',receipt:{resourceId:randomUUID()}});
 await f.service.tick();await vi.waitFor(()=>expect(f.states.get(requireTestValue(f.requests[0]).requestId)).toBe('unknown'));
 expect(f.worker.settleExecution).toHaveBeenCalledTimes(2);expect(f.worker.retainExecutionUnknown).toHaveBeenCalledTimes(1);
 expect(f.service.inspect().lastFailure).toBe('browser_tree_execution_not_terminal');
});
it("shutdown waits for an already started physical promise and its final receipt despite abort",async()=>{
 const f=fixture(),physical=gate();let signal!:AbortSignal;
 f.executor.execute.mockImplementationOnce(async(claim,_proof,input)=>{void _proof;signal=input;await physical.promise;f.published.add(claim.requestId);});
 await f.service.tick();await vi.waitFor(()=>expect(f.executor.execute).toHaveBeenCalledTimes(1));
 let complete=false;const close=f.service.close();void close.then(()=>{complete=true;});expect(f.service.close()).toBe(close);
 await Promise.resolve();expect(signal.aborted).toBe(true);expect(complete).toBe(false);expect(f.locks()).toBe(1);
 physical.release();await close;expect(f.locks()).toBe(0);expect(f.states.get(requireTestValue(f.requests[0]).requestId)).toBe('settled');
});
it("shutdown joins an in-flight admission and leaves it queued for restart",async()=>{
 const f=fixture(),commit=gate();f.admission.requestExecution.mockImplementationOnce(async()=>{await commit.promise;return f.status;});
 const request=f.service.requestExecution(f.proof,requireTestValue(f.requests[0]).reference);await vi.waitFor(()=>expect(f.admission.requestExecution).toHaveBeenCalledTimes(1));
 let complete=false;const close=f.service.close();void close.then(()=>{complete=true;});await Promise.resolve();expect(complete).toBe(false);
 commit.release();await request;await close;expect(f.states.get(requireTestValue(f.requests[0]).requestId)).toBe('queued');expect(f.executor.execute).not.toHaveBeenCalled();
 await expect(f.service.requestExecution(f.proof,requireTestValue(f.requests[0]).reference)).rejects.toThrow('runtime_draining');expect(()=>f.service.start()).toThrow('runtime_draining');
});
it("refuses malformed or duplicate discovery before starting any effect",async()=>{
 const f=fixture(3);f.worker.listExecutionRequests.mockResolvedValueOnce(f.requests);
 await expect(f.service.tick()).rejects.toThrow('execution_capacity');
 f.worker.listExecutionRequests.mockResolvedValueOnce([requireTestValue(f.requests[0]),requireTestValue(f.requests[0])]);await expect(f.service.tick()).rejects.toThrow('reconciliation_required');
 expect(f.worker.claimExecution).not.toHaveBeenCalled();expect(f.executor.execute).not.toHaveBeenCalled();
});
it("bounds retry polling after discovery failure instead of spinning",async()=>{
 vi.useFakeTimers();const f=fixture();f.worker.listExecutionRequests.mockRejectedValue(Error('database unavailable /private'));
 f.service.start();await vi.advanceTimersByTimeAsync(999);expect(f.worker.listExecutionRequests).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);expect(f.worker.listExecutionRequests).toHaveBeenCalledTimes(2);
 expect(f.service.inspect().lastFailure).toBe('browser_tree_execution_failed');
});
it("rejects an unbound worker incarnation before starting discovery",()=>{
 const f=fixture();expect(()=>new BrowserTreeStreamWorker({...f.dependencies,workerId:'1234'})).toThrow('configuration_invalid');expect(f.worker.listExecutionRequests).not.toHaveBeenCalled();
});
