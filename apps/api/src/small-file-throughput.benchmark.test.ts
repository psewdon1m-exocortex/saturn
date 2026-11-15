import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import Fastify from 'fastify';
import {expect,it,vi} from 'vitest';
import {activeFixture,evidence,sha,uid} from './stage3-chat-a.fixture.js';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {SmallBatchRegistry} from '../../../packages/file-core/src/small-batch-registry.js';
import {guardedSyncSmallBatchHttp} from './guarded-sync-small-batch-http.js';

// Explicit isolated-fixture opt-in. Never uses a production/default DB URL.
it.skipIf(process.env.SMALL_FILE_BENCHMARK!=='1')('small-file HTTP publication throughput with independent content and replay verification',async()=>{
  const label=process.env.SMALL_FILE_BENCHMARK_LABEL??'baseline';
  const count=Number(process.env.SMALL_FILE_BENCHMARK_COUNT??256);
  if(!Number.isSafeInteger(count)||count<16||count>100000)throw Error('Invalid benchmark count');
  const f=await activeFixture('smallfile-'+label,'windows',Number(process.env.SMALL_FILE_BENCHMARK_MIGRATION??78)),app=Fastify();
  const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,
    catalogUploadCoordinator:new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true)});
  const registry=new SmallBatchRegistry(f.writer,f.issuer);
  const expected=new Map<string,string>(), saved:{manifest:unknown;type:string;body:Buffer}[]=[];
  const windows:{files:number;elapsedMs:number}[]=[];
  const timings=new Map<string,number[]>();let measuring=false;
  const timed=async<T>(name:string,action:()=>Promise<T>):Promise<T>=>{const capture=measuring,started=performance.now();try{return await action();}finally{if(capture){const samples=timings.get(name)??[];samples.push(performance.now()-started);timings.set(name,samples);}}};
  const withSql=f.writer.withSql.bind(f.writer);
  vi.spyOn(f.writer,'withSql').mockImplementation(action=>withSql(sql=>action(new Proxy(sql,{apply(target,thisArg,args){
    const text=Array.isArray(args[0])?args[0].join('?'):'';
    return text.includes('sync_backend_command')?timed('backend:'+String(args[1]),async()=>await Reflect.apply(target,thisArg,args) as unknown):Reflect.apply(target,thisArg,args) as unknown;
  }}))));
  const transaction=f.writer.transaction.bind(f.writer);
  vi.spyOn(f.writer,'transaction').mockImplementation(action=>transaction(sql=>action(new Proxy(sql,{apply(target,thisArg,args){
    const text=Array.isArray(args[0])?args[0].join('?'):'';
    if(!text.includes('catalog_upload_command'))return Reflect.apply(target,thisArg,args) as unknown;
    const command=text.includes("'batch'")?'batch:'+([...new Set((JSON.parse(String(args[2])) as {command:string}[]).map(entry=>entry.command))].sort().join('+'))
      :text.includes("'verify-claim-group'")?'verify-claim-group':String(args[1]);
    return timed('catalog:'+command,async()=>await Reflect.apply(target,thisArg,args) as unknown);
  }}))));
  const prepare=files.prepareCatalogUpload.bind(files),append=files.appendCatalogUpload.bind(files),complete=files.completeCatalogUpload.bind(files);
  vi.spyOn(files,'prepareCatalogUpload').mockImplementation((...args)=>timed('phase:prepare',()=>prepare(...args)));
  vi.spyOn(files,'appendCatalogUpload').mockImplementation((...args)=>timed('phase:append',()=>append(...args)));
  vi.spyOn(files,'completeCatalogUpload').mockImplementation((...args)=>timed('phase:complete',()=>complete(...args)));
  const prepareSmall=files.prepareSmallCatalogUpload.bind(files),completeSmall=files.completeSmallCatalogUpload.bind(files);
  vi.spyOn(files,'prepareSmallCatalogUpload').mockImplementation((...args)=>timed('phase:prepare-small',()=>prepareSmall(...args)));
  vi.spyOn(files,'completeSmallCatalogUpload').mockImplementation((...args)=>timed('phase:complete-small',()=>completeSmall(...args)));
  try{
    await f.admin.withSql(sql=>sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
    await app.register(guardedSyncSmallBatchHttp,{root:async id=>id===f.rootId?{binding:f.wireBinding,authority:f.issuer,files,batches:registry,admission:f.admission}:undefined});
    await app.listen({host:'127.0.0.1',port:0});
    const base=`http://127.0.0.1:${String((app.server.address() as {port:number}).port)}/sync/v1/roots/${f.rootId}/small-batches/`;
    const post=async(route:string,body:string|Buffer,type:string)=>{
      const response=await fetch(base+route,{method:'POST',headers:{authorization:f.authorization,'content-type':type},body});
      const result=await response.json() as {items:{state:string;code?:string}[]};
      expect(response.status,JSON.stringify(result)).toBe(202);return result;
    };
    const started=performance.now();measuring=true;
    for(let first=0;first<count;first+=16){
      const batchStart=performance.now();
      const entries=Array.from({length:Math.min(16,count-first)},(_,offset)=>{
        const name=`file-${String(first+offset)}.bin`,bytes=Buffer.alloc(48*1024,(first+offset)%251);bytes.writeUInt32LE(first+offset,0);
        expected.set(name,sha(bytes));return {input:f.uploadInput(name,bytes),bytes};
      });
      const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'1',items:entries.map(({input,bytes})=>({operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:uid(),parent_id:f.rootId,name:input.intent.name,size_bytes:String(bytes.length),sha256:sha(bytes),expected:{kind:'absent'}}))};
      await post('prepare',JSON.stringify({manifest,inputs:entries.map(e=>e.input)}),'application/json');
      const boundary='throughput-'+uid(),json=Buffer.from(JSON.stringify(manifest));
      const parts=[Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(json.length)}\r\n\r\n`),json,Buffer.from('\r\n')];
      for(const [i,{bytes}]of entries.entries())parts.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${fixtureValue(manifest.items[i]).operation_id}>\r\nContent-Length: ${String(bytes.length)}\r\n\r\n`),bytes,Buffer.from('\r\n'));
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const request={manifest,type:'multipart/related; boundary='+boundary,body:Buffer.concat(parts)};
      const result=await post('data',request.body,request.type);
      expect(result.items.map(i=>i.state),JSON.stringify(result)).toEqual(entries.map(()=>'PUBLISHED'));
      if(saved.length<2)saved.push(request);
      windows.push({files:entries.length,elapsedMs:performance.now()-batchStart});
    }
    const elapsedMs=performance.now()-started;measuring=false;
    const rows=await f.admin.withSql(sql=>sql<{name:string;storage_path:string;sha256:string;id:string}[]>`SELECT name,storage_path,sha256,id FROM resources WHERE parent_id=${f.rootId} AND type='file'`);
    expect(rows).toHaveLength(count);
    for(const row of rows){const parts:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(row.storage_path)))parts.push(Buffer.from(chunk));expect(sha(Buffer.concat(parts))).toBe(expected.get(row.name));}
    const versions=await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`);
    for(const request of saved)expect((await post('data',request.body,request.type)).items.every(i=>i.state==='PUBLISHED')).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`)).toEqual(versions);
    const sql=await f.admin.withSql(sql=>sql`SELECT query,calls,plans,total_plan_time,mean_plan_time,total_exec_time,mean_exec_time,shared_blks_hit,shared_blks_read,wal_bytes FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY total_exec_time+total_plan_time DESC LIMIT 100`);
    const backend=await f.executor.diagnostics();
    const groupTable=await f.admin.withSql(sql=>sql`SELECT to_regclass('catalog_upload_publication_groups') IS NOT NULL AS available`);
    const groups=groupTable[0]?.available?await f.admin.withSql(sql=>sql`SELECT cardinality(members) AS files,count(*)::int AS groups FROM catalog_upload_publication_groups GROUP BY cardinality(members)`):[];
    const functions=await f.admin.withSql(sql=>sql`SELECT funcname,calls,total_time,self_time FROM pg_stat_user_functions ORDER BY self_time DESC LIMIT 30`);
    const commandTimings=Object.fromEntries([...timings].map(([name,samples])=>{samples.sort((a,b)=>a-b);return[name,{calls:samples.length,totalMs:samples.reduce((a,b)=>a+b,0),p50Ms:samples[Math.floor(samples.length*.5)],p95Ms:samples[Math.floor(samples.length*.95)]}];}));
    await evidence('smallfile-'+label,'result',{count,bytesPerFile:49152,elapsedMs,filesPerSecond:count*1000/elapsedMs,windows,fullShaReadback:true,replayUnchangedVersions:true,scope:'real HTTP + PostgreSQL + durable local storage; excludes native client',commandTimings,backend,groups,functions,sql});
    expect(count*1000/elapsedMs).toBeGreaterThanOrEqual(Number(process.env.SMALL_FILE_BENCHMARK_MIN_FPS??50));
  }finally{await app.close();await f.close();vi.restoreAllMocks();}
},600000);
