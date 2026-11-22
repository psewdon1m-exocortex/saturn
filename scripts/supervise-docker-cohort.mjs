import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Database } from '../packages/database/dist/index.js';
import { DockerBackendCohort, recoverEngineFencedBackendOwner } from '../packages/recovery/dist/index.js';

// Explicit operator tool, never started by HTTP or an ordinary app deployment.
// Config/password/private journal stay outside every runtime bind mount.
const [configPath, expectedSHA] = process.argv.slice(2);
const sha = b => createHash('sha256').update(b).digest('hex');
assert(path.isAbsolute(configPath??'') && /^[a-f0-9]{64}$/.test(expectedSHA??''));
const configInfo=fs.lstatSync(configPath);assert(configInfo.isFile()&&!configInfo.isSymbolicLink()&&configInfo.size>0&&configInfo.size<=1024*1024);
const raw = fs.readFileSync(configPath);assert.equal(sha(raw),expectedSHA);
const s = JSON.parse(raw);assert.equal(s.schema,'saturn.automatic-docker-cohort-supervisor.v1');
assert(path.isAbsolute(s.privateRoot) && path.isAbsolute(s.passwordFile) && path.isAbsolute(s.resultRoot));
assert(path.resolve(configPath).startsWith(path.resolve(s.privateRoot)+path.sep));
assert(/^[a-f0-9]{64}$/.test(s.stopNonce));assert(s.maximumRecoveries>=1&&s.maximumRecoveries<=4);
assert(s.minimumFreeMemoryBytes>=8*1024**3);assert.equal(s.members.length,2);
fs.mkdirSync(s.resultRoot,{recursive:true,mode:0o700});
const resultFile=path.join(s.resultRoot,'result.json');assert(!fs.existsSync(resultFile),'No supervisor replay');
const journalFile=path.join(s.resultRoot,'events.jsonl');
const event=async value=>{const fd=fs.openSync(journalFile,'a',0o600);try{fs.writeSync(fd,JSON.stringify({at:new Date().toISOString(),...value})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const save=(name,value)=>{const fd=fs.openSync(path.join(s.resultRoot,name),'wx',0o600);try{fs.writeSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const paused=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let closing=false;process.once('SIGTERM',()=>{closing=true;});process.once('SIGINT',()=>{closing=true;});
const memory=()=>{assert(os.freemem()>=s.minimumFreeMemoryBytes,'Operator memory reserve unavailable');};
const passwordInfo=fs.lstatSync(s.passwordFile);assert(passwordInfo.isFile()&&!passwordInfo.isSymbolicLink()&&passwordInfo.size<=4096);
const password=fs.readFileSync(s.passwordFile,'utf8').replace(/[\r\n]+$/,'');assert(password.length>=8);
const url=new URL(s.databaseUrl);assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Only explicitly published local operator PG');url.password=password;
const database=new Database(url.toString(),{max:2,maintenanceBarrier:true});
let outcome;let cohort,liveMembers=[...s.members];const recoveries=[];const allCreated=[];const joins=[];
const readOwner=async()=>database.withSql(async sql=>{const rows=await sql.unsafe('SELECT backend_identity,generation,owner_id,fencing_token,state FROM public.sync_backend_executor WHERE backend_identity=$1',[s.backendIdentity]);assert.equal(rows.length,1);const b=rows[0];assert.equal(b.generation,s.generation);assert.equal(b.state,'RUNNING');return{backendIdentity:b.backend_identity,generation:b.generation,ownerId:b.owner_id,fencingToken:b.fencing_token};});
async function ready(member,port,client){const end=Date.now()+60000;for(;;){memory();const c=client.inspect(member.id);assert.equal(c.State.Running,true,'Replacement exited before readiness');try{client.command(['exec',member.id,'node','-e','fetch("http://127.0.0.1:'+port+'/health/ready",{signal:AbortSignal.timeout(2000)}).then(r=>process.exitCode=r.ok?0:1).catch(()=>process.exitCode=1)']);return;}catch{assert(Date.now()<end,'Replacement readiness deadline');await paused(250);}}}
function createReplacement(template,role,index,client){
  memory();const c=template.Config,h=template.HostConfig;
  assert.equal(h.Privileged,false);assert.equal(h.RestartPolicy.Name,'no');assert.equal(h.NetworkMode,s.network);
  assert.equal(c.User,'1000:1000');assert.equal(h.ReadonlyRootfs,true);assert(h.Memory>0&&h.MemorySwap===h.Memory);
  assert(!h.PidMode&&!h.IpcMode.startsWith('container:'));assert(!h.Devices?.length&&!h.DeviceRequests?.length&&!h.CapAdd?.length&&!h.ExtraHosts?.length&&!h.Links?.length);
  const name=s.namePrefix+'-r'+index+'-'+role;assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name));
  const privateEnv=path.join(s.privateRoot,'environment-'+index+'-'+role+'-'+randomBytes(6).toString('hex'));
  assert(c.Env.every(x=>typeof x==='string'&&!/[\r\n]/.test(x)&&x.includes('=')));
  fs.writeFileSync(privateEnv,c.Env.join('\n')+'\n',{flag:'wx',mode:0o600});
  const args=['create','--pull=never','--name',name,'--network',s.network,'--user',c.User,'--memory',String(h.Memory),'--memory-swap',String(h.MemorySwap),'--pids-limit',String(h.PidsLimit),'--read-only','--env-file',privateEnv];
  if(h.NanoCpus)args.push('--cpus',String(h.NanoCpus/1e9));
  for(const v of h.CapDrop??[])args.push('--cap-drop',v);
  for(const v of h.SecurityOpt??[])args.push('--security-opt',v);
  for(const [key,value]of Object.entries(h.Tmpfs??{}))args.push('--tmpfs',key+':'+value);
  for(const [key,value]of Object.entries(c.Labels??{}))args.push('--label',key+'='+value);
  args.push('--label','saturn.automatic-cohort.recovery='+String(index));
  for(const [key,value]of Object.entries(h.LogConfig?.Config??{}))args.push('--log-opt',key+'='+value);
  for(const [port,bindings]of Object.entries(h.PortBindings??{}))for(const b of bindings){assert(['127.0.0.1','::1'].includes(b.HostIp));args.push('--publish',b.HostIp+':'+b.HostPort+':'+port);}
  const network=Object.values(template.NetworkSettings.Networks);assert.equal(network.length,1);
  for(const alias of network[0].Aliases??[])if(alias!==template.Id&&alias!==template.Id.slice(0,12))args.push('--network-alias',alias);
  for(const mount of template.Mounts){assert(['bind','volume'].includes(mount.Type));assert(!mount.Destination.includes(','));let source=mount.Type==='volume'?mount.Name:mount.Source;if(process.platform==='win32'&&mount.Type==='bind'){const mapped=/^\/run\/desktop\/mnt\/host\/([a-z])\/(.*)$/.exec(source);if(mapped)source=mapped[1].toUpperCase()+':\\'+mapped[2].replaceAll('/','\\');}
    const ephemeral=(s.ephemeralOutputMounts??[]).find(x=>x.destination===mount.Destination);
    if(ephemeral){assert.equal(mount.Type,'bind');assert(mount.RW);assert(path.isAbsolute(ephemeral.sourceRoot));source=path.join(ephemeral.sourceRoot,'r'+index+'-'+role);fs.mkdirSync(source,{recursive:true});}
    assert(typeof source==='string'&&!source.includes(','));args.push('--mount','type='+mount.Type+',source='+source+',destination='+mount.Destination+(mount.RW?'':',readonly'));
  }
  if(c.WorkingDir)args.push('--workdir',c.WorkingDir);
  const entry=c.Entrypoint??[];if(entry.length)args.push('--entrypoint',entry[0]);
  args.push(template.Image,...entry.slice(1),...(c.Cmd??[]));
  const id=client.command(args).trim();assert(/^[a-f0-9]{64}$/.test(id));const created=client.inspect(id);
  assert.equal(created.Image,template.Image);assert.equal(created.State.Running,false);
  const member={id,created:created.Created,image:created.Image,role};allCreated.push(member);return member;
}
async function normalStop(){
  if(!cohort)return;
  for(const member of [...liveMembers].sort((a,b)=>a.role==='api'?-1:b.role==='api'?1:0)){
    let c=cohort.inspect(member.id);if(c.State.Running){await event({schema:'saturn.supervisor-normal-drain.v1',id:member.id,role:member.role,signal:'TERM'});cohort.command(['kill','--signal','TERM',member.id]);const deadline=Date.now()+30000;while(c.State.Running&&Date.now()<deadline){await paused(100);c=cohort.inspect(member.id);}assert.equal(c.State.Running,false,'Normal drain pending; no implicit kill');}
    const text=cohort.command(['wait',member.id]).trim();assert(/^\d+$/.test(text));assert(member.role==='api'?[0,143].includes(Number(text)):Number(text)===0,'Unexpected cooperative shutdown status');joins.push({...member,actualExit:Number(text),actualWait:true});
  }
}
try{
  memory();const identity=await readOwner();cohort=await DockerBackendCohort.observe(s.control,liveMembers,identity,event);
  save('ready.json',{schema:'saturn.automatic-cohort-ready.v1',at:new Date().toISOString(),pid:process.pid,sourceConfigSHA256:expectedSHA,identity,members:liveMembers,manualRepairs:0});
  while(!closing){
    if(fs.existsSync(s.stopFile)){assert.equal(fs.readFileSync(s.stopFile,'utf8'),s.stopNonce,'Private stop nonce differs');closing=true;break;}
    memory();if(!cohort.hasFailure()){await paused(500);continue;}
    assert(recoveries.length<s.maximumRecoveries,'Automatic recovery budget exhausted');
    const original=cohort.identity,templates=cohort.replacementTemplates();
    for(const member of liveMembers){const output=cohort.captureLogs(member.id);for(const channel of ['stdout','stderr'])fs.writeFileSync(path.join(s.resultRoot,'retired-'+member.id+'.'+channel+'.log'),output[channel],{flag:'wx',mode:0o600});}
    const fence=await cohort.fence(),proof=fence.proof();
    // Database maintenance authority is held only here, outside runtime actors.
    // The shared transaction refuses every unresolved effect/reader and never
    // rewrites queued IDs, client UNKNOWNs, payloads, profiles or cursors.
    const released=await recoverEngineFencedBackendOwner(database,fence);assert(['RELEASED_ENGINE_FENCED_NO_EFFECT_OWNER','CONFIRMED_ENGINE_FENCED_CLEAN_STOP'].includes(released.status));
    const index=recoveries.length+1;const replacements=[];
    for(const role of ['worker','api']){const source=templates.find(x=>x.Id===liveMembers.find(m=>m.role===role).id);const member=createReplacement(source,role,index,cohort);replacements.push(member);await event({schema:'saturn.replacement-created-before-start.v1',at:new Date().toISOString(),...member,previousOwner:original.ownerId});cohort.command(['start',member.id]);await ready(member,role==='worker'?3001:3000,cohort);}
    const next=await readOwner();assert.notEqual(next.ownerId,original.ownerId);assert.notEqual(next.fencingToken,original.fencingToken);assert.equal(next.generation,original.generation);
    const recovery={at:new Date().toISOString(),original,proof,released,current:next,members:replacements,automatic:true,manualRepairs:0};save('recovery-'+index+'.json',recovery);recoveries.push(recovery);
    liveMembers=replacements;cohort=await DockerBackendCohort.observe(s.control,liveMembers,next,event);
  }
  await normalStop();const stopped=await database.withSql(sql=>sql.unsafe('SELECT state,owner_id,fencing_token FROM public.sync_backend_executor WHERE backend_identity=$1',[s.backendIdentity]));assert.equal(stopped[0].state,'STOPPED');assert.equal(stopped[0].owner_id,null);assert.equal(stopped[0].fencing_token,null);
  outcome={at:new Date().toISOString(),status:'STOPPED_AUTOMATIC_COHORT_SUPERVISOR',recoveries,joins,allCreated,manualRepairs:0,queueRewrites:0,cursorResets:0};
}catch(error){
  await event({schema:'saturn.supervisor-refusal.v1',name:error.name,message:String(error.message).replaceAll(password,'[REDACTED]')});
  outcome={at:new Date().toISOString(),status:'REFUSED_RETAINED_STATE',error:{name:error.name,message:String(error.message).replaceAll(password,'[REDACTED]')},recoveries,joins,allCreated,manualRepairs:0,queueRewrites:0,cursorResets:0};process.exitCode=1;
}finally{let closeCompleted=false,closeError;let closeTimer;const deadline=new Promise(resolve=>{closeTimer=setTimeout(resolve,10000);});await Promise.race([database.close().then(()=>{closeCompleted=true;},error=>{closeError=String(error.message).replaceAll(password,'[REDACTED]');}),deadline]);clearTimeout(closeTimer);outcome.databaseCloseCompleted=closeCompleted;if(closeError)outcome.databaseCloseError=closeError;if(!closeCompleted){outcome.previousStatus=outcome.status;outcome.status='REFUSED_DATABASE_CLOSE_PENDING';process.exitCode=1;}const intendedExit=closeCompleted&&outcome.status==='STOPPED_AUTOMATIC_COHORT_SUPERVISOR'?0:1;await event({schema:'saturn.supervisor-process-exit.v1',databaseCloseCompleted:closeCompleted,intendedExit,ordinaryRuntimeJoinsComplete:outcome.status==='STOPPED_AUTOMATIC_COHORT_SUPERVISOR'});save('result.json',outcome);process.exit(intendedExit);}
