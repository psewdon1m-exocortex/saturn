import {afterEach,expect,it,vi} from 'vitest';
import {DurableBackendExecutor,type BackendCommand} from '../../../packages/storage/src/durable-backend-executor.js';
import type {StorageAdapter} from '../../../packages/storage/src/types.js';

// Node's promises timer retains its native clock. Use the same fake clock for
// the retry delay and Date.now so negative cases cannot submit before the proof.
vi.mock('node:timers/promises',()=>({setTimeout:(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))}));

afterEach(()=>vi.useRealTimers());
function fixture(delta:Record<string,unknown>={},code='CONNECTION_CLOSED',inspectFailures=0){
 let first=true,inspections=0,owner:Parameters<BackendCommand>[1];
 const tasks=new Map<string,{id:string;state:string}>(),queue:unknown[]=[];
 const transport=Object.assign(new Error('connection dropped while awaiting claim'),{code});
 const raw={mkdir:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
 const send=vi.fn<BackendCommand>(async(command,identity,payload)=>{
  if(command==='acquire'){owner=identity;return{owned:true};}
  if(command==='claim'){if(first){first=false;throw transport;}return queue.shift()??null;}
  if(command==='inspect'){
   if(++inspections<=inspectFailures)throw transport;
   return {state:'RUNNING',ownerId:owner.ownerId,fencingToken:owner.fencingToken,generation:owner.generation,oldestPendingAt:null,queued:0,unknown:0,...delta};
  }
  if(command==='submit'){
   const id=String(payload.id);tasks.set(id,{id,state:'QUEUED'});
   queue.push({id,command:payload.command,body:payload.body,reservedBytes:payload.reservedBytes});return tasks.get(id);
  }
  if(command==='status')return tasks.get(String(payload.id));
  if(command==='complete'){const id=String(payload.id);tasks.set(id,{id,state:'DONE'});return tasks.get(id);}
  if(['drain','read-close','stopped'].includes(command))return {};
  throw new Error('unexpected command '+command);
 });
 const executor=new DurableBackendExecutor(raw as unknown as StorageAdapter,send,'backend','generation');
 return{executor,send,raw,tasks};
}

it('recovers a disconnected idle claim only after same-owner empty-work proof',async()=>{
 vi.useFakeTimers();const f=fixture();await f.executor.start();await vi.advanceTimersByTimeAsync(251);
 const write=f.executor.mkdir('retained-original');await vi.advanceTimersByTimeAsync(1);await write;
 expect(f.raw.mkdir).toHaveBeenCalledExactlyOnceWith('retained-original');
 expect(f.send.mock.calls.filter(([c])=>c==='inspect')).toHaveLength(1);
 expect([...f.tasks.values()].map(x=>x.state)).toEqual(['DONE']);
 const close=f.executor.close();await vi.advanceTimersByTimeAsync(1);await close;
 expect(f.send.mock.calls.filter(([c])=>c==='stopped')).toHaveLength(1);expect(vi.getTimerCount()).toBe(0);
});

it('waits through transient inspection failures without changing owner or replaying writes',async()=>{
 vi.useFakeTimers();const f=fixture({},'ECONNRESET',2);await f.executor.start();await vi.advanceTimersByTimeAsync(501);
 expect(f.raw.mkdir).not.toHaveBeenCalled();expect(f.send.mock.calls.filter(([c])=>c==='claim')).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(250);const write=f.executor.mkdir('same-original');await vi.advanceTimersByTimeAsync(1);await write;
 expect(f.raw.mkdir).toHaveBeenCalledTimes(1);expect(f.send.mock.calls.filter(([c])=>c==='acquire')).toHaveLength(1);
 const close=f.executor.close();await vi.advanceTimersByTimeAsync(1);await close;
});

it.each([
 ['owner',{ownerId:'other'}],['fence',{fencingToken:'other'}],['generation',{generation:'other'}],['state',{state:'STOPPED'}],
 ['pending claim',{oldestPendingAt:'2026-10-27T00:00:00Z'}],['queued',{queued:1}],['UNKNOWN',{unknown:1}],['missing empty-work proof',{oldestPendingAt:undefined}],
])('refuses reconnect with changed or uncertain %s',async(_name,delta)=>{
 vi.useFakeTimers();const f=fixture(delta);await f.executor.start();await vi.advanceTimersByTimeAsync(251);
 await expect(f.executor.mkdir('never-write')).rejects.toThrow();expect(f.raw.mkdir).not.toHaveBeenCalled();
 const close=expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');await vi.advanceTimersByTimeAsync(1);await close;
 expect(f.send.mock.calls.filter(([c])=>c==='stopped')).toHaveLength(0);
});

it('does not retry permission errors as connectivity failures',async()=>{
 vi.useFakeTimers();const f=fixture({},'42501');await f.executor.start();await vi.advanceTimersByTimeAsync(1);
 await expect(f.executor.mkdir('denied')).rejects.toMatchObject({code:'42501'});expect(f.send.mock.calls.filter(([c])=>c==='inspect')).toHaveLength(0);
 const close=expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');await vi.advanceTimersByTimeAsync(1);await close;
});

it('bounds disconnected reconciliation and preserves explicit failure',async()=>{
 vi.useFakeTimers();const f=fixture({},'CONNECTION_CLOSED',10000);await f.executor.start();await vi.advanceTimersByTimeAsync(60001);
 await expect(f.executor.mkdir('never-write')).rejects.toMatchObject({code:'CONNECTION_CLOSED'});expect(f.raw.mkdir).not.toHaveBeenCalled();
 expect(f.send.mock.calls.filter(([c])=>c==='inspect').length).toBeLessThanOrEqual(240);
 const close=expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');await vi.advanceTimersByTimeAsync(1);await close;expect(vi.getTimerCount()).toBe(0);
});

it('closing during reconnect cannot fabricate a stopped receipt',async()=>{
 vi.useFakeTimers();const f=fixture({},'CONNECTION_CLOSED',10000);await f.executor.start();await vi.advanceTimersByTimeAsync(1);
 const close=expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');await vi.advanceTimersByTimeAsync(250);await close;
 expect(f.send.mock.calls.filter(([c])=>c==='stopped')).toHaveLength(0);expect(f.raw.close).toHaveBeenCalledTimes(1);
});
