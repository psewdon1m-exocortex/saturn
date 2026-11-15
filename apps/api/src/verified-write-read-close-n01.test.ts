import {Readable} from 'node:stream';
import {setImmediate as turn} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {DurableBackendExecutor,type BackendCommand} from '../../../packages/storage/src/durable-backend-executor.js';
import {BackendPayloadStore} from '../../../packages/storage/src/backend-payload-store.js';
import type {StorageAdapter} from '../../../packages/storage/src/types.js';

function fixture(replay=false,retention=false){
 const bytes=Buffer.from('owned'),id=randomUUID(),generation=randomUUID(),ref={id:randomUUID(),size:String(bytes.length),sha256:createHash('sha256').update(bytes).digest('hex')};
 let confirm!:()=>void,reject!:(e:Error)=>void;const proof=new Promise<void>((yes,no)=>{confirm=yes;reject=no;});void proof.catch(()=>undefined);
 const stream=Readable.from([bytes]);Object.defineProperty(stream,'storageClosed',{value:proof});stream.on('error',()=>undefined);
 const payloads=new BackendPayloadStore(process.cwd(),'test',generation);
 vi.spyOn(payloads,'initialize').mockResolvedValue();vi.spyOn(payloads,'put').mockResolvedValue(ref);vi.spyOn(payloads,'read').mockResolvedValue(bytes);vi.spyOn(payloads,'remove').mockResolvedValue();
 const raw={openRead:vi.fn(async()=>stream),close:vi.fn(async()=>{}),stat:async()=>({path:'owned',name:'owned',type:'file',size:bytes.length,modifiedAt:new Date()}),list:async()=>({entries:[]}),
  statFs:async()=>({totalBytes:1e9,availableBytes:1e9}),exists:async()=>true,write:vi.fn(async()=>bytes.length),truncate:async()=>{},mkdir:async()=>{},rename:async()=>{},copy:async()=>{},delete:vi.fn(async()=>{})} satisfies StorageAdapter;
 let pending:Record<string,unknown>|null=null,state=replay?'DONE':'QUEUED',result:unknown=replay?bytes.length:undefined;
 if(retention){const resourceId=randomUUID(),versionId=randomUUID();pending={id,command:'delete',reservedBytes:'0',body:{path:`_system/versions/${resourceId}/${versionId}`,retention:{resourceId,versionId,sizeBytes:ref.size,sha256:ref.sha256}}};}
 const command=vi.fn<BackendCommand>(async(name,_identity,payload)=>{
  if(name==='acquire')return {owned:!replay,writeOnce:true,writeVerifiedOnce:true};
  if(name==='read-acquire')return {acquired:true};
  if(name==='submit-once'){if(!replay)pending={...payload};return {id,state,result};}
  if(name==='claim'){if(!pending)return null;const task=pending;pending=null;state='RUNNING';return task;}
  if(name==='complete'){state='DONE';result=payload.result;return {id,state,result};}
  if(name==='unknown'){state='UNKNOWN';return {id,state};}
  if(name==='status')return {id,state,result,errorCode:'reconciliation_required'};
  return {};
 });
 const executor=new DurableBackendExecutor(raw,command,'test',generation,0,undefined,{payloads,readCloseTimeoutMs:1000});
 const count=(name:string)=>command.mock.calls.filter(c=>c[0]===name).length;
 return {executor,command,raw,confirm,reject,stream,count,id,bytes};
}

it.each([false,true])('verified write keeps its physical slot until the readback CLOSE proof, replay=%s',async replay=>{
 const f=fixture(replay);let completed=false;
 const work=f.executor.writeVerifiedOnce(f.id,'owned',f.bytes).then(value=>{completed=true;return value;});void work.catch(()=>undefined);
 try{
  await expect.poll(()=>vi.mocked(f.raw.openRead).mock.calls.length).toBe(1);await turn();
  expect(completed,'Readback bytes alone must not release physical lifetime').toBe(false);
  expect(f.count(replay?'read-release':'complete')).toBe(0);
 }finally{f.confirm();await work;await f.executor.close();vi.restoreAllMocks();}
});

it.each([false,true])('unconfirmed readback CLOSE retains ownership and cannot complete verified write, replay=%s',async replay=>{
 const f=fixture(replay);
 const work=f.executor.writeVerifiedOnce(f.id,'owned',f.bytes);void work.catch(()=>undefined);
 try{
  await expect.poll(()=>vi.mocked(f.raw.openRead).mock.calls.length).toBe(1);f.reject(Error('actual CLOSE rejected'));
  await expect(work).rejects.toThrow(replay?'read_close_unconfirmed':'reconciliation_required');
  expect(f.count(replay?'read-release':'complete')).toBe(0);
  await expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');expect(f.count('read-close')).toBe(0);
 }finally{f.confirm();await work.catch(()=>undefined);await f.executor.close().catch(()=>undefined);vi.restoreAllMocks();}
});

it.each([false,true])('retention delete joins physical preimage read CLOSE before deleting archived bytes, rejected=%s',async rejected=>{
 const f=fixture(false,true);await f.executor.start();
 try{
  await expect.poll(()=>vi.mocked(f.raw.openRead).mock.calls.length).toBe(1);await turn();
  expect(vi.mocked(f.raw.delete).mock.calls,'Retention cannot delete while its verification handle is unclosed').toHaveLength(0);
  if(rejected){f.reject(Error('retention CLOSE lost'));await expect.poll(()=>f.count('unknown')).toBe(1);expect(vi.mocked(f.raw.delete).mock.calls).toHaveLength(0);await expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');}
  else{f.confirm();await expect.poll(()=>f.count('complete')).toBe(1);expect(vi.mocked(f.raw.delete).mock.calls).toHaveLength(1);await f.executor.close();}
 }finally{f.confirm();await f.executor.close().catch(()=>undefined);vi.restoreAllMocks();}
});
