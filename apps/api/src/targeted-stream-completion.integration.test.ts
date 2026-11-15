import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import Fastify from 'fastify';
import {expect,it,vi} from 'vitest';
import {activeFixture,evidence,sha,uid,barrier} from './stage3-chat-a.fixture.js';
import {guardedSyncStreamHttp} from './guarded-sync-stream-http.js';
import type {GuardedRuntimeScope} from '../../../packages/sync/src/guarded-runtime.js';
import type {SyncStreamPrepare} from '../../../packages/contracts/src/sync-stream.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

it('HTTP long completion returns durable pending state, joins the same original and drains before shutdown',async()=>{
 const f=await activeFixture('targeted-long-completion-v2','windows',119);
 const app=Fastify();const gate=barrier();let calls=0;
 try{
  const bytes=Buffer.alloc(65536,73),prepared=f.uploadInput('long-completion.bin',bytes);
  await f.admin.withSql(sql=>sql`UPDATE sync_root_policy SET features=features||'"scale-transfer-v2"'::jsonb WHERE root_id=${f.rootId}`);
  const original:SyncStreamPrepare={schema:'saturn.stream-upload.v2',operationId:uid(),source:{generation:'1',witnessSha256:sha('source')},chunkBytes:4194304,prepare:{...prepared,intent:{...prepared.intent,sha256:null}}};
  await f.streams.prepare(original,f.proof);await f.streams.append(original,{index:0,offset:'0',length:String(bytes.length),sha256:sha(bytes)},bytes,f.proof);
  const complete=f.files.completeCatalogUpload.bind(f.files);
  vi.spyOn(f.files,'completeCatalogUpload').mockImplementation(async(...args)=>{calls++;await gate.entered;return complete(...args);});
  await app.register(guardedSyncStreamHttp,{root:async()=>({binding:f.wireBinding,authority:f.issuer,streams:f.streams,extensions:['stream-upload-v1','scale-transfer-v2']} as unknown as GuardedRuntimeScope)});
  const request=(command:string,more:object={})=>app.inject({method:'POST',url:`/sync/v1/roots/${f.rootId}/stream-uploads/${command}`,headers:{authorization:f.authorization},payload:{binding:f.wireBinding,input:original,...more}});
  const started=performance.now();
  const sealed=await request('seal',{seal:{sha256:sha(bytes),sourceGeneration:'1',sourceWitnessSha256:original.source.witnessSha256}});
  expect(sealed.statusCode).toBe(200);expect(['SEALED','PUBLISHING']).toContain(sealed.json<{state:unknown}>().state);expect(performance.now()-started).toBeLessThan(5000);
  expect(f.streams.hasPendingCompletion).toBe(true);
  const repeat=await request('complete');expect(repeat.statusCode).toBe(200);expect(calls).toBe(1);
  const wrong=await app.inject({method:'POST',url:`/sync/v1/roots/${f.rootId}/stream-uploads/complete`,headers:{authorization:f.authorization},payload:{binding:f.wireBinding,input:{...original,source:{...original.source,generation:'changed'}}}});
  expect(wrong.statusCode).toBe(409);expect(calls).toBe(1);
  let native:Promise<unknown>|undefined;
  if(process.env.TARGETED_STREAM_NATIVE){
   const origin=await app.listen({host:'127.0.0.1',port:0});
   const input=path.join(f.directory,'native-input.private.json'),output=path.join(f.directory,'native-result.json');
   await fs.writeFile(input,JSON.stringify({origin,authorization:f.authorization,binding:f.wireBinding,input:original}));
   native=promisify(execFile)(fixtureValue(process.env.TARGETED_DOTNET),[process.env.TARGETED_STREAM_NATIVE,input,output],{windowsHide:true,timeout:90000});
  }
  // Exceed the old 30 second control timeout without holding a request open.
  await new Promise(r=>setTimeout(r,31000));
  if(native){gate.release();await native;await f.streams.close();}
  else{let drained=false;const drain=f.streams.close().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);gate.release();await drain;}
  expect(calls).toBe(1);
  const status=await f.streams.status(original,f.proof);expect(status.state).toBe('PUBLISHED');
  const rows=await f.admin.withSql(sql=>sql<{id:string;storage_path:string;sha256:string}[]>`SELECT id,storage_path,sha256 FROM resources WHERE parent_id=${f.rootId} AND name='long-completion.bin'`);
  expect(rows).toHaveLength(1);const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(fixtureValue(rows[0]).storage_path)))chunks.push(chunk);
  expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));expect(fixtureValue(rows[0]).sha256).toBe(sha(bytes));
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions WHERE resource_id=${fixtureValue(rows[0]).id}`)).toHaveLength(1);
  await evidence('targeted-long-completion-v2','result',{status:'PASS',operationId:original.operationId,elapsedMs:performance.now()-started,completionCalls:calls,fullPhysicalSha256:sha(bytes),oneVersion:true,drained:true});
 }finally{gate.release();await f.streams.close();await app.close();await f.close();}
},60000);

it('late completion failure is surfaced once and does not fabricate publication or discard the original',async()=>{
 const f=await activeFixture('targeted-completion-failure','windows',119);const gate=barrier();
 try{
  const bytes=Buffer.alloc(16,43),prepared=f.uploadInput('failed-completion.bin',bytes);
  const original:SyncStreamPrepare={schema:'saturn.stream-upload.v1',operationId:uid(),source:{generation:'1',witnessSha256:sha('source')},chunkBytes:4194304,prepare:{...prepared,intent:{...prepared.intent,sha256:null}}};
  await f.streams.prepare(original,f.proof);await f.streams.append(original,{index:0,offset:'0',length:'16',sha256:sha(bytes)},bytes,f.proof);
  const completion=vi.spyOn(f.files,'completeCatalogUpload').mockImplementation(async()=>{await gate.entered;throw Object.assign(Error('verification_failed'),{code:'verification_failed'});});
  const pending=await f.streams.completeWithin(original,f.proof,{sha256:sha(bytes),sourceGeneration:'1',sourceWitnessSha256:original.source.witnessSha256},100);
  expect(pending.state).not.toBe('PUBLISHED');gate.release();
  await expect(f.streams.completeWithin(original,f.proof)).rejects.toMatchObject({code:'verification_failed'});
  expect(completion).toHaveBeenCalledTimes(1);expect(f.streams.hasPendingCompletion).toBe(false);
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${f.rootId} AND name='failed-completion.bin'`)).toHaveLength(0);
  const status=await f.streams.status(original,f.proof);expect(status.operationId).toBe(original.operationId);expect(status.state).not.toBe('PUBLISHED');
  await evidence('targeted-completion-failure','result',{status:'PASS',operationId:original.operationId,noPublication:true,noAutomaticRetry:true});
 }finally{gate.release();await f.streams.close();await f.close();}
},30000);

it('shutdown drains admitted preflight and starts no detached writer after closing',async()=>{
 const f=await activeFixture('targeted-completion-close-race','windows',119);const entered=barrier(),release=barrier();
 try{
  const bytes=Buffer.alloc(1,5),prepared=f.uploadInput('close-race.bin',bytes);
  const original:SyncStreamPrepare={schema:'saturn.stream-upload.v1',operationId:uid(),source:{generation:'1',witnessSha256:sha('source')},chunkBytes:4194304,prepare:{...prepared,intent:{...prepared.intent,sha256:null}}};
  await f.streams.prepare(original,f.proof);await f.streams.append(original,{index:0,offset:'0',length:'1',sha256:sha(bytes)},bytes,f.proof);
  const complete=vi.spyOn(f.files,'completeCatalogUpload');
  const transaction=f.writer.transaction.bind(f.writer);
  vi.spyOn(f.writer,'transaction').mockImplementationOnce(async action=>{entered.release();await release.entered;return transaction(action);});
  const request=f.streams.completeWithin(original,f.proof,{sha256:sha(bytes),sourceGeneration:'1',sourceWitnessSha256:original.source.witnessSha256});
  const refused=expect(request).rejects.toMatchObject({code:'backend_draining'});
  await entered.entered;let drained=false;const closing=f.streams.close().then(()=>{drained=true;});
  await Promise.resolve();expect(drained).toBe(false);release.release();await refused;await closing;
  expect(complete).not.toHaveBeenCalled();
  await expect(f.streams.completeWithin(original,f.proof)).rejects.toMatchObject({code:'backend_draining'});
  await evidence('targeted-completion-close-race','result',{status:'PASS',preflightDrained:true,noWriterAfterClose:true,originalPreserved:true});
 }finally{release.release();await f.streams.close();await f.close();}
},30000);
