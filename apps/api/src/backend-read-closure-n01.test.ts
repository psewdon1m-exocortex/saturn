import {setImmediate as turn} from 'node:timers/promises';
import {Readable} from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStorageAdapter} from '@saturn/storage';
import {expect,it,vi} from 'vitest';
import {DurableBackendExecutor,type BackendCommand} from '../../../packages/storage/src/durable-backend-executor.js';
import type {StorageAdapter} from '../../../packages/storage/src/types.js';

function fixture(withProof=true){
 let confirm!:()=>void,reject!:(error:Error)=>void;
 const proof=new Promise<void>((yes,no)=>{confirm=yes;reject=no;});void proof.catch(()=>undefined);
 const stream=Readable.from([Buffer.from('owned')],{autoDestroy:false});
 if(withProof)Object.defineProperty(stream,'storageClosed',{value:proof});stream.on('error',()=>undefined);
 const raw:StorageAdapter={openRead:async()=>stream,close:vi.fn(async()=>{}),
  stat:async()=>({path:'owned',name:'owned',type:'file',size:5,modifiedAt:new Date()}),list:async()=>({entries:[]}),
  statFs:async()=>({totalBytes:1e9,availableBytes:1e9}),exists:async()=>true,write:async()=>0,
  truncate:async()=>{},mkdir:async()=>{},rename:async()=>{},copy:async()=>{},delete:async()=>{}};
 const command=vi.fn<BackendCommand>(async(name,_identity,payload)=>name==='acquire'?{owned:false}:name==='read-acquire'?{acquired:true}:name==='submit'?{id:payload.id,state:'DONE',result:null}:{});
 const executor=new DurableBackendExecutor(raw,command,'backend','generation');
 const count=(name:string)=>command.mock.calls.filter(call=>call[0]===name).length;
 return {stream,proof,confirm,reject,raw,executor,count,command};
}
it('does not release durable read admission on logical end or wrapper close before physical closure',async()=>{
 const f=fixture();const stream=await f.executor.openRead('owned');
 try{
  expect(stream).toBe(f.stream);expect((stream as Readable&{storageClosed:Promise<void>}).storageClosed).toBe(f.proof);
  stream.resume();await turn();expect(f.count('read-release')).toBe(0);
  stream.destroy();await turn();expect(f.count('read-release')).toBe(0);
  f.confirm();await turn();expect(f.count('read-release')).toBe(1);
 }finally{f.confirm();f.stream.destroy();await f.executor.close();}
});
it('retains read admission and refuses STOPPED when physical closure rejects',async()=>{
 const f=fixture();await f.executor.openRead('owned');f.stream.destroy();f.reject(Error('remote CLOSE unconfirmed'));await turn();
 expect(f.count('read-release')).toBe(0);
 await expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');expect(f.count('read-close')).toBe(0);
});
it('joins physical closure before recording all read connections closed',async()=>{
 const f=fixture();await f.executor.openRead('owned');f.stream.destroy();
 let done=false;const closing=f.executor.close().then(()=>{done=true;});await turn();
 try{expect(done).toBe(false);expect(f.count('read-close')).toBe(0);}
 finally{f.confirm();await closing;}
 expect(f.count('read-close')).toBe(1);
});
it('cancellation closes the returned stream but retains its slot until physical CLOSE',async()=>{
 const f=fixture(),abort=new AbortController();await f.executor.openRead('owned',{signal:abort.signal});
 abort.abort();await turn();expect(f.stream.destroyed).toBe(true);expect(f.count('read-release')).toBe(0);
 f.confirm();await turn();expect(f.count('read-release')).toBe(1);await f.executor.close();
});
it('does not manufacture STOPPED after physical closure succeeds but SQL release fails',async()=>{
 const f=fixture();await f.executor.openRead('owned');
 f.command.mockImplementation(async name=>{if(name==='read-release')throw Error('SQL release ACK unavailable');return {};});
 f.confirm();await turn();expect(f.count('read-release')).toBe(1);
 await expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');expect(f.count('read-close')).toBe(0);
});
it('retains admission when a remote OPEN reply fails without proving whether a handle exists',async()=>{
 const f=fixture();f.raw.openRead=async()=>{throw Error('OPEN failed before handle');};
 await expect(f.executor.openRead('owned')).rejects.toThrow('OPEN failed');
 expect(f.count('read-release')).toBe(0);f.confirm();await expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');
});
it('keeps the legacy adapter release contract without inventing a physical closure proof',async()=>{
 const f=fixture(false),stream=await f.executor.openRead('owned');
 expect('storageClosed' in stream).toBe(false);stream.resume();await turn();stream.destroy();await turn();
 expect(f.count('read-release')).toBe(1);f.confirm();await f.executor.close();
});
it('shutdown destroys an unconsumed open read and joins the resulting actual closure',async()=>{
 const f=fixture();await f.executor.openRead('owned');f.stream.once('close',f.confirm);
 await f.executor.close();expect(f.stream.destroyed).toBe(true);expect(f.count('read-release')).toBe(1);expect(f.count('read-close')).toBe(1);
});
it('retains an uncertain read without converting it into unrelated writer failure',async()=>{
 const f=fixture();await f.executor.openRead('owned');f.reject(Error('unknown remote reader'));await turn();
 expect(f.count('read-release')).toBe(0);await expect(f.executor.mkdir('unrelated')).resolves.toBeUndefined();
 expect(f.count('submit')).toBe(1);await expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');
});
it('bounds shutdown on a never-settled physical proof and retains it after late confirmation',async()=>{
 vi.useFakeTimers();const f=fixture();
 const executor=new DurableBackendExecutor(f.raw,f.command,'backend','generation',268435456,undefined,{readCloseTimeoutMs:50});
 try{
  await executor.openRead('owned');const closing=expect(executor.close()).rejects.toThrow('backend_close_unconfirmed');
  await vi.advanceTimersByTimeAsync(51);await closing;expect(f.count('read-close')).toBe(0);expect(f.count('read-release')).toBe(0);
  f.confirm();await vi.advanceTimersByTimeAsync(1);expect(f.count('read-release')).toBe(0);
 }finally{f.confirm();vi.useRealTimers();}
});
it('releases admission rejected before any physical OPEN attempt',async()=>{
 const f=fixture(),open=vi.spyOn(f.raw,'openRead');
 f.command.mockImplementation(async name=>{if(name==='read-acquire')throw Error('admission denied');return {};});
 await expect(f.executor.openRead('owned')).rejects.toThrow('admission denied');expect(open).not.toHaveBeenCalled();
 expect(f.count('read-release')).toBe(1);f.confirm();await f.executor.close();
});
it.each(['full','range','cancel'] as const)('joins actual LocalStorage FileHandle closure through executor, %s',async mode=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'n01-physical-read-'));
 const f=fixture(),abort=new AbortController();
 const raw=new LocalStorageAdapter(directory);
 const executor=new DurableBackendExecutor(raw,f.command,'backend','generation');
 try{
  await fs.writeFile(path.join(directory,'owned'),Buffer.from('actual-file-handle'));
  const stream=await executor.openRead('owned',mode==='range'?{offset:2,length:5}:{signal:abort.signal});
  const proof=(stream as Readable&{storageClosed?:Promise<void>}).storageClosed;expect(proof).toBeInstanceOf(Promise);
  if(mode==='cancel'){stream.on('error',()=>undefined);abort.abort();}
  else expect(Buffer.concat(await stream.toArray()).toString()).toBe(mode==='range'?'tual-':'actual-file-handle');
  await proof;await turn();expect(f.count('read-release')).toBe(1);
  await executor.close();expect(f.count('read-close')).toBe(1);
 }finally{f.confirm();f.stream.destroy();await executor.close();await fs.rm(directory,{recursive:true,force:true});}
});
it('joins and closes a handle returned after shutdown began instead of missing its new lifetime',async()=>{
 const f=fixture();let open!:()=>void;
 f.raw.openRead=async()=>{await new Promise<void>(resolve=>{open=resolve;});return f.stream;};
 const opening=f.executor.openRead('owned');void opening.catch(()=>undefined);await turn();
 let closed=false;const closing=f.executor.close().then(()=>{closed=true;});await turn();
 try{
  open();await expect(opening).rejects.toThrow('backend_draining');await turn();
  expect(f.stream.destroyed).toBe(true);expect(closed).toBe(false);expect(f.count('read-close')).toBe(0);
  f.confirm();await closing;expect(f.count('read-release')).toBe(1);expect(f.count('read-close')).toBe(1);
 }finally{open();f.confirm();await opening.catch(()=>undefined);await closing.catch(()=>undefined);}
});
