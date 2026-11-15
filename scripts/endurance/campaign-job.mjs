import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
const base='C:/.projects/exocortex/.audit/2026-10-15/endurance-6h';
const file=path.resolve(process.argv[2]??'');if(!file.toLowerCase().startsWith(path.resolve(base).toLowerCase()+path.sep))throw Error('Owned job specification required');
const spec=JSON.parse(await fs.readFile(file,'utf8')),dir=path.dirname(file);
const startedAt=new Date().toISOString();
async function atomic(name,value){const target=dir+'/'+name,temp=target+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2));await fs.rename(temp,target);}
const log=createWriteStream(dir+'/process.log');let lastOutputAt=Date.now();
const child=spawn(spec.executable,spec.args,{cwd:spec.cwd,env:{...process.env,...spec.env},windowsHide:true,stdio:['ignore','pipe','pipe']});
let error;const completion=new Promise(resolve=>{child.once('error',e=>{error=String(e);resolve(-1);});child.once('exit',resolve);});
const identity={runId:spec.runId,cycleId:spec.cycleId,laneId:spec.laneId,attemptIndex:spec.attemptIndex,pid:process.pid,childPid:child.pid,startedAt};
await atomic('job-started.json',identity);
for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{lastOutputAt=Date.now();log.write(bytes);});
const tick=setInterval(()=>atomic('job-heartbeat.json',{...identity,at:new Date().toISOString(),lastOutputAt:new Date(lastOutputAt).toISOString(),stalled:Date.now()-lastOutputAt>15*60*1000}).catch(()=>{}),5000);
const exitCode=await completion;clearInterval(tick);log.end();
await atomic('job-result.json',{...identity,finishedAt:new Date().toISOString(),exitCode,...(error?{error}:{})});
process.exitCode=exitCode===0?0:1;
