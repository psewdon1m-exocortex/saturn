import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export async function transferLifecycleFlow({api,json,folder,upload,download,pass,sha,jar,target,seed,output}){
 const evidence={startedAt:new Date().toISOString(),status:'RUNNING',checks:[]};
 const save=()=>fs.writeFile(output+'/transfer-lifecycle.json',JSON.stringify(evidence,null,2));
 const mark=async(id,name,detail={})=>{evidence.checks.push({id,name,...detail});await save();await pass(id,name,detail);};
 const control=(id,action)=>json('/operator/tasks/'+id,{method:'PATCH',jar,json:{action}},[200]);
 const root=await folder(jar,'transfer-'+randomUUID().slice(0,8),target.id);evidence.rootId=root.id;
 const list=async()=>{const r=await json('/folders/'+root.id+'/children',{jar});return r.items??r;};
 const inspect=async id=>{const r=await api('/uploads/'+id,{method:'HEAD',jar});assert.equal(r.status,204);return {offset:Number(r.headers.get('Upload-Offset')),state:r.headers.get('Upload-Status')};};
 const append=async(id,offset,bytes)=>{const r=await api('/uploads/'+id,{method:'PATCH',jar,body:bytes,headers:{'Content-Type':'application/offset+octet-stream','Upload-Offset':String(offset),'Content-Length':String(bytes.length)}});assert.equal(r.status,204);await r.arrayBuffer();};
 try{
  const bytes=Buffer.alloc(4*1048576,61);Buffer.from(seed).copy(bytes);
  const s=await json('/uploads',{method:'POST',jar,json:{parentId:root.id,filename:'resumed.bin',expectedSize:bytes.length,expectedSha256:sha(bytes)}});evidence.uploadId=s.id;await save();
  await append(s.id,0,bytes.subarray(0,1048576));assert.equal((await control(s.id,'pause')).state,'paused');
  let completed=false;const inFlight=append(s.id,1048576,bytes.subarray(1048576,2097152)).then(()=>{completed=true;return null;},e=>e);
  try{
   await delay(500);assert.equal(completed,false,'paused request did not wait');assert.equal((await inspect(s.id)).offset,1048576);
   assert.equal((await control(s.id,'resume')).state,'running');const error=await inFlight;if(error)throw error;
  }finally{if(!completed)await control(s.id,'resume').catch(()=>{});}
  for(let offset=2097152;offset<bytes.length;offset+=1048576)await append(s.id,offset,bytes.subarray(offset,offset+1048576));
  const committed=await json('/uploads/'+s.id+'/complete',{method:'POST',jar,json:{}}),file=committed.resource;evidence.resourceId=file.id;
  assert.equal((await inspect(s.id)).state,'active');await download(jar,file,bytes);assert.equal((await list()).filter(f=>f.name==='resumed.bin').length,1);
  await mark('SAT-02','owner partial upload pause, held chunk, resume on original ID and full SHA',{uploadId:s.id,resourceId:file.id,bytes:bytes.length});

  const cancelled=await json('/uploads',{method:'POST',jar,json:{parentId:root.id,filename:'cancelled.bin',expectedSize:2097152}});evidence.cancelledUploadId=cancelled.id;
  await append(cancelled.id,0,bytes.subarray(0,1048576));assert.equal((await control(cancelled.id,'cancel')).state,'cancelled');assert.equal((await inspect(cancelled.id)).state,'abandoned');
  const refusal=await api('/uploads/'+cancelled.id+'/complete',{method:'POST',jar,json:{}});assert([400,409].includes(refusal.status));await refusal.arrayBuffer();assert(!(await list()).some(f=>f.name==='cancelled.bin'));
  await mark('SAT-02','cancelled partial upload cannot publish a file in the server namespace',{uploadId:cancelled.id});

  evidence.cancelledReads=[];
  const reads=await Promise.allSettled(Array.from({length:16},async()=>{
   const r=await api('/files/'+file.id+'/content',{jar});assert.equal(r.status,200);assert.equal(r.headers.get('etag'),'"sha256-'+sha(bytes)+'"');
   const reader=r.body.getReader();const first=await reader.read();assert(!first.done&&first.value.length>0&&first.value.length<bytes.length);assert.deepEqual(Buffer.from(first.value),bytes.subarray(0,first.value.length));await reader.cancel();evidence.cancelledReads.push({received:first.value.length,total:bytes.length});
  }));for(const r of reads)if(r.status==='rejected')throw r.reason;
  const controlStarted=performance.now(),cut=1234567,parts=[];
  for(const [start,end] of [[0,cut-1],[cut,bytes.length-1]]){const r=await api('/files/'+file.id+'/content',{jar,headers:{Range:'bytes='+start+'-'+end}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),`bytes ${start}-${end}/${bytes.length}`);assert.equal(r.headers.get('etag'),'"sha256-'+sha(bytes)+'"');parts.push(Buffer.from(await r.arrayBuffer()));}
  assert.equal(sha(Buffer.concat(parts)),sha(bytes));evidence.postCancelReadMs=performance.now()-controlStarted;
  const multiple=await api('/files/'+file.id+'/content',{jar,headers:{Range:'bytes=0-1,3-4'}});assert.equal(multiple.status,416);await multiple.arrayBuffer();
  await mark('SAT-03','16 interrupted downloads release capacity; two Range parts reconstruct exact file with stable ETag',{cancelledReads:16,postCancelReadMs:evidence.postCancelReadMs});

  const text=Buffer.from('# Preview\n'+seed),previewFile=await upload(jar,root.id,'preview.txt',text),before=await json('/files/'+previewFile.id+'/versions',{jar});
  const preview=await api('/files/'+previewFile.id+'/preview',{jar});assert.equal(preview.status,200);assert.equal(sha(Buffer.from(await preview.arrayBuffer())),sha(text));assert.match(preview.headers.get('content-disposition'),/^inline/);assert.match(preview.headers.get('content-security-policy'),/sandbox/);
  assert.deepEqual(await json('/files/'+previewFile.id+'/versions',{jar}),before);await download(jar,previewFile,text);await mark('SAT-06','inline text preview preserves bytes and version history');

  // Both originals remain readable after the refused restore. Purge is confined
  // to the freshly created preview fixture, after its readback is recorded.
  await json('/resources/'+previewFile.id,{method:'DELETE',jar},[200,204]);
  const replacementBytes=Buffer.from('replacement '+seed),replacement=await upload(jar,root.id,'preview.txt',replacementBytes);assert.notEqual(replacement.id,previewFile.id);
  const collision=await api('/resources/'+previewFile.id+'/restore',{method:'POST',jar,json:{}});assert.equal(collision.status,409);await collision.arrayBuffer();
  assert.equal((await json('/resources/'+previewFile.id,{jar})).status,'trashed');await download(jar,replacement,replacementBytes);
  await json('/resources/'+replacement.id+'/move',{method:'POST',jar,json:{parentId:root.id,name:'replacement-retained.txt'}});
  await json('/resources/'+previewFile.id+'/restore',{method:'POST',jar,json:{}});await download(jar,previewFile,text);await download(jar,replacement,replacementBytes);
  await mark('SAT-05','restore collision refuses without overwrite; moving incumbent then restoring preserves both IDs and SHA',{originalId:previewFile.id,replacementId:replacement.id});
  await json('/resources/'+previewFile.id,{method:'DELETE',jar},[200,204]);await json('/trash/'+previewFile.id,{method:'DELETE',jar},[200,204]);
  const gone=await api('/files/'+previewFile.id+'/content',{jar});assert([400,404].includes(gone.status));await gone.arrayBuffer();await download(jar,replacement,replacementBytes);await download(jar,file,bytes);
  await mark('SAT-05','explicit purge removes only selected test resource; siblings remain SHA exact',{purgedId:previewFile.id});
  evidence.status='PASS';
 }catch(e){evidence.status='FAIL';evidence.error=String(e);throw e;}finally{evidence.finishedAt=new Date().toISOString();await save();}
}
