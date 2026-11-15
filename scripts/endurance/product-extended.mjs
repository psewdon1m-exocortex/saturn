import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire('C:/.projects/exocortex/saturn/packages/archive/package.json');
const yauzl=require('yauzl');

export async function extendedProduct({api,json,folder,upload,download,pass,sha,jar,target,seed,tier,output,bulkDone}){
 const evidence={startedAt:new Date().toISOString(),status:'RUNNING',checks:[],drop:[],commands:[]};
 let saves=Promise.resolve();const save=()=>{const body=JSON.stringify(evidence,null,2);saves=saves.then(()=>fs.writeFile(output+'/extended-product.json',body));return saves;};
 async function check(id,name,detail={}){evidence.checks.push({id,name,...detail});await save();await pass(id,name,detail);}
 async function consumeDenied(response){assert([401,403,404,410].includes(response.status));await response.arrayBuffer();}
 async function mutation(route,method,input){const key=randomUUID(),command={route,method,input,key,lockedResponses:0,status:'PENDING'};evidence.commands.push(command);await save();let drained=false;for(let n=0;n<120;n++){const response=await api(route,{method,jar,json:input,headers:{'Idempotency-Key':key}});const text=await response.text();if(response.status===423){assert.equal(JSON.parse(text).code,'locked');command.lockedResponses++;await save();if(!drained){await bulkDone;drained=true;}else await delay(500);continue;}assert([200,201,204].includes(response.status),`Explicit ${method} retry returned ${response.status}: ${text.slice(0,200)}`);command.status='PASS';await save();return text?JSON.parse(text):undefined;}throw Error('Mutation remained locked after load drained');}
 async function listAll(route){const all=[];for(let offset=0;;offset+=500){const r=await json(route+`?offset=${offset}&limit=500`,{jar}),page=r.items??r;all.push(...page);if(page.length<500)return all;}}
 async function ownerDrop(name,bytes){const all=await listAll('/folders/00000000-0000-7000-8000-000000000002/children');const match=all.filter(x=>x.name===name);assert.equal(match.length,1);await download(jar,match[0],bytes);return match[0].id;}
 const root=await folder(jar,'mixed-'+randomUUID().slice(0,8),target.id),nested=await folder(jar,'nested',root.id);await folder(jar,'empty',root.id);
 const expected=new Map();const small=[];
 for(let i=0;i<6;i++){const name=i===0?'пустой.md':`shared-${i}.bin`,bytes=i===0?Buffer.alloc(0):Buffer.from((seed+':'+i).repeat(200));const parent=i<3?root:nested;const file=await upload(jar,parent.id,name,bytes);small.push({file,bytes});expected.set((i<3?'':'nested/')+name,sha(bytes));}
 const share=await json('/shares',{method:'POST',jar,json:{resourceId:root.id,mode:'download_folder'}}),prefix='/public/shares/'+share.token,guest=new Map();
 const quotaBytes=Buffer.from('quota '+seed),quotaFile=await upload(jar,target.id,'quota-'+randomUUID().slice(0,8)+'.txt',quotaBytes);
 await json(prefix,{jar:guest});
 async function guestRead(item){const r=await api(prefix+'/content/'+item.file.id,{jar:guest});assert.equal(r.status,200);assert.equal(sha(Buffer.from(await r.arrayBuffer())),sha(item.bytes));}
 const tasks=[(async()=>{
  const children=await json(prefix+'/children',{jar:guest});assert.equal(children.length,5);const descendants=await json(prefix+'/children?parentId='+nested.id,{jar:guest});assert.equal(descendants.length,3);
  const outsider=await upload(jar,target.id,'outside-'+randomUUID().slice(0,6)+'.txt',Buffer.from('forbidden sibling'));await consumeDenied(await api(prefix+'/content/'+outsider.id,{jar:guest}));
  await Promise.all(small.map(guestRead));await check('SHARE-01','folder guest browse and individual SHA downloads');await check('SHARE-04','folder capability denies sibling outside shared root');
  await json(prefix+'/package',{method:'POST',jar:guest,json:{}});let state;
  for(let n=0;n<240;n++){state=await json(prefix+'/package/status',{jar:guest});if(state.state==='ready')break;assert.equal(state.state,'preparing');await delay(500);}assert.equal(state.state,'ready');
  const head=await api(prefix+'/package',{method:'HEAD',jar:guest});assert.equal(head.status,200);assert(Number(head.headers.get('content-length'))>0);
  const response=await api(prefix+'/package',{jar:guest});assert.equal(response.status,200);const archive=Buffer.from(await response.arrayBuffer());assert.equal(archive.length,Number(head.headers.get('content-length')));await fs.writeFile(output+'/shared-package.zip',archive);
  const files=new Map(),dirs=[];
  await new Promise((resolve,reject)=>yauzl.fromBuffer(archive,{lazyEntries:true},(error,zip)=>{
   if(error)return reject(error);zip.on('error',reject);zip.on('end',resolve);zip.on('entry',entry=>{
    if(entry.fileName.endsWith('/')){dirs.push(entry.fileName);zip.readEntry();return;}
    zip.openReadStream(entry,(error,stream)=>{if(error)return reject(error);void(async()=>{const chunks=[];for await(const chunk of stream)chunks.push(chunk);assert(!files.has(entry.fileName),'duplicate ZIP entry');files.set(entry.fileName,sha(Buffer.concat(chunks)));zip.readEntry();})().catch(reject);});
   });zip.readEntry();
  }));
  assert.deepEqual([...files].sort(),[...expected].sort());assert(dirs.includes('empty/'));assert(dirs.includes('nested/'));await check('SHARE-01','folder ZIP exact paths/count/full SHA including empty folder',{files:files.size});
  const moved=await mutation('/resources/'+root.id+'/move','POST',{parentId:target.id,name:root.name+'-renamed'});assert.equal((moved.resource??moved).id,root.id);await Promise.all(small.map(guestRead));await check('SHARE-03','shared folder rename preserves identity; explicit same-key retry after 423 contention',{lockedResponses:evidence.commands[0].lockedResponses});
  await mutation('/resources/'+root.id,'DELETE');await consumeDenied(await api(prefix+'/content/'+small[1].file.id,{jar:guest}));await mutation('/resources/'+root.id+'/restore','POST',{});await guestRead(small[1]);await check('SHARE-03','trash blocks new guest reads; restore preserves SHA');
 })(),(async()=>{
  const sessions=[];
  for(let n=0;n<2;n++){const code=await json('/drop/codes',{method:'POST',jar,json:{}}),cookies=new Map(),session=await json('/drop/redeem',{method:'POST',jar:cookies,json:{code:code.code}});sessions.push({jar:cookies,session});}
  assert.notEqual(sessions[0].session.channelId,sessions[1].session.channelId);
  const uploads=[];
  for(const [channel,s] of sessions.entries())for(let i=0;i<Math.min(8,tier-3);i++){
   const bytes=Buffer.alloc(65536+i,channel*31+i);Buffer.from(seed).copy(bytes);const name=`mixed-${randomUUID()}.bin`,key=randomUUID(),input={filename:name,expectedSize:bytes.length,expectedSha256:sha(bytes)};
   const reserved=await json('/drop/uploads',{method:'POST',jar:s.jar,json:input,headers:{'Idempotency-Key':key}}),replayed=await json('/drop/uploads',{method:'POST',jar:s.jar,json:input,headers:{'Idempotency-Key':key}});assert.equal(reserved.id,replayed.id);uploads.push({...s,id:reserved.id,name,bytes,channel});
  }
  await consumeDenied(await api('/drop/uploads/'+uploads[0].id+'/status',{jar:sessions[1].jar}));
  const results=await Promise.allSettled(uploads.map(async u=>{
   const r=await api('/drop/uploads/'+u.id,{method:'PATCH',jar:u.jar,body:u.bytes,headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':'0','Content-Length':String(u.bytes.length)}});assert.equal(r.status,204);await r.arrayBuffer();await json('/drop/complete',{method:'POST',jar:u.jar,json:{uploadId:u.id}});
   let status;for(let n=0;n<240;n++){status=await json('/drop/uploads/'+u.id+'/status',{jar:u.jar});if(status.state==='stored')break;await delay(500);}assert.equal(status.state,'stored');const resourceId=await ownerDrop(u.name,u.bytes);evidence.drop.push({uploadId:u.id,resourceId,name:u.name,size:u.bytes.length,sha256:sha(u.bytes),channel:u.channel});
  }));for(const r of results)if(r.status==='rejected')throw r.reason;
  await check('DROP-02','parallel uploads across two isolated channels and idempotent reservations',{files:uploads.length});await check('DROP-03','all concurrent Drop files stored once and owner SHA verified',{files:uploads.length});
  for(const s of sessions){const list=await json('/drop/uploads',{jar:s.jar});assert.equal(list.length,uploads.filter(u=>u.session.channelId===s.session.channelId).length);}
  const s=sessions[0],cancelName='cancel-'+randomUUID()+'.txt',cancel=await json('/drop/uploads',{method:'POST',jar:s.jar,json:{filename:cancelName,expectedSize:3}});const patch=await api('/drop/uploads/'+cancel.id,{method:'PATCH',jar:s.jar,body:Buffer.from('ab'),headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':'0','Content-Length':'2'}});assert.equal(patch.status,204);await patch.arrayBuffer();const cancelled=await json('/drop/uploads/'+cancel.id,{method:'DELETE',jar:s.jar});assert.equal(cancelled.state,'cancelled');assert(!(await listAll('/folders/00000000-0000-7000-8000-000000000002/children')).some(x=>x.name===cancelName));await check('DROP-03','partial upload cancellation publishes no file');
  const before=(await json('/drop/uploads',{jar:s.jar})).length,limit=Math.min(s.session.maxBytes,s.session.maxFileBytes);assert(Number.isSafeInteger(limit));const tooBig=await api('/drop/uploads',{method:'POST',jar:s.jar,json:{filename:'oversize.bin',expectedSize:limit+1}});assert.equal(tooBig.status,413);await tooBig.arrayBuffer();assert.equal((await json('/drop/uploads',{jar:s.jar})).length,before);await check('DROP-04','configured maximum plus one rejected before reservation',{limit,allocatedPayloadBytes:0,scope:'admission metadata boundary'});
 })(),(async()=>{
  const s=await json('/shares',{method:'POST',jar,json:{resourceId:quotaFile.id,mode:'download',maxDownloads:1}}),url='/public/shares/'+s.token,session=new Map();
  for(let n=0;n<3;n++){const r=await api(url+'/content',{method:'HEAD',jar:session});assert.equal(r.status,200);assert.equal((await r.arrayBuffer()).byteLength,0);}
  const malformed=await api(url+'/content',{method:'HEAD',jar:session,headers:{Range:'bytes=0-1,3-4'}});assert.equal(malformed.status,416);
  const find=async()=>(await listAll('/shares')).find(x=>x.id===s.share.id);assert.equal((await find()).downloadCount,0);
  const r=await api(url+'/content',{jar:session});assert.equal(r.status,200);assert.equal(sha(Buffer.from(await r.arrayBuffer())),sha(quotaBytes));assert.equal((await find()).downloadCount,1);await consumeDenied(await api(url+'/content',{jar:new Map()}));await check('SHARE-02','HEAD and invalid Range do not consume quota; one download blocks a new session');
  const expiresAt=new Date(Date.now()+10000).toISOString(),expiring=await json('/shares',{method:'POST',jar,json:{resourceId:quotaFile.id,mode:'download',expiresAt}}),expiryUrl='/public/shares/'+expiring.token;
  await json(expiryUrl);await delay(Math.max(0,Date.parse(expiresAt)-Date.now()+250));await consumeDenied(await api(expiryUrl+'/content'));await check('SHARE-02','actual wall-clock expiry rejects subsequent guest content');
 })()];
 try{const results=await Promise.allSettled(tasks);for(const r of results)if(r.status==='rejected')throw r.reason;evidence.status='PASS';await check('RES-05','parallel owner uploads plus two Drop channels and guest sharing',{sharedBackend:true,syncBackendShared:false});}
 catch(error){evidence.status='FAIL';evidence.error=String(error);throw error;}
 finally{evidence.finishedAt=new Date().toISOString();await save();}
}
