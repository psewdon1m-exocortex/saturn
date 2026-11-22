import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import {expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,migrations,sha,uid} from './stage3-chat-a.fixture.js';

const reviewMigration=Number(process.env.SMALL_FILE_REVIEW_MIGRATION??78);
if(![78,79,80,84,85,86,87,88,89,91].includes(reviewMigration))throw Error('Invalid review migration');

async function originals(f:Awaited<ReturnType<typeof activeFixture>>,names=['a.bin','b.bin']){
  const items=[];
  for(const name of names){const bytes=Buffer.from(name),input=f.uploadInput(name,bytes);let prepared=await f.files.prepareCatalogUpload(input,f.proof);prepared=await f.files.appendCatalogUpload(prepared,f.proof,'0',bytes);items.push({input,bytes,prepared,request:{input,originalUploadId:prepared.status.session.uploadId,claimToken:uid(),mimeType:'application/octet-stream'}});}
  return items;
}
async function claim(f:Awaited<ReturnType<typeof activeFixture>>,requests:unknown[]){
  const credential=f.issuer.deviceCredential(f.proof,f.rootId);
  return f.writer.withSql(async sql=>fixtureValue((await sql<{value:{session:{phase:string;uploadId:string};claimToken:string}[]}[]>`SELECT catalog_upload_command('verify-claim-group','{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(requests)}::text::jsonb) AS value`)[0]).value);
}
function client(f:Awaited<ReturnType<typeof activeFixture>>){
  const db=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:db});
  return {db,files};
}
async function clientOriginals(f:Awaited<ReturnType<typeof activeFixture>>,c:ReturnType<typeof client>,names=['client-0.bin','client-1.bin','client-2.bin','client-3.bin']){
  const items=[];
  for(let n=0;n<4;n++){
    const bytes=Buffer.alloc(4096,n+1),input=f.uploadInput(fixtureValue(names[n]),bytes);
    let prepared=await c.files.prepareCatalogUpload(input,f.proof);prepared=await c.files.appendCatalogUpload(prepared,f.proof,'0',bytes);
    items.push({bytes,input,prepared});
  }
  return items;
}

// These fault cards require one genuinely ready four-member publication set.
// Keep the real stat, full-byte verification and SQL capability checks, then
// release all ready completions together; the product's 50ms tail stays intact.
async function readyGroupCompletions(f:Awaited<ReturnType<typeof activeFixture>>,c:ReturnType<typeof client>,items:Awaited<ReturnType<typeof clientOriginals>>){
  const supports=c.db.supportsPublicationGroups.bind(c.db);let release=()=>{},ready=0,expired=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const timer=setTimeout(()=>{expired=true;release();},5000);
  const observed=vi.spyOn(c.db,'supportsPublicationGroups').mockImplementation(async()=>{
    const actual=await supports();
    if(ready>=items.length)return actual;
    if(!actual)throw Error('Publication-group fixture capability unavailable');
    ready++;if(ready===items.length){clearTimeout(timer);release();}
    await gate;if(expired)throw Error('Four real verified originals did not reach the publication-group barrier');return actual;
  });
  try{
    const outcomes=await Promise.allSettled(items.map(i=>c.files.completeCatalogUpload(i.prepared,f.proof)));
    expect(ready).toBe(4);expect(expired).toBe(false);return outcomes;
  }finally{clearTimeout(timer);release();observed.mockRestore();}
}
function publishedGroup(outcomes:Awaited<ReturnType<typeof readyGroupCompletions>>){
  return outcomes.map(outcome=>{if(outcome.status==='rejected')throw outcome.reason;return outcome.value;});
}

it('claims distinct originals together, excludes new work, and publishes independent exact receipts',async()=>{
  const f=await activeFixture('smallfile-group','windows',reviewMigration);
  try{
    const items=await originals(f),accepted=await claim(f,items.map(i=>i.request));
    expect(accepted.map(i=>i.session.phase)).toEqual(['physical_pending','physical_pending']);
    expect(accepted.map(i=>i.claimToken)).toEqual(items.map(i=>i.request.claimToken));
    await expect(f.files.prepareCatalogUpload(f.uploadInput('later.bin',Buffer.from('later')),f.proof)).rejects.toMatchObject({code:'reconciliation_required'});
    await Promise.all(items.map(i=>f.executor.rename(i.prepared.execution.tempPath,i.prepared.execution.targetPath)));
    const db=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
    const handles=await Promise.all(items.map(i=>db.prepare(i.input,f.proof,i.prepared.status.session.uploadId)));
    const published=await Promise.all(handles.map(p=>db.commit(p,f.proof,'application/octet-stream')));
    expect(published.map(p=>p.status.result?.status)).toEqual(['PUBLISHED','PUBLISHED']);
    expect(new Set(published.map(p=>p.execution.versionId)).size).toBe(2);
    for(const i of items){const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(i.prepared.execution.targetPath)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(i.input.intent.sha256);}
    const versions=await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`);
    expect((await Promise.all(handles.map(p=>db.status(p,f.proof)))).map(p=>p.status.result)).toEqual(published.map(p=>p.status.result));
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`)).toEqual(versions);
  }finally{await f.close();}
},60000);

it('falls back from an unclaimed conflicting group without losing independent valid originals',async()=>{
  const f=await activeFixture('smallfile-group-fallback','windows',reviewMigration),c=client(f);
  try{
    const items=await clientOriginals(f,c,['same.bin','same.bin','valid.bin','also-valid.bin']);
    const results=await readyGroupCompletions(f,c,items);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(3);
    expect(results.filter(r=>r.status==='rejected')).toMatchObject([{reason:{code:'precondition_failed'}}]);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM catalog_upload_publication_groups`)).toHaveLength(0);
    const rows=await f.admin.withSql(sql=>sql<{id:string;storage_path:string;sha256:string}[]>`SELECT id,storage_path,sha256 FROM resources WHERE parent_id=${f.rootId}`);
    expect(rows).toHaveLength(3);
    for(const row of rows){const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(row.storage_path)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(row.sha256);}
    const rejected=results.findIndex(r=>r.status==='rejected'),retained=fixtureValue(items[rejected]);
    expect((await c.db.status(retained.prepared,f.proof)).status.session.phase).toBe('transport');
    expect(await f.raw.exists(retained.prepared.execution.tempPath)).toBe(true);
  }finally{await f.close();}
},60000);

it('rechecks revoked authority before a group claim and retains all private bytes',async()=>{
  const f=await activeFixture('smallfile-group-revoked','windows',reviewMigration),c=client(f);
  try{
    const items=await clientOriginals(f,c),rename=vi.spyOn(f.raw,'rename');
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);
    const results=await readyGroupCompletions(f,c,items);
    expect(results.every(r=>r.status==='rejected')).toBe(true);expect(rename).not.toHaveBeenCalled();
    expect(await f.admin.withSql(sql=>sql`SELECT upload_effect_state FROM operation_journal WHERE sync_root_id=${f.rootId}`)).toEqual(Array(4).fill({upload_effect_state:'transport'}));
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM catalog_upload_publication_groups`)).toHaveLength(0);
    for(const i of items){const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(i.prepared.execution.tempPath)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(i.input.intent.sha256);}
  }finally{await f.close();}
},60000);

it('retains immutable group history and refuses a rollback that would erase it',async()=>{
  const f=await activeFixture('smallfile-group-history','windows',reviewMigration),c=client(f);
  try{
    const items=await clientOriginals(f,c);publishedGroup(await readyGroupCompletions(f,c,items));
    const history=await f.admin.withSql(sql=>sql`SELECT * FROM catalog_upload_publication_groups`);expect(history).toHaveLength(1);
    await expect(f.runtime.withSql(sql=>sql`DELETE FROM catalog_upload_publication_groups`)).rejects.toThrow();
    await expect(f.runtime.withSql(sql=>sql`UPDATE operation_journal SET upload_publication_group=NULL WHERE sync_root_id=${f.rootId}`)).rejects.toThrow();
    await f.executor.close();
    const down=await fs.readFile(path.join(migrations,'0078_upload_publication_group.down.sql'),'utf8');
    await expect(f.admin.transaction(sql=>sql.unsafe(down))).rejects.toThrow('publication group history must be retained');
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM catalog_upload_publication_groups`)).toEqual(history);
  }finally{await f.close();}
},60000);

it('a lost group claim ACK retains every original and performs no rename',async()=>{
  const f=await activeFixture('smallfile-group-lost-claim','windows',reviewMigration),c=client(f);
  try{
    const items=await clientOriginals(f,c),original=c.db.verifyAndClaimGroup.bind(c.db),rename=vi.spyOn(f.raw,'rename');
    vi.spyOn(c.db,'verifyAndClaimGroup').mockImplementationOnce(async(...args)=>{await original(...args);throw Error('lost group claim ACK');});
    const outcomes=await readyGroupCompletions(f,c,items);
    expect(outcomes.every(r=>r.status==='rejected')).toBe(true);expect(rename).not.toHaveBeenCalled();
    const restarted=client(f);
    for(const i of items){
      const retained=await restarted.files.prepareCatalogUpload(i.input,f.proof,i.prepared.status.session.uploadId);
      expect(retained.status.session.phase).toBe('reconciliation_required');expect(retained.status.session.uploadId).toBe(i.prepared.status.session.uploadId);
      const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(i.prepared.execution.tempPath)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(i.input.intent.sha256);
    }
    await expect(restarted.files.prepareCatalogUpload(f.uploadInput('new.bin',Buffer.from('new')),f.proof)).rejects.toMatchObject({code:'binding_invalid'});
  }finally{await f.close();}
},60000);

it('a lost group member commit ACK returns all original receipts without repeat effects',async()=>{
  const f=await activeFixture('smallfile-group-lost-commit','windows',reviewMigration),c=client(f);
  try{
    const items=await clientOriginals(f,c),original=c.db.commit.bind(c.db),groups=vi.spyOn(c.db,'verifyAndClaimGroup');
    vi.spyOn(c.db,'commit').mockImplementationOnce(async(...args)=>{await original(...args);throw Error('lost member commit ACK');});
    const published=publishedGroup(await readyGroupCompletions(f,c,items));
    expect(groups).toHaveBeenCalledOnce();expect(fixtureValue(groups.mock.calls[0])[0]).toHaveLength(4);
    expect(published.map(p=>p.status.result?.status)).toEqual(Array(4).fill('PUBLISHED'));
    const versions=await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`),rename=vi.spyOn(f.raw,'rename'),write=vi.spyOn(f.raw,'write'),restarted=client(f);
    for(const [n,i]of items.entries()){
      const same=await restarted.files.prepareCatalogUpload(i.input,f.proof,i.prepared.status.session.uploadId);
      expect((await restarted.files.completeCatalogUpload(same,f.proof)).status.result).toEqual(fixtureValue(published[n]).status.result);
      const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(i.prepared.execution.targetPath)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(i.input.intent.sha256);
    }
    expect(rename).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`)).toEqual(versions);
  }finally{await f.close();}
},60000);

it('a response loss after one rename keeps the whole uncertain group before any new publication',async()=>{
  const f=await activeFixture('smallfile-group-lost-rename','windows',reviewMigration),c=client(f);
  let renamed:string|undefined;
  try{
    const items=await clientOriginals(f,c),rename=f.executor.rename.bind(f.executor);
    if(reviewMigration>=89){
      const raw=f.raw.rename.bind(f.raw);
      vi.spyOn(f.raw,'rename').mockImplementationOnce(async(...args)=>{await raw(...args);renamed=args[1];throw Error('lost rename response');});
    }else vi.spyOn(f.executor,'rename').mockImplementationOnce(async(...args)=>{await rename(...args);throw Error('lost rename response');});
    const results=await readyGroupCompletions(f,c,items);
    expect(results.every(r=>r.status==='rejected')).toBe(true);
    for(const i of items){
      expect((await c.db.status(i.prepared,f.proof)).status.session.phase).toBe('reconciliation_required');
      const target=reviewMigration>=89&&i.prepared.execution.targetPath!==renamed?i.prepared.execution.tempPath:i.prepared.execution.targetPath;
      const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(target)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(i.input.intent.sha256);
    }
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${f.rootId}`)).toHaveLength(0);
    await expect(c.files.prepareCatalogUpload(f.uploadInput('new.bin',Buffer.from('new')),f.proof)).rejects.toMatchObject({code:'binding_invalid'});
  }finally{if(renamed)await expect(f.close()).rejects.toThrow('backend_close_unconfirmed');else await f.close();}
},60000);

it('reserves counter headroom for all members before any physical claim',async()=>{
  const f=await activeFixture('smallfile-group-counter','windows',reviewMigration);
  try{
    const items=await originals(f);
    // Test-only qualified setter in this disposable database; production code
    // has no such entry point. Each member fits alone; the pair does not.
    await f.admin.withSql(sql=>sql.unsafe(`CREATE FUNCTION test_group_counter(root uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'UPDATE public.sync_root_clock SET published_seq=9223372036854775804 WHERE root_id=root'; ALTER FUNCTION test_group_counter(uuid) OWNER TO ${f.roles.writerOwner}; GRANT EXECUTE ON FUNCTION test_group_counter(uuid) TO ${f.roles.writerLogin}`));
    await f.writer.withSql(sql=>sql`SELECT test_group_counter(${f.rootId}::uuid)`);
    await expect(claim(f,items.map(i=>i.request))).rejects.toThrow('counter_exhausted');
    for(const i of items)expect((await f.files.inspectCatalogUpload(i.prepared,f.proof)).status.session.phase).toBe('transport');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM catalog_upload_publication_groups`)).toHaveLength(0);
  }finally{await f.close();}
},60000);

it('a foreign pending publication remains a barrier and failed group creation is atomic',async()=>{
  const f=await activeFixture('smallfile-group-barrier','windows',reviewMigration);
  try{
    const items=await originals(f,['a.bin','b.bin','foreign.bin']),other=fixtureValue(items[2]);
    const db=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
    let foreign=await db.prepare(other.input,f.proof,other.prepared.status.session.uploadId);
    foreign=await db.verifyAndClaim(foreign,f.proof,'application/octet-stream',uid());
    await expect(claim(f,items.slice(0,2).map(i=>i.request))).rejects.toThrow('reconciliation_required');
    for(const i of items.slice(0,2))expect((await f.files.inspectCatalogUpload(i.prepared,f.proof)).status.session.phase).toBe('transport');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM catalog_upload_publication_groups`)).toHaveLength(0);
    await db.markUnknown(foreign);
    await expect(claim(f,items.slice(0,2).map(i=>i.request))).rejects.toThrow('binding_invalid');
  }finally{await f.close();}
},60000);

it('rejects overlapping targets without claiming any member',async()=>{
  const f=await activeFixture('smallfile-group-conflict','windows',reviewMigration);
  try{
    const items=await originals(f,['same.bin','same.bin']);
    await expect(claim(f,items.map(i=>i.request))).rejects.toThrow('precondition_failed');
    for(const i of items)expect((await f.files.inspectCatalogUpload(i.prepared,f.proof)).status.session.phase).toBe('transport');
  }finally{await f.close();}
},60000);
