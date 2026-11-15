import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,databaseFixture,migrations,sha,uid} from './stage3-chat-a.fixture.js';

const reviewMigration=Number(process.env.SMALL_FILE_REVIEW_MIGRATION??84);
if(![84,85,86,87,88,89,91].includes(reviewMigration))throw Error('Invalid review migration');

function client(f:Awaited<ReturnType<typeof activeFixture>>){
  const database=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  return {database,files:new FileService(new PostgresFileRepository(f.runtime),f.executor,
    {uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:database})};
}

it('resumes confirmed partial progress and returns the original receipt after a lost commit ACK',async()=>{
  const f=await activeFixture('smallfile-progress-partial-commit','windows',reviewMigration),{files,database}=client(f);
  try{
    const bytes=Buffer.from('confirmed prefix followed by the original final chunk'),input=f.uploadInput('partial.bin',bytes),writes=vi.spyOn(f.raw,'write');
    let p=await files.prepareCatalogUpload(input,f.proof);p=await files.appendCatalogUpload(p,f.proof,'0',bytes.subarray(0,7));
    expect(p.status.session.receivedSizeBytes).toBe('7');
    const commit=database.commit.bind(database);
    vi.spyOn(database,'commit').mockImplementationOnce(async(...args)=>{await commit(...args);throw Error('lost commit response');});
    const result=await files.completeSmallCatalogUpload(p,f.proof,bytes);expect(result.status.result?.status).toBe('PUBLISHED');
    expect(writes).toHaveBeenCalledTimes(2);
    const chunks=[];for await(const b of await f.raw.openRead(result.execution.targetPath))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));
    const restarted=client(f).files,same=await restarted.prepareSmallCatalogUpload(input,f.proof);
    expect((await restarted.completeSmallCatalogUpload(same,f.proof,bytes)).status.result).toEqual(result.status.result);
    expect(writes).toHaveBeenCalledTimes(2);expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(1);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('publishes a mixed group of ordinary progress and final marked chunks with independent receipts',async()=>{
  const f=await activeFixture('smallfile-progress-group','windows',reviewMigration),{files,database}=client(f);
  try{
    const bytes=Buffer.alloc(8192,123),inputs=[0,1,2,3].map(n=>f.uploadInput('mixed-'+String(n)+'.bin',bytes));
    const prepared=await Promise.all(inputs.map(i=>files.prepareSmallCatalogUpload(i,f.proof)));
    prepared[0]=await files.appendCatalogUpload(fixtureValue(prepared[0]),f.proof,'0',bytes);
    const group=vi.spyOn(database,'verifyAndClaimGroup'),writes=vi.spyOn(f.raw,'write');
    const results=await Promise.all(prepared.map(p=>files.completeSmallCatalogUpload(p,f.proof,bytes)));
    expect(results.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
    expect(writes).toHaveBeenCalledTimes(3);
    expect(group.mock.calls.some(([entries])=>entries.length>1&&entries.some(e=>e.transfer))).toBe(true);
    for(const result of results){const chunks=[];for await(const b of await f.raw.openRead(result.execution.targetPath))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));}
    const versions=await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`);expect(versions).toHaveLength(4);
    const restarted=client(f).files;
    for(const input of inputs){const p=await restarted.prepareSmallCatalogUpload(input,f.proof);expect((await restarted.completeSmallCatalogUpload(p,f.proof,bytes)).status.result?.status).toBe('PUBLISHED');}
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`)).toEqual(versions);expect(writes).toHaveBeenCalledTimes(3);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('keeps accepted final transfers fenced when a group claim response is lost',async()=>{
  const f=await activeFixture('smallfile-progress-group-lost-ack','windows',reviewMigration),{files,database}=client(f);
  try{
    const bytes=Buffer.from('accepted before lost SQL response'),prepared=await Promise.all([0,1].map(n=>files.prepareSmallCatalogUpload(f.uploadInput('lost-'+String(n)+'.bin',bytes),f.proof)));
    const original=database.verifyAndClaimGroup.bind(database),rename=vi.spyOn(f.raw,'rename');
    vi.spyOn(database,'verifyAndClaimGroup').mockImplementationOnce(async(...args)=>{await original(...args);throw Error('lost group claim response');});
    const results=await Promise.allSettled(prepared.map(p=>files.completeSmallCatalogUpload(p,f.proof,bytes)));
    expect(results.every(r=>r.status==='rejected')).toBe(true);expect(rename).not.toHaveBeenCalled();
    const rows=await f.admin.withSql(sql=>sql`SELECT upload_effect_state,upload_transfer,upload_transfer_backend_task,upload_last_transfer IS NOT NULL AS original_retained FROM operation_journal WHERE sync_root_id=${f.rootId} AND upload_execution IS NOT NULL`);
    expect(rows).toHaveLength(2);expect(rows.every(r=>r.upload_effect_state==='reconciliation_required'&&r.upload_transfer===null&&r.upload_transfer_backend_task===null&&r.original_retained)).toBe(true);
    for(const p of prepared)expect(await f.raw.exists(p.execution.tempPath)).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    expect((await f.admin.withSql(sql=>sql`SELECT namespace_state FROM sync_root_clock WHERE root_id=${f.rootId}`))[0]?.namespace_state).toBe('BACKEND_UNCERTAIN');
    await expect(files.prepareSmallCatalogUpload(f.uploadInput('later.bin',bytes),f.proof)).rejects.toMatchObject({code:'binding_invalid'});
    expect((await f.admin.withSql(sql=>sql`SELECT count(*)::int AS n FROM operation_journal WHERE sync_root_id=${f.rootId} AND upload_execution IS NOT NULL`))[0]?.n).toBe(2);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('does not acknowledge corrupt physical bytes or infer legacy pending writes as replayable',async()=>{
  const f=await activeFixture('smallfile-progress-corrupt','windows',reviewMigration),{files,database}=client(f);
  try{
    const bytes=Buffer.alloc(4096,97),p=await files.prepareSmallCatalogUpload(f.uploadInput('bad.bin',bytes),f.proof);
    const write=f.executor.writeOnce.bind(f.executor),rename=vi.spyOn(f.raw,'rename');
    vi.spyOn(f.executor,'writeOnce').mockImplementationOnce(async(...args)=>{const written=await write(...args);await fs.writeFile(path.join(f.directory,'storage',args[1]),Buffer.alloc(bytes.length,98));return written;});
    await expect(files.completeSmallCatalogUpload(p,f.proof,bytes)).rejects.toMatchObject({code:'verification_failed'});
    expect(rename).not.toHaveBeenCalled();
    expect((await database.status(p,f.proof)).status.session).toMatchObject({phase:'transport',transferPending:true,receivedSizeBytes:'0'});
    const legacy=await files.prepareCatalogUpload(f.uploadInput('legacy.bin',bytes),f.proof);await database.beginChunk(legacy,f.proof,'0',String(bytes.length));
    await expect(files.completeSmallCatalogUpload(legacy,f.proof,bytes)).rejects.toMatchObject({code:'transfer_unresolved'});
    expect(await f.raw.exists(legacy.execution.tempPath)).toBe(false);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('acknowledges the exact final replayable chunk and claims with one journal/session update',async()=>{
  const f=await activeFixture('smallfile-progress-claim','windows',reviewMigration);
  try{
    const bytes=Buffer.from('one verified final chunk'),input=f.uploadInput('final.bin',bytes),p=await f.files.prepareCatalogUpload(input,f.proof),credential=f.issuer.deviceCredential(f.proof,f.rootId);
    const transfer={originalUploadId:p.status.session.uploadId,token:uid(),offset:'0',length:String(bytes.length)};
    const call=(command:string,payload:unknown)=>f.writer.withSql(sql=>sql<{value:{session:{phase:string;receivedSizeBytes:string;transferPending:boolean};claimToken:string}}[]>`SELECT catalog_upload_command(${command},${JSON.stringify(input)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`);
    await call('chunk-once',transfer);
    await f.executor.writeOnce(transfer.token,p.execution.tempPath,bytes,{offset:0,create:true,exclusive:true,truncate:false});
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_updates(kind text);
      CREATE FUNCTION observer_updates() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO public.observer_updates VALUES(TG_TABLE_NAME);RETURN NEW;END $$;
      CREATE TRIGGER observer_journal AFTER UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION observer_updates();
      CREATE TRIGGER observer_session AFTER UPDATE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION observer_updates();`));
    const payload={originalUploadId:p.status.session.uploadId,transfer,claimToken:uid(),sizeBytes:String(bytes.length),sha256:input.intent.sha256,mimeType:'application/octet-stream'};
    await expect(call('progress-verify-claim',{...payload,transfer:{...transfer,token:uid()}})).rejects.toThrow('transfer_unresolved');
    await expect(call('progress-verify-claim',{...payload,sha256:'0'.repeat(64)})).rejects.toThrow('verification_failed');
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM observer_updates`)).toHaveLength(0);
    expect((await call('progress-verify-claim',payload))[0]?.value).toMatchObject({claimToken:payload.claimToken,session:{phase:'physical_pending',transferPending:false,receivedSizeBytes:String(bytes.length)}});
    expect(await f.admin.withSql(sql=>sql`SELECT kind FROM observer_updates ORDER BY kind`)).toEqual([{kind:'operation_journal'},{kind:'upload_sessions'}]);
    expect((await f.admin.withSql(sql=>sql`SELECT upload_transfer,upload_transfer_backend_task,upload_last_transfer FROM operation_journal WHERE id=${p.status.session.uploadId}`))[0]).toEqual({upload_transfer:null,upload_transfer_backend_task:null,upload_last_transfer:transfer});
    await expect(f.files.prepareCatalogUpload(f.uploadInput('later.bin',bytes),f.proof)).rejects.toMatchObject({code:'reconciliation_required'});
    expect(await f.raw.exists(p.execution.tempPath)).toBe(true);expect(await f.raw.exists(p.execution.targetPath)).toBe(false);
  }finally{await f.close();}
},60000);

it('restores the exact completion predecessor on rollback',async()=>{
  const f=await databaseFixture('smallfile-progress-claim-rollback',83);
  try{
    const definition=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure) AS source`),before=await definition();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0084_upload_small_completion.up.sql'),'utf8')));
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0084_upload_small_completion.down.sql'),'utf8')));
    expect(await definition()).toEqual(before);
  }finally{await f.close();}
},60000);
