import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {activeFixture,migrations,uid} from './stage3-chat-a.fixture.js';

it('resolves a whole anchor set with the same roots and rejection rules as every original walk',async()=>{
  const f=await activeFixture('smallfile-scope-set','windows',103);
  try{
    for(let n=0;n<4;n++){const bytes=Buffer.from('scope-'+String(n));await f.upload(f.uploadInput('scope-'+String(n),bytes),bytes);}
    const previous=fixtureValue((await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT pg_get_functiondef('catalog_guard_scope(uuid,boolean)'::regprocedure) AS definition`))[0]).definition;
    const source=(await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT definition FROM sync_extension_function_backup WHERE revision=103 AND identity='catalog_guard_scope(uuid,boolean)'`))[0]?.definition??previous;
    await f.admin.withSql(sql=>sql.unsafe(source.replace('FUNCTION public.catalog_guard_scope(', 'FUNCTION public.test_previous_scope(')));
    const ids=(await f.admin.withSql(sql=>sql<{id:string}[]>`SELECT id FROM resources ORDER BY id`)).map(r=>r.id);
    for(const controls of [true,false])for(const anchors of [[],[null],[f.rootId],ids,[...ids,...ids,null]]){
      const same=await f.admin.withSql(sql=>sql<{same:boolean}[]>`SELECT
        ARRAY(SELECT DISTINCT unnest(catalog_guard_scopes(${anchors}::uuid[],${controls})) ORDER BY 1)
        = ARRAY(SELECT DISTINCT unnest(test_previous_scope(id,${controls})) FROM unnest(${anchors}::uuid[]) id ORDER BY 1) AS same`);
      expect(fixtureValue(same[0]).same).toBe(true);
    }
    await expect(f.admin.withSql(sql=>sql`SELECT catalog_guard_scopes(ARRAY[${f.rootId}::uuid,${uid()}::uuid],true)`)).rejects.toThrow('catalog guard membership unproven');
    await expect(f.admin.transaction(async sql=>{
      await sql`ALTER TABLE resources DISABLE TRIGGER USER`;
      await sql`UPDATE resources SET parent_id=id WHERE id=${f.rootId}`;
      await sql`SELECT catalog_guard_scopes(ARRAY[${f.rootId}::uuid],true)`;
    })).rejects.toThrow('catalog guard membership unproven');
    expect(await f.admin.withSql(sql=>sql`SELECT catalog_guard_scopes(ARRAY[${f.rootId}::uuid],true) AS roots`)).toEqual([{roots:[f.rootId]}]);
  }finally{await f.close();}
},60000);

it('retains the exact depth and non-folder ancestor bounds and restores the original functions',async()=>{
  const f=await activeFixture('smallfile-scope-set-bounds','windows',103);
  try{
    const original=fixtureValue((await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT definition FROM sync_extension_function_backup WHERE revision=103 AND identity='catalog_guard_scope(uuid,boolean)'`))[0]).definition;
    await f.admin.withSql(sql=>sql.unsafe(original.replace('FUNCTION public.catalog_guard_scope(', 'FUNCTION public.test_previous_scope(')));
    await f.admin.withSql(sql=>sql.unsafe(`CREATE FUNCTION test_scope_outcome(anchor uuid,previous boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE roots uuid[]; BEGIN
       IF previous THEN roots:=public.test_previous_scope(anchor,true);ELSE roots:=public.catalog_guard_scopes(ARRAY[anchor],true);END IF;
       RETURN jsonb_build_object('roots',ARRAY(SELECT DISTINCT unnest(roots) ORDER BY 1));
      EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('code',SQLSTATE,'error',SQLERRM);END $$;`));
    const ids=Array.from({length:132},()=>uid());
    await expect(f.admin.transaction(async sql=>{
      // Deliberately malformed metadata is confined to this rolled-back fixture.
      await sql`ALTER TABLE resources DISABLE TRIGGER USER`;
      await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
        SELECT id,'folder',CASE WHEN ord=1 THEN '00000000-0000-7000-8000-000000000001'::uuid ELSE (${ids}::uuid[])[ord::int-1] END,id::text,id::text,'active'
        FROM unnest(${ids}::uuid[]) WITH ORDINALITY x(id,ord)`;
      for(const [n,valid]of [[129,true],[130,false],[131,false]] as const){
        const r=fixtureValue((await sql<{same:boolean;value:{roots?:string[];code?:string}}[]>`SELECT test_scope_outcome(${fixtureValue(ids[n])}::uuid,false)=test_scope_outcome(${fixtureValue(ids[n])}::uuid,true) AS same,test_scope_outcome(${fixtureValue(ids[n])}::uuid,false) AS value`)[0]);
        expect(r.same).toBe(true);expect('roots' in r.value).toBe(valid);
      }
      await sql`UPDATE resources SET type='file' WHERE id=${fixtureValue(ids[0])}`;
      const invalid=fixtureValue((await sql<{same:boolean;value:{code:string}}[]>`SELECT test_scope_outcome(${fixtureValue(ids[1])}::uuid,false)=test_scope_outcome(${fixtureValue(ids[1])}::uuid,true) AS same,test_scope_outcome(${fixtureValue(ids[1])}::uuid,false) AS value`)[0]);
      expect(invalid.same).toBe(true);expect(invalid.value.code).toBe('55000');
      throw Error('rollback fixture geometry');
    })).rejects.toThrow('rollback fixture geometry');
    await f.executor.close();await f.admin.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0103_catalog_scope_set.down.sql'),'utf8')));
    expect(fixtureValue((await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT pg_get_functiondef('catalog_guard_scope(uuid,boolean)'::regprocedure) AS definition`))[0]).definition).toBe(original);
    expect(await f.admin.withSql(sql=>sql`SELECT catalog_guard_scope(${f.rootId}::uuid) AS roots`)).toEqual([{roots:[f.rootId]}]);
  }finally{await f.close();}
},60000);

