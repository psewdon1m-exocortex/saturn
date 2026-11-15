import { fixtureValue } from './test-values.fixture.js';
import Fastify from 'fastify';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {SmallBatchRegistry} from '../../../packages/file-core/src/small-batch-registry.js';
import {guardedSyncSmallBatchHttp} from './guarded-sync-small-batch-http.js';
import {activeFixture,sha,uid} from './stage3-chat-a.fixture.js';

it.each([82,83,84,85,86,87,88])('HTTP retry after a lost post-write response resumes the original chunk on migration %i',async(cutoff)=>{
  const f=await activeFixture('smallfile-chunk-once-http-'+String(cutoff),'windows',cutoff),app=Fastify();
  const client=()=>new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,
    catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});
  let files=client();const batches=new SmallBatchRegistry(f.writer,f.issuer);
  const bytes=Buffer.from('lost response after durable write'),input=f.uploadInput('http.bin',bytes);
  const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'1',items:[{operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:f.rootId,name:'http.bin',size_bytes:String(bytes.length),sha256:sha(bytes),expected:{kind:'absent'}}]};
  const boundary='once-'+uid(),json=Buffer.from(JSON.stringify(manifest));
  const multipart=(content:Buffer)=>Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(json.length)}\r\n\r\n`),json,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${input.intent.idempotencyKey}>\r\nContent-Length: ${String(content.length)}\r\n\r\n`),content,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  try{
    await app.register(guardedSyncSmallBatchHttp,{root:async id=>id===f.rootId?{binding:f.wireBinding,authority:f.issuer,files,batches,admission:f.admission}:undefined});
    const origin=await app.listen({host:'127.0.0.1',port:0}),url=origin+'/sync/v1/roots/'+f.rootId+'/small-batches/';
    const post=async(route:string,body:string|Buffer,type:string)=>{
      const response=await fetch(url+route,{method:'POST',headers:{authorization:f.authorization,'content-type':type},body,signal:AbortSignal.timeout(15000)});
      return {code:response.status,value:await response.json() as {items?:{state:string;status?:{session:{uploadId:string}}}[]}};
    };
    expect((await post('prepare',JSON.stringify({manifest,inputs:[input]}),'application/json')).code).toBe(202);
    const raw=vi.spyOn(f.raw,'write'),once=f.executor.writeOnce.bind(f.executor);
    vi.spyOn(f.executor,'writeOnce').mockImplementationOnce(async(...args)=>{await once(...args);throw Error('lost write response');});
    const first=await post('data',multipart(bytes),'multipart/related; boundary='+boundary);
    expect(first).toMatchObject({code:202,value:{items:[{state:'UNRESOLVED'}]}});
    const pending=fixtureValue((await f.admin.withSql(sql=>sql<{id:string;upload_transfer_backend_task:string}[]>`SELECT id,upload_transfer_backend_task FROM operation_journal WHERE sync_root_id=${f.rootId} AND upload_execution IS NOT NULL`))[0]);
    expect(pending.upload_transfer_backend_task).toBeTruthy();
    files=client();
    const resumed=await post('data',multipart(bytes),'multipart/related; boundary='+boundary);
    expect(resumed).toMatchObject({code:202,value:{items:[{state:'PUBLISHED',status:{session:{uploadId:pending.id}}}]}});
    expect(raw).toHaveBeenCalledTimes(1);
    const versions=await f.admin.withSql(sql=>sql`SELECT id FROM file_versions WHERE resource_id IN(SELECT id FROM resources WHERE parent_id=${f.rootId} AND type='file')`);expect(versions).toHaveLength(1);
    const row=fixtureValue((await f.admin.withSql(sql=>sql<{storage_path:string}[]>`SELECT storage_path FROM resources WHERE parent_id=${f.rootId} AND name='http.bin'`))[0]);
    const chunks=[];for await(const chunk of await f.raw.openRead(row.storage_path))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));
    expect((await post('data',multipart(Buffer.alloc(bytes.length,33)),'multipart/related; boundary='+boundary)).code).toBe(400);
    expect((await post('data',multipart(bytes),'multipart/related; boundary='+boundary)).value.items?.[0]?.state).toBe('PUBLISHED');
    expect(raw).toHaveBeenCalledTimes(1);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions WHERE resource_id IN(SELECT id FROM resources WHERE parent_id=${f.rootId} AND type='file')`)).toEqual(versions);
  }finally{await app.close();vi.restoreAllMocks();await f.close();}
},60000);
