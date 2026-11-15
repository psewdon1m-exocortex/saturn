import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {expect,it,vi} from 'vitest';
import {backendFixture,databaseFixture,barrier,migrations,sha,uid} from './stage3-chat-a.fixture.js';
import {BackendPayloadStore} from '../../../packages/storage/src/backend-payload-store.js';
import {DurableBackendExecutor} from '../../../packages/storage/src/durable-backend-executor.js';

function body(ref:{id:string;size:string;sha256:string},target='once.bin'){
  return {schema:'saturn.backend-write-once.v1',path:target,options:{offset:0,create:true,exclusive:true,truncate:false},payloadRef:ref};
}

it('replays a sealed write identity with another matching payload reference but never changes its physical task',async()=>{
  const f=await backendFixture('smallfile-once-sql',81),identity=f.executor.identity,id=uid();
  try{
    expect(await f.command('acquire',identity,{})).toMatchObject({owned:true,writeOnce:true});
    const first={id:uid(),size:'4',sha256:sha('data')},second={...first,id:uid()};
    const submit=(value:ReturnType<typeof body>,reservedBytes='4')=>f.command('submit-once',identity,{id,command:'write',body:value,reservedBytes});
    expect(await submit(body(first))).toMatchObject({id,state:'QUEUED'});
    expect(await submit(body(second))).toMatchObject({id,state:'QUEUED'});
    expect(await f.command('claim',identity,{})).toMatchObject({id,body:body(first)});
    expect(await submit(body(second))).toMatchObject({id,state:'RUNNING'});
    expect(await f.command('claim',identity,{})).toBeNull();
    await f.command('complete',identity,{id,result:4});
    expect(await submit(body(second))).toMatchObject({id,state:'DONE',result:4});
    for(const value of [body({...second,sha256:sha('else')}),body(second,'elsewhere'),{...body(second),options:{...body(second).options,offset:4}}])
      await expect(submit(value)).rejects.toThrow('operation_reused');
    await expect(submit(body(second),'5')).rejects.toThrow('invalid_input');
    await expect(f.command('submit-once',identity,{id:uid(),command:'rename',body:body(second),reservedBytes:'4'})).rejects.toThrow('invalid_input');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks`)).toHaveLength(1);
    await f.command('drain',identity,{});await f.command('stopped',identity,{connectionsClosed:true});
  }finally{await f.close();}
},60000);

it('keeps an uncertain original fenced when its matching write is submitted again',async()=>{
  const f=await backendFixture('smallfile-once-unknown',81),identity=f.executor.identity,id=uid();
  try{
    await f.command('acquire',identity,{});const ref={id:uid(),size:'4',sha256:sha('data')};
    await f.command('submit-once',identity,{id,command:'write',body:body(ref),reservedBytes:'4'});await f.command('claim',identity,{});
    await f.command('unknown',identity,{id,errorCode:'reconciliation_required'});
    expect(await f.command('submit-once',identity,{id,command:'write',body:body({...ref,id:uid()}),reservedBytes:'4'})).toMatchObject({id,state:'UNKNOWN'});
    await expect(f.command('submit-once',identity,{id:uid(),command:'write',body:body({...ref,id:uid()}),reservedBytes:'4'})).rejects.toThrow('reconciliation_required');
    expect(await f.command('claim',identity,{})).toBeNull();
    await expect(f.command('stopped',identity,{connectionsClosed:true})).rejects.toThrow('reconciliation_required');
  }finally{await f.close();}
},60000);

it('restores exact backend command on rollback',async()=>{
  const f=await databaseFixture('smallfile-once-rollback',80);
  try{
    const definition=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure) AS source`),before=await definition();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0081_backend_write_once.up.sql'),'utf8')));
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0081_backend_write_once.down.sql'),'utf8')));
    expect(await definition()).toEqual(before);
  }finally{await f.close();}
},60000);

it('recovers a lost submit ACK and a new caller obtains the original DONE without another write',async()=>{
  const f=await backendFixture('smallfile-once-replay',81),store=new BackendPayloadStore(path.join(f.directory,'payloads'),f.backendIdentity,f.generation),id=uid();
  let lost=0,lostComplete=0;
  const executor=new DurableBackendExecutor(f.raw,async(command,identity,payload)=>{
    const result=await f.command(command,identity,payload);
    if(command==='submit-once'&&lost++<2)throw Error('lost submit ACK');
    if(command==='complete'&&lostComplete++===0)throw Error('lost complete ACK');
    return result;
  },f.backendIdentity,f.generation,0,undefined,{payloads:store,workers:4});
  const reopened=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation,0,undefined,{payloads:new BackendPayloadStore(path.join(f.directory,'payloads'),f.backendIdentity,f.generation)});
  const bytes=Buffer.from('exact durable transfer'),options={offset:0,create:true,exclusive:true,truncate:false},writes=vi.spyOn(f.raw,'write');
  try{
    await expect(executor.writeOnce(id,'once.bin',bytes,options)).rejects.toThrow('lost submit ACK');
    expect(await executor.writeOnce(id,'once.bin',bytes,options)).toBe(bytes.length);
    expect(await reopened.writeOnce(id,'once.bin',bytes,options)).toBe(bytes.length);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(lostComplete).toBe(1);
    const chunks=[];for await(const part of await f.raw.openRead('once.bin'))chunks.push(Buffer.from(part));expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(await f.admin.withSql(sql=>sql`SELECT id,state FROM sync_backend_tasks`)).toEqual([{id,state:'DONE'}]);
    expect(await fs.readdir(store.directory)).toEqual([]);
    await expect(reopened.writeOnce(id,'once.bin',Buffer.from('different bytes'),options)).rejects.toThrow('operation_reused');
    expect(writes).toHaveBeenCalledTimes(1);
    await executor.close();
    await expect(f.admin.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0081_backend_write_once.down.sql'),'utf8')))).rejects.toThrow('write-once task history must be retained');
  }finally{await reopened.close();await executor.close();await f.close();}
},60000);

it('joins concurrent matching retries without duplicating the raw write',async()=>{
  const f=await backendFixture('smallfile-once-concurrent',81),store=new BackendPayloadStore(path.join(f.directory,'payloads'),f.backendIdentity,f.generation),id=uid(),gate=barrier(),started=barrier();
  const executor=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation,0,undefined,{payloads:store,workers:4});
  const rawWrite=f.raw.write.bind(f.raw),write=vi.spyOn(f.raw,'write').mockImplementation(async(...args)=>{started.release();await gate.entered;return rawWrite(...args);});
  let first:Promise<number>|undefined,second:Promise<number>|undefined;
  try{
    const bytes=Buffer.from('one effect'),options={offset:0,create:true,exclusive:true};
    first=executor.writeOnce(id,'once.bin',bytes,options);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([started.entered,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('write did not start')),3000);})]);}finally{clearTimeout(timer);}
    second=executor.writeOnce(id,'once.bin',bytes,options);gate.release();
    expect(await Promise.all([first,second])).toEqual([bytes.length,bytes.length]);expect(write).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(store.directory)).toEqual([]);
  }finally{gate.release();await Promise.allSettled([first,second]);await executor.close();await f.close();}
},60000);

it('refuses old databases before creating a write task or payload',async()=>{
  const f=await backendFixture('smallfile-once-old',80),store=new BackendPayloadStore(path.join(f.directory,'payloads'),f.backendIdentity,f.generation);
  const executor=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation,0,undefined,{payloads:store});
  try{
    await expect(executor.writeOnce(uid(),'once.bin',Buffer.from('no effect'),{offset:0,create:true,exclusive:true})).rejects.toMatchObject({code:'unsupported'});
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks`)).toHaveLength(0);
    expect(await fs.readdir(store.directory)).toEqual([]);
    expect(await executor.write('ordinary.bin',Readable.from(Buffer.from('old path')),{offset:0,create:true,exclusive:true})).toBe(8);
    expect(await f.raw.exists('ordinary.bin')).toBe(true);
  }finally{await executor.close();await f.close();}
},60000);
