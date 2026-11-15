import { fixtureValue } from './test-values.fixture.js';
import Fastify from 'fastify';
import {expect,it} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {SmallBatchRegistry} from '../../../packages/file-core/src/small-batch-registry.js';
import {guardedSyncSmallBatchHttp} from './guarded-sync-small-batch-http.js';
import {activeFixture,sha,uid} from './stage3-chat-a.fixture.js';

it('two scaled requests share the four publication slots without self-inflicted admission failures',async()=>{
  const f=await activeFixture('smallfile-publication-capacity','windows',88),app=Fastify();
  const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,
    catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});
  const batches=new SmallBatchRegistry(f.writer,f.issuer),expected=new Map<string,string>();
  try{
    await app.register(guardedSyncSmallBatchHttp,{root:async id=>id===f.rootId?{binding:f.wireBinding,authority:f.issuer,files,batches,admission:f.admission,extensions:['scale-transfer-v2']}:undefined});
    const origin=await app.listen({host:'127.0.0.1',port:0}),url=origin+'/sync/v1/roots/'+f.rootId+'/small-batches/';
    const post=async(route:string,body:string|Buffer,type:string)=>{
      const response=await fetch(url+route,{method:'POST',headers:{authorization:f.authorization,'content-type':type},body,signal:AbortSignal.timeout(30000)});
      const result=await response.json() as {items:{state:string;code?:string}[]};expect(response.status,JSON.stringify(result)).toBe(202);return result;
    };
    const requests=[];
    for(let batch=0;batch<2;batch++){
      const entries=Array.from({length:16},(_,n)=>{const bytes=Buffer.alloc(48*1024,batch*16+n),name=`capacity-${String(batch)}-${String(n)}.bin`;expected.set(name,sha(bytes));return {bytes,input:f.uploadInput(name,bytes)};});
      const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'1',items:entries.map(({input,bytes})=>({operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:f.rootId,name:input.intent.name,size_bytes:String(bytes.length),sha256:sha(bytes),expected:{kind:'absent'}}))};
      await post('prepare',JSON.stringify({manifest,inputs:entries.map(e=>e.input)}),'application/json');
      const boundary='capacity-'+uid(),json=Buffer.from(JSON.stringify(manifest));
      const parts=[Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(json.length)}\r\n\r\n`),json,Buffer.from('\r\n')];
      for(const [n,{bytes}]of entries.entries())parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${fixtureValue(manifest.items[n]).operation_id}>\r\nContent-Length: ${String(bytes.length)}\r\n\r\n`),bytes,Buffer.from('\r\n'));
      parts.push(Buffer.from(`--${boundary}--\r\n`));requests.push({body:Buffer.concat(parts),type:'multipart/related; boundary='+boundary});
    }
    const replies=await Promise.all(requests.map(r=>post('data',r.body,r.type)));
    for(const reply of replies)expect(reply.items.map(i=>i.state),JSON.stringify(reply)).toEqual(Array(16).fill('PUBLISHED'));
    const rows=await f.admin.withSql(sql=>sql<{name:string;storage_path:string;id:string}[]>`SELECT id,name,storage_path FROM resources WHERE parent_id=${f.rootId} AND type='file'`);
    expect(rows).toHaveLength(32);
    for(const row of rows){const chunks=[];for await(const chunk of await f.raw.openRead(row.storage_path))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(expected.get(row.name));}
    const versions=await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`);expect(versions).toHaveLength(32);
    for(const request of requests)expect((await post('data',request.body,request.type)).items.every(i=>i.state==='PUBLISHED')).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`)).toEqual(versions);
  }finally{await app.close();await f.close();}
},60000);
