import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {expect,it,vi} from 'vitest';
import {backendFixture,databaseFixture,barrier,migrations,uid} from './stage3-chat-a.fixture.js';
import {DurableBackendExecutor} from '../../../packages/storage/src/durable-backend-executor.js';

const members=():GroupMember[]=>Array.from({length:4},(_,n)=>({operationId:uid(),source:'staging/'+String(n)+'.part',destination:'published/'+String(n)+'.bin'}));
const body=(items=members())=>({schema:'saturn.backend-rename-group.v1',members:items});

it('keeps exact group membership and fences every path before a single immutable completion',async()=>{
  const f=await backendFixture('smallfile-backend-publication-group',89),identity=f.executor.identity,id=uid(),payload=body();
  try{
    expect(await f.command('acquire',identity,{})).toMatchObject({owned:true,renameGroup:true});
    const submit=(b=payload)=>f.command('submit',identity,{id,command:'rename-group',body:b,reservedBytes:'0'});
    expect(await submit()).toMatchObject({id,state:'QUEUED'});
    expect(await submit()).toMatchObject({id,state:'QUEUED'});
    expect(await f.command('claim',identity,{})).toMatchObject({id,command:'rename-group',body:payload});
    const overlap=uid(),separate=uid();
    await f.command('submit',identity,{id:overlap,command:'delete',body:{path:fixtureValue(payload.members[2]).destination},reservedBytes:'0'});
    await f.command('submit',identity,{id:separate,command:'mkdir',body:{path:'other'},reservedBytes:'0'});
    expect(await f.command('claim',identity,{})).toMatchObject({id:separate});
    expect(await f.command('claim',identity,{})).toBeNull();
    const result={schema:'saturn.backend-rename-group-result.v1',operationIds:payload.members.map(m=>m.operationId)};
    await expect(f.command('complete',identity,{id,result:{...result,operationIds:[...result.operationIds].reverse()}})).rejects.toThrow('projection_mismatch');
    expect(await f.command('status',identity,{id})).toMatchObject({state:'RUNNING'});
    await f.command('complete',identity,{id,result});
    expect(await submit()).toMatchObject({state:'DONE',result});
    await expect(submit(body(payload.members.map((m,n)=>n===0?{...m,destination:'changed.bin'}:m)))).rejects.toThrow('operation_reused');
    expect(await f.command('inspect',identity,{})).toMatchObject({completedEffects:'4'});
    expect(await f.command('claim',identity,{})).toMatchObject({id:overlap});
    await f.command('complete',identity,{id:overlap,result:null});await f.command('complete',identity,{id:separate,result:null});
    await f.command('drain',identity,{});await f.command('stopped',identity,{connectionsClosed:true});
    await expect(f.admin.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0089_backend_publication_group.down.sql'),'utf8')))).rejects.toThrow('publication group task history must be retained');
  }finally{await f.close();}
},60000);

type GroupMember={operationId:string;source:string;destination:string};
type GroupExecutor={renameGroupOnce(id:string,members:readonly GroupMember[]):Promise<void>};
const groupExecutor=(e:DurableBackendExecutor)=>e as unknown as GroupExecutor;
async function staged(f:Awaited<ReturnType<typeof backendFixture>>,prefix=''){
  const result=members().map(m=>({...m,source:prefix+m.source,destination:prefix+m.destination}));
  await f.raw.mkdir(prefix+'staging');await f.raw.mkdir(prefix+'published');
  for(const m of result)await f.raw.write(m.source,Readable.from(Buffer.from(m.operationId)),{offset:0,create:true,exclusive:true});
  return result;
}

it('recovers lost submit and completion acknowledgements with one durable task and exact raw results',async()=>{
  const f=await backendFixture('smallfile-backend-group-ack',89),id=uid();let lostSubmit=0,lostComplete=0;
  const executor=new DurableBackendExecutor(f.raw,async(command,identity,payload)=>{
    const result=await f.command(command,identity,payload);
    if(command==='submit'&&lostSubmit++===0)throw Error('lost submit ACK');
    if(command==='complete'&&lostComplete++===0)throw Error('lost complete ACK');
    return result;
  },f.backendIdentity,f.generation,0,undefined,{workers:4});
  const reopened=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation,0,undefined,{workers:4});
  try{
    const items=await staged(f),rename=vi.spyOn(f.raw,'rename');
    await groupExecutor(executor).renameGroupOnce(id,items);
    await groupExecutor(reopened).renameGroupOnce(id,items);
    expect(rename).toHaveBeenCalledTimes(4);expect(lostSubmit).toBe(2);expect(lostComplete).toBe(1);
    expect(await f.admin.withSql(sql=>sql`SELECT id,command,state FROM sync_backend_tasks`)).toEqual([{id,command:'rename-group',state:'DONE'}]);
    for(const m of items){const parts:Buffer[]=[];for await(const part of fixtureChunks(await f.raw.openRead(m.destination)))parts.push(Buffer.from(part));expect(Buffer.concat(parts).toString()).toBe(m.operationId);expect(await f.raw.exists(m.source)).toBe(false);}
    await expect(groupExecutor(reopened).renameGroupOnce(id,items.map((m,n)=>n===0?{...m,destination:'other.bin'}:m))).rejects.toThrow('operation_reused');
    expect(rename).toHaveBeenCalledTimes(4);expect((await executor.diagnostics()).completedEffects).toBe('4');
  }finally{vi.restoreAllMocks();await reopened.close();await executor.close();await f.close();}
},60000);

it('retains the entire unknown group after a partial raw effect and never blindly repeats it',async()=>{
  const f=await backendFixture('smallfile-backend-group-partial',89),id=uid();
  const executor=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation,0,undefined,{workers:4});
  const resumed=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation,0,undefined,{workers:4});
  try{
    const items=await staged(f),rawRename=f.raw.rename.bind(f.raw),rename=vi.spyOn(f.raw,'rename').mockImplementationOnce(async(...args)=>{await rawRename(...args);throw Error('lost physical rename response');});
    await expect(groupExecutor(executor).renameGroupOnce(id,items)).rejects.toThrow('reconciliation_required');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await f.admin.withSql(sql=>sql`SELECT id,command,state,payload FROM sync_backend_tasks`)).toEqual([{id,command:'rename-group',state:'UNKNOWN',payload:body(items)}]);
    expect(await f.raw.exists(fixtureValue(items[0]).destination)).toBe(true);expect(await f.raw.exists(fixtureValue(items[0]).source)).toBe(false);
    for(const m of items.slice(1)){expect(await f.raw.exists(m.source)).toBe(true);expect(await f.raw.exists(m.destination)).toBe(false);}
    await expect(groupExecutor(resumed).renameGroupOnce(id,items)).rejects.toThrow('reconciliation_required');
    expect(rename).toHaveBeenCalledTimes(1);
    await expect(executor.close()).rejects.toThrow('backend_close_unconfirmed');
  }finally{vi.restoreAllMocks();await resumed.close();await executor.close().catch(()=>undefined);await f.close();}
},60000);

it('executes groups within four physical worker slots and checks every destination before its first mutation',async()=>{
  const f=await backendFixture('smallfile-backend-group-slots',89),held=barrier(),release=barrier();
  const executor=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation,0,undefined,{workers:4});
  const calls:Promise<void>[]=[];let active=0,peak=0,arrived=0;
  try{
    const groups=[];for(let n=0;n<5;n++){await f.raw.mkdir('g'+String(n));groups.push(await staged(f,'g'+String(n)+'/'));}
    const raw=f.raw.rename.bind(f.raw),rename=vi.spyOn(f.raw,'rename').mockImplementation(async(...args)=>{
      active++;peak=Math.max(peak,active);arrived++;if(arrived===4)held.release();
      try{await release.entered;return await raw(...args);}finally{active--;}
    });
    for(const items of groups){const call=groupExecutor(executor).renameGroupOnce(uid(),items);void call.catch(()=>undefined);calls.push(call);}
    await Promise.race([held.entered,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Four workers did not start')),4000))]);
    expect(peak).toBe(4);expect((await f.admin.withSql(sql=>sql`SELECT count(*)::int AS n FROM sync_backend_tasks WHERE state='RUNNING'`))[0]?.n).toBe(4);
    release.release();await Promise.all(calls);expect(peak).toBe(4);expect(rename).toHaveBeenCalledTimes(20);
    const blocked=await staged(f,'blocked-');await f.raw.write(fixtureValue(blocked[3]).destination,Readable.from(Buffer.from('keep existing')),{offset:0,create:true,exclusive:true});
    rename.mockClear();await expect(groupExecutor(executor).renameGroupOnce(uid(),blocked)).rejects.toThrow('backend_preimage_mismatch');expect(rename).not.toHaveBeenCalled();
    for(const m of blocked)expect(await f.raw.exists(m.source)).toBe(true);
  }finally{release.release();await Promise.allSettled(calls);vi.restoreAllMocks();await executor.close();await f.close();}
},60000);

it('refuses the new effect on an older database before inserting a task',async()=>{
  const f=await backendFixture('smallfile-backend-group-old',88);
  try{await expect(groupExecutor(f.executor).renameGroupOnce(uid(),members())).rejects.toThrow('unsupported');expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks`)).toHaveLength(0);}
  finally{await f.close();}
},60000);

it('rechecks the storage generation between individual raw operations and retains a partial group',async()=>{
  const f=await backendFixture('smallfile-backend-group-generation',89);let changed=false;
  const check=vi.fn(async()=>{if(changed)throw Error('backend_generation_changed');});
  const executor=new DurableBackendExecutor(f.raw,f.command,f.backendIdentity,f.generation,0,undefined,{workers:4,groupStorageCheck:check});
  try{
    const items=await staged(f),raw=f.raw.rename.bind(f.raw),rename=vi.spyOn(f.raw,'rename').mockImplementationOnce(async(...args)=>{await raw(...args);changed=true;});
    await expect(groupExecutor(executor).renameGroupOnce(uid(),items)).rejects.toThrow('reconciliation_required');
    expect(rename).toHaveBeenCalledTimes(1);expect(check.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(await f.admin.withSql(sql=>sql`SELECT command,state FROM sync_backend_tasks`)).toEqual([{command:'rename-group',state:'UNKNOWN'}]);
    for(const m of items.slice(1))expect(await f.raw.exists(m.source)).toBe(true);
  }finally{vi.restoreAllMocks();await executor.close().catch((error: unknown)=>expect(error).toMatchObject({message:'backend_close_unconfirmed'}));await f.close();}
},60000);

it('does not let a group overtake older ordinary work on any of its source or destination paths',async()=>{
  const f=await backendFixture('smallfile-backend-group-candidate-overlap',89),identity=f.executor.identity;
  try{
    await f.command('acquire',identity,{});const items=members(),prior=uid(),group=uid();
    await f.command('submit',identity,{id:prior,command:'mkdir',body:{path:'published'},reservedBytes:'0'});
    await f.command('submit',identity,{id:group,command:'rename-group',body:body(items),reservedBytes:'0'});
    expect(await f.command('claim',identity,{})).toMatchObject({id:prior});expect(await f.command('claim',identity,{})).toBeNull();
    await f.command('complete',identity,{id:prior,result:null});expect(await f.command('claim',identity,{})).toMatchObject({id:group});
    await expect(f.command('claim',{...identity,generation:uid()},{})).rejects.toThrow('binding_invalid');
    await f.command('complete',identity,{id:group,result:{schema:'saturn.backend-rename-group-result.v1',operationIds:items.map(i=>i.operationId)}});
    await f.command('drain',identity,{});await f.command('stopped',identity,{connectionsClosed:true});
  }finally{await f.close();}
},60000);

it('rejects malformed or overlapping group plans and preserves unknown originals',async()=>{
  const f=await backendFixture('smallfile-backend-publication-invalid',89),identity=f.executor.identity;
  try{
    expect(await f.command('acquire',identity,{})).toMatchObject({renameGroup:true});
    const items=members();
    const invalid=[body([]),body([...items,...members()]),body([fixtureValue(items[0]),fixtureValue(items[0])]),
      body(items.map((m,n)=>n===1?{...m,destination:fixtureValue(items[0]).source+'/child'}:m)),
      {...body(items),extra:true},body(items.map((m,n)=>n===0?{...m,operationId:'bad'}:m))];
    for(const b of invalid)await expect(f.command('submit',identity,{id:uid(),command:'rename-group',body:b,reservedBytes:'0'})).rejects.toThrow('invalid_input');
    await expect(f.command('submit',identity,{id:uid(),command:'rename-group',body:body(),reservedBytes:'1'})).rejects.toThrow('invalid_input');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks`)).toHaveLength(0);
    const id=uid(),payload={id,command:'rename-group',body:body(items),reservedBytes:'0'};
    await f.command('submit',identity,payload);await f.command('claim',identity,{});
    await f.command('unknown',identity,{id,errorCode:'reconciliation_required'});
    expect(await f.command('submit',identity,payload)).toMatchObject({id,state:'UNKNOWN'});
    expect(await f.command('claim',identity,{})).toBeNull();
    await expect(f.command('submit',identity,{...payload,id:uid()})).rejects.toThrow('reconciliation_required');
    await expect(f.command('stopped',identity,{connectionsClosed:true})).rejects.toThrow('reconciliation_required');
  }finally{await f.close();}
},60000);

it('restores the exact predecessor and refuses installation while an owner is running',async()=>{
  const f=await databaseFixture('smallfile-backend-publication-rollback',88);
  try{
    const read=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure) AS definition,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='sync_backend_tasks'::regclass AND conname='sync_backend_tasks_command_check') AS constraint_definition`);
    const before=await read(),up=await fs.readFile(path.join(migrations,'0089_backend_publication_group.up.sql'),'utf8'),down=await fs.readFile(path.join(migrations,'0089_backend_publication_group.down.sql'),'utf8');
    await f.db.transaction(sql=>sql.unsafe(up));await f.db.transaction(sql=>sql.unsafe(down));expect(await read()).toEqual(before);
    await f.db.withSql(sql=>sql`INSERT INTO sync_backend_executor(backend_identity,generation,writer_login,writer_owner,state) VALUES('live',${uid()},'postgres','postgres','RUNNING')`);
    await expect(f.db.transaction(sql=>sql.unsafe(up))).rejects.toThrow('backend must be stopped before group migration');
    expect(await read()).toEqual(before);
  }finally{await f.close();}
},60000);
