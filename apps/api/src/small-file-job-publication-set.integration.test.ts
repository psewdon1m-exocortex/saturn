import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,uid,sha} from './stage3-chat-a.fixture.js';
const migration=Number(process.env.SMALL_FILE_JOB_SET_MIGRATION??96);
it('publishes sixteen verified originals in one SQL set and one sequential rename task, with four materializers',async()=>{
  const f=await activeFixture('job-publication-set','windows',migration),database=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:database});
  try{
    const bytes=Buffer.alloc(8192,97),inputs=Array.from({length:16},(_,n)=>f.uploadInput('job-set-'+String(n)+'.bin',bytes));
    const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'1',items:inputs.map(input=>({operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:f.rootId,name:input.intent.name,size_bytes:String(bytes.length),sha256:sha(bytes),expected:{kind:'absent'}}))};
    const wire=Buffer.from(JSON.stringify({manifest,inputs}));await database.prepareExecutionJob(wire,f.wireBinding,f.proof);
    const job=await database.prepareExecutionJob(wire,f.wireBinding,f.proof,true),calls=vi.spyOn(database,'verifyAndClaimGroup'),renames=vi.spyOn(f.executor,'renameGroupOnce');
    const write=f.raw.write.bind(f.raw);let active=0,maximum=0;
    vi.spyOn(f.raw,'write').mockImplementation(async(...args)=>{active++;maximum=Math.max(maximum,active);try{return await write(...args);}finally{active--;}});
    const result=await Promise.all(job.members.map(async p=>(await files.materializeSmallExecutionJob(p,f.proof,bytes)).completion));
    expect(calls.mock.calls.map(c=>c[0].length)).toEqual([16]);expect(renames.mock.calls.map(c=>c[1].length)).toEqual([16]);expect(maximum).toBeLessThanOrEqual(4);
    expect(result.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(16);
    const [task,members]=fixtureValue(renames.mock.calls[0]);
    const effects=await f.executor.diagnostics();await f.executor.renameGroupOnce(task,members);
    expect((await f.executor.diagnostics()).completedEffects).toBe(effects.completedEffects);
    await expect(f.executor.renameGroupOnce(task,members.map((m,n)=>n===15?{...m,destination:m.destination+'-changed'}:m))).rejects.toThrow('operation_reused');
    const forged={id:uid(),command:'rename-group',reservedBytes:'0',body:{schema:'saturn.backend-rename-group.v1',members:members.slice(0,5)}};
    await expect(f.command('submit',f.executor.identity,forged)).rejects.toThrow('publication group membership invalid');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks WHERE id=${forged.id}`)).toHaveLength(0);
    for(const p of result){const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(p.execution.targetPath)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));}
  }finally{vi.restoreAllMocks();await f.close();}
},60000);
