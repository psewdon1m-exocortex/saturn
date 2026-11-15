import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const root='C:/.projects/exocortex',base=root+'/.audit/2026-10-15/endurance-6h',output=process.argv[2];
if(!output?.startsWith(base+'/'))throw Error('Owned evidence path required');await fs.mkdir(output,{recursive:true});
const report={startedAt:new Date().toISOString(),status:'RUNNING',checks:[]};
async function run(name,exe,args,env=process.env){console.log('START '+name);const log=createWriteStream(output+'/'+name+'.log');const p=spawn(exe,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.pipe(log,{end:false});p.stderr.pipe(log,{end:false});const code=await new Promise(resolve=>{p.once('error',()=>resolve(-1));p.once('exit',resolve);});log.end();report.checks.push({name,exitCode:code,status:code===0?'PASS':'FAIL',at:new Date().toISOString(),evidence:name+'.log'});await fs.writeFile(output+'/result.json',JSON.stringify(report,null,2));if(code!==0)throw Error(name+' failed '+code);console.log('PASS '+name);}
try{
 const current=JSON.parse((await fs.readFile(base+'/current.json','utf8')).replace(/^\uFEFF/,''));
 const profile='endurance-'+current.runId.slice(0,8),candidate=base+'/next-tier/windows-payload/Neptune.Windows.exe';
 for(const operation of ['pause','inspect','checkpoint','resume'])await run('native-profile-'+operation,candidate,['--profile',profile,'--profile-command',operation,'--output',output+'/native-'+operation+'.json']);
 const tier=Number(process.env.ENDURANCE_TIER??0);
 const uiRequested=tier===9&&output.includes('/cycle-0010/');
 if(uiRequested)await fs.writeFile(output+'/windows-ui-request.json',JSON.stringify({runId:current.runId,profile:'endurance-ui-'+current.runId.slice(0,8),candidate,scope:'isolated empty profile: startup, mirrors/activity/settings, pause persistence, tray close/reopen; no enrollment or default profile',admittedAt:new Date().toISOString()},null,2));
 const filter=['ObsidianSaveConcurrencyTests','WindowsEnrollmentTests','NetworkRecoveryTests',...(tier>=1?['NetworkAcceptanceTests','NetworkAcceptanceBodyTests','NetworkAcceptanceLegacyTests','NetworkAcceptanceAuthorizationTests','NetworkDeadlineTests']:[])].map(s=>'FullyQualifiedName~'+s).join('|');
 const image='golang@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c';
 const jobs=[run('windows-local-save-network','C:/Users/pc/.dotnet/dotnet.exe',['test',root+'/neptune/tests/Neptune.Core.Tests/Neptune.Core.Tests.csproj','-c','Release','--no-build','--filter',filter,'--logger','trx;LogFileName=local-network.trx','--results-directory',output],{...process.env,ENDURANCE_WINDOWS_PAYLOAD:base+'/next-tier/windows-payload'}),
 run('pluto-daemon-recovery','docker',['run','--rm','--label','exocortex.endurance.run='+current.runId,'--cpus','3','--memory','3g','-v',base+':/suite','-e','STAGE3_PLUTO_BINARY=/suite/bin/pluto',image,'/suite/bin/pluto-tests','-test.v','-test.run',tier>=2?'^TestCompletion(Daemon|Legacy)':'^TestCompletionLegacyQueuedOutageStopsAndResumes$','-test.timeout','15m'])];
 if(uiRequested)jobs.push((async()=>{console.log('START windows-ui manual Computer Use gate');for(;;){let proof;try{proof=JSON.parse(await fs.readFile(output+'/windows-ui-result.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}if(proof){if(proof.runId!==current.runId||proof.profile!=='endurance-ui-'+current.runId.slice(0,8))throw Error('UI evidence identity mismatch');report.checks.push({name:'windows-ui',status:proof.status,at:new Date().toISOString(),evidence:'windows-ui-result.json'});if(proof.status!=='PASS')throw Error('Windows UI gate '+proof.status);console.log('PASS windows-ui');return;}await delay(2000);}})());
 const results=await Promise.allSettled(jobs);const failed=results.find(x=>x.status==='rejected');if(failed)throw failed.reason;report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error);console.error(String(error));process.exitCode=1;}finally{report.finishedAt=new Date().toISOString();await fs.writeFile(output+'/result.json',JSON.stringify(report,null,2));}

