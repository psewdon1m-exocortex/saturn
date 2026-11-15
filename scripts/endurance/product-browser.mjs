import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

export async function publicBrowserFlows({browser,page,fixture,jar,json,folder,upload,download,pass,sha,target,output,seed}) {
 const contexts=[];
 try {
  const channel=await json('/drop/codes',{method:'POST',jar,json:{}});
  async function guest(code){const context=await browser.newContext();contexts.push(context);const tab=await context.newPage();await tab.goto(fixture.publicOrigin+'/drop',{waitUntil:'domcontentloaded'});await tab.getByLabel('Drop code',{exact:true}).fill(code);await tab.getByRole('button',{name:'Enter',exact:true}).click();await tab.getByRole('heading',{name:'saturn drop point',exact:true}).waitFor();return {context,tab};}
  // Issuing a new code revokes every unused code. Activate channel A before
  // issuing B; the two activated channels can then upload concurrently.
  const {context,tab}=await guest(channel.code);
  const isolated=await json('/drop/codes',{method:'POST',jar,json:{}}),other=await guest(isolated.code);
  console.log('BROWSER two independent Drop channels activated');
  const second=await context.newPage();await second.goto(fixture.publicOrigin+'/drop',{waitUntil:'domcontentloaded'});await second.getByRole('heading',{name:'saturn drop point',exact:true}).waitFor();
  const picked={name:'ui-drop-'+randomUUID()+'.md',mimeType:'text/markdown',buffer:Buffer.from('UI drop '+seed)},dragged={name:'ui-drag-'+randomUUID()+'.bin',buffer:Buffer.from('UI drag '+seed)};
  await tab.getByLabel('Choose files for Drop').setInputFiles([picked]);
  const data=await second.evaluateHandle(({name,bytes})=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],name));return dt;},{name:dragged.name,bytes:[...dragged.buffer]});await second.locator('main.drop-view').dispatchEvent('drop',{dataTransfer:data});await data.dispose();
  async function stored(tab,name){const row=tab.locator('.drop-job').filter({has:tab.getByText(name,{exact:true})});await row.getByText('stored',{exact:true}).waitFor({timeout:120000});assert.equal(await row.count(),1);}
  await Promise.all([stored(tab,picked.name),stored(tab,dragged.name),stored(second,picked.name),stored(second,dragged.name)]);
  await tab.reload({waitUntil:'domcontentloaded'});await stored(tab,picked.name);await stored(tab,dragged.name);assert.equal(await tab.locator('.drop-job').count(),2);
  assert.equal(await other.tab.locator('.drop-job').count(),0);
  const actual=[];for(let offset=0;;offset+=500){const body=await json('/folders/00000000-0000-7000-8000-000000000002/children?limit=500&offset='+offset,{jar}),items=body.items??body;actual.push(...items);if(items.length<500)break;}
  for(const item of [picked,dragged]){const matches=actual.filter(x=>x.name===item.name);assert.equal(matches.length,1);await download(jar,matches[0],item.buffer);}
  await tab.screenshot({path:output+'/public-drop-browser.png',fullPage:true});await pass('DROP-02','Chromium picker and drag/drop across two tabs, shared queue, refresh, isolated second channel');await pass('DROP-03','browser Drop commits exactly once and owner SHA matches');
  const content=Buffer.from('guest browser download '+seed),file=await upload(jar,target.id,'browser-shared-'+randomUUID()+'.txt',content),password='owned-'+randomUUID();
  const share=await json('/shares',{method:'POST',jar,json:{resourceId:file.id,mode:'download',password}});
  const guestContext=await browser.newContext();contexts.push(guestContext);const guestPage=await guestContext.newPage();await guestPage.goto(fixture.publicOrigin+'/s/'+share.token,{waitUntil:'domcontentloaded'});
  await guestPage.getByLabel('Password',{exact:true}).fill('wrong-fixture-password');await guestPage.getByRole('button',{name:'Continue',exact:true}).click();await guestPage.getByText('The share password was not accepted.',{exact:true}).waitFor();
  await guestPage.getByLabel('Password',{exact:true}).fill(password);await guestPage.getByRole('button',{name:'Continue',exact:true}).click();
  const pending=guestPage.waitForEvent('download');await guestPage.getByRole('link',{name:'Download '+file.name,exact:true}).click();const result=await pending;assert.equal(await result.failure(),null);assert.equal(sha(await fs.readFile(await result.path())),sha(content));
  await guestPage.reload({waitUntil:'domcontentloaded'});await guestPage.getByRole('heading',{name:file.name,exact:true}).waitFor();await guestPage.screenshot({path:output+'/public-share-browser.png',fullPage:true});
  await json('/shares/'+share.share.id,{method:'DELETE',jar},[200,204]);await guestPage.reload({waitUntil:'domcontentloaded'});await guestPage.getByText('Shared link not found',{exact:true}).waitFor();
  await pass('SHARE-01','Chromium guest download saved and SHA verified without owner cookies');await pass('SHARE-02','Chromium wrong/correct password and refresh');await pass('SHARE-03','Chromium revoked share becomes unavailable');
  const securityParent=await folder(jar,'browser-security-'+randomUUID(),target.id);
  const csrf=await page.context().request.post(fixture.apiOrigin+'/api/v1/folders',{data:{parentId:securityParent.id,name:'csrf-must-not-exist'},headers:{Origin:fixture.publicOrigin}});assert.equal(csrf.status(),403);
  const children=await json('/folders/'+securityParent.id+'/children?limit=500',{jar});assert(!(children.items??children).some(x=>x.name==='csrf-must-not-exist'));
  // Establish a second protected document; Back from the first document is
  // about:blank and says nothing about authentication/cache behavior.
  await page.goto(fixture.publicOrigin+'/storage-new',{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'Logout',exact:true}).click();await page.getByLabel('Access Key',{exact:true}).waitFor();await page.goBack({waitUntil:'domcontentloaded'});await page.getByLabel('Access Key',{exact:true}).waitFor();
  const denied=await page.context().request.get(fixture.apiOrigin+'/api/v1/folders/'+target.id+'/children');assert.equal(denied.status(),401);await pass('SAT-01','Chromium logout/Back denies owner access; missing CSRF cannot create a folder');
 } catch(error) {
  let index=0;for(const context of [page.context(),...contexts])for(const tab of context.pages()){const name=output+'/browser-failure-'+index++;await tab.screenshot({path:name+'.png',fullPage:true}).catch(()=>{});await fs.writeFile(name+'.txt',await tab.locator('body').innerText().catch(()=>''));}
  throw error;
 } finally { await Promise.allSettled(contexts.map(c=>c.close())); }
}

export async function dropCapacityFlow({api,json,jar,pass,sha,download,output,seed}) {
 const report={status:'RUNNING',startedAt:new Date().toISOString(),reservations:[],rejections:[]};
 const save=()=>fs.writeFile(output+'/drop-capacity.json',JSON.stringify(report,null,2));
 const pool=async(items,action)=>{let next=0;const results=await Promise.allSettled(Array.from({length:Math.min(32,items.length)},async()=>{while(next<items.length){const i=next++;await action(items[i],i);}}));for(const r of results)if(r.status==='rejected')throw r.reason;};
 try {
  const code=await json('/drop/codes',{method:'POST',jar,json:{}}),guest=new Map();await json('/drop/redeem',{method:'POST',jar:guest,json:{code:code.code}});const session=await json('/drop/session',{jar:guest});
  await fs.writeFile(output+'/drop-capacity.private.json',JSON.stringify({jar:[...guest]},null,2));
  const limit=session.maxFiles;assert(Number.isSafeInteger(limit)&&limit>=1&&limit<=10000);report.limit=limit;report.scope='actual configured per-channel reservation limit; no disk exhaustion';
  await pool(Array.from({length:limit},(_,i)=>i),async i=>{const key='capacity-'+randomUUID(),input={filename:'held-'+i+'.bin',expectedSize:16};const r=await json('/drop/uploads',{method:'POST',jar:guest,json:input,headers:{'Idempotency-Key':key}});report.reservations.push({id:r.id,key,input});if(report.reservations.length%100===0){console.log('DROP CAPACITY '+report.reservations.length+'/'+limit);}});
  await save();assert.equal((await json('/drop/uploads',{jar:guest})).length,limit);
  const original=report.reservations[0],replay=await json('/drop/uploads',{method:'POST',jar:guest,json:original.input,headers:{'Idempotency-Key':original.key}});assert.equal(replay.id,original.id);
  await pool(Array.from({length:32},(_,i)=>i),async i=>{const r=await api('/drop/uploads',{method:'POST',jar:guest,json:{filename:'rejected-'+i+'.bin',expectedSize:16}});const body=await r.json();report.rejections.push({status:r.status,code:body.code});assert.equal(r.status,413);assert.equal(body.code,'drop_quota_exhausted');});
  assert.equal((await json('/drop/uploads',{jar:guest})).length,limit);
  await json('/drop/uploads/'+original.id,{method:'DELETE',jar:guest},[200,204]);
  const winners=[];await pool(Array.from({length:32},(_,i)=>i),async i=>{const r=await api('/drop/uploads',{method:'POST',jar:guest,json:{filename:'race-'+i+'.bin',expectedSize:16}}),body=await r.json();if([200,201].includes(r.status))winners.push(body);else{assert.equal(r.status,413);assert.equal(body.code,'drop_quota_exhausted');}});
  assert.equal(winners.length,1,'exactly one freed slot admitted under concurrent pressure');report.raceWinner=winners[0].id;
  const pending=report.reservations.filter(x=>x.id!==original.id).map(x=>x.id).concat(winners.map(x=>x.id));await pool(pending,async id=>{await json('/drop/uploads/'+id,{method:'DELETE',jar:guest},[200,204]);});
  const released=await json('/drop/uploads',{jar:guest});assert.equal(released.length,limit+1);assert(released.every(x=>x.state==='cancelled'));
  const bytes=Buffer.from('capacity drain recovered '+seed),name='capacity-recovered-'+randomUUID()+'.txt';const recovered=await json('/drop/uploads',{method:'POST',jar:guest,json:{filename:name,expectedSize:bytes.length,expectedSha256:sha(bytes)}});
  const patch=await api('/drop/uploads/'+recovered.id,{method:'PATCH',jar:guest,body:bytes,headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':'0','Content-Length':String(bytes.length)}});assert.equal(patch.status,204);await patch.arrayBuffer();await json('/drop/complete',{method:'POST',jar:guest,json:{uploadId:recovered.id}});
  let stored=false;for(let n=0;n<240;n++){const r=await json('/drop/uploads/'+recovered.id+'/status',{jar:guest});if(r.state==='stored'){stored=true;break;}await new Promise(resolve=>setTimeout(resolve,500));}assert(stored,'post-pressure recovery must durably store');
  const matches=[];for(let offset=0;;offset+=500){const r=await json('/folders/00000000-0000-7000-8000-000000000002/children?limit=500&offset='+offset,{jar}),items=r.items??r;matches.push(...items.filter(x=>x.name===name));if(items.length<500)break;}assert.equal(matches.length,1);await download(jar,matches[0],bytes);
  report.recovered={id:matches[0].id,sha256:sha(bytes),size:bytes.length};report.status='PASS';await pass('RES-04','Drop actual channel limit: concurrent rejection, same-key replay, one-slot race, cancellation and SHA recovery',{limit,rejected:report.rejections.length,scope:report.scope});
 }catch(error){report.status='FAIL';report.error=String(error);throw error;}finally{report.finishedAt=new Date().toISOString();await save();}
}
