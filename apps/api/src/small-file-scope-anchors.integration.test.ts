import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {ROOT_RESOURCE_ID,SYNC_RESOURCE_ID,OUTDOOR_CONNECTIONS_RESOURCE_ID} from '@saturn/file-core';
import {OwnerAuthService,PostgresOwnerAuthRepository} from '@saturn/auth';
import {GuardedOutsideFolderService} from '../../../packages/sync/src/guarded-outside-folder.js';
import {activeFixture,databaseFixture,migrations,uid} from './stage3-chat-a.fixture.js';

it('resolves each distinct anchor/control pair once per row guard, including journal aliases',async()=>{
  const f=await activeFixture('smallfile-scope-anchors-count','windows',86);
  try{
    const bytes=Buffer.from('scope anchors'),p=await f.upload(f.uploadInput('anchors.bin',bytes),bytes);
    const old=fixtureValue((await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT pg_get_functiondef('catalog_guard_scope(uuid,boolean)'::regprocedure) AS definition`))[0]).definition;
    await f.admin.withSql(sql=>sql.unsafe(old.replace('public.catalog_guard_scope(','public.observer_scope_original(')));
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_scope_calls(anchor uuid,controls boolean);
      CREATE OR REPLACE FUNCTION catalog_guard_scope(anchor uuid,include_controls boolean DEFAULT true) RETURNS uuid[] LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
        IF anchor IS NOT NULL THEN INSERT INTO public.observer_scope_calls VALUES(anchor,include_controls);END IF;
        RETURN public.observer_scope_original(anchor,include_controls);END $$;
      CREATE FUNCTION observer_scope_touch(kind text,node uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN
        IF kind='resources' THEN UPDATE public.resources SET updated_at=updated_at WHERE id=node;
        ELSIF kind='file_versions' THEN UPDATE public.file_versions SET storage_path=storage_path WHERE resource_id=node;
        ELSIF kind='upload_sessions' THEN UPDATE public.upload_sessions SET updated_at=updated_at WHERE resource_id=node;
        ELSIF kind='operation_journal' THEN UPDATE public.operation_journal SET updated_at=updated_at WHERE resource_id=node;
        ELSE RAISE EXCEPTION 'invalid test table';END IF;END $$;
      ALTER FUNCTION observer_scope_touch(text,uuid) OWNER TO ${f.roles.writerOwner};
      GRANT EXECUTE ON FUNCTION observer_scope_touch(text,uuid) TO ${f.roles.writerLogin};`));
    const pairs={resources:[{anchor:p.execution.nodeId,controls:true},{anchor:f.rootId,controls:false}],file_versions:[{anchor:p.execution.nodeId,controls:true}],
      upload_sessions:[{anchor:p.execution.nodeId,controls:true},{anchor:f.rootId,controls:true}],operation_journal:[{anchor:p.execution.nodeId,controls:true},{anchor:f.rootId,controls:true}]};
    const sort=(v:{anchor:string;controls:boolean}[])=>v.toSorted((a,b)=>a.anchor.localeCompare(b.anchor)||Number(a.controls)-Number(b.controls));
    for(const [kind,expected]of Object.entries(pairs)){
      await f.admin.withSql(sql=>sql`TRUNCATE observer_scope_calls`);
      await f.writer.withSql(sql=>sql`SELECT observer_scope_touch(${kind},${p.execution.nodeId}::uuid)`);
      expect(sort(await f.admin.withSql(sql=>sql<{anchor:string;controls:boolean}[]>`SELECT * FROM observer_scope_calls`)),kind).toEqual(sort(expected));
    }
  }finally{await f.close();}
},60000);

it('preserves owner-authenticated outside folders under all control parents and their original replay',async()=>{
  const f=await activeFixture('smallfile-scope-anchors-controls','windows',86),key=uid();
  try{
    const auth=new OwnerAuthService({repository:new PostgresOwnerAuthRepository(f.admin),ownerAccessKey:key,pepper:'isolated-scope-owner-pepper-123456789012345678',options:{publicOrigin:'https://fixture.invalid',sessionIdleTtlMs:600000,sessionAbsoluteTtlMs:3600000,reauthTtlMs:600000,failureLimit:10,failureWindowMs:60000}});await auth.initialize();
    const service=new GuardedOutsideFolderService(f.runtime,f.writer,f.executor,{uploadMaxBytes:1073741824});
    const before=await f.admin.withSql(sql=>sql`SELECT published_seq,binding_version,namespace_state FROM sync_root_clock WHERE root_id=${f.rootId}`);
    for(const parent of [ROOT_RESOURCE_ID,SYNC_RESOURCE_ID,OUTDOOR_CONNECTIONS_RESOURCE_ID]){
      const operation=uid(),name='outside-'+operation;
      const folder=await service.ownerAction({bootstrap:key},()=>service.createFolder(parent,name),operation);
      expect(await service.ownerAction({bootstrap:key},()=>service.createFolder(parent,name),operation)).toEqual(folder);
      expect((await f.raw.stat(folder.storagePath)).type).toBe('directory');
      expect((await f.admin.withSql(sql=>sql`SELECT count(*)::int AS n FROM resources WHERE parent_id=${parent} AND name=${name}`))[0]?.n).toBe(1);
    }
    await expect(service.ownerAction({bootstrap:'wrong-owner'},()=>service.createFolder(ROOT_RESOURCE_ID,'refused'))).rejects.toMatchObject({code:'authority_invalid'});
    expect(await f.admin.withSql(sql=>sql`SELECT published_seq,binding_version,namespace_state FROM sync_root_clock WHERE root_id=${f.rootId}`)).toEqual(before);
    expect((await f.admin.withSql(sql=>sql`SELECT count(*)::int AS n FROM sync_backend_tasks WHERE command='mkdir' AND state='DONE'`))[0]?.n).toBe(3);
  }finally{await f.close();}
},60000);

it('keeps old/new parent boundaries, direct roots and unqualified table writes protected',async()=>{
  const f=await activeFixture('smallfile-scope-anchors-authorization','windows',86);
  try{
    const bytes=Buffer.from('guarded membership'),p=await f.upload(f.uploadInput('guarded.bin',bytes),bytes),outside=uid();
    await f.runtime.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status) VALUES(${outside},'file',${ROOT_RESOURCE_ID},${'outside-'+outside},${'outside-'+outside},'active')`);
    await expect(f.runtime.withSql(sql=>sql`UPDATE resources SET parent_id=${f.rootId} WHERE id=${outside}`)).rejects.toThrow('catalog writer unqualified');
    await expect(f.runtime.withSql(sql=>sql`UPDATE resources SET parent_id=${ROOT_RESOURCE_ID} WHERE id=${p.execution.nodeId}`)).rejects.toThrow('catalog writer unqualified');
    await expect(f.runtime.withSql(sql=>sql`UPDATE resources SET parent_id=${uid()} WHERE id=${outside}`)).rejects.toThrow('catalog guard membership unproven');
    for(const query of ['UPDATE resources SET size_bytes=size_bytes WHERE id=$1::uuid','UPDATE file_versions SET storage_path=storage_path WHERE resource_id=$1::uuid',
      'UPDATE upload_sessions SET updated_at=updated_at WHERE resource_id=$1::uuid','UPDATE operation_journal SET updated_at=updated_at WHERE resource_id=$1::uuid',
      'DELETE FROM resources WHERE id=$1::uuid'])await expect(f.runtime.withSql(sql=>sql.unsafe(query,[p.execution.nodeId]))).rejects.toThrow('catalog writer unqualified');
    await expect(f.runtime.withSql(sql=>sql`UPDATE sync_root_clock SET updated_at=updated_at WHERE root_id=${f.rootId}`)).rejects.toThrow('catalog writer unqualified');
    expect((await f.admin.withSql(sql=>sql`SELECT parent_id FROM resources WHERE id=${p.execution.nodeId}`))[0]?.parent_id).toBe(f.rootId);
    expect((await f.admin.withSql(sql=>sql`SELECT parent_id FROM resources WHERE id=${outside}`))[0]?.parent_id).toBe(ROOT_RESOURCE_ID);
    expect((await f.files.inspectCatalogUpload(p,f.proof)).status.result?.status).toBe('PUBLISHED');
  }finally{await f.close();}
},60000);

it('restores the exact guard function without changing scope semantics',async()=>{
  const f=await databaseFixture('smallfile-scope-anchors-rollback',85);
  try{
    const definitions=()=>f.db.withSql(sql=>sql<{identity:string;definition:string}[]>`SELECT oid::regprocedure::text AS identity,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE oid IN ('catalog_guard_rows()'::regprocedure,'catalog_guard_scope(uuid,boolean)'::regprocedure) ORDER BY identity`),before=await definitions();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0086_catalog_scope_anchors.up.sql'),'utf8')));
    const changed=await definitions();expect(changed.filter((v,n)=>v.definition!==before[n]?.definition).map(v=>v.identity)).toEqual(['catalog_guard_rows()']);
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0086_catalog_scope_anchors.down.sql'),'utf8')));expect(await definitions()).toEqual(before);
  }finally{await f.close();}
},60000);
