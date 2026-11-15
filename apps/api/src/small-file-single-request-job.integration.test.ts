import { fixtureChunks } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {SmallBatchRegistry} from '../../../packages/file-core/src/small-batch-registry.js';
import {guardedSyncSmallBatchHttp} from './guarded-sync-small-batch-http.js';
import {activeFixture,migrations,sha,uid} from './stage3-chat-a.fixture.js';

it('accepts and executes exact originals in one request, preserves replay and rollback readers',async()=>{
  const migration=Number(process.env.SMALL_FILE_SINGLE_REQUEST_MIGRATION??101);const f=await activeFixture('smallfile-single-request','windows',migration),app=Fastify();let enabled=true;
  const coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:coordinator});
  try{
    await app.register(guardedSyncSmallBatchHttp,{executionJobs:true,root:async()=>({binding:f.wireBinding,authority:f.issuer,files,batches:new SmallBatchRegistry(f.writer,f.issuer),admission:f.admission,extensions:enabled?['small-execution-job-v1']:[]})});
    const url='/sync/v1/roots/'+f.rootId+'/small-jobs/',bytes=Buffer.alloc(49152,71),inputs=Array.from({length:16},(_,n)=>f.uploadInput('single-'+String(n),bytes));
    const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'1',items:inputs.map(input=>({operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:f.rootId,name:input.intent.name,size_bytes:String(bytes.length),sha256:sha(bytes),expected:{kind:'absent'}}))};
    const wire=Buffer.from(JSON.stringify({manifest,inputs})),boundary='job-'+uid();
    const parts=[Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(wire.length)}\r\n\r\n`),wire,Buffer.from('\r\n')];
    for(const item of manifest.items)parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${item.operation_id}>\r\nContent-Length: ${String(bytes.length)}\r\n\r\n`),bytes,Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));const body=Buffer.concat(parts);
    const post=(route:string,payload=body,type='multipart/related; boundary='+boundary)=>app.inject({method:'POST',url:url+route,headers:{authorization:f.authorization,'content-type':type},payload});
    expect((await post('data')).statusCode).toBe(404); // old command still requires prepare
    const commands=vi.spyOn(f.writer,'catalogUploadBatch');
    const done=await post('execute');expect(done.statusCode,done.body).toBe(202);
    expect(done.json<{items:{state:string}[]}>().items.every(i=>i.state==='PUBLISHED')).toBe(true);
    expect(commands.mock.calls.filter(([c])=>['accept-job','start-job','execute-job'].includes(c)).map(([c])=>c)).toEqual(['execute-job']);
    const originals=await f.admin.withSql(sql=>sql`SELECT id,upload_intent_hash FROM operation_journal ORDER BY id`),versions=await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`);
    const writes=vi.spyOn(f.raw,'write'),renames=vi.spyOn(f.raw,'rename');
    expect((await post('execute')).statusCode).toBe(202);expect(writes).not.toHaveBeenCalled();expect(renames).not.toHaveBeenCalled();
    for(const row of await f.admin.withSql(sql=>sql<{storage_path:string}[]>`SELECT storage_path FROM resources WHERE type='file'`)){
      const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(row.storage_path)))chunks.push(Buffer.from(chunk));expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));
    }
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);
    expect((await post('execute')).statusCode).toBe(401);
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=true WHERE sync_root_id=${f.rootId}`);
    enabled=false;expect((await post('execute')).statusCode).toBe(404);
    expect((await post('status',wire,'application/json')).statusCode).toBe(200);
    expect(await f.admin.withSql(sql=>sql`SELECT id,upload_intent_hash FROM operation_journal ORDER BY id`)).toEqual(originals);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`)).toEqual(versions);
    await f.executor.close();if(migration===101)await f.admin.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0101_single_request_job.down.sql'),'utf8')));
    expect((await post('status',wire,'application/json')).statusCode).toBe(200);
  }finally{vi.restoreAllMocks();await app.close();await f.close();}
},60000);

