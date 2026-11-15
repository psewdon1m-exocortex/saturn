import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator,type CatalogUploadExecution,type CatalogUploadTransfer} from '../../../packages/file-core/src/catalog-upload-database.js';
import type {CatalogUploadStatus} from '../../../packages/file-core/src/catalog-upload-intent.js';
import {activeFixture,databaseFixture,migrations,uid} from './stage3-chat-a.fixture.js';

function client(f:Awaited<ReturnType<typeof activeFixture>>){return new FileService(new PostgresFileRepository(f.runtime),f.executor,
  {uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,
    catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});}

it('a lost combined reservation ACK resumes its original token before any bytes were written',async()=>{
  const f=await activeFixture('smallfile-reserve-chunk-lost-ack','windows',83);
  try{
    const bytes=Buffer.from('first write after lost SQL reservation'),input=f.uploadInput('lost.bin',bytes),files=client(f);
    const command=f.writer.catalogUploadBatch.bind(f.writer),raw=vi.spyOn(f.raw,'write');
    vi.spyOn(f.writer,'catalogUploadBatch').mockImplementationOnce(async(...args)=>{await command(...args);throw Error('lost reservation response');});
    await expect(files.prepareSmallCatalogUpload(input,f.proof)).rejects.toThrow('lost reservation response');
    expect(raw).not.toHaveBeenCalled();
    const original=fixtureValue((await f.admin.withSql(sql=>sql<{id:string;upload_transfer_backend_task:string}[]>`SELECT id,upload_transfer_backend_task FROM operation_journal WHERE idempotency_key=${input.intent.idempotencyKey}`))[0]);
    const restarted=client(f);let p=await restarted.prepareSmallCatalogUpload(input,f.proof);
    expect(p.status.session.uploadId).toBe(original.id);
    p=await restarted.appendCatalogUpload(p,f.proof,'0',bytes);
    expect((await restarted.completeCatalogUpload(p,f.proof)).status.result?.status).toBe('PUBLISHED');
    expect(raw).toHaveBeenCalledTimes(1);
    expect(await f.admin.withSql(sql=>sql`SELECT id,state FROM sync_backend_tasks WHERE command='write'`)).toEqual([{id:original.upload_transfer_backend_task,state:'DONE'}]);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('uses the acknowledged first reservation once and retains ordinary zero/large compatibility',async()=>{
  const f=await activeFixture('smallfile-reserve-chunk-app','windows',83);
  try{
    const database=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true),bytes=Buffer.from('acknowledged original');
    const p=await database.prepareSmall(f.uploadInput('first.bin',bytes),f.proof);
    const command=vi.spyOn(f.writer,'catalogUploadBatch');
    const first=await database.startReplayableChunk(p,f.proof,'0',String(bytes.length));
    expect(command).not.toHaveBeenCalled();
    const again=await database.startReplayableChunk(p,f.proof,'0',String(bytes.length));
    expect(command).toHaveBeenCalledTimes(1);expect(again.transfer).toEqual(first.transfer);
    for(const size of [0,262145]){
      const ordinary=await database.prepareSmall(f.uploadInput('ordinary-'+String(size)+'.bin',Buffer.alloc(size)),f.proof);
      expect(ordinary.status.session.transferPending).toBe(false);
    }
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('reserves a small original and its first replayable chunk with inserts only',async()=>{
  const f=await activeFixture('smallfile-reserve-chunk','windows',83);
  try{
    const bytes=Buffer.from('one durable reservation'),input=f.uploadInput('small.bin',bytes),credential=f.issuer.deviceCredential(f.proof,f.rootId);
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_writes(kind text,action text);
      CREATE FUNCTION observer_writes() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
        INSERT INTO public.observer_writes VALUES(TG_TABLE_NAME,TG_OP);RETURN NEW;END $$;
      CREATE TRIGGER observer_journal AFTER INSERT OR UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION observer_writes();
      CREATE TRIGGER observer_session AFTER INSERT OR UPDATE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION observer_writes();`));
    const payload={uploadId:uid(),nodeId:uid(),versionId:uid(),maximumFileBytes:'1073741824',transferToken:uid()};
    type Reservation={current?:{session:CatalogUploadStatus['session'];execution:CatalogUploadExecution};transfer?:CatalogUploadTransfer;session?:CatalogUploadStatus['session']};
    const call=(p:unknown=payload,i=input)=>f.writer.withSql(sql=>sql<{value:Reservation}[]>`SELECT catalog_upload_command('reserve-small',${JSON.stringify(i)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(p)}::text::jsonb) AS value`);
    const stored=fixtureValue((await call())[0]).value;
    expect(fixtureValue(stored.current).session).toMatchObject({uploadId:payload.uploadId,receivedSizeBytes:'0',transferPending:true,phase:'transport'});
    expect(stored.transfer).toEqual({token:payload.transferToken,originalUploadId:payload.uploadId,offset:'0',length:String(bytes.length)});
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM observer_writes ORDER BY kind`)).toEqual([{kind:'operation_journal',action:'INSERT'},{kind:'upload_sessions',action:'INSERT'}]);
    // Lost reservation response: a fresh candidate cannot replace the original.
    const again=fixtureValue((await call({...payload,uploadId:uid(),nodeId:uid(),versionId:uid(),transferToken:uid()}))[0]).value;
    expect(fixtureValue(again.session).uploadId).toBe(payload.uploadId);expect(fixtureValue(again.session).transferPending).toBe(true);
    expect((await f.admin.withSql(sql=>sql`SELECT upload_transfer_backend_task FROM operation_journal WHERE id=${payload.uploadId}`))[0]?.upload_transfer_backend_task).toBe(payload.transferToken);
    expect(await f.raw.exists(fixtureValue(stored.current).execution.tempPath)).toBe(false);
    await expect(call({...payload,transferToken:'bad'})).rejects.toThrow('invalid_input');
    await expect(call(payload,{...input,intent:{...input.intent,sizeBytes:'262145'}})).rejects.toThrow('invalid_input');
    await expect(call(payload,{...input,intent:{...input.intent,sizeBytes:'0'}})).rejects.toThrow('invalid_input');
    await expect(call({...payload,originalUploadId:uid()})).rejects.toThrow('operation_reused');
    await expect(call(payload,{...input,intent:{...input.intent,sha256:'0'.repeat(64)}})).rejects.toThrow('operation_reused');
    const old=await f.files.prepareCatalogUpload(f.uploadInput('ordinary.bin',bytes),f.proof);
    expect(old.status.session.transferPending).toBe(false);
  }finally{await f.close();}
},60000);

it('restores the exact reserve predecessor on rollback',async()=>{
  const f=await databaseFixture('smallfile-reserve-chunk-rollback',82);
  try{
    const definition=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure) AS source`),before=await definition();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0083_upload_small_reservation.up.sql'),'utf8')));
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0083_upload_small_reservation.down.sql'),'utf8')));
    expect(await definition()).toEqual(before);
  }finally{await f.close();}
},60000);
