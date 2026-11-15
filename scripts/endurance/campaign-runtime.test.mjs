import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {CampaignPolicy,preparedCampaign,DURATION_MS} from './campaign-policy.mjs';
const base='C:/.projects/exocortex/.audit/2026-10-15/endurance-6h';
const wrapper='C:/.projects/exocortex/saturn/scripts/endurance/campaign-job.mjs';
async function job(laneId,attemptIndex=0,exitCode=0,executable=process.execPath){const dir=base+'/controller-qualification/'+randomUUID();await fs.mkdir(dir,{recursive:true});const spec={runId:'qualification',cycleId:'last',laneId,attemptIndex,executable,args:['-e',`setTimeout(()=>process.exit(${exitCode}),150)`],cwd:base,env:{}};await fs.writeFile(dir+'/job.json',JSON.stringify(spec));const child=spawn(process.execPath,[wrapper,dir+'/job.json'],{windowsHide:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});return {dir,result:JSON.parse(await fs.readFile(dir+'/job-result.json','utf8'))};}
test('real parallel jobs survive a coordinator reconstruction and drain the original admitted cycle',async()=>{
 const at=1000000000000,p=new CampaignPolicy(preparedCampaign('qualification'),{wallMs:at,monotonicMs:0});p.start({wallMs:at,monotonicMs:0},true);
 p.admit({cycleId:'last',cohort:'fixture',seed:'fixed',lanes:['A','B','C'].map(id=>({id,scenarios:['fixture']}))},{wallMs:at+DURATION_MS-1,monotonicMs:DURATION_MS-1});
 const running=['A','B','C'].map(id=>job(id));
 const resumed=new CampaignPolicy(JSON.parse(JSON.stringify(p.snapshot())),{wallMs:at+DURATION_MS+1,monotonicMs:0});
 for(const {dir,result} of await Promise.all(running)){assert.equal(result.exitCode,0);resumed.finishLane(result.cycleId,result.laneId,result.attemptIndex,'PASS',dir+'/job-result.json',{wallMs:at+DURATION_MS+2,monotonicMs:1});}
 assert.equal(resumed.closeCycle('last',{wallMs:at+DURATION_MS+3,monotonicMs:2}).status,'PASS');
 assert.throws(()=>resumed.admit({},{wallMs:at+DURATION_MS+4,monotonicMs:3}),/admission closed/);
});
test('nonzero and failed process creation produce durable failure evidence',async()=>{
 const normal=await job('failure',0,7);assert.equal(normal.result.exitCode,7);
 const missing=await job('missing',0,0,'C:/nonexistent-owned-endurance-command.exe');assert.equal(missing.result.exitCode,-1);assert.match(missing.result.error,/ENOENT/);
});
test('attempt identity is retained across a real failed process and repair',async()=>{
 const failed=await job('repair',0,3),fixed=await job('repair',1,0);assert.equal(failed.result.attemptIndex,0);assert.equal(failed.result.exitCode,3);assert.equal(fixed.result.attemptIndex,1);assert.equal(fixed.result.exitCode,0);assert.notEqual(failed.result.pid,fixed.result.pid);
});
