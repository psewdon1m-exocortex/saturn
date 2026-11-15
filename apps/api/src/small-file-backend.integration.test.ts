import {expect,it} from 'vitest';
import {backendFixture,barrier,uid} from './stage3-chat-a.fixture.js';

const reviewMigration=Number(process.env.SMALL_FILE_REVIEW_MIGRATION??77);
if(![77,80,84,86,87,88].includes(reviewMigration))throw Error('Invalid review migration');

it.each(['status','inspect','claim'])('backend %s does not serialize behind an unrelated admission row lock when it has no effect',async command=>{
  const f=await backendFixture('smallfile-backend-'+command,reviewMigration),identity=f.executor.identity,gate=barrier(),locked=barrier();
  let transaction:Promise<unknown>|undefined,read:Promise<unknown>|undefined;
  try{
    await f.command('acquire',identity,{});
    const id=uid();await f.command('submit',identity,{id,command:'mkdir',body:{path:'not-executed'},reservedBytes:'0'});
    await f.command('claim',identity,{});await f.command('complete',identity,{id,result:null});
    transaction=f.admin.transaction(async sql=>{await sql`SELECT backend_identity FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity} FOR UPDATE`;locked.release();await gate.entered;});
    await locked.entered;
    read=f.command(command,identity,command==='status'?{id}:{});
    const delayed=Symbol('blocked');let timer:ReturnType<typeof setTimeout>|undefined;
    try{expect(await Promise.race([read,new Promise<symbol>(resolve=>{timer=setTimeout(()=>resolve(delayed),300);})])).not.toBe(delayed);}finally{clearTimeout(timer);}
    gate.release();await transaction;
    await expect(f.command('claim',{...identity,ownerId:uid()},{})).rejects.toThrow('backend_draining');
    await expect(f.command('claim',{...identity,generation:uid()},{})).rejects.toThrow('binding_invalid');
    await f.command('drain',identity,{});await f.command('stopped',identity,{connectionsClosed:true});
  }finally{gate.release();await transaction;await read;await f.close();}
},60000);

it('returns a committed terminal task receipt and never admits work beyond UNKNOWN',async()=>{
  const f=await backendFixture('smallfile-backend-receipt',reviewMigration),identity=f.executor.identity;
  try{
    await f.command('acquire',identity,{});
    const id=uid();await f.command('submit',identity,{id,command:'mkdir',body:{path:'a'},reservedBytes:'0'});await f.command('claim',identity,{});
    expect(await f.command('complete',identity,{id,result:null})).toMatchObject({id,state:'DONE',result:null});
    expect(await f.command('complete',identity,{id,result:'different'})).toMatchObject({id,state:'DONE',result:null});
    const unknown=uid(),later=uid();await f.command('submit',identity,{id:unknown,command:'mkdir',body:{path:'b'},reservedBytes:'0'});await f.command('claim',identity,{});
    await f.command('submit',identity,{id:later,command:'mkdir',body:{path:'c'},reservedBytes:'0'});
    await f.command('unknown',identity,{id:unknown,errorCode:'reconciliation_required'});
    expect(await f.command('claim',identity,{})).toBeNull();
    expect(await f.command('status',identity,{id:later})).toMatchObject({state:'QUEUED'});
    await expect(f.command('stopped',identity,{connectionsClosed:true})).rejects.toThrow('reconciliation_required');
  }finally{await f.close();}
},60000);
