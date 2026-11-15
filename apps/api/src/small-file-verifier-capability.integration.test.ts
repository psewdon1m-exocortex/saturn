import { fixtureValue } from './test-values.fixture.js';
import {Readable} from 'node:stream';
import {expect,it,vi} from 'vitest';
import {LocalStorageAdapter} from '@saturn/storage';
import {activeFixture,sha} from './stage3-chat-a.fixture.js';
import {completionAdopt} from './completion-adoption.fixture.js';

it.each(['identity_mismatch','verification_failed'])('a supported verifier refusal %s still prevents qualified publication',async code=>{
  const f=await activeFixture('smallfile-verifier-refusal-'+code,'windows',88);let adopted:Awaited<ReturnType<typeof completionAdopt>>|undefined;
  try{
    adopted=await completionAdopt(f,{scaleTransfer:true});const scope=await adopted.runtime.scope(f.rootId);if(!scope)throw Error('Qualified scope absent');
    const proof=await scope.authority.device(f.authorization,f.rootId),bytes=Buffer.from('%PDF-1.7\n'+'supported verifier '.repeat(1000));
    const input={...f.uploadInput('refused.pdf',bytes),epoch:scope.binding.server_epoch,bindingVersion:scope.binding.binding_version};
    vi.spyOn(LocalStorageAdapter.prototype,'supportsVerify').mockResolvedValue(true);
    const verify=vi.spyOn(LocalStorageAdapter.prototype,'verify').mockRejectedValue(Object.assign(Error(code),{code}));
    const prepared=await scope.files.prepareSmallCatalogUpload(input,proof);
    await expect(scope.files.completeSmallCatalogUpload(prepared,proof,bytes)).rejects.toMatchObject({code});
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${f.rootId} AND name='refused.pdf'`)).toHaveLength(0);
    expect((await scope.files.inspectCatalogUpload(prepared,proof)).status.session.phase).toBe('transport');
  }finally{await adopted?.runtime.close();vi.restoreAllMocks();await f.close();}
},60000);

it('qualified runtime uses complete SHA readback without invoking an unavailable adapter verifier',async()=>{
  const f=await activeFixture('smallfile-verifier-capability','windows',88);let adopted:Awaited<ReturnType<typeof completionAdopt>>|undefined;
  try{
    adopted=await completionAdopt(f,{scaleTransfer:true});const scope=await adopted.runtime.scope(f.rootId);if(!scope)throw Error('Qualified scope absent');
    const proof=await scope.authority.device(f.authorization,f.rootId),bytes=Buffer.from('%PDF-1.7\n'+'verified small file '.repeat(1000));
    const input={...f.uploadInput('available.pdf',bytes),epoch:scope.binding.server_epoch,bindingVersion:scope.binding.binding_version};
    const verify=vi.spyOn(LocalStorageAdapter.prototype,'verify');
    const prepared=await scope.files.prepareSmallCatalogUpload(input,proof),result=await scope.files.completeSmallCatalogUpload(prepared,proof,bytes);
    expect(result.status.result?.status).toBe('PUBLISHED');
    const chunks=[];for await(const chunk of await f.raw.openRead(result.execution.targetPath))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));
    expect(await f.admin.withSql(sql=>sql`SELECT mime_type,sha256 FROM resources WHERE parent_id=${f.rootId} AND name='available.pdf'`)).toEqual([{mime_type:'application/pdf',sha256:sha(bytes)}]);
    expect(verify).not.toHaveBeenCalled();
  }finally{await adopted?.runtime.close();vi.restoreAllMocks();await f.close();}
},60000);

it('an unavailable verifier never allows corrupted durable bytes to publish',async()=>{
  const f=await activeFixture('smallfile-verifier-fallback-corruption','windows',88);let adopted:Awaited<ReturnType<typeof completionAdopt>>|undefined;
  try{
    adopted=await completionAdopt(f,{scaleTransfer:true});const scope=await adopted.runtime.scope(f.rootId);if(!scope)throw Error('Qualified scope absent');
    const proof=await scope.authority.device(f.authorization,f.rootId),bytes=Buffer.from('%PDF-1.7\n'+'verified small file '.repeat(1000));
    const input={...f.uploadInput('corrupt.pdf',bytes),epoch:scope.binding.server_epoch,bindingVersion:scope.binding.binding_version};
    let prepared=await scope.files.prepareCatalogUpload(input,proof);prepared=await scope.files.appendCatalogUpload(prepared,proof,'0',bytes);
    const changed=Buffer.from(bytes);changed[changed.length-1]=fixtureValue(changed[changed.length-1])^1;
    await f.raw.write(prepared.execution.tempPath,Readable.from(changed),{offset:0,create:false,truncate:true});
    await expect(scope.files.completeCatalogUpload(prepared,proof)).rejects.toMatchObject({code:'verification_failed'});
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${f.rootId} AND name='corrupt.pdf'`)).toHaveLength(0);
    expect((await scope.files.inspectCatalogUpload(prepared,proof)).status.session.phase).toBe('transport');
  }finally{await adopted?.runtime.close();vi.restoreAllMocks();await f.close();}
},60000);
