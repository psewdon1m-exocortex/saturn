import { fixtureMethod } from './test-values.fixture.js';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import type {StorageAdapter} from '@saturn/storage';
import {BackendCheckedStorage} from '../../../packages/sync/src/guarded-runtime.js';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,sha,uid} from './stage3-chat-a.fixture.js';

it('forwards durable small writes through the runtime generation check, including a replay attempt',async()=>{
  const f=await activeFixture('smallfile-runtime-storage','windows',84),check=vi.fn(async()=>{}),checked:StorageAdapter=new BackendCheckedStorage(f.executor,check);
  try{
    expect(await checked.supportsWriteOnce?.()).toBe(true);
    const files=new FileService(new PostgresFileRepository(f.runtime),checked,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,
      catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});
    const bytes=Buffer.from('qualified runtime small write'),input=f.uploadInput('runtime.bin',bytes),p=await files.prepareSmallCatalogUpload(input,f.proof);
    expect(p.status.session.transferPending).toBe(true);
    const result=await files.completeSmallCatalogUpload(p,f.proof,bytes);expect(result.status.result?.status).toBe('PUBLISHED');
    expect((await f.admin.withSql(sql=>sql`SELECT payload->>'schema' AS schema FROM sync_backend_tasks WHERE command='write'`))[0]?.schema).toBe('saturn.backend-write-once.v1');
    const chunks=[];for await(const b of await f.raw.openRead(result.execution.targetPath))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));
    const delegate=vi.spyOn(f.executor,'writeOnce'),calls=check.mock.calls.length,task=uid(),raw=vi.spyOn(f.raw,'write');
    for(let n=0;n<2;n++)await fixtureMethod(checked, "writeOnce")(task,'_system/incoming/checked.part',bytes,{offset:0,create:true,exclusive:true});
    expect(check).toHaveBeenCalledTimes(calls+2);expect(delegate).toHaveBeenCalledTimes(2);expect(raw).toHaveBeenCalledTimes(1);
    check.mockRejectedValueOnce(Error('backend_generation_changed'));
    await expect(fixtureMethod(checked, "writeOnce")(task,'_system/incoming/checked.part',bytes,{offset:0,create:true,exclusive:true})).rejects.toThrow('backend_generation_changed');
    expect(delegate).toHaveBeenCalledTimes(2);expect(raw).toHaveBeenCalledTimes(1);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('does not advertise replayability for an ordinary adapter or fall back to a raw write',async()=>{
  const raw={write:vi.fn()},check=vi.fn(async()=>{}),checked:StorageAdapter=new BackendCheckedStorage(raw as unknown as StorageAdapter,check);
  expect(await checked.supportsWriteOnce?.()).toBe(false);
  await expect(fixtureMethod(checked, "writeOnce")(uid(),'file',Buffer.from('x'),{offset:0,create:true})).rejects.toMatchObject({code:'unsupported'});
  expect(raw.write).not.toHaveBeenCalled();
});
