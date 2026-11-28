import { fixtureChunks } from './test-values.fixture.js';
import Fastify from 'fastify';
const migration=Number(process.env.SMALL_FILE_JOB_MIGRATION??92);
if(![92,93,94,95,96,97,98,99,101,102,103,104,105].includes(migration))throw Error('Invalid job migration');
import {gzipSync} from 'node:zlib';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {SmallBatchRegistry} from '../../../packages/file-core/src/small-batch-registry.js';
import {guardedSyncSmallBatchHttp} from './guarded-sync-small-batch-http.js';
import {activeFixture,barrier,sha,uid} from './stage3-chat-a.fixture.js';

it('explicit execution HTTP keeps exact plans, individual receipts and a read-only recovery path when disabled',async()=>{
  const f=await activeFixture('smallfile-job-http','windows',migration),app=Fastify();let enabled=true;
  const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,
    catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});
  const batches=new SmallBatchRegistry(f.writer,f.issuer);
  try{
    await app.register(guardedSyncSmallBatchHttp,{executionJobs:true,root:async id=>id===f.rootId?{binding:f.wireBinding,authority:f.issuer,files,batches,admission:f.admission,extensions:enabled?['small-execution-job-v1','metadata-gzip-v1']:['metadata-gzip-v1']}:undefined});
    const origin=await app.listen({host:'127.0.0.1',port:0}),url=origin+'/sync/v1/roots/'+f.rootId+'/small-jobs/';
    const post=async(route:string,body:string|Buffer,type='application/json')=>{
      const response=await fetch(url+route,{method:'POST',headers:{authorization:f.authorization,'content-type':type},body,signal:AbortSignal.timeout(30000)});
      return {status:response.status,body:await response.json() as {code?:string;items:{state:string;status:{session:{uploadId:string}}}[]}};
    };
    const bytes=Buffer.alloc(8192,71),inputs=Array.from({length:16},(_,n)=>f.uploadInput('http-'+String(n)+'.bin',bytes));
    const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'1',items:inputs.map(input=>({operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:f.rootId,name:input.intent.name,size_bytes:String(bytes.length),sha256:sha(bytes),expected:{kind:'absent'}}))};
    const plan=JSON.stringify({inputs,manifest},null,2);
    const wrongBackend=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:'another-backend',catalogRootAdmission:f.admission,
      catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});
    await expect(wrongBackend.prepareSmallExecutionJob(Buffer.from(plan),f.wireBinding,f.proof,'prepare')).rejects.toMatchObject({code:'binding_invalid'});
    expect((await post('status',plan)).status).toBe(404);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal`)).toHaveLength(0);
    const accepted=await post('prepare',plan);expect(accepted.status,JSON.stringify(accepted.body)).toBe(202);
    expect(accepted.body.items.every(i=>i.state==='PENDING')).toBe(true);
    const zipped=await fetch(url+'prepare',{method:'POST',headers:{authorization:f.authorization,'content-type':'application/json','content-encoding':'gzip'},body:gzipSync(plan),signal:AbortSignal.timeout(30000)});
    expect(zipped.status,await zipped.text()).toBe(202);
    expect((await post('prepare',JSON.stringify({inputs,manifest}))).status).toBe(409);
    const boundary='job-'+uid(),json=Buffer.from(plan),parts=[Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(json.length)}\r\n\r\n`),json,Buffer.from('\r\n')];
    for(const item of manifest.items)parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${item.operation_id}>\r\nContent-Length: ${String(bytes.length)}\r\n\r\n`),bytes,Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));const body=Buffer.concat(parts),type='multipart/related; boundary='+boundary;
    const done=await post('data',body,type);expect(done.status,JSON.stringify(done.body)).toBe(202);expect(done.body.items.every(i=>i.state==='PUBLISHED')).toBe(true);
    expect(done.body.items.map(i=>i.status.session.uploadId)).toEqual(accepted.body.items.map(i=>i.status.session.uploadId));
    const rows=await f.admin.withSql(sql=>sql<{storage_path:string}[]>`SELECT storage_path FROM resources WHERE type='file'`);expect(rows).toHaveLength(16);
    for(const row of rows){const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(row.storage_path)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));}
    const versions=await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`);
    enabled=false;expect((await post('prepare',plan)).status).toBe(404);
    expect((await post('status',plan)).body.items.every(i=>i.state==='PUBLISHED')).toBe(true);
    expect((await post('data',body,type)).body.items.every(i=>i.state==='PUBLISHED')).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`)).toEqual(versions);
  }finally{await app.close();await f.close();}
},60000);

it.each(migration>=101?['data','execute']:['data'])('joins started publications after an incomplete final delimiter on %s before releasing the shared HTTP lease',async route=>{
  const f=await activeFixture('smallfile-job-http-tail','windows',migration),app=Fastify(),held=barrier(),release=barrier(),requests={active:0};
  const coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:coordinator});
  let pending:Promise<Response>|undefined;
  try{
    const batches=new SmallBatchRegistry(f.writer,f.issuer);
    await app.register(guardedSyncSmallBatchHttp,{executionJobs:true,requests,root:async id=>id===f.rootId?{binding:f.wireBinding,authority:f.issuer,files,batches,admission:f.admission,extensions:['small-execution-job-v1']}:undefined});
    const origin=await app.listen({host:'127.0.0.1',port:0}),url=origin+'/sync/v1/roots/'+f.rootId+'/small-jobs/';
    const bytes=Buffer.alloc(1024,86),inputs=Array.from({length:16},(_,n)=>f.uploadInput('tail-'+String(n)+'.bin',bytes));
    const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'1',items:inputs.map(input=>({operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:f.rootId,name:input.intent.name,size_bytes:String(bytes.length),sha256:sha(bytes),expected:{kind:'absent'}}))};
    const plan=JSON.stringify({manifest,inputs}),headers={authorization:f.authorization,'content-type':'application/json'};
    if(route==='data'){const accepted=await fetch(url+'prepare',{method:'POST',headers,body:plan});expect(accepted.status).toBe(202);await accepted.arrayBuffer();}
    const boundary='job-'+uid(),json=Buffer.from(plan),parts=[Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(json.length)}\r\n\r\n`),json,Buffer.from('\r\n')];
    for(const item of manifest.items)parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${item.operation_id}>\r\nContent-Length: ${String(bytes.length)}\r\n\r\n`),bytes,Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));const body=Buffer.concat(parts),dataHeaders={...headers,'content-type':'multipart/related; boundary='+boundary};
    const commit=coordinator.commitSet.bind(coordinator),writes=vi.spyOn(f.raw,'write');
    vi.spyOn(coordinator,'commitSet').mockImplementationOnce(async(...args)=>{held.release();await release.entered;return commit(...args);});
    let settled=false;
    pending=fetch(url+route,{method:'POST',headers:dataHeaders,body:body.subarray(0,body.length-5),signal:AbortSignal.timeout(30000)}).finally(()=>{settled=true;});
    await held.entered;await new Promise(resolve=>setTimeout(resolve,50));expect(settled).toBe(false);expect(requests.active).toBe(1);
    release.release();const interrupted=await pending;expect(interrupted.status).toBe(400);await interrupted.arrayBuffer();expect(requests.active).toBe(0);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(15);
    const done=await fetch(url+'data',{method:'POST',headers:dataHeaders,body,signal:AbortSignal.timeout(30000)});
    expect(done.status,await done.text()).toBe(202);expect(writes).toHaveBeenCalledTimes(16);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(16);
  }finally{release.release();await pending?.catch(()=>undefined);vi.restoreAllMocks();await app.close();await f.close();}
},60000);
