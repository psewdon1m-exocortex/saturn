import { readySmallPublications,publishedSmallGroup } from './publication-ready.fixture.js';
import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,evidence,migrations,sha,uid} from './stage3-chat-a.fixture.js';

const migration=Number(process.env.SMALL_FILE_SET_MIGRATION??91);
if(![89,91,92,93,99].includes(migration))throw Error('Invalid set publication migration');
type Fixture=Awaited<ReturnType<typeof activeFixture>>;
type Result={execution:{nodeId:string;versionId:string};session:{uploadId:string;phase:string};result:{publicationReceipt:{uploadId:string;versionId:string;sha256:string};firstSeq:string;lastSeq:string};replayed:boolean};
async function ready(f:Fixture,count=4){
  const items=[];
  for(let n=0;n<count;n++){
    const bytes=Buffer.alloc(4096+n,n+1),input=f.uploadInput('set-'+String(n)+'.bin',bytes);
    let p=await f.files.prepareCatalogUpload(input,f.proof);
    p=await f.files.appendCatalogUpload(p,f.proof,'0',bytes);
    items.push({bytes,input,p,request:{input,originalUploadId:p.status.session.uploadId,claimToken:uid(),mimeType:'application/octet-stream'}});
  }
  const credential=f.issuer.deviceCredential(f.proof,f.rootId);
  const requests=items.map(i=>i.request);
  await f.writer.withSql(sql=>sql`SELECT catalog_upload_command('verify-claim-group','{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(requests)}::text::jsonb)`);
  for(const item of items)await f.executor.rename(item.p.execution.tempPath,item.p.execution.targetPath);
  return items;
}
async function publish(f:Fixture,items:Awaited<ReturnType<typeof ready>>,override?:unknown){
  const credential=f.issuer.deviceCredential(f.proof,f.rootId);
  const payload=override??items.map(({input,p})=>({input,originalUploadId:p.status.session.uploadId,mimeType:'application/octet-stream'}));
  try{return await f.writer.withSql(async sql=>fixtureValue((await sql<{value:Result[]}[]>`SELECT catalog_upload_command('publish-set','{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]).value);}
  catch(error){const e=error as {message?:string;where?:string;code?:string};await evidence('smallfile-set-diagnostics',uid(),{message:e.message,where:e.where,code:e.code});throw error;}
}
const history=(f:Fixture)=>f.admin.withSql(sql=>sql`SELECT id,upload_intent,upload_intent_hash,upload_execution,upload_claim_token FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`);
const projections=(f:Fixture)=>f.admin.withSql(sql=>sql`SELECT id,upload_effect_state,sync_result FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`);

it('publishes a ready set as individual immutable receipts and a contiguous exact final namespace',async()=>{
  const f=await activeFixture('smallfile-set-publish','windows',migration);
  try{
    const items=await ready(f),before=await history(f),result=await publish(f,items);
    expect(result.map(r=>r.session.phase)).toEqual(Array(4).fill('published'));
    expect(result.map(r=>r.result.publicationReceipt.uploadId)).toEqual(items.map(i=>i.p.status.session.uploadId));
    expect(result.map(r=>r.result.publicationReceipt.versionId)).toEqual(items.map(i=>i.p.execution.versionId));
    expect(result.map(r=>r.result.publicationReceipt.sha256)).toEqual(items.map(i=>i.input.intent.sha256));
    expect(await history(f)).toEqual(before);
    const versions=await f.admin.withSql(sql=>sql`SELECT * FROM file_versions ORDER BY id`);
    expect(versions).toHaveLength(4);
    for(const item of items){const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(item.p.execution.targetPath)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(item.input.intent.sha256);}
    const changes=await f.admin.withSql(sql=>sql<{seq:string;node_id:string;document:{description:{size_bytes:string;version:string}}}[]>`SELECT seq::text,node_id,document FROM sync_root_changes WHERE root_id=${f.rootId} ORDER BY seq`);
    expect(changes.map(c=>Number(c.seq))).toEqual(Array.from({length:changes.length},(_,n)=>n+1));
    const root=await f.admin.withSql(sql=>sql<{size:string;version:string}[]>`SELECT size_bytes::text AS size,metadata_version::text AS version FROM resources WHERE id=${f.rootId}`);
    expect(fixtureValue(root[0]).size).toBe(String(items.reduce((sum,i)=>sum+i.bytes.length,0)));
    expect(changes.filter(c=>c.node_id===f.rootId).at(-1)?.document.description).toMatchObject({size_bytes:fixtureValue(root[0]).size,version:fixtureValue(root[0]).version});
    const replay=await publish(f,items);
    expect(replay.map(r=>r.result)).toEqual(result.map(r=>r.result));expect(replay.every(r=>r.replayed)).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT * FROM file_versions ORDER BY id`)).toEqual(versions);
    expect(await f.admin.withSql(sql=>sql`SELECT seq::text,node_id,document FROM sync_root_changes WHERE root_id=${f.rootId} ORDER BY seq`)).toEqual(changes);
  }finally{await f.close();}
},60000);

it('rejects a changed last original atomically and retains every already stored file',async()=>{
  const f=await activeFixture('smallfile-set-invalid','windows',migration);
  try{
    const items=await ready(f),before=await projections(f);
    const payload=items.map(({input,p},n)=>({input:n===3?{...input,intent:{...input.intent,name:'changed.bin'}}:input,originalUploadId:p.status.session.uploadId,mimeType:'application/octet-stream'}));
    await expect(publish(f,items,payload)).rejects.toThrow('operation_reused');
    expect(await projections(f)).toEqual(before);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${f.rootId}`)).toHaveLength(0);
    for(const item of items)expect(await f.raw.exists(item.p.execution.targetPath)).toBe(true);
    expect((await publish(f,items)).every(r=>r.session.phase==='published')).toBe(true);
  }finally{await f.close();}
},60000);

it('rechecks authority and rejects direct runtime publication without losing pending originals',async()=>{
  const f=await activeFixture('smallfile-set-authority','windows',migration);
  try{
    const items=await ready(f),before=await projections(f);
    await expect(f.runtime.withSql(sql=>sql`SELECT catalog_upload_publish_set_v1('{}'::jsonb,'[]'::jsonb)`)).rejects.toThrow();
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);
    await expect(publish(f,items)).rejects.toThrow('authorization_changed');
    expect(await projections(f)).toEqual(before);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
  }finally{await f.close();}
},60000);

it('rejects duplicate, incomplete, foreign and malformed sets before any catalog write',async()=>{
  const f=await activeFixture('smallfile-set-boundaries','windows',migration);
  try{
    const items=await ready(f),before=await projections(f),payload=items.map(({input,p})=>({input,originalUploadId:p.status.session.uploadId,mimeType:'application/octet-stream'}));
    const invalid=[[],null,{},[...payload,payload[0]],payload.slice(0,3),[payload[0],payload[0],payload[2],payload[3]],
      payload.map((p,n)=>n===3?{...p,input:{...p.input,intent:{...p.input.intent,rootId:uid()}}}:p),
      payload.map((p,n)=>n===3?{...p,originalUploadId:uid()}:p),
      payload.map((p,n)=>n===3?{...p,input:{...p.input,bindingVersion:uid()}}:p),
      payload.map((p,n)=>n===3?{...p,mimeType:null}:p),payload.map((p,n)=>n===3?{...p,extra:true}:p)];
    for(const candidate of invalid){
      // Preserve a literal null test; publish's optional override otherwise uses its default.
      if(candidate===null){const credential=f.issuer.deviceCredential(f.proof,f.rootId);await expect(f.writer.withSql(sql=>sql`SELECT catalog_upload_command('publish-set','{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,'null'::jsonb)`)).rejects.toThrow();}
      else await expect(publish(f,items,candidate)).rejects.toThrow();
      expect(await projections(f)).toEqual(before);
    }
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    expect((await publish(f,items)).every(r=>r.session.phase==='published')).toBe(true);
  }finally{await f.close();}
},60000);

function composed(f:Fixture){
  const database=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  return {database,files:new FileService(new PostgresFileRepository(f.runtime),f.executor,
    {uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:database})};
}
async function smallReady(f:Fixture,c:ReturnType<typeof composed>){
  const bytes=Buffer.alloc(8192,123),inputs=[0,1,2,3].map(n=>f.uploadInput('runtime-set-'+String(n)+'.bin',bytes));
  const prepared=await Promise.all(inputs.map(input=>c.files.prepareSmallCatalogUpload(input,f.proof)));
  return {bytes,inputs,prepared};
}
it('uses the set writer through FileService and recovers a lost commit response by exact original status',async()=>{
  const f=await activeFixture('smallfile-set-runtime-lost','windows',migration),c=composed(f);
  try{
    const {bytes,inputs,prepared}=await smallReady(f,c),original=c.database.commitSet.bind(c.database),writes=vi.spyOn(f.raw,'write');
    const set=vi.spyOn(c.database,'commitSet').mockImplementationOnce(async(...args)=>{await original(...args);throw Error('lost set commit ACK');});
    const outcomes=publishedSmallGroup(await readySmallPublications(f,c,prepared.map(prepared=>({prepared,bytes}))));
    expect(set).toHaveBeenCalledTimes(1);expect(outcomes.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);expect(writes).toHaveBeenCalledTimes(4);
    const before=await projections(f),restarted=composed(f);
    for(const input of inputs){const p=await restarted.files.prepareSmallCatalogUpload(input,f.proof);expect((await restarted.files.completeSmallCatalogUpload(p,f.proof,bytes)).status.result?.status).toBe('PUBLISHED');}
    expect(await projections(f)).toEqual(before);expect(writes).toHaveBeenCalledTimes(4);
    for(const p of outcomes){const chunks:Buffer[]=[];for await(const b of fixtureChunks(await f.raw.openRead(p.execution.targetPath)))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));}
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('retains all original identities and physical files when authority changes after rename',async()=>{
  const f=await activeFixture('smallfile-set-runtime-revoked','windows',migration),c=composed(f);
  try{
    const {bytes,prepared}=await smallReady(f,c),before=await history(f),original=c.database.commitSet.bind(c.database);
    vi.spyOn(c.database,'commitSet').mockImplementationOnce(async(...args)=>{await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);return original(...args);});
    const outcomes=await readySmallPublications(f,c,prepared.map(prepared=>({prepared,bytes})));
    expect(outcomes.every(r=>r.status==='rejected')).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    expect((await projections(f)).every(r=>r.upload_effect_state==='reconciliation_required')).toBe(true);
    const after=await history(f);expect(after.map(r=>({...r,upload_claim_token:null}))).toEqual(before);
    for(const p of prepared)expect(await f.raw.exists(p.execution.targetPath)).toBe(true);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('keeps old databases on the previous publication path',async()=>{
  const f=await activeFixture('smallfile-set-legacy','windows',89),c=composed(f);
  try{
    const {bytes,prepared}=await smallReady(f,c),set=vi.spyOn(c.database,'commitSet');
    expect(await c.database.supportsPublicationSets()).toBe(false);
    expect((await Promise.all(prepared.map(p=>c.files.completeSmallCatalogUpload(p,f.proof,bytes)))).every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
    expect(set).not.toHaveBeenCalled();expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(4);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('rolls back only while stopped and preserves published results for the former reader',async()=>{
  const f=await activeFixture('smallfile-set-rollback','windows',migration);
  try{
    const items=await ready(f),results=await publish(f,items),before=await projections(f);
    const down=await fs.readFile(path.join(migrations,'0091_catalog_publish_set.down.sql'),'utf8');
    await expect(f.admin.transaction(sql=>sql.unsafe(down))).rejects.toThrow('backend must be stopped');
    await f.executor.close();await f.admin.transaction(sql=>sql.unsafe(down));
    expect(await projections(f)).toEqual(before);
    for(const [n,item] of items.entries()){const p=await f.files.prepareCatalogUpload(item.input,f.proof,item.p.status.session.uploadId);expect(p.status.result).toEqual(fixtureValue(results[n]).result);}
    expect(await f.admin.withSql(sql=>sql`SELECT to_regprocedure('public.catalog_upload_publish_set_v1(jsonb,jsonb)') AS helper`)).toEqual([{helper:null}]);
  }finally{await f.close();}
},60000);
