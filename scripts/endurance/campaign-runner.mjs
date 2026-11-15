import fs from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {acceptLockedDesktopDisposition} from './environment-block.mjs';
import {CampaignPolicy,preparedCampaign,DURATION_MS} from './campaign-policy.mjs';
const exec=promisify(execFile),root='C:/.projects/exocortex',base=root+'/.audit/2026-10-15/endurance-6h',scripts=root+'/saturn/scripts/endurance';
const currentFile=base+'/current.json',policyFile=base+'/policy.json',journal=root+'/.history/2026-10-15-six-hour-run.md';
const read=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const atomic=async(file,data)=>{await fs.writeFile(file+'.tmp',JSON.stringify(data,null,2));await fs.rename(file+'.tmp',file);};
const clock=()=>({wallMs:Date.now(),monotonicMs:Math.floor(performance.now())});
async function event(reason,before,action,after){await fs.appendFile(journal,`\n## ${new Date().toISOString()} — ${reason}\n\n- Причина: ${reason}.\n- До / входной гейт: ${before}.\n- Что и как сделано: ${action}.\n- Выходной гейт / тесты: ${after}.\n`);}
async function cohort(){const files=['product-cycle.mjs','product-backend-fault.mjs','product-transfer-lifecycle.mjs','environment-block.mjs','product-extended.mjs','product-browser.mjs','guarded-cycle.mjs','recovery-cycle.mjs','campaign-job.mjs','campaign-runner.mjs','campaign-policy.mjs'].map(n=>scripts+'/'+n).concat([root+'/saturn/apps/api/dist/main.js',root+'/saturn/apps/worker/dist/main.js',root+'/saturn/apps/api/src/completion-clients.integration.test.ts',root+'/saturn/apps/api/src/stage3-chat-a.fixture.ts',base+'/cohort-resource-budget.json',root+'/neptune/tests/Neptune.Core.Tests/bin/Release/net10.0/Neptune.Core.Tests.dll',root+'/neptune/tests/Neptune.Core.Tests/bin/Release/net10.0/Neptune.Core.dll',base+'/next-tier/windows-payload/Neptune.Windows.exe',base+'/next-tier/windows-payload/Neptune.Windows.dll',base+'/next-tier/windows-payload/Neptune.Core.dll',base+'/bin/pluto',base+'/bin/pluto-tests',base+'/bin/syncstate-tests',root+'/saturn/packages/database/migrations/0068_retention_backlog_admission.up.sql',root+'/saturn/packages/database/migrations/0068_retention_backlog_admission.down.sql']);const hashes=[];for(const file of files)hashes.push({file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});const digest=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');await atomic(base+'/cohort-'+digest.slice(0,12)+'.json',{digest,hashes});return digest;}
async function resources(){const result=await exec('powershell.exe',['-NoProfile','-Command',"$o=Get-CimInstance Win32_OperatingSystem; @{at=(Get-Date -Format o);freeDiskBytes=(Get-PSDrive C).Free;availableRamBytes=[long]$o.FreePhysicalMemory*1024}|ConvertTo-Json -Compress"],{windowsHide:true,timeout:20000});return JSON.parse(result.stdout);}
let current=await read(currentFile),policy,lastResources,lastResourceAt=0,lastJournalAt=0;
const lockFile=base+'/manager.lock.json';
try{const lock=await fs.open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await lock.close();}
catch(error){if(error.code!=='EEXIST')throw error;const previous=await read(lockFile);let alive=true;try{process.kill(previous.pid,0);}catch{alive=false;}if(alive||process.argv[2]!=='--resume')throw Error('Manager lock exists; no duplicate admission');await fs.unlink(lockFile);const lock=await fs.open(lockFile,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await lock.close();}
async function persist(status){await atomic(policyFile,policy.snapshot());current={...current,status,managerPid:process.pid,updatedAt:new Date().toISOString(),startedAt:new Date(policy.state.startedAtMs).toISOString(),deadline:new Date(policy.state.deadlineMs).toISOString(),elapsedMs:policy.state.elapsedMs,active:policy.state.active,completedCycles:policy.state.completed.length,resources:lastResources};await atomic(currentFile,current);}
function jobsFor(tier){const count=[128,256,512,1024,2048,4096,8192,16384,20000,40000,100000][Math.min(tier,10)];const parallel=[2,4,8,12,16,24,32,48,64,64,96][Math.min(tier,10)];return {files:count,parallel,lanes:[{id:'SYNC',scenarios:['SYNC-08','SYNC-11','SYNC-12','RES-01',...(tier>=2?['PLU-03']:[]),...(tier>=4?['SYNC-01','SYNC-02','SYNC-03','DUP-01','DUP-02']:[]),...(tier>=5?['SYNC-10','PLU-01']:[]),...(tier>=6?['SYNC-05','SYNC-06']:[]),...(tier>=7?['RES-02','RES-03']:[]),...(tier>=8?['PLU-02']:[]),...(tier>=9?['SYNC-07','SYNC-09']:[])],script:'guarded-cycle.mjs'},{id:'PRODUCT',scenarios:['SAT-01','SAT-02','SAT-03','SAT-04','SAT-05','SAT-06','SHARE-01','SHARE-02','SHARE-03','SHARE-04','DROP-01','DROP-02','DROP-03','RES-06',...(tier>=6?['DROP-04','RES-05']:[]),...(tier>=8?['RES-04']:[])],script:'product-cycle.mjs'},{id:'RECOVERY',scenarios:['SYNC-04','DUP-01','DUP-02','WIN-01','SYNC-10','RES-02','RES-03'],script:'recovery-cycle.mjs'}]};}
async function launch(lane){const active=policy.state.active,index=lane.attempts.length-1,dir=base+'/cycles/'+active.cycleId+'/'+lane.id+'/attempt-'+index;await fs.mkdir(dir,{recursive:true});const spec={runId:current.runId,cycleId:active.cycleId,laneId:lane.id,attemptIndex:index,executable:process.execPath,args:[scripts+'/'+lane.script,dir],cwd:root,env:{ENDURANCE_SEED:active.seed,ENDURANCE_TIER:String(active.tier),ENDURANCE_FILES:String(active.files),ENDURANCE_CONCURRENCY:String(active.parallel)}};await atomic(dir+'/job.json',spec);const child=spawn(process.execPath,[scripts+'/campaign-job.mjs',dir+'/job.json'],{cwd:root,windowsHide:true,detached:true,stdio:'ignore'});child.unref();lane.jobDirectory=dir;lane.wrapperPid=child.pid;await persist('RUNNING');}
try{
 if(process.argv[2]==='--start'){
  if(current.status!=='PREPARING'||current.startedAt!==null)throw Error('Fresh authorized preparation required');
  for(const p of ['preflight-product5/result.json','preflight-sync/result.json','preflight-recovery3/result.json','controller-qualified.json']){if((await read(base+'/'+p)).status!=='PASS')throw Error('Unqualified start gate '+p);}
  const stand=await read(base+'/stand-ready.json');const health=await fetch(stand.apiOrigin+'/health/ready',{signal:AbortSignal.timeout(5000)});if(!health.ok)throw Error('Stand unhealthy');
  lastResources=await resources();if(lastResources.freeDiskBytes<10*2**30||lastResources.availableRamBytes<8*2**30)throw Error('Resource reserve unavailable');
  policy=new CampaignPolicy(preparedCampaign(current.runId),clock());policy.start(clock(),true);await persist('RUNNING');await event('Шестичасовой прогон начат','Все стартовые проверки PASS',`Установлены T0=${current.startedAt}, deadline=${current.deadline}; heartbeat каждые 30 минут`,'Новые циклы разрешены до deadline, последний цикл завершается полностью');
 }else if(process.argv[2]==='--resume'){policy=new CampaignPolicy(await read(policyFile),clock());await event('Возобновление dispatcher','Прежний manager отсутствует','Восстановлен checkpoint без сдвига T0/deadline','Существующие jobs будут прочитаны, повторный запуск не выполняется автоматически');}
 else throw Error('Explicit --start or --resume required');
 for(;;){
  policy.observe(clock());
  if(Date.now()-lastResourceAt>60000){lastResources=await resources();await fs.appendFile(base+'/resources.jsonl',JSON.stringify(lastResources)+'\n');lastResourceAt=Date.now();}
  if(!policy.state.active){
   if(policy.state.elapsedMs>=DURATION_MS){await persist('FINISHED');break;}
   try{await fs.access(base+'/hold-admission');await persist('ADMISSION_HOLD');await delay(2000);continue;}catch(error){if(error.code!=='ENOENT')throw error;}
   if(lastResources.freeDiskBytes<10*2**30||lastResources.availableRamBytes<8*2**30){await persist('RESOURCE_HOLD');await delay(10000);continue;}
   const cycleNumber=policy.state.completed.length+1,tier=Math.min(cycleNumber-1,10),job=jobsFor(tier),cohortId=await cohort();
   policy.admit({cycleId:'cycle-'+String(cycleNumber).padStart(4,'0'),cohort:cohortId,seed:current.runId+':'+cycleNumber,tier,...job},clock());await persist('RUNNING');
   await event('Старт параллельного цикла',`Ступень ${tier}, cohort ${cohortId.slice(0,12)}`,`${job.files} файлов, ${job.parallel} источников запросов; SYNC/PRODUCT/RECOVERY запускаются параллельно`,'Сценарии и нагрузка зафиксированы до запуска');
   for(const lane of policy.state.active.lanes)await launch(lane);
  }
  let stalled=false;
  for(const lane of policy.state.active.lanes){if(lane.status!=='RUNNING')continue;if(!lane.jobDirectory){lane.status='BLOCKED';await event('Неполный checkpoint запуска',lane.id,'Автоповтор без доказательства отсутствия старого процесса запрещён','BLOCKED');continue;}
   try{const result=await read(lane.jobDirectory+'/job-result.json');if(result.cycleId!==policy.state.active.cycleId||result.laneId!==lane.id||result.attemptIndex!==lane.attempts.length-1)throw Error('Stale job identity');let passed=result.exitCode===0;try{passed&&=(await read(lane.jobDirectory+'/result.json')).status==='PASS';}catch{passed=false;}policy.finishLane(result.cycleId,lane.id,result.attemptIndex,passed?'PASS':'FAIL',lane.jobDirectory+'/job-result.json',clock());await event('Завершение направления',`${result.cycleId}/${lane.id}`,`Получен exit ${result.exitCode}; primary evidence ${lane.jobDirectory}`,passed?'PASS проверенного набора, не всей группы coverage':'FAIL; нужна диагностика и адресный повтор');}
   catch(error){if(error.code!=='ENOENT')throw error;try{if((await read(lane.jobDirectory+'/job-heartbeat.json')).stalled)stalled=true;}catch{}}
  }
  const active=policy.state.active;
  if(active.lanes.every(l=>l.status==='PASS')){const done=policy.closeCycle(active.cycleId,clock());await event('Цикл завершён',done.cycleId,'Все направления прошли; исходные доказательства сохранены',`PASS, tail=${done.tailMs} ms`);await persist(policy.state.status==='FINISHED'?'FINISHED':'RUNNING');await exec(process.execPath,[scripts+'/coverage-review.mjs'],{windowsHide:true});continue;}
  if(active.lanes.every(l=>l.status!=='RUNNING')){
   const dispositionFile=base+'/independent-disposition.json';
   try{
    const disposition=await read(dispositionFile),lane=active.lanes.find(l=>l.id==='RECOVERY');
    const accepted=acceptLockedDesktopDisposition(active,disposition,await read(lane.jobDirectory+'/result.json'),await read(lane.jobDirectory+'/windows-ui-result.json'));
    active.environmentDisposition=accepted;const done=policy.closeCycle(active.cycleId,clock());
    await fs.rename(dispositionFile,base+'/independent-disposition-applied-'+Date.now()+'.json');
    await event('Цикл закрыт с сохранённым BLOCKED UI',done.cycleId,accepted.reason,'FAIL цикла сохранён; WIN-01 BLOCKED. Независимые сценарии могут продолжаться до прежнего deadline');
    await persist(policy.state.status==='FINISHED'?'FINISHED':'RUNNING');await exec(process.execPath,[scripts+'/coverage-review.mjs'],{windowsHide:true});continue;
   }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(active.lanes.some(l=>l.status==='FAIL'||l.status==='BLOCKED')){
   const controlFile=base+'/repair.json';try{const repair=await read(controlFile);if(repair.cycleId!==active.cycleId)throw Error('Repair cycle mismatch');const currentCohort=await cohort();for(const id of repair.lanes){const lane=active.lanes.find(l=>l.id===id);if(!lane)throw Error('Unknown repair lane');policy.repairLane(active.cycleId,id,{diagnosis:repair.diagnosis,cohort:currentCohort},clock());await launch(lane);}await fs.rename(controlFile,base+'/repair-applied-'+Date.now()+'.json');await event('Адресный повтор после исправления',repair.cycleId,repair.diagnosis,'Повторяется прежний набор сценариев, T0 не изменён');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const status=stalled?'NEEDS_ATTENTION':active.lanes.some(l=>l.status==='FAIL'||l.status==='BLOCKED')?'WAITING_REPAIR':'RUNNING';await persist(status);
  if(Date.now()-lastJournalAt>300000){await event('Контроль прогресса',active.cycleId,active.lanes.map(l=>l.id+':'+l.status).join(', '),`C free ${(lastResources.freeDiskBytes/2**30).toFixed(2)} GiB; ${status}; elapsed ${(policy.state.elapsedMs/60000).toFixed(1)} min`);lastJournalAt=Date.now();}
  await delay(2000);
 }
 await event('Окно кампании завершено','Новая admission закрыта','Последний начатый цикл завершён','Результаты сохранены; требуется итоговая оценка coverage и лимитов');
}catch(error){await atomic(base+'/manager-error.json',{at:new Date().toISOString(),error:String(error),stack:error.stack});await event('Ошибка dispatcher',current.status,'Checkpoint и процессы не сброшены',String(error));throw error;}
finally{await fs.unlink(lockFile).catch(()=>{});}



