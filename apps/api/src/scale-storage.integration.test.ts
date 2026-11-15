import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect,it,vi } from 'vitest';
import { backendFixture,barrier,evidence,uid } from './stage3-chat-a.fixture.js';
import { BackendPayloadStore } from '../../../packages/storage/src/backend-payload-store.js';
import { DurableBackendExecutor } from '../../../packages/storage/src/durable-backend-executor.js';

it('durable staged chunks survive reopen, reject corruption and SQL carries references only; four disjoint writes overlap',async()=>{
  const f=await backendFixture('scale-staging',72),store=new BackendPayloadStore(path.join(f.directory,'payloads'),f.backendIdentity,f.generation);
  const executor=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation,0,undefined,{payloads:store,workers:4});
  const gate=barrier(),started=barrier();let active=0,peak=0;
  try{
    const bytes=Buffer.alloc(65536,37),ref=await store.put(bytes);
    const reopen=new BackendPayloadStore(path.join(f.directory,'payloads'),f.backendIdentity,f.generation);
    expect(await reopen.read(ref)).toEqual(bytes);
    await fs.writeFile(path.join(store.directory,ref.id+'.payload'),Buffer.alloc(bytes.length,38));
    await expect(reopen.read(ref)).rejects.toThrow('payload_integrity_failed');
    await expect(reopen.read({...ref,id:'../outside'})).rejects.toThrow('invalid_payload_reference');
    await store.remove(ref);
    const write=f.raw.write.bind(f.raw);
    vi.spyOn(f.raw,'write').mockImplementation(async(...args)=>{active++;peak=Math.max(peak,active);if(active===4)started.release();try{await gate.entered;return await write(...args);}finally{active--;}});
    await executor.start();
    const pending=Array.from({length:4},(_,n)=>executor.write('object-'+String(n),Readable.from(bytes),{offset:0,create:true,exclusive:true}));
    try{await Promise.race([started.entered,new Promise<never>((_,reject)=>{const t=setTimeout(()=>reject(Error('disjoint writes stayed serial')),5000);t.unref();})]);expect(active).toBe(4);}finally{gate.release();}
    expect(await Promise.all(pending)).toEqual([65536,65536,65536,65536]);
    const tasks=await f.admin.withSql(sql=>sql<{payload:Record<string,unknown>;state:string}[]>`SELECT payload,state FROM sync_backend_tasks WHERE backend_identity=${f.backendIdentity}`);
    expect(tasks).toHaveLength(4);for(const task of tasks){expect(task.state).toBe('DONE');expect(task.payload).not.toHaveProperty('bytes');expect(task.payload).toHaveProperty('payloadRef.sha256');}
    for(let n=0;n<4;n++){const parts=[];for await(const b of await f.raw.openRead('object-'+String(n)))parts.push(Buffer.from(b));expect(Buffer.concat(parts)).toEqual(bytes);}
    expect(await fs.readdir(store.directory)).toEqual([]);
    await evidence('scale-staging','result',{status:'PASS',peak,files:4,bytes:4*bytes.length,sqlPayloadBytes:false,fullReadback:true,reopen:true,corruptionRefused:true});
  }finally{gate.release();await executor.close();await f.close();}
},60000);

it('corrupt staged payload is rejected before any physical write',async()=>{
  const f=await backendFixture('scale-staging-corrupt',72),store=new BackendPayloadStore(path.join(f.directory,'payloads'),f.backendIdentity,f.generation);
  let ready=false;
  const executor=new DurableBackendExecutor(f.raw,async(command,identity,payload)=>{
    if(command==='claim'&&!ready)return null;
    const answer=await f.command(command,identity,payload);
    if(command==='submit'){
      const body=payload.body as {payloadRef:{id:string;size:string}};
      await fs.writeFile(path.join(store.directory,body.payloadRef.id+'.payload'),Buffer.alloc(Number(body.payloadRef.size),99));ready=true;
    }
    return answer;
  },f.backendIdentity,f.generation,0,undefined,{payloads:store,workers:4});
  const writes=vi.spyOn(f.raw,'write');
  try{
    await expect(executor.write('protected',Readable.from(Buffer.from('original')),{offset:0,create:true,exclusive:true})).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
    const row=fixtureValue((await f.admin.withSql(sql=>sql<{state:string}[]>`SELECT state FROM sync_backend_tasks WHERE backend_identity=${f.backendIdentity}`))[0]);
    expect(row.state).toBe('REJECTED');expect(await fs.readdir(store.directory)).toHaveLength(1);
  }finally{await executor.close();await f.close();}
},60000);

it('SQL admits disjoint offsets but fences overlap, truncate and rename until prior writes finish',async()=>{
  const f=await backendFixture('scale-ranges',72),identity=f.executor.identity;
  try{
    await f.command('acquire',identity,{});const ids=Array.from({length:4},()=>uid());
    for(const [n,offset] of [0,4,2].entries())await f.command('submit',identity,{id:ids[n],command:'write',body:{path:'same',options:{offset,create:false,truncate:false},bytes:'AAAAAA=='},reservedBytes:'4'});
    await f.command('submit',identity,{id:ids[3],command:'rename',body:{source:'same',destination:'moved'},reservedBytes:'0'});
    expect(await f.command('claim',identity,{})).toMatchObject({id:ids[0]});expect(await f.command('claim',identity,{})).toMatchObject({id:ids[1]});expect(await f.command('claim',identity,{})).toBeNull();
    await f.command('complete',identity,{id:ids[0],result:4});expect(await f.command('claim',identity,{})).toBeNull();
    await f.command('complete',identity,{id:ids[1],result:4});expect(await f.command('claim',identity,{})).toMatchObject({id:ids[2]});expect(await f.command('claim',identity,{})).toBeNull();
    await f.command('complete',identity,{id:ids[2],result:4});expect(await f.command('claim',identity,{})).toMatchObject({id:ids[3]});await f.command('complete',identity,{id:ids[3],result:null});
    const truncate=uid(),later=uid();await f.command('submit',identity,{id:truncate,command:'write',body:{path:'moved',options:{offset:0,truncate:true}},reservedBytes:'4'});
    await f.command('submit',identity,{id:later,command:'write',body:{path:'moved',options:{offset:8,create:false,truncate:false}},reservedBytes:'4'});
    expect(await f.command('claim',identity,{})).toMatchObject({id:truncate});expect(await f.command('claim',identity,{})).toBeNull();
    await f.command('complete',identity,{id:truncate,result:4});expect(await f.command('claim',identity,{})).toMatchObject({id:later});await f.command('complete',identity,{id:later,result:4});
    await f.command('drain',identity,{});await f.command('stopped',identity,{connectionsClosed:true});
  }finally{await f.close();}
},60000);

it('SQL parallel claim preserves conflicting path order and never admits past UNKNOWN',async()=>{
  const f=await backendFixture('scale-claim',72),identity=f.executor.identity;
  const ids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003'];
  try{
    await f.command('acquire',identity,{});
    for(const [i,p] of ['parent/a','parent','other'].entries())await f.command('submit',identity,{id:ids[i],command:'mkdir',body:{path:p},reservedBytes:'0'});
    expect(await f.command('claim',identity,{})).toMatchObject({id:ids[0]});
    expect(await f.command('claim',identity,{})).toMatchObject({id:ids[2]});
    expect(await f.command('claim',identity,{})).toBeNull();
    await f.command('complete',identity,{id:ids[0],result:null});
    expect(await f.command('claim',identity,{})).toMatchObject({id:ids[1]});
    await f.command('unknown',identity,{id:ids[1],errorCode:'reconciliation_required'});
    expect(await f.command('claim',identity,{})).toBeNull();
    await expect(f.command('stopped',identity,{connectionsClosed:true})).rejects.toThrow('reconciliation_required');
    await evidence('scale-claim','result',{status:'PASS',ancestorOrdering:true,independentBypass:true,unknownFenced:true});
  }finally{await f.close();}
},60000);
