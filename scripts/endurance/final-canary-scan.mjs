// Final read-only check of exportable text evidence, not a new stress scenario.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import assert from 'node:assert/strict';
const base='C:/.projects/exocortex/.audit/2026-10-15/endurance-6h';
const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const current=await read(base+'/current.json');assert.equal(current.active,null);assert.equal(current.status,'FINISHED');
const secrets=new Set(),sourceFiles=[];
function add(value){if(typeof value==='string'&&value.length>=16&&value.length<=4096&&!/\s/.test(value))secrets.add(value);}
function collect(value){if(!value||typeof value!=='object')return;for(const [key,v] of Object.entries(value)){if(typeof v==='object')collect(v);else if(/^(?:token|accessToken|accessKey|password|secret|credential|authorization|cookie)$/i.test(key)){add(v);if(typeof v==='string'&&v.startsWith('Bearer '))add(v.slice(7));}}}
const env=await read(base+'/private/environment.json');
for(const [k,v] of Object.entries(env))if(/(?:TOKEN|PEPPER|PASSWORD)_FILE$/.test(k)&&v){add((await fs.readFile(v,'utf8')).trim());sourceFiles.push(k);}
const cycles=await fs.readdir(base+'/cycles');
for(const cycle of cycles){const dir=base+'/cycles/'+cycle+'/SYNC';for(const attempt of await fs.readdir(dir).catch(()=>[])){try{collect(await read(dir+'/'+attempt+'/clients.private.json'));sourceFiles.push(cycle+'/'+attempt);}catch(e){if(e.code!=='ENOENT')throw e;}}}
assert(secrets.size>0);
const report={runId:current.runId,startedAt:new Date().toISOString(),status:'RUNNING',scope:'Known fixture token/pepper/password canaries in exportable log/md/json/trx text evidence. Private configurations, cookies, databases, binaries, source trees and retained state excluded. Not a proof of absence of every possible secret.',canaries:secrets.size,sourceFiles:sourceFiles.length,files:0,bytes:0,matches:[],excluded:0};
const patterns=[...secrets].map(s=>Buffer.from(s)),overlap=Math.max(...patterns.map(s=>s.length))-1;
async function visit(dir){for(const ent of await fs.readdir(dir,{withFileTypes:true})){
 const file=path.join(dir,ent.name),rel=path.relative(base,file).replaceAll('\\','/');
 if(ent.isSymbolicLink()){report.excluded++;continue;}
 if(ent.isDirectory()){
  if(/^(?:private|bin|next-tier|tier\d+|node_modules|\.git)$/.test(ent.name)||/(?:state|payload|windows-tests|pluto-before|tests-before|cancel-create-bin|api-dist|api-before)/i.test(ent.name)){report.excluded++;continue;}
  await visit(file);continue;
 }
 if(!/\.(?:log|md|json|trx)$/i.test(ent.name)||/(?:private|cookie|environment|config|secret|token|fixture|runtime-manifest)/i.test(ent.name)||ent.name==='final-canary-scan.json'){report.excluded++;continue;}
 report.files++;let tail=Buffer.alloc(0),found=false;
 for await(const chunk of createReadStream(file)){report.bytes+=chunk.length;const data=Buffer.concat([tail,chunk]);if(patterns.some(p=>data.includes(p))){found=true;break;}tail=data.subarray(Math.max(0,data.length-overlap));}
 if(found)report.matches.push({file:rel,reason:'known secret canary found; value intentionally omitted'});
}}
await visit(base);report.status=report.matches.length?'FAIL':'PASS';report.finishedAt=new Date().toISOString();
await fs.writeFile(base+'/final-canary-scan.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,canaries:report.canaries,files:report.files,bytes:report.bytes,matches:report.matches.length}));
if(report.status!=='PASS')process.exitCode=1;
