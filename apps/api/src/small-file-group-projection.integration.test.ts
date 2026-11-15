import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,databaseFixture,migrations,uid} from './stage3-chat-a.fixture.js';

const revision=Number(process.env.SMALL_FILE_REVIEW_MIGRATION??87);
async function originals(f:Awaited<ReturnType<typeof activeFixture>>,count=4){
  const items=[];
  for(let n=0;n<count;n++){
    const bytes=Buffer.from('group member '+String(n)),input=f.uploadInput('member-'+String(n)+'.bin',bytes);
    let prepared=await f.files.prepareCatalogUpload(input,f.proof);
    prepared=await f.files.appendCatalogUpload(prepared,f.proof,'0',bytes);
    items.push({input,originalUploadId:prepared.status.session.uploadId,claimToken:uid(),mimeType:'application/octet-stream'});
  }
  return items;
}
function command(f:Awaited<ReturnType<typeof activeFixture>>,name:string,input:unknown,payload:unknown){
  const credential=f.issuer.deviceCredential(f.proof,f.rootId);
  return f.writer.withSql(sql=>sql<{value:unknown}[]>`SELECT catalog_upload_command(${name},${JSON.stringify(input)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`);
}
it('assigns an immutable group and claims each original in one journal update',async()=>{
  const f=await activeFixture('smallfile-group-projection','windows',revision);
  try{
    const items=await originals(f);
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_group_updates(id uuid,group_id uuid,phase text);
      CREATE FUNCTION observer_group_updates() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO public.observer_group_updates VALUES(NEW.id,NEW.upload_publication_group,NEW.upload_effect_state);RETURN NEW;END $$;
      CREATE TRIGGER observer_group_updates AFTER UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION observer_group_updates();`));
    await command(f,'verify-claim-group',{},items);
    const rows=await f.admin.withSql(sql=>sql<{id:string;group_id:string|null;phase:string}[]>`SELECT * FROM observer_group_updates`);
    expect(rows).toHaveLength(4);expect(rows.every(r=>r.phase==='physical_pending'&&r.group_id!==null)).toBe(true);
    expect(new Set(rows.map(r=>r.group_id)).size).toBe(1);
    const stored=await f.admin.withSql(sql=>sql`SELECT id,upload_publication_group,upload_claim_token FROM operation_journal WHERE sync_root_id=${f.rootId}`);
    for(const item of items)expect(stored.find(r=>r.id===item.originalUploadId)).toMatchObject({upload_publication_group:fixtureValue(rows[0]).group_id,upload_claim_token:item.claimToken});
  }finally{await f.close();}
},60000);

it('rejects fabricated, nonmember and already assigned group context without changing originals',async()=>{
  const f=await activeFixture('smallfile-group-projection-context','windows',revision);
  try{
    const items=await originals(f,3),other=fixtureValue(items[2]);
    const payload=(item:typeof other,publicationGroup:unknown)=>({originalUploadId:item.originalUploadId,claimToken:item.claimToken,mimeType:item.mimeType,sizeBytes:item.input.intent.sizeBytes,sha256:item.input.intent.sha256,publicationGroup});
    await expect(command(f,'verify-claim',other.input,payload(other,uid()))).rejects.toThrow();
    await command(f,'verify-claim-group',{},items.slice(0,2));
    const group=fixtureValue((await f.admin.withSql(sql=>sql<{id:string}[]>`SELECT id FROM catalog_upload_publication_groups`))[0]).id;
    const before=await f.admin.withSql(sql=>sql`SELECT * FROM operation_journal ORDER BY id`);
    for(const item of [other,fixtureValue(items[0])])await expect(command(f,'verify-claim',item.input,payload(item,group))).rejects.toThrow();
    await expect(command(f,'status',other.input,{originalUploadId:other.originalUploadId,publicationGroup:group})).rejects.toThrow('invalid_input');
    await expect(command(f,'verify-claim',other.input,payload(other,null))).rejects.toThrow('invalid_input');
    await expect(f.runtime.withSql(sql=>sql`UPDATE operation_journal SET upload_publication_group=${group}::uuid WHERE id=${other.originalUploadId}`)).rejects.toThrow();
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM operation_journal ORDER BY id`)).toEqual(before);
  }finally{await f.close();}
},60000);

it('rolls back the complete group if a later original fails verification',async()=>{
  const f=await activeFixture('smallfile-group-projection-rollback','windows',revision);
  try{
    const items=await originals(f);
    const before=await f.admin.withSql(sql=>sql`SELECT * FROM operation_journal ORDER BY id`);
    const sessions=await f.admin.withSql(sql=>sql`SELECT * FROM upload_sessions ORDER BY id`);
    const bad=items.map((item,n)=>n===3?{...item,input:{...item.input,intent:{...item.input.intent,sha256:'0'.repeat(64)}}}:item);
    await expect(command(f,'verify-claim-group',{},bad)).rejects.toThrow('operation_reused');
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM operation_journal ORDER BY id`)).toEqual(before);
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM upload_sessions ORDER BY id`)).toEqual(sessions);
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM catalog_upload_publication_groups`)).toHaveLength(0);
  }finally{await f.close();}
},60000);

it('restores both exact predecessor functions on rollback',async()=>{
  const f=await databaseFixture('smallfile-group-projection-down',86);
  try{
    const source=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE proname IN ('catalog_upload_command','guard_catalog_upload_group_member') ORDER BY proname`);
    const before=await source();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0087_upload_group_projection.up.sql'),'utf8')));
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0087_upload_group_projection.down.sql'),'utf8')));
    expect(await source()).toEqual(before);
  }finally{await f.close();}
},60000);

it('finishes a group accepted before the migration with the same originals and receipts',async()=>{
  const f=await activeFixture('smallfile-group-projection-old-history','windows',86);
  try{
    const items=await originals(f,2);
    await command(f,'verify-claim-group',{},items);
    const history=await f.admin.withSql(sql=>sql`SELECT * FROM catalog_upload_publication_groups`);
    await f.admin.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0087_upload_group_projection.up.sql'),'utf8')));
    const db=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
    for(const item of items){
      const original=await db.prepare(item.input,f.proof,item.originalUploadId);
      await f.executor.rename(original.execution.tempPath,original.execution.targetPath);
      const published=await db.commit(original,f.proof,item.mimeType);
      expect(published.status.result?.status).toBe('PUBLISHED');
      expect((await db.prepare(item.input,f.proof,item.originalUploadId)).status.result).toEqual(published.status.result);
    }
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM catalog_upload_publication_groups`)).toEqual(history);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(2);
  }finally{await f.close();}
},60000);
