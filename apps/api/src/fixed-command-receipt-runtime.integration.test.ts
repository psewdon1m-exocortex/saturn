import { expect,it } from 'vitest';
import { backendFixture,uid } from './stage3-chat-a.fixture.js';

const qualified=it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE);
function invalidSubmission(){return {id:uid(),command:'write',body:{invalid:true},reservedBytes:'1'};}

qualified('fixed backend statements keep rollback evidence separate from concurrent successful observations',async()=>{
  const f=await backendFixture('fixed-command-receipt-runtime',126);
  try{
    await f.executor.start();
    const attempts=Array.from({length:8},()=>({payload:invalidSubmission(),witness:{}}));
    const results=await Promise.all(attempts.map(async attempt=>{
      const failure=f.writer.backendCommand('submit-once',f.executor.identity,attempt.payload,attempt.witness).catch((error:unknown)=>error);
      const observed=f.writer.backendCommand('inspect',f.executor.identity,{});
      return {failure:await failure,observed:await observed,attempt};
    }));
    for(const result of results){
      expect(result.failure).toMatchObject({code:'P0001',message:'invalid_input'});
      expect(result.observed).toMatchObject({state:'RUNNING',ownerId:f.executor.identity.ownerId,queued:0,unknown:0});
      expect(f.writer.confirmsBackendRollback(result.failure,'submit-once',f.executor.identity,result.attempt.payload,result.attempt.witness)).toBe(true);
      expect(f.writer.confirmsBackendRollback(result.failure,'submit-once',f.executor.identity,result.attempt.payload,{})).toBe(false);
    }
  }finally{await f.close();}
},60000);

qualified('fixed backend observations remain available while an independent mutation waits for its owner row',async()=>{
  const f=await backendFixture('fixed-command-observation-runtime',126);
  let unlock:()=>void=()=>undefined;
  let holding:Promise<void>|undefined;
  let failed:Promise<unknown>|undefined;
  let observed:Promise<unknown>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await f.executor.start();
    await f.writer.backendCommand('inspect',f.executor.identity,{});
    let locked:()=>void=()=>undefined;
    const acquired=new Promise<void>(resolve=>{locked=resolve;});
    const released=new Promise<void>(resolve=>{unlock=resolve;});
    holding=f.admin.transaction(async sql=>{
      await sql`SELECT backend_identity FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity} FOR UPDATE`;
      locked();await released;
    });
    await acquired;
    const payload=invalidSubmission(),witness={};
    failed=f.writer.backendCommand('submit-once',f.executor.identity,payload,witness).catch((error:unknown)=>error);
    observed=f.writer.backendCommand('inspect',f.executor.identity,{});
    const current=await Promise.race([observed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Observation blocked behind mutation')),1000);})]);
    expect(current).toMatchObject({state:'RUNNING',ownerId:f.executor.identity.ownerId,queued:0,unknown:0});
    unlock();await holding;
    const failure=await failed;
    expect(failure).toMatchObject({code:'P0001',message:'invalid_input'});
    expect(f.writer.confirmsBackendRollback(failure,'submit-once',f.executor.identity,payload,witness)).toBe(true);
  }finally{
    clearTimeout(timer);unlock();
    await Promise.allSettled([holding,failed,observed]);
    await f.close();
  }
},60000);
