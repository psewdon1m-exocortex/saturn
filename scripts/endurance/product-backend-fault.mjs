import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile);
const base='C:/.projects/exocortex/.audit/2026-10-15/endurance-6h';

export function assertOwnedBackend(container,expected,runId){
 assert.equal(container.Id,expected.id,'backend identity');
 assert.equal(container.Created,expected.created,'backend creation');
 assert.equal(container.Name,'/'+expected.name,'backend name');
 assert.equal(container.Config.Labels['exocortex.endurance.run'],runId,'backend ownership');
 assert.equal(container.Config.Labels['com.docker.compose.service'],'sftp','backend service');
 assert.equal(container.State.Running,true,'backend running');
}

// Only called by an admitted PRODUCT cycle after its ordinary mixed actors drain.
// Native SYNC uses a separate backend; this does not claim the full RES-05 group.
export async function backendFaultFlow({api,json,folder,upload,download,pass,sha,jar,target,seed,output}){
 const current=JSON.parse(await fs.readFile(base+'/current.json','utf8'));
 assert(current.active&&output.includes('/'+current.active.cycleId+'/PRODUCT/'));
 assert(current.active.tier>=10,'fault scenario must be admitted before deadline');
 const budgets=JSON.parse(await fs.readFile(base+'/cohort-resource-budget.json','utf8'));
 const expected=budgets.containers.find(x=>x.name==='endurance-'+current.runId.slice(0,8)+'-sftp-1');
 assert(expected);assert.equal(budgets.runId,current.runId);
 const docker=(args)=>exec('docker',args,{windowsHide:true,timeout:20000,maxBuffer:1024*1024});
 const inspect=async()=>JSON.parse((await docker(['inspect',expected.id])).stdout)[0];
 assertOwnedBackend(await inspect(),expected,current.runId);
 const evidence={runId:current.runId,cycleId:current.active.cycleId,startedAt:new Date().toISOString(),status:'RUNNING',sharedBackend:true,syncBackendShared:false,rounds:[]};
 let saves=Promise.resolve();const save=()=>{const body=JSON.stringify(evidence,null,2);saves=saves.then(()=>fs.writeFile(output+'/backend-fault.json',body));return saves;};
 async function children(id){const all=[];for(let offset=0;;offset+=500){const r=await json('/folders/'+id+'/children?offset='+offset+'&limit=500',{jar}),page=r.items??r;all.push(...page);if(page.length<500)return all;}}
 async function waitFor(check,name){const end=Date.now()+180000;for(;;){if(await check())return;assert(Date.now()<end,name+' did not recover on original IDs');await delay(1000);}}
 try{
  for(const pauseMs of [8000,35000]){
   const round={pauseMs,status:'RUNNING',owner:[],drop:[],reads:[],control:[]};evidence.rounds.push(round);await save();
   const root=await folder(jar,'backend-fault-'+randomUUID().slice(0,8),target.id);
   const knownBytes=Buffer.alloc(262144,41);Buffer.from(seed).copy(knownBytes);
   const known=await upload(jar,root.id,'read-source.bin',knownBytes);
   const share=await json('/shares',{method:'POST',jar,json:{resourceId:known.id,mode:'download'}}),guest=new Map();
   // Retain capabilities privately for repair; never log tokens/cookies.
   await fs.mkdir(output+'/private',{recursive:true});
   await fs.writeFile(output+'/private/backend-fault-'+pauseMs+'.json',JSON.stringify({share,ownerCookies:[...jar]},null,2));
   const owners=[];
   for(let i=0;i<8;i++){
    const name='owner-'+i+'.bin',bytes=Buffer.alloc(131072+i,73+i),key='fault-'+randomUUID();
    const s=await json('/uploads',{method:'POST',jar,json:{parentId:root.id,filename:name,expectedSize:bytes.length,expectedSha256:sha(bytes)},headers:{'Idempotency-Key':key}});
    const r=await api('/uploads/'+s.id,{method:'PATCH',jar,body:bytes,headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':'0','Content-Length':String(bytes.length)}});assert.equal(r.status,204);await r.arrayBuffer();
    const proof={id:s.id,name,size:bytes.length,sha256:sha(bytes),parentId:root.id,creationKey:key};round.owner.push(proof);owners.push({proof,bytes});
   }
   const drops=[];
   for(let channel=0;channel<2;channel++){
    const code=await json('/drop/codes',{method:'POST',jar,json:{}}),cookies=new Map();
    const session=await json('/drop/redeem',{method:'POST',jar:cookies,json:{code:code.code}});
    for(let i=0;i<4;i++){
     const bytes=Buffer.alloc(262144+i,90+channel*10+i),name='fault-drop-'+randomUUID()+'.bin';
     const s=await json('/drop/uploads',{method:'POST',jar:cookies,json:{filename:name,expectedSize:bytes.length,expectedSha256:sha(bytes)}});
     const r=await api('/drop/uploads/'+s.id,{method:'PATCH',jar:cookies,body:bytes,headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':'0','Content-Length':String(bytes.length)}});assert.equal(r.status,204);await r.arrayBuffer();
     const proof={id:s.id,name,size:bytes.length,sha256:sha(bytes),channelId:session.channelId};round.drop.push(proof);drops.push({proof,bytes,jar:cookies});
    }
   }
   await fs.writeFile(output+'/private/backend-fault-drops-'+pauseMs+'.json',JSON.stringify(drops.map(d=>({id:d.proof.id,cookies:[...d.jar]})),null,2));
   await save();
   assertOwnedBackend(await inspect(),expected,current.runId);
   assert.equal((await inspect()).State.Paused,false,'backend must not already be paused');
   // Independent fail-safe restores this exact owned ID if the test process dies.
   const guardCode=`const fs=require('node:fs');const cp=require('node:child_process');setTimeout(()=>{try{const c=JSON.parse(cp.execFileSync('docker',['inspect',${JSON.stringify(expected.id)}],{windowsHide:true,encoding:'utf8'}))[0];if(c.Id===${JSON.stringify(expected.id)}&&c.Created===${JSON.stringify(expected.created)}&&c.Config.Labels['exocortex.endurance.run']===${JSON.stringify(current.runId)}&&c.State.Paused){cp.execFileSync('docker',['unpause',c.Id],{windowsHide:true});fs.writeFileSync(${JSON.stringify(output+'/backend-fault-guard-'+pauseMs+'.json')},JSON.stringify({at:new Date().toISOString(),restored:true}));}}catch(e){fs.writeFileSync(${JSON.stringify(output+'/backend-fault-guard-'+pauseMs+'.json')},JSON.stringify({error:String(e)}));}},65000);`;
   const guard=spawn(process.execPath,['-e',guardCode],{windowsHide:true,detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{guard.once('spawn',resolve);guard.once('error',reject);});guard.unref();round.guardPid=guard.pid;
   let paused=false,pending=[];
   try{
    await docker(['pause',expected.id]);paused=true;assert.equal((await inspect()).State.Paused,true);
    round.pausedAt=new Date().toISOString();console.log('START shared SFTP pause '+pauseMs+'ms');await save();
    const observe=async(proof,request)=>{proof.requestAt=new Date().toISOString();try{const r=await request();proof.responseStatus=r.status;proof.responseAt=new Date().toISOString();const body=Buffer.from(await r.arrayBuffer());if(r.status<400)proof.responseSha256=sha(body);else proof.failureBody=body.toString('utf8').slice(0,150);return {status:r.status,body};}catch(e){proof.transportError=String(e);return {transportError:String(e)};}};
    pending.push(...owners.map(({proof})=>observe(proof,()=>api('/uploads/'+proof.id+'/complete',{method:'POST',jar,json:{},headers:{'Idempotency-Key':'complete-'+proof.id}}))));
    pending.push(...drops.map(({proof,jar:dropJar})=>observe(proof,()=>api('/drop/complete',{method:'POST',jar:dropJar,json:{uploadId:proof.id}}))));
    for(let i=0;i<8;i++){const proof={index:i};round.reads.push(proof);pending.push(observe(proof,()=>api('/public/shares/'+share.token+'/content',{jar:guest})).then(r=>{if(r.status===200)assert.equal(sha(r.body),sha(knownBytes),'stalled guest SHA');}));}
    // DB-only control must remain responsive even when the storage pool is busy.
    const control=(async()=>{for(let n=0;n<3;n++){const started=performance.now(),r=await api('/uploads/'+owners[0].proof.id,{method:'HEAD',jar});assert.equal(r.status,204);round.control.push({at:new Date().toISOString(),latencyMs:performance.now()-started,status:r.headers.get('Upload-Status')});assert(round.control.at(-1).latencyMs<10000,'control starved by backend fault');await delay(1500);}})();pending.push(control);
    // Attach handlers immediately; evidence is collected after restoring storage.
    const settled=Promise.allSettled(pending);
    await delay(pauseMs);
    await docker(['unpause',expected.id]);paused=false;round.restoredAt=new Date().toISOString();round.observedPauseMs=Date.parse(round.restoredAt)-Date.parse(round.pausedAt);assert(round.observedPauseMs>=pauseMs);assert.equal((await inspect()).State.Paused,false);console.log('RESTORED shared SFTP after '+pauseMs+'ms');await save();
    const outcomes=await settled;for(const r of outcomes)if(r.status==='rejected')throw r.reason;
   }finally{
    if(paused){assertOwnedBackend(await inspect(),expected,current.runId);await docker(['unpause',expected.id]);round.restoredInFinallyAt=new Date().toISOString();}
    // A completed guard must not affect the next intentionally paused round.
    if(!(await inspect()).State.Paused)guard.kill();
    await save();
   }
   // No blind repeat of uncertain completion. The ordinary worker reconciles
   // the accepted payload on its original durable upload identity.
   await waitFor(async()=>{
    const states=await Promise.all(owners.map(async x=>{const r=await api('/uploads/'+x.proof.id,{method:'HEAD',jar});assert.equal(r.status,204);const state=r.headers.get('Upload-Status');x.proof.finalState=state;assert.notEqual(state,'failed_final');return state;}));await save();return states.every(x=>x==='active');
   },'owner completions');
   const actual=await children(root.id);assert.equal(actual.length,9,'no extra owner copies after recovery');
   for(const x of owners){const matches=actual.filter(f=>f.name===x.proof.name);assert.equal(matches.length,1);x.proof.resourceId=matches[0].id;await download(jar,matches[0],x.bytes);const v=await json('/files/'+matches[0].id+'/versions',{jar});assert.equal((v.items??v).length,1,'no duplicate owner version');}
   await waitFor(async()=>{const states=await Promise.all(drops.map(async x=>{const s=await json('/drop/uploads/'+x.proof.id+'/status',{jar:x.jar});x.proof.finalState=s.state;return s.state;}));await save();return states.every(s=>s==='stored');},'Drop drain');
   const dropFiles=await children('00000000-0000-7000-8000-000000000002');
   for(const x of drops){const matches=dropFiles.filter(f=>f.name===x.proof.name);assert.equal(matches.length,1,'Drop published once');x.proof.resourceId=matches[0].id;await download(jar,matches[0],x.bytes);}
   const reread=await api('/public/shares/'+share.token+'/content',{jar:new Map()});assert.equal(reread.status,200);assert.equal(sha(Buffer.from(await reread.arrayBuffer())),sha(knownBytes));await download(jar,known,knownBytes);
   assertOwnedBackend(await inspect(),expected,current.runId);assert.equal((await inspect()).State.Paused,false);
   round.status='PASS';round.finishedAt=new Date().toISOString();await save();await pass('RES-05','shared SFTP stall and original-ID recovery across owner, Drop and sharing',{pauseMs,ownerFiles:8,dropFiles:8,guestRequests:8,syncBackendShared:false,evidence:output+'/backend-fault.json'});
  }
  evidence.status='PASS';
 }catch(e){evidence.status='FAIL';evidence.error=String(e);throw e;}finally{evidence.finishedAt=new Date().toISOString();await save();}
}
