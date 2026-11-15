import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,databaseFixture,migrations,uid} from './stage3-chat-a.fixture.js';

it('claims a fully verified original with one durable journal/session update and no intermediate visible state',async()=>{
  const f=await activeFixture('smallfile-atomic-claim','windows',79);
  try{
    const bytes=Buffer.from('sealed payload'),input=f.uploadInput('atomic.bin',bytes);
    let p=await f.files.prepareCatalogUpload(input,f.proof);p=await f.files.appendCatalogUpload(p,f.proof,'0',bytes);
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_updates(kind text,old_phase text,new_phase text);
      CREATE FUNCTION observer_updates() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
        IF TG_TABLE_NAME='operation_journal' THEN INSERT INTO public.observer_updates VALUES(TG_TABLE_NAME,OLD.upload_effect_state,NEW.upload_effect_state);
        ELSE INSERT INTO public.observer_updates VALUES(TG_TABLE_NAME,OLD.status,NEW.status); END IF;RETURN NEW;END $$;
      CREATE TRIGGER observer_journal AFTER UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION observer_updates();
      CREATE TRIGGER observer_session AFTER UPDATE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION observer_updates();`));
    const credential=f.issuer.deviceCredential(f.proof,f.rootId),claimToken=uid();
    const payload={originalUploadId:p.status.session.uploadId,sizeBytes:String(bytes.length),sha256:input.intent.sha256,mimeType:'application/octet-stream',claimToken};
    const command=(value:unknown)=>f.writer.withSql(sql=>sql<{value:{session:{phase:string};claimToken:string}}[]>`SELECT catalog_upload_command('verify-claim',${JSON.stringify(input)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(value)}::text::jsonb) AS value`);
    await expect(command({...payload,sha256:'0'.repeat(64)})).rejects.toThrow('verification_failed');
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM observer_updates`)).toHaveLength(0);
    const claimed=await command(payload);
    expect(claimed[0]?.value).toMatchObject({session:{phase:'physical_pending'},claimToken});
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM observer_updates ORDER BY kind`)).toEqual([
      {kind:'operation_journal',old_phase:'transport',new_phase:'physical_pending'},
      {kind:'upload_sessions',old_phase:'uploading',new_phase:'committing'},
    ]);
    expect(await f.raw.exists(p.execution.tempPath)).toBe(true);
    expect(await f.raw.exists(p.execution.targetPath)).toBe(false);
    await expect(f.files.prepareCatalogUpload(f.uploadInput('later.bin',bytes),f.proof)).rejects.toMatchObject({code:'reconciliation_required'});
    await expect(f.runtime.withSql(sql=>sql`UPDATE operation_journal SET upload_claim_token=${uid()} WHERE id=${p.status.session.uploadId}`)).rejects.toThrow();
  }finally{await f.close();}
},60000);

it('keeps transaction-local deadlines on standalone, batched and grouped publication commands',async()=>{
  const f=await activeFixture('smallfile-command-deadlines','windows',79);
  try{
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_limits(statement_timeout text,lock_timeout text,idle_timeout text);
      CREATE FUNCTION observer_limits() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
        INSERT INTO public.observer_limits VALUES(current_setting('statement_timeout'),current_setting('lock_timeout'),current_setting('idle_in_transaction_session_timeout'));RETURN NEW;END $$;
      CREATE TRIGGER observer_limits AFTER INSERT OR UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION observer_limits();`));
    const bytes=Buffer.from('deadline checked');
    expect((await f.upload(f.uploadInput('standalone.bin',bytes),bytes)).status.result?.status).toBe('PUBLISHED');
    const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,
      catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});
    const prepared=[];
    for(const name of ['group-a.bin','group-b.bin']){let p=await files.prepareCatalogUpload(f.uploadInput(name,bytes),f.proof);p=await files.appendCatalogUpload(p,f.proof,'0',bytes);prepared.push(p);}
    expect((await Promise.all(prepared.map(p=>files.completeCatalogUpload(p,f.proof)))).every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT DISTINCT * FROM observer_limits`)).toEqual([{statement_timeout:'2s',lock_timeout:'2s',idle_timeout:'2s'}]);
    expect((await f.writer.withSql(sql=>sql`SELECT current_setting('statement_timeout') AS s,current_setting('lock_timeout') AS l,current_setting('idle_in_transaction_session_timeout') AS i`))[0]).toEqual({s:'0',l:'0',i:'0'});
  }finally{await f.close();}
},60000);

it('restores exact command and execution guard definitions on rollback',async()=>{
  const f=await databaseFixture('smallfile-atomic-rollback',78);
  try{
    const definitions=()=>f.db.withSql(sql=>sql`SELECT oid::regprocedure::text AS identity,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid IN ('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure,'guard_catalog_upload_execution()'::regprocedure) ORDER BY identity`);
    const before=await definitions();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0079_upload_atomic_claim.up.sql'),'utf8')));
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0079_upload_atomic_claim.down.sql'),'utf8')));
    expect(await definitions()).toEqual(before);
  }finally{await f.close();}
},60000);
