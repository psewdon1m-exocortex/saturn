import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {inspectJournal} from '../../../packages/recovery/src/consistent-snapshot.js';
import {DatabaseMetadataExporter} from '../../../packages/recovery/src/metadata-exporter.js';
import {qualifyCatalogDatabaseRoles} from '../../../packages/database/src/catalog-role-qualification.js';
import {activeFixture,activeRootsFixture,sha,uid,evidence,migrations} from './stage3-chat-a.fixture.js';

const migration=Number(process.env.SMALL_FILE_JOB_MIGRATION??92);
if(![91,92,93,94,95,96,97,98,99,101,102,103,104,105].includes(migration))throw Error('Invalid job admission migration');
type Fixture=Awaited<ReturnType<typeof activeFixture>>;
function job(f:Fixture,count=16){
  const bytes=Buffer.alloc(3072,83),inputs=Array.from({length:count},(_,n)=>f.uploadInput('job-'+String(n)+'.bin',bytes));
  const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'job-test-v1',items:inputs.map(input=>({
    operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:input.intent.idempotencyKey,
    parent_id:input.intent.parentId,name:input.intent.name,size_bytes:input.intent.sizeBytes,sha256:input.intent.sha256,expected:{kind:'absent'},
  }))};
  // The job binds the exact immutable UTF-8 plan bytes, without treating a
  // reserialization of arbitrary JSON as a cross-language canonical digest.
  return {bytes,inputs,plan:{manifest,inputs},wire:JSON.stringify({manifest,inputs})};
}
interface JobResult {schema:string;manifestSha256:string;replayed:boolean;items:{originalUploadId:string;operationId:string;current:{session:{uploadId:string;phase:string;transferPending:boolean};result?:{status:string}}}[]}
async function accept(f:Fixture,wire:string){
  const credential=f.issuer.deviceCredential(f.proof,f.rootId),payload=JSON.stringify({planBytes:wire});
  try{return await f.writer.withSql(async sql=>fixtureValue((await sql<{value:JobResult}[]>`SELECT catalog_upload_command('accept-job','{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,${payload}::text::jsonb) AS value`)[0]).value);}
  catch(error){const e=error as {message?:string;where?:string;code?:string};await evidence('smallfile-job-diagnostics',uid(),{message:e.message,where:e.where,code:e.code});throw error;}
}
const originals=(f:Fixture)=>f.admin.withSql(sql=>sql`SELECT id,idempotency_key,upload_execution,upload_intent,upload_transfer,upload_transfer_backend_task FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`);

it('qualifies the unchanged runtime and writer privilege boundary with job helpers installed',async()=>{
  const f=await activeFixture('smallfile-job-qualification','windows',migration);
  try{
    const policy={...f.roles,approvedFunctions:f.approvedFunctions};
    expect(await qualifyCatalogDatabaseRoles(f.runtime,{...policy,connection:'runtime'})).toMatchObject({connection:'runtime',sessionRole:f.roles.runtimeRole});
    expect(await qualifyCatalogDatabaseRoles(f.writer,{...policy,connection:'writer'})).toMatchObject({connection:'writer',sessionRole:f.roles.writerLogin});
  }finally{await f.close();}
},60000);

it('includes immutable jobs and their original references in one bounded recovery snapshot',async()=>{
  const f=await activeFixture('smallfile-job-backup','windows',migration);
  try{
    const request=job(f),accepted=await accept(f,request.wire),state=await f.admin.withSql(inspectJournal);
    expect(state).toMatchObject({smallExecutionJobShape:'saturn.small-execution-job.v1',smallExecutionJobs:'1',smallExecutionMembers:'16',dumpPolicy:'durable-journal-with-upload-dependencies'});
    const members=await new DatabaseMetadataExporter(f.admin).exportTo(path.join(f.directory,'job-metadata'));
    const jobs=members.find(m=>m.path==='metadata/sync_small_execution_jobs.jsonl');expect(jobs).toBeDefined();
    const row=JSON.parse(await fs.readFile(fixtureValue(jobs).sourcePath,'utf8')) as {plan_bytes:string;manifest_sha256:string;members:string[]};
    expect(row.plan_bytes).toBe(request.wire);expect(row.manifest_sha256).toBe(sha(request.wire));expect(row.members).toEqual(accepted.items.map(i=>i.originalUploadId));
  }finally{await f.close();}
},60000);

it('blocks recovery when the job guard or exact stored membership is damaged',async()=>{
  const f=await activeFixture('smallfile-job-backup-negative','windows',migration);
  try{
    await accept(f,job(f).wire);
    await f.admin.withSql(sql=>sql`ALTER TABLE sync_small_execution_jobs DISABLE TRIGGER small_execution_job_members`);
    await expect(f.admin.withSql(inspectJournal)).rejects.toThrow('Incomplete execution job guards');
    await f.admin.withSql(sql=>sql`ALTER TABLE sync_small_execution_jobs ENABLE TRIGGER small_execution_job_members`);
    await f.admin.withSql(sql=>sql`ALTER TABLE sync_small_execution_jobs DISABLE TRIGGER small_execution_job_guard`);
    await f.admin.withSql(sql=>sql`UPDATE sync_small_execution_jobs SET members[16]=gen_random_uuid() WHERE root_id=${f.rootId}`);
    await f.admin.withSql(sql=>sql`ALTER TABLE sync_small_execution_jobs ENABLE TRIGGER small_execution_job_guard`);
    await expect(f.admin.withSql(inspectJournal)).rejects.toThrow('Incoherent execution job originals');
  }finally{await f.close();}
},60000);

it('charges the exact extra job metadata once without changing accepted replay',async()=>{
  const f=await activeFixture('smallfile-job-metadata-budget','windows',migration);
  try{
    const request=job(f);await accept(f,request.wire);
    const before=await f.admin.withSql(sql=>sql<{metadata_bytes:string;execution_metadata_bytes:string}[]>`SELECT metadata_bytes::text,execution_metadata_bytes::text FROM sync_small_batch_budget WHERE root_id=${f.rootId}`);
    expect(fixtureValue(before[0]).execution_metadata_bytes).toBe(String(Buffer.byteLength(request.wire)+16*16));
    await accept(f,request.wire);
    expect(await f.admin.withSql(sql=>sql`SELECT metadata_bytes::text,execution_metadata_bytes::text FROM sync_small_batch_budget WHERE root_id=${f.rootId}`)).toEqual(before);
    expect(await f.admin.withSql(inspectJournal)).toMatchObject({smallBatchMetadataBytes:String(BigInt(fixtureValue(before[0]).metadata_bytes)+BigInt(fixtureValue(before[0]).execution_metadata_bytes))});
  }finally{await f.close();}
},60000);

it('allows bounded private job state but preserves the public-effect read barrier',async()=>{
  const f=await activeFixture('smallfile-job-read-gate','windows',migration);
  try{
    const request=job(f),accepted=await accept(f,request.wire);
    const allowed=()=>f.runtime.withSql(async sql=>fixtureValue((await sql<{allowed:boolean}[]>`SELECT catalog_guard_read_admission(${f.rootId}::uuid,${f.binding.epoch}::uuid,${f.binding.bindingVersion}::uuid,${f.binding.guardRevision}::uuid) AS allowed`)[0]).allowed);
    expect(await allowed()).toBe(true);
    let p=await f.files.prepareCatalogUpload(fixtureValue(request.inputs[0]),f.proof,fixtureValue(accepted.items[0]).originalUploadId);
    p=await f.files.appendCatalogUpload(p,f.proof,'0',request.bytes);
    const database=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
    p=await database.prepare(fixtureValue(request.inputs[0]),f.proof,p.status.session.uploadId);
    await database.verifyAndClaimGroup([{prepared:p,mimeType:'application/octet-stream',claimToken:uid()}],f.proof);
    expect(await allowed()).toBe(false);
  }finally{await f.close();}
},60000);

it('atomically admits sixteen originals before payload and preserves all identities after lost ACK',async()=>{
  const f=await activeFixture('smallfile-job-accept','windows',migration);
  try{
    const request=job(f),first=await accept(f,request.wire),saved=await originals(f);
    expect(first.schema).toBe('saturn.small-execution-job.v1');expect(first.manifestSha256).toBe(sha(request.wire));
    expect(first.items.map(i=>i.operationId)).toEqual(request.inputs.map(i=>i.intent.idempotencyKey));
    expect(first.items).toHaveLength(16);expect(new Set(first.items.map(i=>i.originalUploadId)).size).toBe(16);
    expect(first.items.every(i=>i.current.session.phase==='transport'&&i.current.session.transferPending)).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks`)).toHaveLength(0);
    const replay=await accept(f,request.wire);expect(replay.replayed).toBe(true);
    expect(replay.items.map(i=>i.originalUploadId)).toEqual(first.items.map(i=>i.originalUploadId));expect(await originals(f)).toEqual(saved);
    // An unrelated ordinary reservation still obeys the original four-slot cap.
    await expect(f.files.prepareSmallCatalogUpload(f.uploadInput('unrelated.bin',request.bytes),f.proof)).rejects.toThrow('admission_full');
  }finally{await f.close();}
},60000);

function restartedFiles(f:Fixture){
  return new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,
    catalogRootAdmission:f.admission,catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});
}
it('finishes an accepted job through the former per-original reader after a lost write response',async()=>{
  const f=await activeFixture('smallfile-job-restart','windows',migration);
  try{
    const request=job(f),accepted=await accept(f,request.wire),saved=await originals(f),writes=vi.spyOn(f.raw,'write');
    const firstFiles=restartedFiles(f);
    if(await f.executor.supportsWriteVerifiedOnce()){
      const originalWrite=f.executor.writeVerifiedOnce.bind(f.executor);
      vi.spyOn(f.executor,'writeVerifiedOnce').mockImplementationOnce(async(...args)=>{await originalWrite(...args);throw Error('lost durable write response');});
    }else{
      const originalWrite=f.executor.writeOnce.bind(f.executor);
      vi.spyOn(f.executor,'writeOnce').mockImplementationOnce(async(...args)=>{await originalWrite(...args);throw Error('lost durable write response');});
    }
    const first=await firstFiles.prepareSmallCatalogUpload(fixtureValue(request.inputs[0]),f.proof,fixtureValue(accepted.items[0]).originalUploadId);
    await expect(firstFiles.completeSmallCatalogUpload(first,f.proof,request.bytes)).rejects.toThrow('lost durable write response');
    expect(await originals(f)).toEqual(saved);
    const resumed=restartedFiles(f);
    for(let offset=0;offset<16;offset+=4){
      const handles=await Promise.all(request.inputs.slice(offset,offset+4).map((input,n)=>resumed.prepareSmallCatalogUpload(input,f.proof,fixtureValue(accepted.items[offset+n]).originalUploadId)));
      const done=await Promise.all(handles.map(h=>resumed.completeSmallCatalogUpload(h,f.proof,request.bytes)));
      expect(done.every(d=>d.status.result?.status==='PUBLISHED')).toBe(true);
      for(const h of done){const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(h.execution.targetPath)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(sha(request.bytes));}
    }
    expect(writes).toHaveBeenCalledTimes(16);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(16);
    const replay=await accept(f,request.wire);expect(replay.items.every(i=>i.current.result?.status==='PUBLISHED')).toBe(true);
    expect(replay.items.map(i=>i.originalUploadId)).toEqual(accepted.items.map(i=>i.originalUploadId));
    const after=await originals(f);
    expect(after.map(({upload_transfer,upload_transfer_backend_task,...identity})=>{void upload_transfer;void upload_transfer_backend_task;return identity;})).toEqual(saved.map(({upload_transfer,upload_transfer_backend_task,...identity})=>{void upload_transfer;void upload_transfer_backend_task;return identity;}));
    expect((await accept(f,request.wire)).items).toEqual(replay.items);expect(writes).toHaveBeenCalledTimes(16);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('accounts every payload byte and rolls the entire admission back at the shared budget',async()=>{
  const f=await activeFixture('smallfile-job-byte-budget','windows',migration);
  try{
    const request=job(f),limit=request.bytes.length*16-1;
    await f.admin.withSql(sql=>sql`UPDATE sync_backend_executor SET maximum_reserved_bytes=${limit} WHERE backend_identity=${f.backendIdentity}`);
    await expect(accept(f,request.wire)).rejects.toThrow('capacity');
    expect(await originals(f)).toHaveLength(0);
    for(const table of ['upload_sessions','sync_small_execution_jobs','sync_small_batches','sync_small_batch_operations','sync_small_batch_budget'])expect(await f.admin.withSql(sql=>sql.unsafe('SELECT * FROM '+table))).toHaveLength(0);
    await f.admin.withSql(sql=>sql`UPDATE sync_backend_executor SET maximum_reserved_bytes=${limit+1} WHERE backend_identity=${f.backendIdentity}`);
    expect((await accept(f,request.wire)).items).toHaveLength(16);
  }finally{await f.close();}
},60000);

it('shares four job credits across roots without raising the physical worker ceiling',async()=>{
  const roots=await activeRootsFixture('smallfile-job-credit-budget','windows',5,migration),f=fixtureValue(roots[0]);
  try{
    for(const root of roots.slice(0,4))expect((await accept(root,job(root).wire)).items).toHaveLength(16);
    await expect(accept(fixtureValue(roots[4]),job(fixtureValue(roots[4])).wire)).rejects.toThrow('capacity');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal WHERE upload_execution_job IS NOT NULL`)).toHaveLength(64);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_small_execution_jobs`)).toHaveLength(4);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks`)).toHaveLength(0);
    expect(await originals(fixtureValue(roots[4]))).toHaveLength(0);
  }finally{await f.close();}
},60000);

it('keeps accepted manifests readable when a schema rollback is attempted',async()=>{
  const f=await activeFixture('smallfile-job-rollback-reader','windows',migration);
  try{
    const request=job(f),accepted=await accept(f,request.wire),down=await fs.readFile(path.join(migrations,'0092_small_execution_job.down.sql'),'utf8');
    await expect(f.admin.transaction(sql=>sql.unsafe(down))).rejects.toThrow('backend must be stopped');
    await f.executor.close();
    await expect(f.admin.transaction(sql=>sql.unsafe(down))).rejects.toThrow('accepted execution jobs require their reader');
    expect((await accept(f,request.wire)).items.map(i=>i.originalUploadId)).toEqual(accepted.items.map(i=>i.originalUploadId));
  }finally{await f.close();}
},60000);

it('restores the old command and quota functions when no job was ever admitted',async()=>{
  const f=await activeFixture('smallfile-job-empty-rollback','windows',migration);
  try{
    const down=await fs.readFile(path.join(migrations,'0092_small_execution_job.down.sql'),'utf8');await f.executor.close();
    const previous=await f.admin.withSql(sql=>sql<{identity:string;definition:string}[]>`SELECT identity,definition FROM sync_extension_function_backup WHERE revision=92 ORDER BY identity`);
    await f.admin.transaction(sql=>sql.unsafe(down));
    for(const before of previous)expect(fixtureValue((await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT pg_get_functiondef(${before.identity}::regprocedure) AS definition`))[0]).definition).toBe(before.definition);
    expect(await f.admin.withSql(sql=>sql`SELECT to_regclass('public.sync_small_execution_jobs') AS jobs`)).toEqual([{jobs:null}]);
  }finally{await f.close();}
},60000);

it('rejects an invalid late member or changed manifest without partial admission',async()=>{
  const f=await activeFixture('smallfile-job-invalid','windows',migration);
  try{
    const request=job(f),bad=structuredClone(request.plan);bad.inputs[15]={...fixtureValue(bad.inputs[15]),intent:{...fixtureValue(bad.inputs[15]).intent,parentTopology:[{...fixtureValue(fixtureValue(bad.inputs[15]).intent.parentTopology[0]),name:'changed-parent'}]}};
    await expect(accept(f,JSON.stringify(bad))).rejects.toThrow();expect(await originals(f)).toHaveLength(0);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_small_execution_jobs`)).toHaveLength(0);
    const first=await accept(f,request.wire),saved=await originals(f);
    const changed=structuredClone(request.plan);fixtureValue(changed.manifest.items[15]).source_generation='2';
    await expect(accept(f,JSON.stringify(changed))).rejects.toThrow('operation_reused');
    await expect(accept(f,' '+request.wire)).rejects.toThrow('operation_reused');
    expect(await originals(f)).toEqual(saved);expect((await accept(f,request.wire)).items.map(i=>i.originalUploadId)).toEqual(first.items.map(i=>i.originalUploadId));
  }finally{await f.close();}
},60000);

it('rechecks current authorization and prevents direct runtime job writes',async()=>{
  const f=await activeFixture('smallfile-job-authority','windows',migration);
  try{
    const request=job(f);await accept(f,request.wire);const saved=await originals(f);
    await expect(f.runtime.withSql(sql=>sql`SELECT catalog_upload_accept_job_v1('{}'::jsonb,'{}'::jsonb)`)).rejects.toThrow();
    await expect(f.runtime.withSql(sql=>sql`UPDATE sync_small_execution_jobs SET plan_bytes=plan_bytes WHERE root_id=${f.rootId}`)).rejects.toThrow();
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);
    await expect(accept(f,request.wire)).rejects.toThrow('authorization_changed');expect(await originals(f)).toEqual(saved);
  }finally{await f.close();}
},60000);

