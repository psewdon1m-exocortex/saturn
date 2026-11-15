import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import {extendedProduct} from './product-extended.mjs';
import {backendFaultFlow} from './product-backend-fault.mjs';
import {transferLifecycleFlow} from './product-transfer-lifecycle.mjs';
import {publicBrowserFlows,dropCapacityFlow} from './product-browser.mjs';
const base='C:/.projects/exocortex/.audit/2026-10-15/endurance-6h';
const output=process.argv[2];if(!output?.startsWith(base+'/'))throw Error('Owned evidence path required');
await fs.mkdir(output,{recursive:true});
const fixture=JSON.parse(await fs.readFile(base+'/stand-ready.json','utf8'));
const env=JSON.parse(await fs.readFile(base+'/private/environment.json','utf8'));
const count=Number(process.env.ENDURANCE_FILES??8),parallel=Number(process.env.ENDURANCE_CONCURRENCY??2),tier=Number(process.env.ENDURANCE_TIER??0);
assert(count>=1&&count<=100000&&parallel>=1&&parallel<=128);
const ownerKey=(await fs.readFile(env.OWNER_BOOTSTRAP_TOKEN_FILE,'utf8')).trim();
const seed=process.env.ENDURANCE_SEED??path.basename(path.dirname(path.dirname(output))),sha=b=>createHash('sha256').update(b).digest('hex'),seedName=sha(seed).slice(0,16);
const report={schema:'saturn.endurance-product.v1',startedAt:new Date().toISOString(),seed,tier,count,parallel,checks:[],status:'RUNNING'};
const manifest=[],latencies=[];let browser,extended;
let finishBulk;const bulkDone=new Promise(resolve=>{finishBulk=resolve;});
let saves=Promise.resolve();function save(){const body=JSON.stringify(report,null,2);saves=saves.then(async()=>{await fs.writeFile(output+'/result.json.tmp',body);await fs.rename(output+'/result.json.tmp',output+'/result.json');});return saves;}
async function pass(id,name,detail={}){report.checks.push({id,name,status:'PASS',at:new Date().toISOString(),...detail});await save();console.log('PASS '+id+' '+name);}
async function api(route,{method='GET',jar,json,body,headers={}}={}){
 const h=new Headers(headers);h.set('User-Agent','endurance-owned/1');if(jar?.size)h.set('Cookie',[...jar].map(([k,v])=>k+'='+v).join('; '));
 if(!['GET','HEAD'].includes(method)){h.set('Origin',fixture.publicOrigin);if(!h.has('Idempotency-Key'))h.set('Idempotency-Key','endurance-'+randomUUID());const csrf=(route.startsWith('/drop')?jar?.get('vault_drop_csrf_dev'):undefined)??jar?.get('vault_csrf_dev');if(csrf)h.set('X-Vault-CSRF',csrf);}
 if(json!==undefined){h.set('Content-Type','application/json');body=JSON.stringify(json);}
 const started=performance.now();const response=await fetch(fixture.apiOrigin+'/api/v1'+route,{method,headers:h,body,signal:AbortSignal.timeout(120000)});latencies.push(performance.now()-started);
 if(jar)for(const c of response.headers.getSetCookie()){const pair=c.split(';')[0],n=pair.indexOf('=');if(n>0)jar.set(pair.slice(0,n),pair.slice(n+1));}
 return response;
}
async function json(route,options={},expected=[200,201]){
 const resourceMutation=route.startsWith('/resources/')&&['POST','DELETE'].includes(options.method);
 if(resourceMutation)options={...options,headers:{'Idempotency-Key':'endurance-'+randomUUID(),...options.headers}};
 for(let attempt=0;;attempt++){
  const r=await api(route,options),text=await r.text();
  // Only an explicit pre-effect lock refusal is repeatable here. Transport
  // uncertainty and every other failure still stop the test immediately.
  if(resourceMutation&&r.status===423&&JSON.parse(text).code==='locked'&&attempt<120){
   report.expectedContention??=[];report.expectedContention.push({route,key:options.headers['Idempotency-Key'],attempt,at:new Date().toISOString()});await save();await delay(500);continue;
  }
  assert(expected.includes(r.status),`${options.method??'GET'} ${route.replace(/\/public\/shares\/[^/]+/,'/public/shares/[redacted]')}: ${r.status} ${text.slice(0,300)}`);return text?JSON.parse(text):undefined;
 }
}
async function folder(jar,name,parentId='00000000-0000-7000-8000-000000000004'){return json('/folders',{method:'POST',jar,json:{parentId,name}});}
async function upload(jar,parentId,filename,bytes,overwriteResourceId){const key='endurance-'+randomUUID(),input={parentId,filename,expectedSize:bytes.length,expectedSha256:sha(bytes),...(overwriteResourceId?{overwriteResourceId}:{})};
 const s=await json('/uploads',{method:'POST',jar,json:input,headers:{'Idempotency-Key':key}});
 const again=await json('/uploads',{method:'POST',jar,json:input,headers:{'Idempotency-Key':key}});assert.equal(again.id,s.id,'reservation idempotency');
 for(let offset=0;offset<bytes.length;offset+=1048576){const chunk=bytes.subarray(offset,offset+1048576);const r=await api('/uploads/'+s.id,{method:'PATCH',jar,body:chunk,headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':String(offset),'Content-Length':String(chunk.length)}});assert.equal(r.status,204,'append');await r.arrayBuffer();}
 const result=await json('/uploads/'+s.id+'/complete',{method:'POST',jar,json:{}});return result.resource;
}
async function download(jar,file,bytes){const r=await api('/files/'+file.id+'/content',{jar});assert.equal(r.status,200);assert.equal(sha(Buffer.from(await r.arrayBuffer())),sha(bytes),'download SHA');}
async function repairPublicBrowserAndCapacity(jar){
 const retainedFile=path.dirname(output)+'/attempt-1/result.json',prior=JSON.parse(await fs.readFile(retainedFile,'utf8'));
 assert.equal(prior.seed,seed);assert(prior.checks.some(x=>x.id==='SAT-03'&&x.name==='complete SHA readback'&&x.status==='PASS'));
 report.checks.push(...prior.checks.filter(x=>x.status==='PASS').map(x=>({...x,reusedFrom:retainedFile})));
 report.retainedGatesFrom=retainedFile;report.targetId=prior.targetId;await save();
 const target={id:prior.targetId};browser=await chromium.launch({headless:true});const context=await browser.newContext(),page=await context.newPage();
 await page.goto(fixture.publicOrigin,{waitUntil:'networkidle'});await page.getByLabel('Access Key').fill(ownerKey);await page.getByRole('button',{name:'Enter service'}).click();await page.getByRole('button',{name:'Storage',exact:true}).waitFor();
 await publicBrowserFlows({browser,page,fixture,jar,json,folder,upload,download,pass,sha,target,output,seed});
 await dropCapacityFlow({api,json,jar,pass,sha,download,output,seed});
 const original=JSON.parse(await fs.readFile(path.dirname(output)+'/attempt-0/expected-manifest.json','utf8')).find(x=>x.size>0),start=performance.now();
 const content=await api('/files/'+original.id+'/content',{jar});assert.equal(content.status,200);assert.equal(sha(Buffer.from(await content.arrayBuffer())),original.sha256);await pass('RES-06','retained original small SHA control after browser/capacity repair',{latencyMs:performance.now()-start});
 report.status='PASS';
}
try{
 const jar=new Map();await json('/auth/login',{method:'POST',jar,json:{accessKey:ownerKey}});await pass('SAT-01','owner login');
 if(output.includes('/cycle-0009/PRODUCT/')&&Number(path.basename(output).replace('attempt-',''))>=2){await repairPublicBrowserAndCapacity(jar);}else{
 const target=await folder(jar,'endurance-'+seedName+'-'+randomUUID().slice(0,6));report.targetId=target.id;
 if(tier>=10){await transferLifecycleFlow({api,json,folder,upload,download,pass,sha,jar,target,seed,output});await backendFaultFlow({api,json,folder,upload,download,pass,sha,jar,target,seed,output});}
 if(tier>=6)extended=extendedProduct({api,json,folder,upload,download,pass,sha,jar,target,seed,tier,output,bulkDone}).then(()=>null,error=>error);
 let retained;const firstAttempt=path.dirname(output)+'/attempt-0';
 if(path.basename(output)!=='attempt-0'&&path.basename(output).startsWith('attempt-')){const original=JSON.parse(await fs.readFile(firstAttempt+'/result.json','utf8'));if(original.seed===seed&&original.checks.some(x=>x.id==='SAT-03'&&x.name==='complete SHA readback'&&x.status==='PASS')){retained=JSON.parse(await fs.readFile(firstAttempt+'/expected-manifest.json','utf8'));assert.equal(retained.length,count);report.retainedCorpusFrom=firstAttempt;}}
 const files=[];let next=0;
 const bulkResults=await Promise.allSettled(Array.from({length:parallel},async()=>{while(next<count){const i=next++,size=i===0?0:i%19===0?1048576:1024+(i%8)*4096;const bytes=Buffer.alloc(size,i%251);if(size)Buffer.from(seed+':'+i).copy(bytes);
 const filename=i===0?'пустой.md':`файл-${String(i).padStart(5,'0')}.bin`;const file=retained?retained.find(f=>f.name===filename):await upload(jar,target.id,filename,bytes);assert(file);if(retained){assert.equal(file.sha256,sha(bytes));assert.equal(file.size,size);}await download(jar,file,bytes);files[i]={file,bytes};manifest.push({id:file.id,name:filename,size,sha256:sha(bytes)});
 if((i+1)%32===0){report.progress={uploaded:manifest.length,total:count,at:new Date().toISOString()};await save();console.log('PROGRESS '+manifest.length+'/'+count);}
 }}));finishBulk();for(const result of bulkResults)if(result.status==='rejected')throw result.reason;
 await fs.writeFile(output+'/expected-manifest.json',JSON.stringify(manifest,null,2));await pass('SAT-02','parallel uploads and idempotent reservation',{files:count,bytes:manifest.reduce((n,x)=>n+x.size,0),reused:!!retained,...(retained?{evidence:firstAttempt+'/result.json'}:{})});await pass('SAT-03','complete SHA readback',{files:count,retainedOriginals:!!retained});
 const item=files.find(x=>x.bytes.length>8)??{file:await upload(jar,target.id,'range.bin',Buffer.from('range-payload')),bytes:Buffer.from('range-payload')};
 const range=await api('/files/'+item.file.id+'/content',{jar,headers:{Range:'bytes=1-7'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),item.bytes.subarray(1,8));
 const invalid=await api('/files/'+item.file.id+'/content',{jar,headers:{Range:`bytes=${item.bytes.length+100}-`}});assert.equal(invalid.status,416);await invalid.arrayBuffer();await pass('SAT-03','Range and invalid Range');
 const destination=await folder(jar,'mutations',target.id);const copied=await json('/resources/'+item.file.id+'/copy',{method:'POST',jar,json:{parentId:destination.id,name:'copy.bin'}});const copy=copied.resource??copied;assert.notEqual(copy.id,item.file.id);await download(jar,copy,item.bytes);
 const moved=await json('/resources/'+copy.id+'/move',{method:'POST',jar,json:{parentId:target.id,name:'renamed.bin'}});assert.equal((moved.resource??moved).id,copy.id);await download(jar,copy,item.bytes);await pass('SAT-04','folder/copy/move/rename identity');
 await json('/resources/'+copy.id,{method:'DELETE',jar},[200,204]);await json('/resources/'+copy.id+'/restore',{method:'POST',jar,json:{}});await download(jar,copy,item.bytes);await pass('SAT-05','trash and restore readback');
 const versions=await json('/files/'+item.file.id+'/versions',{jar});assert(Array.isArray(versions)||Array.isArray(versions.items));await pass('SAT-06','version history readable');
 if(tier>=4){
  const old=Buffer.from('version one '+seed),newBytes=Buffer.from('version two '+seed);
  const v=await upload(jar,target.id,'versioned.txt',old);const history=await json('/files/'+v.id+'/versions',{jar});const original=(history.items??history)[0];assert(original?.id);
  const replacement=await upload(jar,target.id,'versioned.txt',newBytes,v.id);assert.equal(replacement.id,v.id);await download(jar,v,newBytes);
  await json('/files/'+v.id+'/versions/'+original.id+'/restore',{method:'POST',jar,json:{}});await download(jar,v,old);await pass('SAT-06','overwrite and restore prior version with SHA');
 }
 const password='fixture-'+randomUUID();const share=await json('/shares',{method:'POST',jar,json:{resourceId:item.file.id,mode:'download',password}});const guest=new Map();
 const prefix='/public/shares/'+share.token;await json(prefix,{jar:guest});const denied=await api(prefix+'/content',{jar:guest});assert([401,403,404].includes(denied.status));await denied.arrayBuffer();
 await json(prefix+'/unlock',{method:'POST',jar:guest,json:{password}});const shared=await api(prefix+'/content',{jar:guest});assert.equal(shared.status,200);assert.equal(sha(Buffer.from(await shared.arrayBuffer())),sha(item.bytes));await pass('SHARE-01','public capability download SHA');await pass('SHARE-02','password gate');
 const other=await api(prefix+'/content/'+files[0].file.id,{jar:guest});assert([400,403,404].includes(other.status));await other.arrayBuffer();await pass('SHARE-04','sibling denied');
 await json('/shares/'+share.share.id,{method:'DELETE',jar},[200,204]);const revoked=await api(prefix+'/content',{jar:guest});assert([401,403,404,410].includes(revoked.status));await revoked.arrayBuffer();await pass('SHARE-03','revocation blocks further content');
 const code=await json('/drop/codes',{method:'POST',jar,json:{}});const dropJar=new Map();await json('/drop/redeem',{method:'POST',jar:dropJar,json:{code:code.code}});
 const forbidden=await api('/folders/'+target.id+'/children',{jar:dropJar});assert([401,403].includes(forbidden.status));await forbidden.arrayBuffer();await pass('DROP-01','code redeem and owner scope denied');
 const dropBytes=Buffer.from('drop-content-'+seed),dropName='drop-'+seedName+'-'+randomUUID().slice(0,8)+'.txt';const drop=await json('/drop/uploads',{method:'POST',jar:dropJar,headers:{'Idempotency-Key':'drop-'+randomUUID()},json:{filename:dropName,expectedSize:dropBytes.length,expectedSha256:sha(dropBytes)}});
 const appended=await api('/drop/uploads/'+drop.id,{method:'PATCH',jar:dropJar,body:dropBytes,headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':'0','Content-Length':String(dropBytes.length)}});assert.equal(appended.status,204);await appended.arrayBuffer();
 await json('/drop/complete',{method:'POST',jar:dropJar,json:{uploadId:drop.id}});
 let status;for(let i=0;i<120;i++){status=await json('/drop/uploads/'+drop.id+'/status',{jar:dropJar});if(['STORED','stored','COMPLETED','completed'].includes(status.state??status.status))break;await delay(500);}report.dropStatus=status;
 assert(['STORED','stored','COMPLETED','completed'].includes(status.state??status.status),'Drop did not durably store');await pass('DROP-03','buffer drain reaches stored',{uploadId:drop.id});
 const freshJar=new Map(dropJar);await json('/drop/session',{jar:freshJar});await json('/drop/uploads',{jar:freshJar});await pass('DROP-02','session/queue refresh');
 async function children(id){const all=[];for(let offset=0;;offset+=500){const r=await json('/folders/'+id+'/children?offset='+offset+'&limit=500',{jar}),page=r.items??r;all.push(...page);if(page.length<500)return all;}}
 async function verifyDrop(name,bytes){const roots=await children('00000000-0000-7000-8000-000000000002'),matches=roots.filter(x=>x.name===name&&x.type==='file');for(const date of roots.filter(x=>x.type==='folder'&&/^\d{4}-\d{2}-\d{2}$/.test(x.name)))matches.push(...(await children(date.id)).filter(x=>x.name===name));assert.equal(matches.length,1,'Stored drop must be owner-visible exactly once in Drop Point');await download(jar,matches[0],bytes);return matches[0].id;}
 if(tier>=4){report.dropReadback={resourceId:await verifyDrop(dropName,dropBytes),name:dropName,size:dropBytes.length,sha256:sha(dropBytes)};await pass('DROP-03','independent owner SHA readback after stored');
  if(path.basename(output)!=='attempt-0'){const original=JSON.parse(await fs.readFile(path.dirname(output)+'/attempt-0/result.json','utf8'));if(original.dropStatus?.filename){await verifyDrop(original.dropStatus.filename,Buffer.from('drop-content-'+original.seed));await pass('DROP-03','retained original failed-attempt drop SHA readback');}}
 }
 browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();await page.goto(fixture.publicOrigin,{waitUntil:'networkidle'});await page.getByLabel('Access Key').fill(ownerKey);await page.getByRole('button',{name:'Enter service'}).click();await page.getByRole('button',{name:'Storage',exact:true}).waitFor({timeout:15000});await page.screenshot({path:output+'/owner-browser.png',fullPage:true});await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:'Storage',exact:true}).waitFor();await pass('SAT-01','actual Chromium login and refresh');
 if(tier>=4){
  const uiFolder=await folder(jar,'browser',target.id),parent=await json('/resources/00000000-0000-7000-8000-000000000004',{jar});
  await page.goto(fixture.publicOrigin+'/storage-new/'+[parent.name,target.name,uiFolder.name].map(encodeURIComponent).join('/'),{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'Upload files',exact:true}).waitFor();
  const picked=[{name:'picker-кириллица.md',mimeType:'text/markdown',buffer:Buffer.from('picker '+seed)},{name:'empty.txt',mimeType:'text/plain',buffer:Buffer.alloc(0)}];
  await page.getByLabel('Choose files to upload').setInputFiles(picked);
  async function verifyUi(expected){for(let n=0;n<120;n++){const actual=await children(uiFolder.id);if(expected.every(x=>actual.some(f=>f.name===x.name))){for(const x of expected){const found=actual.filter(f=>f.name===x.name);assert.equal(found.length,1);await download(jar,found[0],x.buffer);}return;}await delay(250);}throw Error('Browser upload not committed');}
  await verifyUi(picked);await pass('SAT-02','Chromium multiple file picker and zero-byte SHA readback');
  const dropped={name:'dragged-данные.md',buffer:Buffer.from('drag drop '+seed)};
  const data=await page.evaluateHandle(({name,bytes})=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],name,{type:'text/markdown'}));return dt;},{name:dropped.name,bytes:[...dropped.buffer]});
  await page.locator('section.storage-new').dispatchEvent('drop',{dataTransfer:data});await data.dispose();await verifyUi([dropped]);await page.reload({waitUntil:'networkidle'});await verifyUi([...picked,dropped]);await page.screenshot({path:output+'/browser-uploads.png',fullPage:true});await pass('SAT-02','Chromium drag/drop and refresh without duplicate files');
 }
 if(tier>=8)await publicBrowserFlows({browser,page,fixture,jar,json,folder,upload,download,pass,sha,target,output,seed});
 if(tier>=8)await dropCapacityFlow({api,json,jar,pass,sha,download,output,seed});
 const controlStart=performance.now();await download(jar,item.file,item.bytes);await json('/drop/buffer',{jar});await pass('RES-06','post-load small control SHA readback',{latencyMs:performance.now()-controlStart});
 if(extended){const error=await extended;if(error)throw error;}
 report.status='PASS';
 }
}catch(error){report.status='FAIL';report.error=String(error);console.error(String(error));process.exitCode=1;}finally{finishBulk();if(extended){const error=await extended;if(error){report.status='FAIL';report.error??=String(error);process.exitCode=1;}}await browser?.close();latencies.sort((a,b)=>a-b);report.metrics={requestHeaderLatencyMs:{p50:latencies[Math.floor(latencies.length*.50)],p95:latencies[Math.floor(latencies.length*.95)],p99:latencies[Math.floor(latencies.length*.99)]},requests:latencies.length,memory:process.memoryUsage()};report.finishedAt=new Date().toISOString();await save();}
