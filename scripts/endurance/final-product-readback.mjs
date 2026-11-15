// Final, read-only content verification of every retained owner bulk manifest.
// Login is fixture-local; the script never changes resources or sync state.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const base='C:/.projects/exocortex/.audit/2026-10-15/endurance-6h';
const read=async p=>JSON.parse((await fs.readFile(p,'utf8')).replace(/^\uFEFF/,''));
const current=await read(base+'/current.json');
assert.equal(current.active,null,'Finish the admitted cycle first');
assert(Date.now()>=Date.parse(current.deadline),'Final readback is only after the fixed deadline');
const fixture=await read(base+'/stand-ready.json'),env=await read(base+'/private/environment.json');
const key=(await fs.readFile(env.OWNER_BOOTSTRAP_TOKEN_FILE,'utf8')).trim();
const login=await fetch(fixture.apiOrigin+'/api/v1/auth/login',{method:'POST',headers:{Origin:fixture.publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({accessKey:key}),signal:AbortSignal.timeout(30000)});
assert([200,201].includes(login.status));
const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');await login.arrayBuffer();
const originals=new Map(),manifests=[];
for(const cycle of await fs.readdir(base+'/cycles')) {
 const lane=path.join(base,'cycles',cycle,'PRODUCT');
 for(const attempt of await fs.readdir(lane).catch(()=>[])) {
  const file=path.join(lane,attempt,'expected-manifest.json');let rows;
  try{rows=await read(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  manifests.push({file,count:rows.length});
  for(const row of rows){const existing=originals.get(row.id);if(existing){assert.equal(existing.sha256,row.sha256);assert.equal(existing.size,row.size);}else originals.set(row.id,{...row,evidence:file});}
 }
}
const report={startedAt:new Date().toISOString(),runId:current.runId,status:'RUNNING',scope:'All unique IDs in retained PRODUCT expected-manifest.json files; other mutation/share/drop/client evidence is reviewed separately.',manifests,expected:originals.size,verified:0,bytes:0,failures:[]};
const out=base+'/final-product-readback.json',items=[...originals.values()];let next=0,saves=Promise.resolve();
function save(){const body=JSON.stringify(report,null,2);saves=saves.then(async()=>{await fs.writeFile(out+'.tmp',body);await fs.rename(out+'.tmp',out);});return saves;}
await save();
await Promise.all(Array.from({length:8},async()=>{while(next<items.length){const row=items[next++];try{
 const response=await fetch(fixture.apiOrigin+'/api/v1/files/'+row.id+'/content',{headers:{Cookie:cookie},signal:AbortSignal.timeout(120000)});assert.equal(response.status,200);
 const hash=createHash('sha256');let size=0;for await(const chunk of response.body){hash.update(chunk);size+=chunk.length;}
 assert.equal(size,row.size);assert.equal(hash.digest('hex'),row.sha256);report.verified++;report.bytes+=size;
 }catch(error){report.failures.push({id:row.id,evidence:row.evidence,error:String(error)});}
 if((report.verified+report.failures.length)%256===0){await save();console.log(JSON.stringify({verified:report.verified,total:report.expected,failures:report.failures.length}));}
}}));
report.status=report.failures.length===0&&report.verified===report.expected&&report.expected>0?'PASS':'FAIL';report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,verified:report.verified,bytes:report.bytes,failures:report.failures.length}));if(report.status!=='PASS')process.exitCode=1;
