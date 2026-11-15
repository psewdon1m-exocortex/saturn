import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {ROOT_RESOURCE_ID} from '@saturn/file-core';
import {activeFixture,databaseFixture,migrations,uid} from './stage3-chat-a.fixture.js';

it('checks every resource INSERT parent once per statement and rejects a forbidden last member atomically',async()=>{
  const f=await activeFixture('resource-insert-set','windows',105);
  try{
    const old=fixtureValue((await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT pg_get_functiondef('catalog_guard_scopes(uuid[],boolean)'::regprocedure) AS definition`))[0]).definition;
    await f.admin.withSql(sql=>sql.unsafe(old.replace('public.catalog_guard_scopes(','public.observer_resource_scope(')));
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_resource_calls(anchor uuid,controls boolean);
      CREATE OR REPLACE FUNCTION catalog_guard_scopes(anchors uuid[],include_controls boolean DEFAULT true) RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
        INSERT INTO public.observer_resource_calls SELECT DISTINCT id,include_controls FROM unnest(anchors) id WHERE id IS NOT NULL;
        RETURN public.observer_resource_scope(anchors,include_controls);END $$;
      CREATE FUNCTION observer_insert_resources(ids uuid[],parents uuid[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
        INSERT INTO public.resources(id,type,parent_id,name,storage_path,status)
          SELECT id,'folder',parent,id::text,id::text,'active' FROM unnest(ids,parents) WITH ORDINALITY x(id,parent,n) ORDER BY n;
      END $$;
      ALTER FUNCTION observer_insert_resources(uuid[],uuid[]) OWNER TO ${f.roles.writerOwner}; REVOKE ALL ON FUNCTION observer_insert_resources(uuid[],uuid[]) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION observer_insert_resources(uuid[],uuid[]) TO ${f.roles.writerLogin};`));
    const ids=Array.from({length:16},()=>uid()),parents=ids.map(()=>f.rootId);
    await f.admin.withSql(sql=>sql`TRUNCATE observer_resource_calls`);
    await f.writer.withSql(sql=>sql`SELECT observer_insert_resources(${ids}::uuid[],${parents}::uuid[])`);
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM observer_resource_calls WHERE anchor=${f.rootId}`)).toEqual([{anchor:f.rootId,controls:false}]);
    const badIds=Array.from({length:16},()=>uid()),badParents=badIds.map((_,n)=>n===15?f.rootId:ROOT_RESOURCE_ID);
    await expect(f.runtime.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
      SELECT id,'folder',parent,id::text,id::text,'active' FROM unnest(${badIds}::uuid[],${badParents}::uuid[]) WITH ORDINALITY x(id,parent,n) ORDER BY n`)).rejects.toThrow('catalog writer unqualified');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE id=ANY(${badIds}::uuid[])`)).toHaveLength(0);
    // Plain parents exclude descendant CONTROL roots, but a trashed-parent
    // alias includes them. The last alias must not disappear in a set walk.
    const outside=uid();
    await f.runtime.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
      VALUES(${outside},'folder',${ROOT_RESOURCE_ID},${outside},${outside},'active')`);
    const aliasIds=Array.from({length:16},()=>uid()),aliases=aliasIds.map((_,n)=>n===15?ROOT_RESOURCE_ID:null);
    await expect(f.runtime.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,trashed_from_parent_id,name,storage_path,status)
      SELECT id,'folder',${outside},alias,id::text,id::text,'active' FROM unnest(${aliasIds}::uuid[],${aliases}::uuid[]) WITH ORDINALITY x(id,alias,n) ORDER BY n`)).rejects.toThrow('catalog writer unqualified');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE id=ANY(${aliasIds}::uuid[])`)).toHaveLength(0);
    // Existing UPDATE/DELETE row guards still protect OLD membership.
    await expect(f.runtime.withSql(sql=>sql`UPDATE resources SET parent_id=${ROOT_RESOURCE_ID} WHERE id=${fixtureValue(ids[0])}`)).rejects.toThrow();
    await expect(f.runtime.withSql(sql=>sql`DELETE FROM resources WHERE id=${fixtureValue(ids[0])}`)).rejects.toThrow();
  }finally{await f.close();}
},60000);

it('restores the exact resource triggers after a stopped rollback',async()=>{
  const f=await databaseFixture('resource-insert-set-rollback',104);
  try{
    const definitions=()=>f.db.withSql(sql=>sql`SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='resources'::regclass AND NOT tgisinternal ORDER BY tgname`);
    const before=await definitions();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0105_resource_insert_set.up.sql'),'utf8')));
    expect(await definitions()).not.toEqual(before);
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0105_resource_insert_set.down.sql'),'utf8')));
    expect(await definitions()).toEqual(before);
  }finally{await f.close();}
},60000);
