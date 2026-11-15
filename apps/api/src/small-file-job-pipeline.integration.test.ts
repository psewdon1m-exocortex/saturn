import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import {expect,it,vi} from 'vitest';
// These cases require the two-private-job pipeline introduced in migration 97.
const migration=Number(process.env.SMALL_FILE_JOB_MIGRATION??97);
if(![97,98,99,101,102,103,104,105].includes(migration))throw Error('Invalid job pipeline migration');
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,barrier,sha,uid} from './stage3-chat-a.fixture.js';

type Fixture=Awaited<ReturnType<typeof activeFixture>>;
function request(f:Fixture,prefix='pipeline'){
  const bytes=Buffer.alloc(8192,93),inputs=Array.from({length:16},(_,n)=>f.uploadInput(prefix+'-'+String(n)+'.bin',bytes));
  const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'pipeline-v1',items:inputs.map(input=>({
    operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:input.intent.idempotencyKey,parent_id:input.intent.parentId,
    name:input.intent.name,size_bytes:input.intent.sizeBytes,sha256:input.intent.sha256,expected:{kind:'absent'},
  }))};
  return {bytes,inputs,wire:Buffer.from(JSON.stringify({manifest,inputs}))};
}
function composed(f:Fixture){
  const database=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  return {database,files:new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,
    catalogRootAdmission:f.admission,catalogUploadCoordinator:database})};
}

it('keeps progressing sibling jobs in separate complete publication sets',async()=>{
  const f=await activeFixture('smallfile-job-progress-groups','windows',migration),c=composed(f);
  try{
    const inputs=[request(f,'first'),request(f,'second')],jobs=[];
    for(const input of inputs){await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof);jobs.push(await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof,true));}
    const write=f.raw.write.bind(f.raw),groups=vi.spyOn(c.database,'verifyAndClaimGroup');let active=0,maximum=0;
    vi.spyOn(f.raw,'write').mockImplementation(async(...args)=>{
      active++;maximum=Math.max(maximum,active);
      try{await new Promise(resolve=>setTimeout(resolve,100));return await write(...args);}finally{active--;}
    });
    const results=await Promise.all(jobs.flatMap((job,n)=>job.members.map(async p=>(await c.files.materializeSmallExecutionJob(p,f.proof,fixtureValue(inputs[n]).bytes)).completion)));
    expect(results.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
    expect(groups.mock.calls.map(call=>call[0].length)).toEqual([16,16]);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(32);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('pipelines private materialization while the first publication waits, with one receipt per original',async()=>{
  const f=await activeFixture('smallfile-job-pipeline','windows',migration),c=composed(f),held=barrier(),release=barrier(),fifth=barrier();
  let running:Promise<unknown>|undefined;
  try{
    const input=request(f),accepted=await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof);
    expect(accepted.executionAdmitted).toBe(false);
    const job=await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof,true);
    expect(job.executionAdmitted).toBe(true);expect(job.members.map(p=>p.status.session.uploadId)).toEqual(accepted.members.map(p=>p.status.session.uploadId));
    const commit=c.database.commitSet.bind(c.database),write=f.raw.write.bind(f.raw);let writes=0,active=0,maximum=0;
    vi.spyOn(f.raw,'write').mockImplementation(async(...args)=>{active++;maximum=Math.max(maximum,active);try{const result=await write(...args);if(++writes===5)fifth.release();return result;}finally{active--;}});
    vi.spyOn(c.database,'commitSet').mockImplementationOnce(async(...args)=>{held.release();await release.entered;return commit(...args);});
    running=Promise.all(job.members.map(async p=>(await c.files.materializeSmallExecutionJob(p,f.proof,input.bytes)).completion));
    await held.entered;
    // A fifth independent private file must be written before the first group
    // can commit. Simply raising transport windows cannot satisfy this check.
    await Promise.race([fifth.entered,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('pipeline did not advance')),3000);timer.unref();})]);
    expect(writes).toBeGreaterThanOrEqual(5);expect(maximum).toBeLessThanOrEqual(4);
    release.release();const results=await running as Awaited<ReturnType<typeof c.database.prepareExecutionJob>>['members'];
    expect(results.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);expect(writes).toBe(16);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(16);
    for(const p of results){const chunks:Buffer[]=[];for await(const b of fixtureChunks(await f.raw.openRead(p.execution.targetPath)))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(sha(input.bytes));}
  }finally{release.release();await running?.catch(()=>undefined);vi.restoreAllMocks();await f.close();}
},60000);

it('recovers a lost durable write response with a new job reader and no repeated physical writes',async()=>{
  const f=await activeFixture('smallfile-job-pipeline-retry','windows',migration),c=composed(f);
  try{
    const input=request(f);await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof);
    const started=await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof,true),writes=vi.spyOn(f.raw,'write');
    if(await f.executor.supportsWriteVerifiedOnce()){
      const write=f.executor.writeVerifiedOnce.bind(f.executor);
      vi.spyOn(f.executor,'writeVerifiedOnce').mockImplementationOnce(async(...args)=>{await write(...args);throw Error('lost write ACK');});
    }else{
      const write=f.executor.writeOnce.bind(f.executor);
      vi.spyOn(f.executor,'writeOnce').mockImplementationOnce(async(...args)=>{await write(...args);throw Error('lost write ACK');});
    }
    const failed=await Promise.allSettled(started.members.map(async p=>(await c.files.materializeSmallExecutionJob(p,f.proof,input.bytes)).completion));
    expect(failed.some(r=>r.status==='rejected')).toBe(true);
    const restarted=composed(f),resumed=await restarted.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof,true);
    expect(resumed.members.map(p=>p.status.session.uploadId)).toEqual(started.members.map(p=>p.status.session.uploadId));
    const done=await Promise.all(resumed.members.map(async p=>(await restarted.files.materializeSmallExecutionJob(p,f.proof,input.bytes)).completion));
    expect(done.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);expect(writes).toHaveBeenCalledTimes(16);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(16);
    for(const p of done){const chunks:Buffer[]=[];for await(const b of fixtureChunks(await f.raw.openRead(p.execution.targetPath)))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(sha(input.bytes));}
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('retains individual committed receipts when the first set commit response is lost',async()=>{
  const f=await activeFixture('smallfile-job-pipeline-commit-ack','windows',migration),c=composed(f);
  try{
    const input=request(f);await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof);
    const started=await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof,true),commit=c.database.commitSet.bind(c.database),writes=vi.spyOn(f.raw,'write');
    vi.spyOn(c.database,'commitSet').mockImplementationOnce(async(...args)=>{await commit(...args);throw Error('lost publication ACK');});
    const done=await Promise.all(started.members.map(async p=>(await c.files.materializeSmallExecutionJob(p,f.proof,input.bytes)).completion));
    expect(done.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
    const reader=composed(f),replay=await reader.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof);
    expect(replay.members.map(p=>p.status.result)).toEqual(done.map(p=>p.status.result));expect(writes).toHaveBeenCalledTimes(16);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(16);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('keeps an uncertain rename as a root barrier and retains all original records',async()=>{
  const f=await activeFixture('smallfile-job-pipeline-unknown','windows',migration),c=composed(f);
  try{
    const input=request(f);await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof);
    const started=await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof,true),rename=f.raw.rename.bind(f.raw);
    vi.spyOn(f.raw,'rename').mockImplementationOnce(async(...args)=>{await rename(...args);throw Error('rename result unknown');});
    const results=await Promise.allSettled(started.members.map(async p=>(await c.files.materializeSmallExecutionJob(p,f.proof,input.bytes)).completion));
    expect(results.some(r=>r.status==='rejected')).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId}`)).toHaveLength(16);
    expect(fixtureValue((await f.admin.withSql(sql=>sql<{namespace_state:string}[]>`SELECT namespace_state FROM sync_root_clock WHERE root_id=${f.rootId}`))[0]).namespace_state).toBe('BACKEND_UNCERTAIN');
    await expect(composed(f).database.prepareExecutionJob(input.wire,f.wireBinding,f.proof,true)).rejects.toThrow('binding_invalid');
    const status=await composed(f).database.prepareExecutionJob(input.wire,f.wireBinding,f.proof);
    expect(status.members.map(p=>p.status.session.uploadId)).toEqual(started.members.map(p=>p.status.session.uploadId));
    await f.admission.drain();
    await expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');
  }finally{
    vi.restoreAllMocks();
    try{await f.executor.close();}catch(error){expect(error).toMatchObject({message:'backend_close_unconfirmed'});}
    await Promise.all([f.runtime.close(),f.writer.close(),f.admin.close()]);
  }
},60000);

it('never turns an acceptance/status result or a cloned handle into a materialization permit',async()=>{
  const f=await activeFixture('smallfile-job-permit','windows',migration),c=composed(f);
  try{
    const input=request(f),accepted=await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof),writes=vi.spyOn(f.raw,'write');
    await expect(c.files.materializeSmallExecutionJob(fixtureValue(accepted.members[0]),f.proof,input.bytes)).rejects.toThrow('authority_invalid');
    const started=await c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof,true);
    await expect(c.files.materializeSmallExecutionJob({...fixtureValue(started.members[0])},f.proof,input.bytes)).rejects.toThrow('authority_invalid');
    expect(writes).not.toHaveBeenCalled();
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);
    await expect(c.database.prepareExecutionJob(input.wire,f.wireBinding,f.proof,true)).rejects.toThrow('authorization_changed');
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

