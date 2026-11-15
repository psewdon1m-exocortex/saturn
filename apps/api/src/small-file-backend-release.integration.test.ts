import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {backendFixture,databaseFixture,barrier,migrations,uid} from './stage3-chat-a.fixture.js';

it('releases only its existing read slot without waiting for the global mutation row',async()=>{
  const f=await backendFixture('smallfile-read-release',80),identity=f.executor.identity,id=uid(),gate=barrier(),locked=barrier();
  let transaction:Promise<unknown>|undefined,release:Promise<unknown>|undefined;
  try{
    await f.command('acquire',identity,{});
    expect(await f.command('read-acquire',identity,{id,priority:'foreground'})).toMatchObject({acquired:true});
    await f.command('read-release',{...identity,ownerId:uid()},{id});
    expect((await f.command('inspect',identity,{}) as {activeReads:number}).activeReads).toBe(1);
    await expect(f.command('read-release',{...identity,generation:uid()},{id})).rejects.toThrow('binding_invalid');
    transaction=f.admin.transaction(async sql=>{await sql`SELECT backend_identity FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity} FOR UPDATE`;locked.release();await gate.entered;});
    await locked.entered;
    release=f.command('read-release',identity,{id});
    let timer:ReturnType<typeof setTimeout>|undefined;const blocked=Symbol('blocked');
    try{expect(await Promise.race([release,new Promise<symbol>(resolve=>{timer=setTimeout(()=>resolve(blocked),300);})])).not.toBe(blocked);}finally{clearTimeout(timer);}
    gate.release();await transaction;
    expect((await f.command('inspect',identity,{}) as {activeReads:number}).activeReads).toBe(0);
    await f.command('drain',identity,{});await f.command('stopped',identity,{connectionsClosed:true});
  }finally{gate.release();await transaction;await release;await f.close();}
},60000);

it('an ineligible full-capacity claim remains an observation and cannot start a fifth effect',async()=>{
  const f=await backendFixture('smallfile-full-claim',80),identity=f.executor.identity,gate=barrier(),locked=barrier();
  let transaction:Promise<unknown>|undefined,claim:Promise<unknown>|undefined;
  try{
    await f.command('acquire',identity,{});
    const ids=Array.from({length:5},()=>uid());
    for(const [n,id]of ids.entries())await f.command('submit',identity,{id,command:'mkdir',body:{path:'dir-'+String(n)},reservedBytes:'0'});
    for(let n=0;n<4;n++)expect(await f.command('claim',identity,{})).not.toBeNull();
    transaction=f.admin.transaction(async sql=>{await sql`SELECT backend_identity FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity} FOR UPDATE`;locked.release();await gate.entered;});
    await locked.entered;claim=f.command('claim',identity,{});
    let timer:ReturnType<typeof setTimeout>|undefined;const blocked=Symbol('blocked');
    try{expect(await Promise.race([claim,new Promise<symbol>(resolve=>{timer=setTimeout(()=>resolve(blocked),300);})])).toBeNull();}finally{clearTimeout(timer);}
    gate.release();await transaction;
    expect(await f.command('status',identity,{id:ids[4]})).toMatchObject({state:'QUEUED'});
    await expect(f.command('claim',{...identity,ownerId:uid()},{})).rejects.toThrow('backend_draining');
  }finally{gate.release();await transaction;await claim;await f.close();}
},60000);

it('restores the exact backend predecessor on rollback',async()=>{
  const f=await databaseFixture('smallfile-read-release-rollback',79);
  try{
    const definition=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef('sync_backend_command(text,jsonb,jsonb)'::regprocedure) AS source`);
    const before=await definition();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0080_backend_release_observation.up.sql'),'utf8')));
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0080_backend_release_observation.down.sql'),'utf8')));
    expect(await definition()).toEqual(before);
  }finally{await f.close();}
},60000);
