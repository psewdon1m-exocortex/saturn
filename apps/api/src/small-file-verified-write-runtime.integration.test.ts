import { fixtureMethod, fixtureValue } from './test-values.fixture.js';
const migration=Number(process.env.SMALL_FILE_VERIFIED_WRITE_MIGRATION??98);
import {Readable} from 'node:stream';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import type {StorageAdapter} from '@saturn/storage';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {BackendCheckedStorage} from '../../../packages/sync/src/guarded-runtime.js';
import {activeFixture,sha,uid} from './stage3-chat-a.fixture.js';

function client(f:Awaited<ReturnType<typeof activeFixture>>,storage:StorageAdapter=new BackendCheckedStorage(f.executor,async()=>{})){
  const db=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  return {db,files:new FileService(new PostgresFileRepository(f.runtime),storage,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:db})};
}

it('publishes independent originals through verified writes and grouped renames with exact physical bytes and receipts',async()=>{
  const f=await activeFixture('smallfile-verified-write-runtime','windows',migration),c=client(f);
  try{
    const data=Buffer.alloc(8192,73),prepared=await Promise.all([0,1,2,3].map(n=>c.files.prepareSmallCatalogUpload(f.uploadInput('verified-'+String(n)+'.bin',data),f.proof)));
    const reads=vi.spyOn(f.raw,'openRead'),results=await Promise.all(prepared.map(p=>c.files.completeSmallCatalogUpload(p,f.proof,data)));
    expect(results.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);expect(reads).toHaveBeenCalledTimes(4);
    const tasks=await f.admin.withSql(sql=>sql<{payload:{schema:string};result:{sha256:string};state:string}[]>`SELECT payload,result,state FROM sync_backend_tasks WHERE command='write'`);
    expect(tasks).toHaveLength(4);expect(tasks.every(t=>t.payload.schema==='saturn.backend-write-verified-once.v1'&&t.state==='DONE'&&t.result.sha256===sha(data))).toBe(true);
    const originals=await f.admin.withSql(sql=>sql`SELECT id,upload_id,upload_intent_hash FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`),versions=await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`),writes=vi.spyOn(f.raw,'write'),rename=vi.spyOn(f.raw,'rename');
    const restarted=client(f);
    for(const [n,p]of prepared.entries()){
      const same=await restarted.files.prepareSmallCatalogUpload(p.input,f.proof);expect((await restarted.files.completeSmallCatalogUpload(same,f.proof,data)).status.result).toEqual(fixtureValue(results[n]).status.result);
      const chunks=[];for await(const b of await f.raw.openRead(same.execution.targetPath))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(sha(data));
    }
    expect(writes).not.toHaveBeenCalled();expect(rename).not.toHaveBeenCalled();
    expect(await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`)).toEqual(versions);
    expect(await f.admin.withSql(sql=>sql`SELECT id,upload_id,upload_intent_hash FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`)).toEqual(originals);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('keeps partial old transfers on the existing chunk path and reads all bytes before publication',async()=>{
  const f=await activeFixture('smallfile-verified-write-partial','windows',migration),c=client(f);
  try{
    const data=Buffer.from('a confirmed prefix followed by the remaining content'),input=f.uploadInput('partial.bin',data);
    let p=await c.files.prepareCatalogUpload(input,f.proof);p=await c.files.appendCatalogUpload(p,f.proof,'0',data.subarray(0,7));
    const result=await c.files.completeSmallCatalogUpload(p,f.proof,data);expect(result.status.result?.status).toBe('PUBLISHED');
    const rows=await f.admin.withSql(sql=>sql<{schema:string}[]>`SELECT payload->>'schema' AS schema FROM sync_backend_tasks WHERE command='write'`);expect(rows).toHaveLength(2);expect(rows.every(r=>r.schema==='saturn.backend-write-once.v1')).toBe(true);
    const chunks=[];for await(const b of await f.raw.openRead(result.execution.targetPath))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(sha(data));
  }finally{await f.close();}
},60000);

it('rejects a corrupted DONE transfer on retry without publishing or losing the original',async()=>{
  const f=await activeFixture('smallfile-verified-write-stale-proof','windows',migration),c=client(f),data=Buffer.from('independent physical proof'),input=f.uploadInput('stale.bin',data);
  try{
    const p=await c.files.prepareSmallCatalogUpload(input,f.proof),group=c.db.verifyAndClaim.bind(c.db);
    // Leave the acknowledged write before the catalog claim, as with a failed reader/request.
    vi.spyOn(c.db,'verifyAndClaim').mockRejectedValueOnce(Error('before claim'));
    await expect(c.files.completeSmallCatalogUpload(p,f.proof,data)).rejects.toThrow();
    expect((await c.db.status(p,f.proof)).status.result).toBeUndefined();
    await f.raw.write(p.execution.tempPath,Readable.from(Buffer.alloc(data.length,migration)),{offset:0,create:false});
    vi.spyOn(c.db,'verifyAndClaim').mockImplementation(group);const writes=vi.spyOn(f.raw,'write'),renames=vi.spyOn(f.raw,'rename');
    const again=await c.files.prepareSmallCatalogUpload(input,f.proof);await expect(c.files.completeSmallCatalogUpload(again,f.proof,data)).rejects.toMatchObject({code:'verification_failed'});
    expect(writes).not.toHaveBeenCalled();expect(renames).not.toHaveBeenCalled();expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId}`)).toHaveLength(1);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('checks runtime generation before dispatch and refuses unsupported raw adapters',async()=>{
  const raw={writeVerifiedOnce:vi.fn(),supportsWriteVerifiedOnce:async()=>true},checked:StorageAdapter=new BackendCheckedStorage(raw as unknown as StorageAdapter,async()=>{throw Error('backend_generation_changed');});
  await expect(fixtureMethod(checked, "writeVerifiedOnce")(uid(),'file.bin',Buffer.from('x'))).rejects.toThrow('backend_generation_changed');expect(raw.writeVerifiedOnce).not.toHaveBeenCalled();
  const unsupported:StorageAdapter=new BackendCheckedStorage({} as StorageAdapter,async()=>{});expect(await fixtureMethod(unsupported, "supportsWriteVerifiedOnce")()).toBe(false);
  await expect(fixtureMethod(unsupported, "writeVerifiedOnce")(uid(),'file.bin',Buffer.from('x'))).rejects.toMatchObject({code:'unsupported'});
});
