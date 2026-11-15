import { fixtureChunks, fixtureMethod, fixtureValue } from './test-values.fixture.js';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import type {StorageAdapter} from '@saturn/storage';
import {BackendCheckedStorage} from '../../../packages/sync/src/guarded-runtime.js';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,sha,uid} from './stage3-chat-a.fixture.js';

function client(f:Awaited<ReturnType<typeof activeFixture>>,storage:StorageAdapter){
  const database=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  const files=new FileService(new PostgresFileRepository(f.runtime),storage,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:database});
  return {database,files};
}

it('publishes four independent originals with one backend group and replays exact versions through the runtime wrapper',async()=>{
  const f=await activeFixture('smallfile-publication-group-runtime','windows',89),check=vi.fn(async()=>{}),storage=new BackendCheckedStorage(f.executor,check),c=client(f,storage);
  try{
    const items=Array.from({length:4},(_,n)=>{const bytes=Buffer.alloc(4096,n+1);return {bytes,input:f.uploadInput('group-'+String(n)+'.bin',bytes)};});
    const prepared=await Promise.all(items.map(i=>c.files.prepareSmallCatalogUpload(i.input,f.proof)));
    const results=await Promise.all(prepared.map((p,n)=>c.files.completeSmallCatalogUpload(p,f.proof,fixtureValue(items[n]).bytes)));
    expect(results.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
    const tasks=await f.admin.withSql(sql=>sql<{id:string;command:string;state:string;payload:{members:{operationId:string}[]}}[]>`SELECT id,command,state,payload FROM sync_backend_tasks WHERE command IN ('rename','rename-group')`);
    expect(tasks).toHaveLength(1);expect(tasks[0]).toMatchObject({command:'rename-group',state:'DONE'});
    const originals=await f.admin.withSql(sql=>sql<{id:string;upload_claim_token:string;upload_publication_group:string}[]>`SELECT id,upload_claim_token,upload_publication_group FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`);
    expect(fixtureValue(tasks[0]).payload.members.map(m=>m.operationId).sort()).toEqual(originals.map(o=>o.id).sort());
    expect(fixtureValue(tasks[0]).id).toBe(fixtureValue(originals.find(o=>o.id===fixtureValue(fixtureValue(tasks[0]).payload.members[0]).operationId)).upload_claim_token);
    expect(new Set(originals.map(o=>o.upload_publication_group)).size).toBe(1);
    const versions=await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`),raw=vi.spyOn(f.raw,'rename'),restarted=client(f,storage);
    for(const [n,i]of items.entries()){
      const p=await restarted.files.prepareSmallCatalogUpload(i.input,f.proof);
      expect((await restarted.files.completeSmallCatalogUpload(p,f.proof,i.bytes)).status.result).toEqual(fixtureValue(results[n]).status.result);
      const chunks:Buffer[]=[];for await(const part of fixtureChunks(await f.raw.openRead(p.execution.targetPath)))chunks.push(Buffer.from(part));expect(sha(Buffer.concat(chunks))).toBe(sha(i.bytes));
    }
    expect(raw).not.toHaveBeenCalled();expect(await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`)).toEqual(versions);
    const group=vi.spyOn(f.executor,'renameGroupOnce');check.mockRejectedValueOnce(Error('backend_generation_changed'));
    await expect(fixtureMethod((storage as StorageAdapter), "renameGroupOnce")(uid(),[])).rejects.toThrow('backend_generation_changed');expect(group).not.toHaveBeenCalled();
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('keeps all original claims when the grouped physical response is lost after the renames',async()=>{
  const f=await activeFixture('smallfile-publication-group-response','windows',89),c=client(f,new BackendCheckedStorage(f.executor,async()=>{}));
  try{
    const items=Array.from({length:4},(_,n)=>{const bytes=Buffer.alloc(4096,n+7);return {bytes,input:f.uploadInput('uncertain-'+String(n)+'.bin',bytes)};});
    const prepared=await Promise.all(items.map(i=>c.files.prepareSmallCatalogUpload(i.input,f.proof))),effect=f.executor.renameGroupOnce.bind(f.executor);
    vi.spyOn(f.executor,'renameGroupOnce').mockImplementationOnce(async(...args)=>{await effect(...args);throw Error('lost grouped response');});
    expect((await Promise.allSettled(prepared.map((p,n)=>c.files.completeSmallCatalogUpload(p,f.proof,fixtureValue(items[n]).bytes)))).every(r=>r.status==='rejected')).toBe(true);
    for(const [n,p]of prepared.entries()){
      expect((await c.database.status(p,f.proof)).status.session.phase).toBe('reconciliation_required');
      const chunks:Buffer[]=[];for await(const part of fixtureChunks(await f.raw.openRead(p.execution.targetPath)))chunks.push(Buffer.from(part));expect(sha(Buffer.concat(chunks))).toBe(sha(fixtureValue(items[n]).bytes));
    }
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    await expect(c.files.prepareSmallCatalogUpload(f.uploadInput('later.bin',Buffer.from('later')),f.proof)).rejects.toMatchObject({code:'binding_invalid'});
    expect(await f.admin.withSql(sql=>sql`SELECT command,state FROM sync_backend_tasks WHERE command='rename-group'`)).toEqual([{command:'rename-group',state:'DONE'}]);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('never substitutes raw renames when the adapter lacks grouped replay capability',async()=>{
  const raw={rename:vi.fn()},checked:StorageAdapter=new BackendCheckedStorage(raw as unknown as StorageAdapter,async()=>{});
  expect(await checked.supportsRenameGroupOnce?.()).toBe(false);
  await expect(fixtureMethod(checked, "renameGroupOnce")(uid(),[])).rejects.toMatchObject({code:'unsupported'});expect(raw.rename).not.toHaveBeenCalled();
});

it('retains already accepted claims if checking the optional effect capability fails',async()=>{
  const f=await activeFixture('smallfile-publication-group-capability-failure','windows',89),c=client(f,new BackendCheckedStorage(f.executor,async()=>{}));
  try{
    const bytes=Buffer.from('retained verified bytes'),prepared=await Promise.all(Array.from({length:4},(_,n)=>c.files.prepareSmallCatalogUpload(f.uploadInput('cap-'+String(n)+'.bin',bytes),f.proof)));
    vi.spyOn(f.executor,'supportsRenameGroupOnce').mockRejectedValueOnce(Error('lost capability response'));const rename=vi.spyOn(f.raw,'rename');
    expect((await Promise.allSettled(prepared.map(p=>c.files.completeSmallCatalogUpload(p,f.proof,bytes)))).every(r=>r.status==='rejected')).toBe(true);expect(rename).not.toHaveBeenCalled();
    for(const p of prepared){expect((await c.database.status(p,f.proof)).status.session.phase).toBe('reconciliation_required');expect(await f.raw.exists(p.execution.tempPath)).toBe(true);}
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks WHERE command='rename-group'`)).toHaveLength(0);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);
