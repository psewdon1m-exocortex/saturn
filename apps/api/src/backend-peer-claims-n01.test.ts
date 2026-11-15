import { fixtureValue } from './test-values.fixture.js';
import {afterEach,expect,it,vi} from 'vitest';
import {DurableBackendExecutor,type BackendCommand} from '../../../packages/storage/src/durable-backend-executor.js';
import type {StorageAdapter} from '../../../packages/storage/src/types.js';

afterEach(()=>vi.useRealTimers());
function fixture(count:number,firstEmpty=false){
 const tasks=Array.from({length:count},(_,n)=>({id:'peer-'+String(n),command:'mkdir',body:{path:'peer-'+String(n)},reservedBytes:'0',state:'QUEUED'}));
 let release!:()=>void,active=0,peak=0,claims=0,claimActive=0,claimPeak=0,empty=firstEmpty;
 const gate=new Promise<void>(r=>{release=r;});
 const mkdir=vi.fn(async()=>{active++;peak=Math.max(peak,active);try{await gate;}finally{active--;}});
 const raw={mkdir,close:vi.fn(async()=>{})} as unknown as StorageAdapter;
 const send=vi.fn<BackendCommand>(async(command,_identity,payload)=>{
  if(command==='acquire')return {owned:true};
  if(command==='claim'){
   claims++;claimActive++;claimPeak=Math.max(claimPeak,claimActive);
   try{
    await Promise.resolve();
    if(empty){empty=false;return null;}
    const task=tasks.find(t=>t.state==='QUEUED');if(task)task.state='RUNNING';return task?{...task}:null;
   }finally{claimActive--;}
  }
  if(command==='complete'){const task=fixtureValue(tasks.find(t=>t.id===payload.id));task.state='DONE';return {id:task.id,state:'DONE'};}
  return {};
 });
 const executor=new DurableBackendExecutor(raw,send,'backend','generation',268435456,undefined,{workers:4});
 return {executor,raw,send,tasks,mkdir,release,stats:()=>({active,peak,claims,claimPeak})};
}

it('fills four free worker slots from peer backlog before the idle polling deadline and does not prefetch a fifth',async()=>{
 vi.useFakeTimers();const f=fixture(5);
 try{
  await f.executor.start();await vi.advanceTimersByTimeAsync(1);
  expect(f.mkdir).toHaveBeenCalledTimes(4);expect(f.stats()).toMatchObject({active:4,peak:4,claims:4,claimPeak:1});
  expect(f.tasks.filter(t=>t.state==='QUEUED')).toHaveLength(1);
  f.release();await vi.advanceTimersByTimeAsync(1);
  expect(f.mkdir).toHaveBeenCalledTimes(5);expect(f.stats().peak).toBe(4);expect(f.tasks.every(t=>t.state==='DONE')).toBe(true);
 }finally{f.release();const closing=f.executor.close();await vi.advanceTimersByTimeAsync(1);await closing;}
 expect(vi.getTimerCount()).toBe(0);
});

it('an empty observer reply still backs off, then drains peer arrivals into available slots without per-task sleeps',async()=>{
 vi.useFakeTimers();const f=fixture(4,true);
 try{
  await f.executor.start();await vi.advanceTimersByTimeAsync(99);
  expect(f.mkdir).not.toHaveBeenCalled();expect(f.stats().claims).toBe(1);
  await vi.advanceTimersByTimeAsync(2);expect(f.mkdir).toHaveBeenCalledTimes(4);expect(f.stats().claimPeak).toBe(1);
 }finally{f.release();const closing=f.executor.close();await vi.advanceTimersByTimeAsync(1);await closing;}
 expect(vi.getTimerCount()).toBe(0);
});

it('after peer backlog drains there is one bounded empty observer, not a busy loop',async()=>{
 vi.useFakeTimers();const f=fixture(4);f.release();
 try{
  await f.executor.start();await vi.advanceTimersByTimeAsync(1);
  expect(f.mkdir).toHaveBeenCalledTimes(4);expect(f.stats().claims).toBe(5);
  await vi.advanceTimersByTimeAsync(300);expect(f.stats().claims).toBe(8);
 }finally{const closing=f.executor.close();await vi.advanceTimersByTimeAsync(1);await closing;}
 expect(vi.getTimerCount()).toBe(0);
});

it('close joins all claimed peer effects before issuing the STOPPED receipt',async()=>{
 vi.useFakeTimers();const f=fixture(4);await f.executor.start();await vi.advanceTimersByTimeAsync(1);
 let closed=false;const closing=f.executor.close().then(()=>{closed=true;});
 try{
  await vi.advanceTimersByTimeAsync(1);expect(f.mkdir).toHaveBeenCalledTimes(4);expect(closed).toBe(false);
  expect(f.send.mock.calls.filter(([command])=>command==='stopped')).toHaveLength(0);
 }finally{f.release();await vi.advanceTimersByTimeAsync(1);await closing;}
 expect(f.tasks.every(t=>t.state==='DONE')).toBe(true);expect(f.send.mock.calls.filter(([command])=>command==='stopped')).toHaveLength(1);
 expect(vi.getTimerCount()).toBe(0);
});

it('a failed peer claim stops further admission, joins running effects and never reports STOPPED',async()=>{
 vi.useFakeTimers();const f=fixture(4);let claims=0;
 const executor=new DurableBackendExecutor(f.raw,async(command,id,payload)=>{
  if(command==='claim'&&++claims===3)throw Error('lost claim reply');
  return f.send(command,id,payload);
 },'backend','generation',268435456,undefined,{workers:4});
 await executor.start();await vi.advanceTimersByTimeAsync(1);
 try{expect(f.mkdir).toHaveBeenCalledTimes(2);expect(claims).toBe(3);}
 finally{
  const closed=expect(executor.close()).rejects.toThrow('backend_close_unconfirmed');
  f.release();await vi.advanceTimersByTimeAsync(1);await closed;
 }
 expect(f.tasks.filter(t=>t.state==='QUEUED')).toHaveLength(2);
 expect(f.send.mock.calls.filter(([command])=>command==='stopped')).toHaveLength(0);
 expect(vi.getTimerCount()).toBe(0);
});
