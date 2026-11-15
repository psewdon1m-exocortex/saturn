import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root='C:/.projects/exocortex',repo=root+'/saturn',out=root+'/.audit/2026-10-15/endurance-6h';
const env={...process.env,...JSON.parse(await fs.readFile(out+'/private/environment.json','utf8'))};
const fixture=JSON.parse(await fs.readFile(out+'/fixture-ready.json','utf8'));
const children=[];let web;
const token=randomBytes(32).toString('base64url');
const kernel=http.createServer((q,s)=>{if(q.method!=='POST'||q.url!=='/api/v1/register/resolve'||q.headers.authorization!==`Bearer ${token}`){s.writeHead(404).end();return;}const u=new URL(env.PUBLIC_ORIGIN);s.writeHead(200,{'Content-Type':'application/json'});s.end(JSON.stringify({schema:'exocortex.register.resolution.v1',values:{'services.saturn.sni':{value:u.hostname,secret:false},'services.saturn.port':{value:u.port,secret:false}}}));});
await new Promise(r=>kernel.listen(0,'127.0.0.1',r));
env.KERNEL_URL='http://127.0.0.1:'+kernel.address().port;env.KERNEL_TOKEN_FILE=out+'/private/kernel-token';await fs.writeFile(env.KERNEL_TOKEN_FILE,token);
function start(name,file){const child=spawn(process.execPath,[file],{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});const log=createWriteStream(out+'/'+name+'.log',{flags:'a'});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});children.push({name,child});child.once('exit',(code)=>{log.end();console.error(name+' exited '+code);});return child;}
async function health(url){for(let i=0;i<180;i++){try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});if(r.ok)return;}catch{}if(children.some(x=>x.child.exitCode!==null))throw Error('Stand child exited');await delay(500);}throw Error('Readiness timeout '+url);}
try{
 start('worker',repo+'/apps/worker/dist/main.js');start('api',repo+'/apps/api/dist/main.js');
 const require=createRequire(repo+'/apps/web/package.json');const {preview}=await import(pathToFileURL(require.resolve('vite')));
 web=await preview({root:repo+'/apps/web',configFile:false,preview:{host:'127.0.0.1',port:Number(new URL(env.PUBLIC_ORIGIN).port),strictPort:true,proxy:{'/api':fixture.apiOrigin,'/health':fixture.apiOrigin,'/a/':fixture.apiOrigin}},logLevel:'error'});
 await health(fixture.apiOrigin+'/health/ready');await health(env.PUBLIC_ORIGIN);
 await fs.writeFile(out+'/stand-ready.json',JSON.stringify({at:new Date().toISOString(),pid:process.pid,children:children.map(x=>({name:x.name,pid:x.child.pid})),...fixture},null,2));
 console.log('PASS full API/worker/browser stand ready');
 let stopping=false;process.on('SIGTERM',()=>stopping=true);process.on('SIGINT',()=>stopping=true);
 while(!stopping){if(children.some(x=>x.child.exitCode!==null))throw Error('Stand child died');try{await fs.access(out+'/stand-stop');break;}catch{}await delay(1000);}
}finally{await web?.httpServer.close();for(const {child} of children)if(child.exitCode===null)child.kill();kernel.closeAllConnections();kernel.close();}
