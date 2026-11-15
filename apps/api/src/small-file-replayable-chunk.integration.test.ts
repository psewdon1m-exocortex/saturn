import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,databaseFixture,migrations,sha,uid} from './stage3-chat-a.fixture.js';

function client(f:Awaited<ReturnType<typeof activeFixture>>){
  return new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,
    catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});
}

it('reuses the explicitly marked pending transfer and refuses legacy or mismatched pending writes',async()=>{
  const f=await activeFixture('smallfile-chunk-once-sql','windows',82);
  try{
    const bytes=Buffer.from('small sealed bytes'),input=f.uploadInput('once.bin',bytes),p=await f.files.prepareCatalogUpload(input,f.proof);
    const credential=f.issuer.deviceCredential(f.proof,f.rootId),token=uid();
    const transfer={originalUploadId:p.status.session.uploadId,token,offset:'0',length:String(bytes.length)};
    const call=(command:string,value:unknown,original=input)=>f.writer.withSql(sql=>sql<{value:{current:unknown;transfer:typeof transfer}}[]>`SELECT catalog_upload_command(${command},${JSON.stringify(original)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(value)}::text::jsonb) AS value`);
    expect((await call('chunk-once',transfer))[0]?.value.transfer).toEqual(transfer);
    expect((await call('chunk-once',{...transfer,token:uid()}))[0]?.value.transfer).toEqual(transfer);
    await expect(call('chunk-once',{...transfer,length:'1'})).rejects.toThrow('transfer_unresolved');
    await expect(call('chunk-once',{...transfer,offset:'1'})).rejects.toThrow('transfer_unresolved');
    expect((await f.admin.withSql(sql=>sql`SELECT upload_transfer_backend_task FROM operation_journal WHERE id=${p.status.session.uploadId}`))[0]?.upload_transfer_backend_task).toBe(token);
    const legacy=f.uploadInput('legacy.bin',bytes),l=await f.files.prepareCatalogUpload(legacy,f.proof);
    const old={...transfer,originalUploadId:l.status.session.uploadId,token:uid()};
    await call('chunk',old,legacy);
    await expect(call('chunk-once',{...old,token:uid()},legacy)).rejects.toThrow('transfer_unresolved');
    expect(await f.raw.exists(p.execution.tempPath)).toBe(false);
    expect(await f.raw.exists(l.execution.tempPath)).toBe(false);
  }finally{await f.close();}
},60000);

it('a fresh client resumes a lost write response with the same task and publishes one verified version',async()=>{
  const f=await activeFixture('smallfile-chunk-once-restart','windows',82),files=client(f);
  try{
    const bytes=Buffer.from('the same original after a lost response'),input=f.uploadInput('resumed.bin',bytes),prepared=await files.prepareCatalogUpload(input,f.proof);
    const oldWrite=f.executor.write.bind(f.executor),once=f.executor.writeOnce.bind(f.executor),raw=vi.spyOn(f.raw,'write');let lost=false;
    vi.spyOn(f.executor,'write').mockImplementation(async(...args)=>{const n=await oldWrite(...args);if(!lost){lost=true;throw Error('lost write response');}return n;});
    vi.spyOn(f.executor,'writeOnce').mockImplementation(async(...args)=>{const n=await once(...args);if(!lost){lost=true;throw Error('lost write response');}return n;});
    await expect(files.appendCatalogUpload(prepared,f.proof,'0',bytes)).rejects.toThrow('lost write response');
    const before=await f.admin.withSql(sql=>sql<{upload_transfer_backend_task:string;upload_transfer:{token:string}}[]>`SELECT upload_transfer_backend_task,upload_transfer FROM operation_journal WHERE id=${prepared.status.session.uploadId}`);
    expect(before[0]?.upload_transfer_backend_task).toBe(before[0]?.upload_transfer.token);
    const restarted=client(f);let same=await restarted.prepareCatalogUpload(input,f.proof,prepared.status.session.uploadId);
    expect(same.status.session.transferPending).toBe(true);
    same=await restarted.appendCatalogUpload(same,f.proof,'0',bytes);
    const published=await restarted.completeCatalogUpload(same,f.proof);expect(published.status.result?.status).toBe('PUBLISHED');
    expect(raw).toHaveBeenCalledTimes(1);
    expect(await f.admin.withSql(sql=>sql`SELECT id,state FROM sync_backend_tasks WHERE command='write'`)).toEqual([{id:fixtureValue(before[0]).upload_transfer_backend_task,state:'DONE'}]);
    expect((await f.admin.withSql(sql=>sql`SELECT count(*)::int AS n FROM file_versions WHERE resource_id=${published.execution.nodeId}`))[0]?.n).toBe(1);
    const chunks=[];for await(const b of await f.raw.openRead(published.execution.targetPath))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(input.intent.sha256);
    const replay=await restarted.prepareCatalogUpload(input,f.proof,prepared.status.session.uploadId);expect((await restarted.completeCatalogUpload(replay,f.proof)).status.result).toEqual(published.status.result);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('restores the predecessor but refuses to erase a pending transfer mapping',async()=>{
  const f=await databaseFixture('smallfile-chunk-once-rollback',81);
  try{
    const definition=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure) AS source`),before=await definition();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0082_upload_replayable_chunk.up.sql'),'utf8')));
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0082_upload_replayable_chunk.down.sql'),'utf8')));
    expect(await definition()).toEqual(before);
  }finally{await f.close();}
  const active=await activeFixture('smallfile-chunk-once-pending-rollback','windows',82);
  try{
    const bytes=Buffer.from('pending'),input=active.uploadInput('pending.bin',bytes),p=await active.files.prepareCatalogUpload(input,active.proof),credential=active.issuer.deviceCredential(active.proof,active.rootId);
    await active.writer.withSql(sql=>sql`SELECT catalog_upload_command('chunk-once',${JSON.stringify(input)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify({originalUploadId:p.status.session.uploadId,token:uid(),offset:'0',length:String(bytes.length)})}::text::jsonb)`);
    await active.executor.close();
    await expect(active.admin.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0082_upload_replayable_chunk.down.sql'),'utf8')))).rejects.toThrow('pending transfer identity must be retained');
  }finally{await active.close();}
},60000);
