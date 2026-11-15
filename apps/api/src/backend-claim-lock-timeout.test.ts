import {afterEach,expect,it,vi} from 'vitest';
import {DurableBackendExecutor,type BackendCommand} from '../../../packages/storage/src/durable-backend-executor.js';
import type {StorageAdapter} from '../../../packages/storage/src/types.js';
vi.mock('node:timers/promises',()=>({setTimeout:(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))}));
afterEach(()=>vi.useRealTimers());
function fixture(failures=1,code='55P03'){
 const tasks=new Map<string,{id:string;state:string}>(),queue:unknown[]=[];
 const raw={mkdir:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
 const send=vi.fn<BackendCommand>(async(command,_identity,payload)=>{
  if(command==='acquire')return{owned:true};
  if(command==='claim'){if(failures-->0)throw Object.assign(new Error('lock timeout; statement rolled back'),{code});return queue.shift()??null;}
  if(command==='submit'){const id=String(payload.id);tasks.set(id,{id,state:'QUEUED'});queue.push({id,command:payload.command,body:payload.body,reservedBytes:payload.reservedBytes});return tasks.get(id);}
  if(command==='status')return tasks.get(String(payload.id));
  if(command==='complete'){const id=String(payload.id);tasks.set(id,{id,state:'DONE'});return tasks.get(id);}
  if(['drain','read-close','stopped'].includes(command))return{};
  throw new Error('Unexpected command '+command);
 });
 return{raw,send,tasks,executor:new DurableBackendExecutor(raw as unknown as StorageAdapter,send,'backend','generation')};
}
it('continues queued original after a rolled-back claim lock timeout',async()=>{
 vi.useFakeTimers();const f=fixture();await f.executor.start();
 const write=f.executor.mkdir('same-original');const observed=write.catch((e: unknown)=>e);
 await vi.advanceTimersByTimeAsync(251);expect(await observed).toBeUndefined();
 expect(f.raw.mkdir).toHaveBeenCalledExactlyOnceWith('same-original');expect([...f.tasks.values()].map(x=>x.state)).toEqual(['DONE']);
 expect(f.send.mock.calls.filter(([c])=>c==='acquire')).toHaveLength(1);
 expect(f.send.mock.calls.filter(([c])=>c==='inspect')).toHaveLength(0);
 const close=f.executor.close();await vi.advanceTimersByTimeAsync(1);await close;
});
it('backs off repeated rolled-back claims without duplicate submission or effects',async()=>{
 vi.useFakeTimers();const f=fixture(3);await f.executor.start();const write=f.executor.mkdir('only-once');
 await vi.advanceTimersByTimeAsync(501);expect(f.raw.mkdir).not.toHaveBeenCalled();
 expect(f.send.mock.calls.filter(([c])=>c==='claim')).toHaveLength(3);
 await vi.advanceTimersByTimeAsync(250);await write;expect(f.raw.mkdir).toHaveBeenCalledTimes(1);
 expect(f.send.mock.calls.filter(([c])=>c==='submit')).toHaveLength(1);
 const close=f.executor.close();await vi.advanceTimersByTimeAsync(1);await close;
});
it('bounds maintenance contention and does not fabricate STOPPED after failure',async()=>{
 vi.useFakeTimers();const f=fixture(10000);await f.executor.start();await vi.advanceTimersByTimeAsync(60001);
 await expect(f.executor.mkdir('not-written')).rejects.toMatchObject({code:'55P03'});expect(f.raw.mkdir).not.toHaveBeenCalled();
 expect(f.send.mock.calls.filter(([c])=>c==='claim').length).toBeLessThanOrEqual(241);
 const close=expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');await vi.advanceTimersByTimeAsync(1);await close;
 expect(f.send.mock.calls.filter(([c])=>c==='stopped')).toHaveLength(0);
});
it.each(['42501','55000','57014','40P01'])('does not widen retry to unrelated SQLSTATE %s',async code=>{
 vi.useFakeTimers();const f=fixture(1,code);await f.executor.start();await vi.advanceTimersByTimeAsync(1);
 await expect(f.executor.mkdir('no-effect')).rejects.toMatchObject({code});expect(f.raw.mkdir).not.toHaveBeenCalled();
 expect(f.send.mock.calls.filter(([c])=>c==='claim')).toHaveLength(1);
 const close=expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');await vi.advanceTimersByTimeAsync(1);await close;
});
it('closing during lock backoff does not perform an extra claim',async()=>{
 vi.useFakeTimers();const f=fixture(10000);await f.executor.start();await vi.advanceTimersByTimeAsync(1);
 const close=expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');await vi.advanceTimersByTimeAsync(250);await close;
 expect(f.send.mock.calls.filter(([c])=>c==='claim')).toHaveLength(1);expect(f.raw.mkdir).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
