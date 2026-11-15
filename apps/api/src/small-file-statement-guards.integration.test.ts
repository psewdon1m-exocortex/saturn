import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {ROOT_RESOURCE_ID} from '@saturn/file-core';
import {activeFixture,activeRootsFixture,databaseFixture,evidence,migrations,uid} from './stage3-chat-a.fixture.js';

const migration=Number(process.env.SMALL_FILE_STATEMENT_GUARD_MIGRATION??93);
if(![92,93,103,105].includes(migration))throw Error('Invalid statement guard migration');

it('shares each scope anchor across the complete OLD/NEW statement without caching between statements',async()=>{
  const f=await activeFixture('statement-guard-count','windows',migration);
  try{
    const originals=[];
    for(let n=0;n<4;n++){const bytes=Buffer.from('statement '+String(n));originals.push(await f.upload(f.uploadInput('scope-'+String(n),bytes),bytes));}
    const name=migration>=103?'catalog_guard_scopes':'catalog_guard_scope',argument=migration>=103?'anchors':'anchor',type=migration>=103?'uuid[]':'uuid';
    const old=fixtureValue((await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT pg_get_functiondef(${name+'('+type+',boolean)'}::regprocedure) AS definition`))[0]).definition;
    await f.admin.withSql(sql=>sql.unsafe(old.replace('public.'+name+'(','public.observer_scope_original(')));
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_scope_calls(anchor uuid,controls boolean);
      CREATE OR REPLACE FUNCTION ${name}(${argument} ${type},include_controls boolean DEFAULT true) RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
        INSERT INTO public.observer_scope_calls SELECT DISTINCT id,include_controls FROM unnest(${migration>=103?'anchors':'ARRAY[anchor]'}) id WHERE id IS NOT NULL;
        RETURN public.observer_scope_original(${argument},include_controls);END $$;
      CREATE FUNCTION observer_touch() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
        UPDATE public.upload_sessions SET updated_at=updated_at;
      END $$;
      ALTER FUNCTION observer_touch() OWNER TO ${f.roles.writerOwner}; REVOKE ALL ON FUNCTION observer_touch() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION observer_touch() TO ${f.roles.writerLogin};`));
    for(let attempt=0;attempt<2;attempt++){
      await f.admin.withSql(sql=>sql`TRUNCATE observer_scope_calls`);
      await f.writer.withSql(sql=>sql`SELECT observer_touch()`);
      const calls=await f.admin.withSql(sql=>sql<{anchor:string;controls:boolean}[]>`SELECT * FROM observer_scope_calls ORDER BY anchor`);
      await evidence('statement-guard-count','calls-'+String(migration)+'-'+String(attempt),calls);
      expect(calls).toHaveLength(5);
      expect(calls.filter(x=>x.anchor===f.rootId)).toHaveLength(1);
      expect(calls.every(x=>x.controls)).toBe(true);
    }
  }finally{await f.close();}
},60000);

it('rejects direct SQL and mixed OLD/NEW roots atomically, retaining ordinary publication and replay',async()=>{
  const roots=await activeRootsFixture('statement-guard-boundaries','windows',2,migration),f=fixtureValue(roots[0]),peer=fixtureValue(roots[1]);
  try{
    const bytes=Buffer.from('statement guards'),p=await f.upload(f.uploadInput('guarded.bin',bytes),bytes);
    const q=await peer.upload(peer.uploadInput('peer.bin',bytes),bytes);
    const before=await f.admin.withSql(sql=>sql`SELECT id,parent_id,resource_id FROM upload_sessions ORDER BY id`);
    for(const query of ['UPDATE upload_sessions SET updated_at=updated_at','UPDATE operation_journal SET updated_at=updated_at',
      'UPDATE file_versions SET storage_path=storage_path','UPDATE sync_root_changes SET document=document']){
      await expect(f.runtime.withSql(sql=>sql.unsafe(query))).rejects.toThrow('catalog writer unqualified');
    }
    await expect(f.runtime.withSql(sql=>sql`UPDATE upload_sessions SET parent_id=${ROOT_RESOURCE_ID},resource_id=NULL WHERE id=${p.status.session.uploadId}`)).rejects.toThrow(/catalog writer unqualified|Sealed upload session/);
    await expect(f.runtime.withSql(sql=>sql`UPDATE upload_sessions SET parent_id=${peer.rootId} WHERE id=${p.status.session.uploadId}`)).rejects.toThrow(/catalog writer unqualified|Sealed upload session/);
    await expect(f.runtime.withSql(sql=>sql`UPDATE upload_sessions SET parent_id=${uid()} WHERE id=${q.status.session.uploadId}`)).rejects.toThrow();
    expect(await f.admin.withSql(sql=>sql`SELECT id,parent_id,resource_id FROM upload_sessions ORDER BY id`)).toEqual(before);
    expect((await f.files.inspectCatalogUpload(p,f.proof)).status.result?.status).toBe('PUBLISHED');
    expect((await peer.files.inspectCatalogUpload(q,peer.proof)).status.result?.status).toBe('PUBLISHED');
  }finally{await f.close();}
},60000);

it('includes the last invalid member and both old and new anchors even for unsealed rows',async()=>{
  const f=await activeFixture('statement-guard-unsealed','windows',migration),outside=uid(),valid=uid(),guarded=uid();
  try{
    await f.runtime.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status) VALUES(${outside},'folder',${ROOT_RESOURCE_ID},${outside},${outside},'active')`);
    await f.admin.withSql(sql=>sql.unsafe(`CREATE FUNCTION observer_insert(id uuid,parent uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
      INSERT INTO public.upload_sessions(id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,status,expires_at)
        VALUES(id,id::text,parent,id::text,id::text,id::text,0,'created',now()+interval '1 hour');END $$;
      ALTER FUNCTION observer_insert(uuid,uuid) OWNER TO ${f.roles.writerOwner}; REVOKE ALL ON FUNCTION observer_insert(uuid,uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION observer_insert(uuid,uuid) TO ${f.roles.writerLogin};`));
    await f.writer.withSql(sql=>sql`SELECT observer_insert(${valid}::uuid,${outside}::uuid)`);
    await f.writer.withSql(sql=>sql`SELECT observer_insert(${guarded}::uuid,${f.rootId}::uuid)`);
    const before=await f.admin.withSql(sql=>sql`SELECT id,parent_id FROM upload_sessions ORDER BY id`);
    await expect(f.runtime.withSql(sql=>sql`UPDATE upload_sessions SET parent_id=${outside} WHERE id=${guarded}`)).rejects.toThrow('catalog writer unqualified');
    await expect(f.runtime.withSql(sql=>sql`UPDATE upload_sessions SET parent_id=${f.rootId} WHERE id=${valid}`)).rejects.toThrow('catalog writer unqualified');
    const ids=[uid(),uid(),uid()],parents=[outside,outside,f.rootId];
    await expect(f.runtime.withSql(sql=>sql`INSERT INTO upload_sessions(id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,status,expires_at)
      SELECT id,id::text,parent,id::text,id::text,id::text,0,'created',now()+interval '1 hour'
      FROM unnest(${ids}::uuid[],${parents}::uuid[]) WITH ORDINALITY x(id,parent,n) ORDER BY n`)).rejects.toThrow('catalog writer unqualified');
    expect(await f.admin.withSql(sql=>sql`SELECT id,parent_id FROM upload_sessions ORDER BY id`)).toEqual(before);
    await expect(f.runtime.withSql(sql=>sql`UPDATE upload_sessions SET parent_id=NULL WHERE id=${valid}`)).rejects.toThrow();
  }finally{await f.close();}
},60000);

it('restores exactly the original triggers on stopped rollback',async()=>{
  const f=await databaseFixture('statement-guard-rollback',92);
  try{
    const definitions=()=>f.db.withSql(sql=>sql`SELECT t.tgname,c.relname,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
    const before=await definitions();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0093_catalog_statement_guards.up.sql'),'utf8')));
    expect(await definitions()).not.toEqual(before);
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0093_catalog_statement_guards.down.sql'),'utf8')));
    expect(await definitions()).toEqual(before);
  }finally{await f.close();}
},60000);
