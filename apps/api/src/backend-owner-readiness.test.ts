import {afterEach,expect,it,vi} from 'vitest';
import {DurableBackendExecutor,type BackendCommand} from '../../../packages/storage/src/durable-backend-executor.js';
import type {StorageAdapter} from '../../../packages/storage/src/types.js';
import {BackendCheckedStorage} from '../../../packages/sync/src/guarded-runtime.js';
import {LegacyStorageFence} from '../../../packages/file-core/src/legacy-storage-fence.js';
import {AdapterStorageHealthProbe} from '../../../packages/storage-health/src/index.js';
afterEach(()=>vi.useRealTimers());
function fixture(owned=true,enabled=true){
 const state={ready:true,heartbeatError:false,claimError:false,generation:'generation',heartbeats:0};
 const stat=vi.fn(async()=>({type:'directory'})),mkdir=vi.fn(async()=>{});
 const raw={stat,mkdir,close:vi.fn(async()=>{})} as unknown as StorageAdapter;
 const send=vi.fn<BackendCommand>(async(command,_identity)=>{
   if(command==='acquire')return{owned,healthHeartbeat:enabled};
   if(command==='heartbeat'){if(state.heartbeatError)throw Error('connection_closed');state.heartbeats++;return{};}
   if(command==='readiness')return{ready:state.ready,generation:state.generation};
   if(command==='claim'){if(state.claimError)throw Object.assign(Error('permission_refused'),{code:'42501'});return null;}
   if(command==='inspect')return{state:'RUNNING',ownerId:_identity.ownerId,fencingToken:_identity.fencingToken};
   if(['drain','read-close','stopped'].includes(command))return{};
   throw Error('unexpected '+command);
 });
 return{state,send,raw,stat,mkdir,executor:new DurableBackendExecutor(raw,send,'backend','generation')};
}
async function close(f:ReturnType<typeof fixture>){const p=f.executor.close();await vi.advanceTimersByTimeAsync(1);await p;expect(vi.getTimerCount()).toBe(0);}
it('keeps separate owner liveness and joins its timer before STOPPED',async()=>{
 vi.useFakeTimers();const f=fixture();await f.executor.start();expect(f.state.heartbeats).toBe(1);
 await vi.advanceTimersByTimeAsync(15001);expect(f.state.heartbeats).toBe(4);await f.executor.assertReady();
 await close(f);await vi.advanceTimersByTimeAsync(20000);expect(f.state.heartbeats).toBe(4);
 await expect(f.executor.assertReady()).rejects.toThrow('backend_owner_unavailable');
});
it('a follower observes the real owner without sending a heartbeat or taking ownership',async()=>{
 vi.useFakeTimers();const f=fixture(false);await f.executor.start();await f.executor.assertReady();f.state.ready=false;
 await expect(f.executor.assertReady()).rejects.toThrow('backend_owner_unavailable');await vi.advanceTimersByTimeAsync(16000);
 expect(f.state.heartbeats).toBe(0);expect(f.send.mock.calls.filter(([c])=>c==='acquire')).toHaveLength(1);expect(f.mkdir).not.toHaveBeenCalled();await close(f);
});
it('a transient heartbeat failure degrades health and a same-owner reply restores it',async()=>{
 vi.useFakeTimers();const f=fixture();await f.executor.start();f.state.heartbeatError=true;await vi.advanceTimersByTimeAsync(5001);
 await expect(f.executor.assertReady()).rejects.toThrow('backend_owner_unavailable');f.state.heartbeatError=false;await vi.advanceTimersByTimeAsync(5000);await f.executor.assertReady();
 expect(f.send.mock.calls.filter(([c])=>c==='acquire')).toHaveLength(1);await close(f);
});
it('a failed claim pump stops advertising owner health without fabricating STOPPED',async()=>{
 vi.useFakeTimers();const f=fixture();f.state.claimError=true;await f.executor.start();await vi.advanceTimersByTimeAsync(5001);
 await expect(f.executor.assertReady()).rejects.toThrow('backend_owner_unavailable');expect(f.state.heartbeats).toBe(1);
 expect(await f.executor.diagnostics()).toMatchObject({state:'RUNNING',process:{owned:true,closing:false,claimFailureCode:'42501',heartbeatFailureCode:null}});
 const p=expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');await vi.advanceTimersByTimeAsync(1);await p;
 expect(f.send.mock.calls.filter(([c])=>c==='stopped')).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
});
it('does not call an old database healthy when it lacks qualified owner liveness',async()=>{
 vi.useFakeTimers();const f=fixture(true,false);await f.executor.start();await expect(f.executor.assertReady()).rejects.toThrow('backend_owner_unavailable');expect(f.state.heartbeats).toBe(0);await close(f);
});
it('rejects a readiness projection from another generation',async()=>{
 vi.useFakeTimers();const f=fixture();await f.executor.start();f.state.generation='other';await expect(f.executor.assertReady()).rejects.toThrow('backend_owner_unavailable');await close(f);
});
it('both ordinary storage wrappers forward the probe and retain binding checks',async()=>{
 vi.useFakeTimers();const f=fixture(false);await f.executor.start();const check=vi.fn(async()=>{});
 const wrapped=new LegacyStorageFence(new BackendCheckedStorage(f.executor,check),{assertBackend:check,assertMutation:async()=>{throw Error('no writes');}});
 const health=new AdapterStorageHealthProbe(wrapped);f.state.ready=false;
 expect(await health.check()).toMatchObject({state:'fail',detail:'storage_unavailable'});expect(check).toHaveBeenCalledTimes(2);expect(f.stat).not.toHaveBeenCalled();await close(f);
});
it('keeps heartbeats alive when all four workers are inside long physical effects',async()=>{
 vi.useFakeTimers();const f=fixture();let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
 let claimed=0;const send:BackendCommand=async(c,id,p)=>{
   if(c==='claim')return claimed<4?{id:String(++claimed),command:'mkdir',body:{path:`own-${String(claimed)}`},reservedBytes:'0'}:null;
   if(c==='complete')return{id:p.id,state:'DONE'};
   return f.send(c,id,p);
 };
 const mkdir=vi.fn(async()=>held);
 const raw={mkdir,close:vi.fn(async()=>{})} as unknown as StorageAdapter;
 const owner=new DurableBackendExecutor(raw,send,'backend','generation',0,undefined,{workers:4});await owner.start();await vi.advanceTimersByTimeAsync(1);
 expect(mkdir).toHaveBeenCalledTimes(4);await vi.advanceTimersByTimeAsync(16000);expect(f.state.heartbeats).toBe(4);await owner.assertReady();
 release();await vi.advanceTimersByTimeAsync(1);const stopped=owner.close();await vi.advanceTimersByTimeAsync(1);await stopped;expect(vi.getTimerCount()).toBe(0);
});
it.each([{create:1},{create:'true'},{exclusive:1},{truncate:0},{offset:'0'}])('rejects noncanonical verified-write options before any physical effect: %j',async(invalid)=>{
 vi.useFakeTimers();const f=fixture();let claimed=false;
 const send=vi.fn<BackendCommand>(async(command,identity,payload)=>{
   if(command==='claim'){
     if(claimed)return null;claimed=true;
     return{id:'00000000-0000-4000-8000-000000000001',command:'write',reservedBytes:'0',body:{path:'own',schema:'saturn.backend-write-verified-once.v1',bytes:'AA==',options:{offset:0,create:true,exclusive:true,truncate:false,...invalid}}};
   }
   if(command==='reject')return{};
   return f.send(command,identity,payload);
 });
 const write=vi.fn(async()=>1),raw={write,close:vi.fn(async()=>{})} as unknown as StorageAdapter;
 const owner=new DurableBackendExecutor(raw,send,'backend','generation');await owner.start();await vi.advanceTimersByTimeAsync(1);
 expect(write).not.toHaveBeenCalled();expect(send.mock.calls.filter(([command])=>command==='reject')).toHaveLength(1);
 expect(send.mock.calls.find(([command])=>command==='reject')?.[2]).toMatchObject({errorCode:'invalid_input'});
 expect(send.mock.calls.filter(([command])=>command==='complete'||command==='unknown')).toHaveLength(0);
 const stopped=owner.close();await vi.advanceTimersByTimeAsync(1);await stopped;expect(vi.getTimerCount()).toBe(0);
});
it.each([null,undefined])('resolves a nullable complete reply through the same task status without replay: %s',async(completeReply)=>{
 vi.useFakeTimers();const f=fixture();let task:{id:unknown;state:string;command:unknown;body:unknown;reservedBytes:unknown}|undefined;
 const send=vi.fn<BackendCommand>(async(command,identity,payload)=>{
   if(command==='submit'){task={id:payload.id,state:'QUEUED',command:payload.command,body:payload.body,reservedBytes:payload.reservedBytes};return{...task};}
   if(command==='claim'){if(task?.state!=='QUEUED')return null;task.state='RUNNING';return{...task};}
   if(command==='complete'){if(!task)throw Error('missing task');task.state='DONE';return completeReply;}
   if(command==='status')return task?{...task}:null;
   return f.send(command,identity,payload);
 });
 const mkdir=vi.fn(async()=>{}),raw={mkdir,close:vi.fn(async()=>{})} as unknown as StorageAdapter;
 const owner=new DurableBackendExecutor(raw,send,'backend','generation');await owner.start();
 const operation=owner.mkdir('own');await vi.advanceTimersByTimeAsync(101);await operation;
 expect(mkdir).toHaveBeenCalledTimes(1);expect(send.mock.calls.filter(([command])=>command==='status').length).toBeGreaterThan(0);
 expect(send.mock.calls.filter(([command])=>command==='complete')).toHaveLength(1);expect(send.mock.calls.filter(([command])=>command==='unknown')).toHaveLength(0);
 const stopped=owner.close();await vi.advanceTimersByTimeAsync(1);await stopped;expect(vi.getTimerCount()).toBe(0);
});
