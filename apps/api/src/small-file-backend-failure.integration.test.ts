import {expect,it,vi} from 'vitest';
import {backendFixture,barrier} from './stage3-chat-a.fixture.js';

const reviewMigration=Number(process.env.SMALL_FILE_REVIEW_MIGRATION??77);
if(![77,80,84,86,87,88].includes(reviewMigration))throw Error('Invalid review migration');
import {DurableBackendExecutor} from '../../../packages/storage/src/durable-backend-executor.js';

it('releases a waiting submitter after a lost claim response while retaining the unreconciled original',async()=>{
  const f=await backendFixture('smallfile-backend-claim-failure',reviewMigration),effect=vi.spyOn(f.raw,'mkdir');
  const failure=Error('lost claim response');let lost=false;
  const executor=new DurableBackendExecutor(f.raw,async(command,identity,payload)=>{
    const value=await f.command(command,identity,payload);
    if(command==='claim'&&value!==null&&!lost){lost=true;throw failure;}
    return value;
  },f.backendIdentity,f.generation);
  try{
    await executor.start();
    const request=executor.mkdir('unresolved'),blocked=Symbol('blocked');let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const result=await Promise.race([request.then(()=>undefined,(e: unknown)=>e),new Promise<symbol>(r=>{timer=setTimeout(()=>r(blocked),2000);})]);
      expect(result).toBe(failure);
    }finally{clearTimeout(timer);}
    expect(lost).toBe(true);expect(effect).not.toHaveBeenCalled();
    const tasks=await f.admin.withSql(sql=>sql`SELECT id,state FROM sync_backend_tasks`);
    expect(tasks).toHaveLength(1);expect(tasks[0]?.state).toBe('RUNNING');
    await expect(executor.mkdir('new')).rejects.toBe(failure);
    await expect(executor.close()).rejects.toThrow('backend_close_unconfirmed');
    expect(await f.admin.withSql(sql=>sql`SELECT id,state FROM sync_backend_tasks`)).toEqual(tasks);
    expect((await f.admin.withSql(sql=>sql`SELECT state FROM sync_backend_executor`))[0]?.state).not.toBe('STOPPED');
  }finally{await executor.close().catch(()=>undefined);await f.close();}
},60000);

it('returns a confirmed successful receipt even when a different worker loses its claim response',async()=>{
  const f=await backendFixture('smallfile-backend-peer-failure',reviewMigration),started=barrier(),release=barrier();
  const failure=Error('peer lost claim response');let claims=0;
  const mkdir=f.raw.mkdir.bind(f.raw);f.raw.mkdir=async p=>{await mkdir(p);started.release();await release.entered;};
  const executor=new DurableBackendExecutor(f.raw,async(command,identity,payload)=>{
    const value=await f.command(command,identity,payload);
    if(command==='claim'&&value!==null&&++claims===2){await started.entered;throw failure;}
    return value;
  },f.backendIdentity,f.generation,268435456,undefined,{workers:2});
  let first:Promise<unknown>|undefined;
  try{
    await executor.start();first=executor.mkdir('first').then(()=>undefined,(e: unknown)=>e);await started.entered;
    expect(await executor.mkdir('second').then(()=>undefined,(e: unknown)=>e)).toBe(failure);
    release.release();expect(await first).toBeUndefined();
    expect(await f.admin.withSql(sql=>sql`SELECT state FROM sync_backend_tasks ORDER BY state`)).toEqual([{state:'DONE'},{state:'RUNNING'}]);
    await expect(executor.close()).rejects.toThrow('backend_close_unconfirmed');
  }finally{release.release();await first;await executor.close().catch(()=>undefined);await f.close();}
},60000);
