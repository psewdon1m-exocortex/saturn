import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {activeFixture,databaseFixture,migrations} from './stage3-chat-a.fixture.js';

const revision=Number(process.env.SMALL_FILE_REVIEW_MIGRATION??88);
it('reuses only a strictly checked stored activation proof and validates synthetic proofs normally',async()=>{
  const f=await activeFixture('smallfile-active-proof','windows',revision);
  try{
    await f.admin.withSql(async sql=>{
      const definition=fixtureValue((await sql<{source:string}[]>`SELECT pg_get_functiondef('catalog_guard_active_shape(jsonb)'::regprocedure) AS source`)[0]).source;
      await sql.unsafe(definition.replace('FUNCTION public.catalog_guard_active_shape(', 'FUNCTION public.test_original_active_shape('));
      await sql.unsafe(`CREATE SEQUENCE test_active_shape_calls;
        CREATE OR REPLACE FUNCTION catalog_guard_active_shape(p jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$ BEGIN PERFORM nextval('public.test_active_shape_calls');RETURN public.test_original_active_shape(p);END $$`);
    });
    for(let n=0;n<3;n++)expect((await f.admin.withSql(sql=>sql`SELECT catalog_guard_active_valid(g) AS valid FROM catalog_guard_roots g WHERE root_id=${f.rootId}`))[0]?.valid).toBe(true);
    expect((await f.admin.withSql(sql=>sql`SELECT is_called FROM test_active_shape_calls`))[0]?.is_called).toBe(false);
    expect((await f.admin.withSql(sql=>sql`SELECT catalog_guard_active_valid(jsonb_populate_record(NULL::catalog_guard_roots,to_jsonb(g)||jsonb_build_object('active_runtime',g.active_runtime||' {"extra":true}'::jsonb))) AS valid FROM catalog_guard_roots g WHERE root_id=${f.rootId}`))[0]?.valid).toBe(false);
    expect((await f.admin.withSql(sql=>sql`SELECT last_value FROM test_active_shape_calls`))[0]?.last_value).toBe('1');
    const bytes=Buffer.from('activation proof remains checked'),result=await f.upload(f.uploadInput('proof.bin',bytes),bytes);
    expect(result.status.result?.status).toBe('PUBLISHED');
    expect((await f.admin.withSql(sql=>sql`SELECT last_value FROM test_active_shape_calls`))[0]?.last_value).toBe('1');
  }finally{await f.close();}
},60000);

it('preserves the former active validation result for changed identities and malformed proofs',async()=>{
  const f=await activeFixture('smallfile-active-proof-equivalence','windows',revision);
  try{
    const source=fixtureValue((await f.admin.withSql(sql=>sql<{source:string}[]>`SELECT definition AS source FROM sync_extension_function_backup WHERE revision=88 AND identity='catalog_guard_active_valid(catalog_guard_roots)'`))[0]).source;
    await f.admin.withSql(sql=>sql.unsafe(source.replace('FUNCTION public.catalog_guard_active_valid(', 'FUNCTION public.test_original_active_valid(')));
    const row=fixtureValue((await f.admin.withSql(sql=>sql<{value:Record<string,unknown>}[]>`SELECT to_jsonb(g) AS value FROM catalog_guard_roots g WHERE root_id=${f.rootId}`))[0]).value;
    const proof=row.active_runtime as Record<string,unknown>;
    const variants=[row,{...row,root_id:'00000000-0000-4000-8000-000000000000'},{...row,backend_identity:'other'},{...row,writer_contract:'other'},
      ...Object.keys(proof).flatMap(key=>[{...row,active_runtime:{...proof,[key]:null}},{...row,active_runtime:Object.fromEntries(Object.entries(proof).filter(([k])=>k!==key))}])];
    for(const value of variants){
      const r=fixtureValue((await f.admin.withSql(sql=>sql<{current:boolean|null;previous:boolean|null}[]>`SELECT catalog_guard_active_valid(g) AS current,test_original_active_valid(g) AS previous FROM jsonb_populate_record(NULL::catalog_guard_roots,${JSON.stringify(value)}::text::jsonb) g`))[0]);
      expect(r.current).toBe(r.previous);
    }
    // Corrupt only this disposable fixture inside a transaction that is rolled
    // back, to prove that an unchanged stored proof cannot hide a changed epoch.
    await expect(f.admin.transaction(async sql=>{
      await sql`ALTER TABLE sync_root_clock DISABLE TRIGGER USER`;
      await sql`UPDATE sync_root_clock SET epoch=gen_random_uuid() WHERE root_id=${f.rootId}`;
      expect((await sql`SELECT catalog_guard_active_valid(g) AS current,test_original_active_valid(g) AS previous FROM catalog_guard_roots g WHERE root_id=${f.rootId}`)[0]).toEqual({current:false,previous:false});
      throw Error('rollback test epoch');
    })).rejects.toThrow('rollback test epoch');
  }finally{await f.close();}
},60000);

it('rejects nullable proof validation at the stored-row constraint and during migration validation',async()=>{
  const f=await activeFixture('smallfile-active-proof-null','windows',87);
  try{
    const source=fixtureValue((await f.admin.withSql(sql=>sql<{source:string}[]>`SELECT pg_get_functiondef('catalog_guard_active_valid(catalog_guard_roots)'::regprocedure) AS source`))[0]).source;
    await f.admin.withSql(sql=>sql.unsafe(`CREATE OR REPLACE FUNCTION catalog_guard_active_shape(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS 'SELECT NULL::boolean'`));
    const up=await fs.readFile(path.join(migrations,'0088_catalog_active_proof.up.sql'),'utf8');
    await expect(f.admin.transaction(sql=>sql.unsafe(up))).rejects.toThrow('catalog_guard_active_proof_checked');
    expect((await f.admin.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_guard_active_valid(catalog_guard_roots)'::regprocedure) AS source`))[0]?.source).toBe(source);
  }finally{await f.close();}
  const qualified=await activeFixture('smallfile-active-proof-null-write','windows',88);
  try{
    await qualified.admin.withSql(sql=>sql.unsafe(`CREATE OR REPLACE FUNCTION catalog_guard_active_shape(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS 'SELECT NULL::boolean'`));
    // Isolate this exact CHECK from the independent registration trigger in an
    // owned fixture. Rejection rolls back the trigger change and the mutation.
    await expect(qualified.admin.transaction(async sql=>{
      await sql`ALTER TABLE catalog_guard_roots DISABLE TRIGGER USER`;
      await sql`UPDATE catalog_guard_roots SET active_runtime=active_runtime||'{"extra":true}'::jsonb WHERE root_id=${qualified.rootId}`;
    })).rejects.toThrow('catalog_guard_active_proof_checked');
  }finally{await qualified.close();}
},60000);

it('requires true rather than nullable validation and restores the exact predecessor',async()=>{
  const f=await databaseFixture('smallfile-active-proof-down',87);
  try{
    const source=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_guard_active_valid(catalog_guard_roots)'::regprocedure) AS source`);
    const before=await source(),up=await fs.readFile(path.join(migrations,'0088_catalog_active_proof.up.sql'),'utf8'),down=await fs.readFile(path.join(migrations,'0088_catalog_active_proof.down.sql'),'utf8');
    await f.db.transaction(sql=>sql.unsafe(up));
    expect((await f.db.withSql(sql=>sql`SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='catalog_guard_roots'::regclass AND conname='catalog_guard_active_proof_checked'`))[0]).toMatchObject({convalidated:true,definition:'CHECK (((active_runtime IS NULL) OR (catalog_guard_active_shape(active_runtime) IS TRUE)))'});
    await f.db.transaction(sql=>sql.unsafe(down));expect(await source()).toEqual(before);
    expect(await f.db.withSql(sql=>sql`SELECT oid FROM pg_constraint WHERE conrelid='catalog_guard_roots'::regclass AND conname='catalog_guard_active_proof_checked'`)).toHaveLength(0);
  }finally{await f.close();}
},60000);
