import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),root='C:/.projects/exocortex',repo=root+'/saturn',base=root+'/.audit/2026-10-15/endurance-6h';
const output=process.argv[2];if(!output?.startsWith(base+'/'))throw Error('Owned output required');await fs.mkdir(output,{recursive:true});
const current=JSON.parse((await fs.readFile(base+'/current.json','utf8')).replace(/^\uFEFF/,''));
const environment={...process.env,STAGE3_CHAT_A_FIXTURE:base+'/private/sync-fixture.json',STAGE3_CHAT_A_EVIDENCE:output,COMPLETION_EVIDENCE:output};
const children=[];const report={startedAt:new Date().toISOString(),status:'RUNNING',checks:[]};
const sourceCohort=[];for(const file of [repo+'/packages/sync/src/sync-snapshot-read.ts',repo+'/apps/api/src/completion-clients.integration.test.ts'])sourceCohort.push({file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});
await fs.writeFile(output+'/source-cohort.json',JSON.stringify(sourceCohort,null,2));report.sourceCohort=sourceCohort;
let windowsProgress=0;const progressTimer=setInterval(async()=>{try{const p=JSON.parse(await fs.readFile(output+'/windows-bulk/progress.json','utf8'));if(p.events>windowsProgress){windowsProgress=p.events;console.log('PROGRESS windows-bulk '+p.events+' publication/status events, last '+p.at);}}catch{}},15000);
let saves=Promise.resolve();function save(){const body=JSON.stringify(report,null,2);saves=saves.then(async()=>{await fs.writeFile(output+'/result.json.tmp',body);await fs.rename(output+'/result.json.tmp',output+'/result.json');});return saves;}
function launch(name,exe,args,env=environment,cwd=repo){const log=createWriteStream(output+'/'+name+'.log');const child=spawn(exe,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});let lastReport=Date.now();for(const stream of [child.stdout,child.stderr])stream.on('data',()=>{if(Date.now()-lastReport>30000){lastReport=Date.now();console.log('ACTIVITY '+name+' new child output');}});const result=new Promise(resolve=>{child.once('error',error=>{log.end(String(error));resolve(-1);});child.once('exit',code=>{log.end();resolve(code);});});return {child,result};}
async function checked(name,exe,args,env,cwd){const startedAt=new Date().toISOString();console.log('START '+name);const {result}=launch(name,exe,args,env,cwd);const code=await result;const check={name,exitCode:code,status:code===0?'PASS':'FAIL',startedAt,at:new Date().toISOString(),evidence:name+'.log'};report.checks.push(check);await save();if(code!==0)throw Error(name+' failed with '+code);console.log('PASS '+name);return check;}
const fixture=launch('actual-api',process.execPath,[repo+'/node_modules/vitest/vitest.mjs','run','--config','apps/api/vitest.config.ts','apps/api/src/completion-clients.integration.test.ts','--maxWorkers=1']);
try{
 for(let i=0;i<240;i++){try{await fs.access(output+'/api-ready.json');break;}catch{}if(fixture.child.exitCode!==null)throw Error('API fixture failed');if(i===239)throw Error('API fixture readiness timeout');await delay(250);}
 const ipResult=await exec('docker',['run','--rm','--label','exocortex.endurance.run='+current.runId,'golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c','getent','ahostsv4','host.docker.internal'],{windowsHide:true});
 const ip=ipResult.stdout.trim().split(/\s+/)[0];if(!/^\d+\.\d+\.\d+\.\d+$/.test(ip))throw Error('Owned Docker host IPv4 unavailable');
 const dotnet='C:/Users/pc/.dotnet/dotnet.exe',project=root+'/neptune/tests/Neptune.Core.Tests/Neptune.Core.Tests.csproj';
 const resumeCycle10=output.includes('/cycle-0010/')&&path.basename(output)!=='attempt-0';
 // Attempt 2 changes the shared snapshot reader, so both clients must qualify
 // again against that source before the paired bulk; earlier API gates expire.
 const resumeCycle11=output.includes('/cycle-0011/')&&path.basename(output)==='attempt-1';
 const resumeCycle11Cancellation=output.includes('/cycle-0011/')&&Number(path.basename(output).replace('attempt-',''))>=3;
 if(resumeCycle11Cancellation){
  const original=base+'/cycles/cycle-0011/SYNC/attempt-2/result.json',prior=JSON.parse(await fs.readFile(original,'utf8'));
  const checkpoint=JSON.parse((await fs.readFile(base+'/policy.json','utf8')).replace(/^\uFEFF/,''));
  const digest=checkpoint.active.lanes.find(l=>l.id==='SYNC').attempts[2].cohort;
  const frozen=JSON.parse(await fs.readFile(base+'/cohort-'+digest.slice(0,12)+'.json','utf8'));
  const sources=JSON.parse(await fs.readFile(base+'/cycles/cycle-0011/SYNC/attempt-2/source-cohort.json','utf8'));
  for(const file of [root+'/neptune/tests/Neptune.Core.Tests/bin/Release/net10.0/Neptune.Core.Tests.dll',root+'/neptune/tests/Neptune.Core.Tests/bin/Release/net10.0/Neptune.Core.dll',repo+'/apps/api/src/completion-clients.integration.test.ts',repo+'/packages/sync/src/sync-snapshot-read.ts']){const saved=[...frozen.hashes,...sources].find(x=>x.file===file);assert(saved);assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),saved.sha256,'reused Windows gate changed');}
  for(const name of ['windows-interop','windows-service-recovery']){const check=prior.checks.find(x=>x.name===name);assert.equal(check?.status,'PASS');report.checks.push({...check,reusedFrom:original});}await save();
 }
 if(resumeCycle11){
  const original=base+'/cycles/cycle-0011/SYNC/attempt-0/result.json',prior=JSON.parse(await fs.readFile(original,'utf8'));
  const frozen=JSON.parse(await fs.readFile(base+'/cohort-49fd02d2e2b9.json','utf8'));
  for(const file of [root+'/neptune/tests/Neptune.Core.Tests/bin/Release/net10.0/Neptune.Core.Tests.dll',root+'/neptune/tests/Neptune.Core.Tests/bin/Release/net10.0/Neptune.Core.dll',root+'/saturn/apps/api/src/completion-clients.integration.test.ts']){const saved=frozen.hashes.find(x=>x.file===file);assert(saved);assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),saved.sha256,'reused Windows gate source/binary changed');}
  for(const name of ['windows-interop','windows-service-recovery']){const check=prior.checks.find(x=>x.name===name);assert.equal(check?.status,'PASS');report.checks.push({...check,reusedFrom:original});}await save();
 }
 if(resumeCycle10){
  const original=base+'/cycles/cycle-0010/SYNC/attempt-0/result.json';
  const prior=JSON.parse(await fs.readFile(original,'utf8'));
  const frozen=JSON.parse(await fs.readFile(base+'/cohort-d1a30b1b0655.json','utf8'));
  for(const file of [root+'/neptune/tests/Neptune.Core.Tests/bin/Release/net10.0/Neptune.Core.Tests.dll',root+'/neptune/tests/Neptune.Core.Tests/bin/Release/net10.0/Neptune.Core.dll',base+'/bin/pluto',base+'/bin/syncstate-tests',root+'/saturn/apps/api/src/completion-clients.integration.test.ts']){
   const saved=frozen.hashes.find(x=>x.file===file);assert(saved);assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),saved.sha256,'reused gate binary/source changed');
  }
  for(const name of ['windows-interop','windows-service-recovery','pluto-interop','pluto-native-network-qualification']){const check=prior.checks.find(x=>x.name===name);assert.equal(check?.status,'PASS');report.checks.push({...check,reusedFrom:original});}
  report.retainedGatesFrom=original;await save();
 }

 if(!resumeCycle10&&!resumeCycle11&&!resumeCycle11Cancellation)await checked('windows-interop',dotnet,['test',project,'-c','Release','--no-build','--filter','FullyQualifiedName~CompletionInteropTests','--logger','trx;LogFileName=windows-interop.trx','--results-directory',output],environment,root+'/neptune');
 if(!resumeCycle10&&!resumeCycle11&&!resumeCycle11Cancellation&&process.env.ENDURANCE_PREFLIGHT!=='1')await checked('windows-service-recovery',dotnet,['test',project,'-c','Release','--no-build','--filter','FullyQualifiedName~CompletionServiceTests','--logger','trx;LogFileName=windows-service.trx','--results-directory',output],environment,root+'/neptune');
 const tier=Number(process.env.ENDURANCE_TIER??0);
 const windowsBulk=()=>checked('windows-bulk',dotnet,['test',project,'-c','Release','--no-build','--filter','FullyQualifiedName~CompletionBulkTests','--logger','trx;LogFileName=windows-bulk.trx','--results-directory',output],{...environment,ENDURANCE_SYNC_FILES:String(Math.min(4096,128*2**(tier-4)))},root+'/neptune');
 if(tier>=4&&tier<9)await windowsBulk();
 const config='/suite/'+path.relative(base,output).replaceAll('\\','/')+'/clients.private.json';
 const dockerArgs=['run','--rm','--label','exocortex.endurance.run='+current.runId,'--cpus','3','--memory','3g','-v',base+':/suite','-v','endurance-native-'+current.runId+':/retained','-e','STAGE3_NATIVE_RETAIN_BASE=/retained/endurance-'+current.runId,'-e','COMPLETION_CONFIG='+config,'-e','COMPLETION_HOST_IP='+ip,'-e','ENDURANCE_TIER='+(process.env.ENDURANCE_TIER??'0'),'-e','STAGE3_PLUTO_BINARY=/suite/bin/pluto','-e','STAGE3_C_EVIDENCE=/suite/'+path.relative(base,output).replaceAll('\\','/'),'golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c'];
 if(!resumeCycle10)await checked('pluto-interop','docker',[...dockerArgs,'/suite/bin/syncstate-tests','-test.v','-test.run',process.env.ENDURANCE_PREFLIGHT==='1'?'^TestCompletionActualSaturnCallers$':'^TestCompletionActualSaturn(Callers|Recovery)$','-test.timeout','15m']);
 if(!resumeCycle10&&Number(process.env.ENDURANCE_TIER??0)>=7){const nativeArgs=[...dockerArgs];nativeArgs.splice(nativeArgs.length-1,0,'-e','ENDURANCE_SYNC_FILES=32');await checked('pluto-native-network-qualification','docker',[...nativeArgs,'/suite/bin/pluto-tests','-test.v','-test.run','^TestCompletionNativeBulkReadbackPauseRestartNoCopies$','-test.timeout','0']);await fs.copyFile(output+'/pluto-bulk.json',output+'/pluto-network-qualification.json');}
 const plutoBulk=()=>{const nativeArgs=[...dockerArgs];nativeArgs.splice(nativeArgs.length-1,0,'-e','ENDURANCE_SYNC_FILES='+Math.min(4096,128*2**(tier-5)));return checked('pluto-native-bulk','docker',[...nativeArgs,'/suite/bin/pluto-tests','-test.v','-test.run','^TestCompletionNativeBulkReadbackPauseRestartNoCopies$','-test.timeout','0']);};
 if(tier>=9){
  const configs=JSON.parse(await fs.readFile(output+'/clients.private.json','utf8'));
  assert.notEqual(configs[0].authorization,configs[1].authorization);assert.notEqual(configs[0].binding.root_id,configs[1].binding.root_id);assert.notEqual(configs[0].binding.binding_version,configs[1].binding.binding_version);
  const pair=await Promise.allSettled([windowsBulk(),plutoBulk()]);for(const item of pair)if(item.status==='rejected')throw item.reason;
  const checks=pair.map(x=>x.value),overlapMs=Math.min(...checks.map(x=>Date.parse(x.at)))-Math.max(...checks.map(x=>Date.parse(x.startedAt)));assert(overlapMs>0);
  const proof={status:'PASS',overlapMs,distinctCredentials:true,roots:configs.map(c=>c.binding.root_id),checks,readback:['windows-bulk/result.json','pluto-bulk.json']};await fs.writeFile(output+'/concurrent-clients.json',JSON.stringify(proof,null,2));
  report.checks.push({name:'concurrent-native-clients',status:'PASS',at:new Date().toISOString(),evidence:'concurrent-clients.json'});await save();
 }else if(tier>=5)await plutoBulk();
 if(tier>=9)await checked('windows-conflict',dotnet,['test',project,'-c','Release','--no-build','--filter','FullyQualifiedName~CompletionConflictTests','--logger','trx;LogFileName=windows-conflict.trx','--results-directory',output],environment,root+'/neptune');
 if(Number(process.env.ENDURANCE_TIER??0)>=8)await checked('pluto-backup-boundaries','docker',[...dockerArgs,'/suite/bin/pluto-tests','-test.v','-test.run','^TestCompletionNativeBackupVersionsDeletionAndSizeBoundaries$','-test.timeout','0']);
 if(Number(process.env.ENDURANCE_TIER??0)>=2)await checked('pluto-native-adoption','docker',[...dockerArgs,'/suite/bin/pluto-tests','-test.v','-test.run','^TestCompletionRealOperatorBindingAdoptThroughNativeCLI$','-test.timeout','15m']);
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error);console.error(String(error));process.exitCode=1;}
finally{clearInterval(progressTimer);await fs.writeFile(output+'/api-stop','');const apiCode=await Promise.race([fixture.result,delay(30000,null,{ref:false})]);if(apiCode!==0){report.status='FAIL';report.apiExitCode=apiCode;process.exitCode=1;if(apiCode===null)fixture.child.kill();}report.finishedAt=new Date().toISOString();await save();}

