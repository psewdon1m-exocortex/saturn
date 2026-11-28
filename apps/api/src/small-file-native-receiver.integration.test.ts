import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import Fastify from 'fastify';
import {it,vi} from 'vitest';
import {Database} from '@saturn/database';
import {activeFixture,fixtureManifest} from './stage3-chat-a.fixture.js';
import {completionAdopt} from './completion-adoption.fixture.js';
import {guardedSyncRuntimeHttp} from './guarded-sync-runtime-http.js';
import {smallFilePhaseTrace} from './small-file-phase-trace.fixture.js';

// Independent receiver for the actual Windows service on an owned NTFS VHDX.
// Full qualified runtime/profile/verifier/deadline path, no synthetic capabilities.
it.skipIf(process.env.SMALL_FILE_NATIVE_RECEIVER!=='1')('qualified receiver for isolated native throughput and restart',async()=>{
  const stopBudget=Number(process.env.SMALL_FILE_NATIVE_STOP_TIMEOUT_MS??3540000);
  if(!Number.isSafeInteger(stopBudget)||stopBudget<=0||stopBudget>3540000)throw Error('Invalid native receiver stop budget');
  // The existing one-hour test watchdog retains at least one minute for joins.
  const stopDeadline=performance.now()+stopBudget;
  const fixtureFile=process.env.STAGE3_CHAT_A_FIXTURE;
  const evidencePath=process.env.STAGE3_CHAT_A_EVIDENCE;
  const requestedOutput=process.env.SMALL_FILE_NATIVE_EVIDENCE;
  if(!fixtureFile||!evidencePath||!requestedOutput||process.env.COMPLETION_SHARED_BACKEND
    ||![fixtureFile,evidencePath,requestedOutput].every(value=>path.isAbsolute(value)))throw Error('Own local native receiver output required');
  const runRoot=await fs.realpath(path.dirname(fixtureFile));
  if(path.relative(path.dirname(fixtureFile),runRoot)!==''||!(await fs.lstat(fixtureFile)).isFile())
    throw Error('Own local native receiver manifest required');
  const evidence=await fs.realpath(evidencePath);
  const output=path.join(evidence,'small-file-native-receiver');
  // The controller places the admitted PG manifest next to its private
  // fixtures and evidence directories. Admit one fresh receiver output there.
  if(path.relative(runRoot,evidence)!=='evidence'||path.relative(evidencePath,evidence)!==''
    ||path.relative(output,requestedOutput)!=='')throw Error('Own local native receiver output required');
  const ownedFixture=await fixtureManifest();
  const fixtures=await fs.realpath(ownedFixture.fixtureDirectory);
  if(!path.isAbsolute(ownedFixture.fixtureDirectory)||path.relative(runRoot,fixtures)!=='fixtures'
    ||path.relative(ownedFixture.fixtureDirectory,fixtures)!=='')throw Error('Own local native receiver fixture directory required');
  const backendMode=process.env.SMALL_FILE_NATIVE_BACKEND_MODE??'atomic';
  if(!['atomic','transaction'].includes(backendMode))throw Error('Invalid comparison mode');
  const catalogMode=process.env.SMALL_FILE_NATIVE_CATALOG_MODE??'atomic';
  if(!['atomic','transaction'].includes(catalogMode))throw Error('Invalid catalog comparison mode');
  const migration=Number(process.env.SMALL_FILE_NATIVE_MIGRATION??'89');
  if(![88,89,91,92,93,94,95,96,97,98,99,101,102,103,104,105,126].includes(migration))throw Error('Invalid native migration comparison');
  const phaseTrace=process.env.SMALL_FILE_NATIVE_TRACE==='1'?smallFilePhaseTrace():undefined;
  // Test-only previous catalog transaction path for sequential A/B measurement.
  if(catalogMode==='transaction')vi.spyOn(Database.prototype,'catalogUploadBatch').mockImplementation(function(this:Database,command,credential,payload){
    return this.transaction(async sql=>{
      await sql`SELECT set_config('statement_timeout','2s',true),set_config('lock_timeout','2s',true),set_config('idle_in_transaction_session_timeout','2s',true)`;
      return(await sql<{value:unknown}[]>`SELECT public.catalog_upload_command(${command},'{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]?.value;
    });
  });
  // Benchmark-only previous command path; no production environment switch.
  if(backendMode==='transaction')vi.spyOn(Database.prototype,'backendCommand').mockImplementation(function(this:Database,command,identity,payload){
    return this.transaction(async sql=>{
      await sql`SELECT set_config('lock_timeout','2s',true),set_config('statement_timeout','3s',true)`;
      return(await sql<{value:unknown}[]>`SELECT public.sync_backend_command(${command},${JSON.stringify(identity)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]?.value;
    });
  });
  await fs.mkdir(output,{mode:0o700});
  const f=await activeFixture('smallfile-native-receiver','windows',migration),app=Fastify();
  let adopted:Awaited<ReturnType<typeof completionAdopt>>|undefined,loseResponse=false,lostResponses=0;
  let runtimeDatabase:Database|undefined;
  const batchOutcomes:unknown[]=[];
  const timings=new Map<string,{calls:number;elapsedMs:number;errors:number}>(),starts=new WeakMap<object,number>();
  try{
    await f.admin.withSql(sql=>sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
    const sqlProfiling=(await f.admin.withSql(sql=>sql`SELECT current_setting('pg_stat_statements.track') AS statements,current_setting('track_functions') AS functions,current_setting('track_io_timing') AS io_timing`))[0];
    const commitBatching=fixtureValue((await f.admin.withSql(sql=>sql<{present:boolean}[]>`SELECT to_regprocedure('public.sync_maintenance_backend_commands(jsonb)') IS NOT NULL AS present`))[0]).present;
    const runtimeUrl=new URL(f.url);runtimeUrl.username=f.roles.runtimeRole;
    runtimeDatabase=new Database(runtimeUrl.toString(),{max:10,maintenanceBarrier:true});
    const runtimeMaintenance=await runtimeDatabase.withSharedMaintenance(async()=>Number((await f.admin.withSql(sql=>sql<{count:string}[]>`
      SELECT count(*)::text AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE a.datname=current_database() AND a.usename=${f.roles.runtimeRole} AND l.locktype='advisory'
        AND l.objid=1397967206 AND l.mode='ShareLock' AND l.granted`))[0]?.count)>0);
    if(!runtimeMaintenance)throw Error('Production runtime maintenance admission absent');
    adopted=await completionAdopt({...f,runtime:runtimeDatabase},{scaleTransfer:true,executionJobs:migration>=92&&process.env.SMALL_FILE_NATIVE_JOBS!=='0'});const runtime=adopted.runtime;
    app.addHook('onRequest',async request=>{starts.set(request,performance.now());});
    app.addHook('onResponse',async(request,reply)=>{
      const name=request.routeOptions.url??'unmatched',prior=timings.get(name)??{calls:0,elapsedMs:0,errors:0};
      prior.calls++;prior.elapsedMs+=performance.now()-(starts.get(request)??performance.now());prior.errors+=reply.statusCode>=400?1:0;timings.set(name,prior);
    });
    app.addHook('onSend',async(request,reply,payload)=>{
      if((request.url.endsWith('/small-batches/data')||request.url.endsWith('/small-jobs/data'))&&reply.statusCode===202&&batchOutcomes.length<512){
        const result=JSON.parse(String(payload)) as {items:{state:string;code?:string;status?:{session?:{phase?:string}}}[]};
        const outcomes:Record<string,number>={};for(const item of result.items){const key=[item.state,item.code??'',item.status?.session?.phase??''].join(':');outcomes[key]=(outcomes[key]??0)+1;}
        batchOutcomes.push({at:new Date().toISOString(),items:result.items.length,outcomes});
      }
      if(loseResponse&&(request.url.endsWith('/small-batches/data')||request.url.endsWith('/small-jobs/data')||request.url.endsWith('/small-jobs/execute'))&&reply.statusCode===202){loseResponse=false;lostResponses++;reply.raw.destroy();}
      return payload;
    });
    // Use the production composition, including its request maintenance lease.
    await app.register(guardedSyncRuntimeHttp,{runtime,database:runtimeDatabase});
    app.post('/__smallfile/lose-response',async()=>{loseResponse=true;return {armed:true};});
    app.get('/__smallfile/originals',async()=>({originals:await f.admin.withSql(sql=>sql`
      SELECT id,upload_id,upload_intent_hash,upload_intent FROM operation_journal
      WHERE sync_root_id=${f.rootId} AND upload_intent IS NOT NULL ORDER BY id`)}));
    const rows=()=>f.admin.withSql(sql=>sql<{id:string;relative_path:string;storage_path:string;sha256:string;size_bytes:string;current_version_id:string;version_count:number}[]>`
      WITH RECURSIVE tree AS(
        SELECT id,type,name,storage_path,sha256,size_bytes,current_version_id,''::text relative_path FROM resources WHERE id=${f.rootId}
        UNION ALL SELECT r.id,r.type,r.name,r.storage_path,r.sha256,r.size_bytes,r.current_version_id,CASE WHEN t.relative_path='' THEN r.name ELSE t.relative_path||'/'||r.name END
        FROM resources r JOIN tree t ON r.parent_id=t.id WHERE r.status='active'
      ) SELECT t.*,(SELECT count(*)::int FROM file_versions v WHERE v.resource_id=t.id) AS version_count FROM tree t WHERE type='file' ORDER BY relative_path`);
    app.get('/__smallfile/progress',async()=>{
      const result=await f.admin.withSql(sql=>sql`WITH RECURSIVE tree AS(SELECT id,type,size_bytes FROM resources WHERE id=${f.rootId}
        UNION ALL SELECT r.id,r.type,r.size_bytes FROM resources r JOIN tree t ON r.parent_id=t.id WHERE r.status='active')
        SELECT count(*) FILTER(WHERE type='file')::int AS files,coalesce(sum(size_bytes) FILTER(WHERE type='file'),0)::text AS bytes FROM tree`);
      return {...result[0],lostResponses};
    });
    app.get('/__smallfile/readback',async()=>{
      const files=[];
      for(const row of await rows()){
        const hash=createHash('sha256');let size=0;
        for await(const chunk of fixtureChunks(await f.raw.openRead(row.storage_path))){hash.update(chunk);size+=chunk.length;}
        files.push({path:row.relative_path,id:row.id,versionId:row.current_version_id,versionCount:row.version_count,sha256:hash.digest('hex'),catalogSha256:row.sha256,size,catalogSize:row.size_bytes});
      }
      return {files,lostResponses};
    });
    const origin=await app.listen({host:'127.0.0.1',port:0}),scope=fixtureValue(await runtime.scope(f.rootId));
    await fs.writeFile(path.join(output,'client.private.json'),JSON.stringify({origin:origin+'/',authorization:f.authorization,deviceId:f.uploadInput('config',Buffer.alloc(0)).intent.deviceId,binding:scope.binding,rootName:fixtureValue(f.uploadInput('config',Buffer.alloc(0)).intent.parentTopology[0]).name}),{mode:0o600,flag:'wx'});
    await fs.writeFile(path.join(output,'ready.json'),JSON.stringify({origin,rootId:f.rootId,database:'stage3_'+f.suffix,fullGuardedRuntime:true,productionHttpComposition:true,runtimeMaintenanceVerified:runtimeMaintenance,runtimePoolMaximum:10,localBackend:true,migration,backendMode,catalogMode,sqlProfiling,commitBatching}),{flag:'wx'});
    let stopRequested=false;
    while(performance.now()<stopDeadline){
      try{await fs.access(path.join(output,'stop'));stopRequested=true;break;}
      catch(error){if(!(error instanceof Error)||!('code'in error)||error.code!=='ENOENT')throw error instanceof Error?error:new Error('Native receiver stop check failed',{cause:error});await delay(250);}
    }
    if(!stopRequested)throw Error('Native receiver stop deadline exceeded');
    const sql=await f.admin.withSql(sql=>sql`SELECT query,calls,total_exec_time,mean_exec_time,wal_bytes FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY total_exec_time DESC LIMIT 100`);
    const functions=await f.admin.withSql(sql=>sql`SELECT funcname,calls,total_time,self_time FROM pg_stat_user_functions ORDER BY self_time DESC LIMIT 30`);
    const backendTasks=await f.admin.withSql(sql=>sql`SELECT command,state,payload->>'schema' AS schema,count(*)::int AS count FROM sync_backend_tasks GROUP BY command,state,payload->>'schema' ORDER BY command,state,payload->>'schema'`);
    await fs.writeFile(path.join(output,'server-result.json'),JSON.stringify({migration,backendMode,catalogMode,sqlProfiling,commitBatching,productionHttpComposition:true,runtimeMaintenanceVerified:runtimeMaintenance,timings:Object.fromEntries(timings),batchOutcomes,lostResponses,rows:await rows(),backendTasks,backend:await runtime.diagnostics(),sql,functions,phaseTrace},null,2),{flag:'wx'});
  }finally{await app.close();await adopted?.runtime.close();await runtimeDatabase?.close();await f.close();vi.restoreAllMocks();}
},3600000);
