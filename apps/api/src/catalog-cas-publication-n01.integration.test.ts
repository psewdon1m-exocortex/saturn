import { readySmallPublications } from './publication-ready.fixture.js';
import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator,type PreparedCatalogUpload} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,migrations,uid,sha,evidence} from './stage3-chat-a.fixture.js';
const migration=Number(process.env.N01_CAS_MIGRATION??109);
type Fixture=Awaited<ReturnType<typeof activeFixture>>;
function previous(p:PreparedCatalogUpload){
 const r=p.status.result;if(r?.status!=='PUBLISHED')throw Error('Published predecessor required');
 const d=r.publishedDescription;return {nodeId:d.node_id,metadataVersion:d.version,versionId:fixtureValue(d.content_version_id)};
}
function composition(f:Fixture){const database=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
 const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:database});return {database,files};}
async function seeded(f:Fixture,count=4,size=49152){const old:PreparedCatalogUpload[]=[],bytes:Buffer[]=[];
 for(let n=0;n<count;n++){const b=Buffer.alloc(size,30+n);bytes.push(b);old.push(await f.upload(f.uploadInput('cas-'+String(n)+'.bin',b),b));}return {old,bytes};}
async function physical(f:Fixture,p:string){const chunks:Buffer[]=[];for await(const b of fixtureChunks(await f.raw.openRead(p)))chunks.push(Buffer.from(b));return Buffer.concat(chunks);}
const state=(f:Fixture)=>f.admin.withSql(sql=>sql<({id:string}&Record<string,unknown>)[]>`SELECT id,upload_intent,upload_execution,upload_effect_state,upload_claim_token,upload_publication_group,upload_transfer,sync_result FROM operation_journal ORDER BY id`);

it('publishes a bounded CAS set preserving resource IDs, exact old archives, deltas and rollback readers',async()=>{
 const id='n01-cas-set-positive',f=await activeFixture(id,'windows',migration),{files}=composition(f);
 let releaseVerified=()=>{},verifiedTimer:ReturnType<typeof setTimeout>|undefined,completionJoin:Promise<unknown>|undefined;
 try{
  const seed=await seeded(f),bytes=[49152,49153,49151,32768].map((size,n)=>Buffer.alloc(size,90+n));
  const inputs=seed.old.map((old,n)=>f.uploadInput('cas-'+String(n)+'.bin',fixtureValue(bytes[n]),previous(old)));
  const originals=[];for(const input of inputs)originals.push(await files.prepareCatalogUpload(input,f.proof));
  const commands=vi.spyOn(f.writer,'catalogUploadBatch');
  // Qualify one four-member ready set, independently of host fsync timing.
  // Every original still performs its real durable verified write.
  const writeVerified=f.executor.writeVerifiedOnce.bind(f.executor),verifiedGate=new Promise<void>(resolve=>{releaseVerified=resolve;});
  let verifiedReady=0,verifiedExpired=false;
  verifiedTimer=setTimeout(()=>{verifiedExpired=true;releaseVerified();},5000);
  const verifiedWrites=vi.spyOn(f.executor,'writeVerifiedOnce').mockImplementation(async(...args)=>{
   const proof=await writeVerified(...args);verifiedReady++;
   if(verifiedReady===originals.length){clearTimeout(verifiedTimer);releaseVerified();}
   await verifiedGate;if(verifiedExpired)throw Error('Four real verified originals did not reach the fixture barrier');return proof;
  });
  const renameGroups=vi.spyOn(f.executor,'renameGroupOnce');
  const completing=originals.map((p,n)=>files.completeSmallCatalogUpload(p,f.proof,fixtureValue(bytes[n])));
  completionJoin=Promise.allSettled(completing);const results=await Promise.all(completing);
  expect(verifiedReady).toBe(4);expect(verifiedExpired).toBe(false);
  expect(verifiedWrites).toHaveBeenCalledTimes(4);
  expect(renameGroups).toHaveBeenCalledTimes(2);
  expect(commands.mock.calls.filter(([c])=>c==='claim-cas-set')).toHaveLength(1);
  expect(commands.mock.calls.filter(([c])=>c==='publish-cas-set')).toHaveLength(1);
  expect(results.map(p=>previous(p).nodeId)).toEqual(seed.old.map(p=>previous(p).nodeId));
  expect(results.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
  for(const [n,p]of results.entries()){
   expect(sha(await physical(f,p.execution.targetPath))).toBe(sha(fixtureValue(bytes[n])));
   expect(sha(await physical(f,fixtureValue(p.execution.archivePath)))).toBe(sha(fixtureValue(seed.bytes[n])));
  }
  const versions=await f.admin.withSql(sql=>sql`SELECT id,resource_id,storage_path,sha256,size_bytes FROM file_versions ORDER BY id`);
  expect(versions).toHaveLength(8);
  expect(Number(fixtureValue((await f.admin.withSql(sql=>sql`SELECT size_bytes FROM resources WHERE id=${f.rootId}`))[0]).size_bytes)).toBe(bytes.reduce((n,b)=>n+b.length,0));
  const writes=vi.spyOn(f.raw,'write'),renames=vi.spyOn(f.raw,'rename');
  const replay=await Promise.all(results.map((p,n)=>files.completeSmallCatalogUpload(p,f.proof,fixtureValue(bytes[n]))));
  expect(replay.map(p=>previous(p).versionId)).toEqual(results.map(p=>previous(p).versionId));expect(writes).not.toHaveBeenCalled();expect(renames).not.toHaveBeenCalled();
  await f.executor.close();
  const rollback=await fs.readFile(path.join(migrations,'0109_catalog_cas_publication.down.sql'),'utf8');
  await f.admin.transaction(sql=>sql.unsafe(rollback));
  const oldReader=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  expect(await oldReader.supportsCasPublicationSets()).toBe(false);
  const rolled=await Promise.all(results.map(p=>oldReader.prepare(p.input,f.proof,p.status.session.uploadId)));
  expect(rolled.map(p=>previous(p).versionId)).toEqual(results.map(p=>previous(p).versionId));
  expect(await f.admin.withSql(sql=>sql`SELECT id,resource_id,storage_path,sha256,size_bytes FROM file_versions ORDER BY id`)).toEqual(versions);
  await evidence(id,'result',{casClaims:1,casPublishes:1,files:4,versions:8,allPhysicalSha:true,resourceIdsPreserved:true,sizeDelta:true,replayNoPhysicalEffects:true,rollbackReaders:true});
 }finally{releaseVerified();clearTimeout(verifiedTimer);await completionJoin;vi.restoreAllMocks();await f.close();}
},90000);

it('resumes the same CAS original after a verified temporary-write acknowledgement is lost',async()=>{
 const id='n01-cas-verified-write-lost-ack',f=await activeFixture(id,'windows',migration),{files}=composition(f);
 try{
  const seed=await seeded(f,1),bytes=Buffer.alloc(49152,178);
  const p=await files.prepareCatalogUpload(f.uploadInput('cas-0.bin',bytes,previous(fixtureValue(seed.old[0]))),f.proof);
  const write=f.executor.writeVerifiedOnce.bind(f.executor);let lost=false;
  vi.spyOn(f.executor,'writeVerifiedOnce').mockImplementation(async(...args)=>{const proof=await write(...args);if(!lost){lost=true;throw Error('Lost verified temporary write ACK');}return proof;});
  await expect(files.completeSmallCatalogUpload(p,f.proof,bytes)).rejects.toThrow('Lost verified temporary write ACK');
  expect(sha(await physical(f,p.execution.targetPath))).toBe(sha(fixtureValue(seed.bytes[0])));
  expect(sha(await physical(f,p.execution.tempPath))).toBe(sha(bytes));expect(await f.raw.exists(fixtureValue(p.execution.archivePath))).toBe(false);
  const rawWrites=vi.spyOn(f.raw,'write'),fresh=composition(f);
  const pending=await fresh.files.prepareCatalogUpload(p.input,f.proof,p.status.session.uploadId);
  const done=await fresh.files.completeSmallCatalogUpload(pending,f.proof,bytes);
  expect(done.status.session.operationId).toBe(p.status.session.operationId);expect(previous(done).nodeId).toBe(previous(fixtureValue(seed.old[0])).nodeId);
  expect(rawWrites).not.toHaveBeenCalled();expect(sha(await physical(f,p.execution.targetPath))).toBe(sha(bytes));
  expect(sha(await physical(f,fixtureValue(p.execution.archivePath)))).toBe(sha(fixtureValue(seed.bytes[0])));
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(2);
  await evidence(id,'result',{lostVerifiedTemporaryWriteAck:true,freshCoordinator:true,osProcessRestart:false,sameOriginal:true,noRepeatPhysicalWrite:true,versions:2,fullShaAndArchive:true});
 }finally{vi.restoreAllMocks();await f.close();}
},90000);

it('refuses a mismatched verified replacement without changing the existing file or its version',async()=>{
 const id='n01-cas-verified-write-mismatch',f=await activeFixture(id,'windows',migration),{files}=composition(f);
 try{
  const seed=await seeded(f,1),bytes=Buffer.alloc(49152,190),bad=Buffer.alloc(49152,191);
  const p=await files.prepareCatalogUpload(f.uploadInput('cas-0.bin',bytes,previous(fixtureValue(seed.old[0]))),f.proof);
  await expect(files.completeSmallCatalogUpload(p,f.proof,bad)).rejects.toThrow('verification_failed');
  expect(sha(await physical(f,p.execution.targetPath))).toBe(sha(fixtureValue(seed.bytes[0])));
  expect(await f.raw.exists(fixtureValue(p.execution.archivePath))).toBe(false);
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(1);
  expect((await state(f)).filter(r=>r.sync_result===null)).toHaveLength(1);
  await evidence(id,'result',{mismatchedNewBytesRejected:true,oldFileUnchanged:true,oldVersionUnchanged:true,originalRetained:true});
 }finally{vi.restoreAllMocks();await f.close();}
},90000);

it('rejects malformed or stale final CAS members and revoked authority before claiming any member',async()=>{
 const id='n01-cas-set-negative',f=await activeFixture(id,'windows',migration),{database,files}=composition(f);
 try{
  const seed=await seeded(f),bytes=Buffer.alloc(49152,102),prepared=[];
  for(const [n,old]of seed.old.entries()){let p=await files.prepareCatalogUpload(f.uploadInput('cas-'+String(n)+'.bin',bytes,previous(old)),f.proof);p=await files.appendCatalogUpload(p,f.proof,'0',bytes);prepared.push(p);}
  const credential=f.issuer.deviceCredential(f.proof,f.rootId),payload=prepared.map(p=>({input:p.input,originalUploadId:p.status.session.uploadId,claimToken:uid(),mimeType:'application/octet-stream'})),before=await state(f);
  const variants:unknown[]=[[],null,[...payload,payload[0]],[payload[0],payload[0]],
    payload.map((p,n)=>n===3?{...p,originalUploadId:uid()}:p),
    payload.map((p,n)=>n===3?{...p,input:{...p.input,epoch:uid()}}:p),
    payload.map((p,n)=>n===3?{...p,input:{...p.input,intent:{...p.input.intent,expectedVersionId:uid()}}}:p),
    payload.map((p,n)=>n===3?{...p,input:{...p.input,intent:{...p.input.intent,parentId:uid()}}}:p),
    payload.map((p,n)=>n===3?{...p,input:{...p.input,intent:{...p.input.intent,sha256:sha('wrong')}}}:p),
    payload.map((p,n)=>n===3?{...p,extra:true}:p)];
  for(const variant of variants){await expect(f.writer.catalogUploadBatch('claim-cas-set',credential,variant)).rejects.toThrow();expect(await state(f)).toEqual(before);}
  await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);
  await expect(f.writer.catalogUploadBatch('claim-cas-set',credential,payload)).rejects.toThrow('authorization_changed');expect(await state(f)).toEqual(before);
  await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=true WHERE sync_root_id=${f.rootId}`);
  for(const p of prepared)await database.cancel(p,f.proof);
  // Two retained originals leave capacity for a real competing writer, whose
  // successful publication changes the final member after its reservation.
  const stale=[];for(let n=0;n<2;n++){let p=await files.prepareCatalogUpload(f.uploadInput('cas-'+String(n)+'.bin',bytes,previous(fixtureValue(seed.old[n]))),f.proof);p=await files.appendCatalogUpload(p,f.proof,'0',bytes);stale.push(p);}
  await f.upload(f.uploadInput('cas-1.bin',Buffer.alloc(49152,222),previous(fixtureValue(seed.old[1]))),Buffer.alloc(49152,222));
  const beforeConflict=await state(f),requests=stale.map(p=>({prepared:p,mimeType:'application/octet-stream',claimToken:uid()}));
  await expect(database.verifyAndClaimGroup(requests,f.proof)).rejects.toThrow('precondition_failed');
  expect(await state(f)).toEqual(beforeConflict);
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM catalog_upload_publication_groups`)).toHaveLength(0);
  for(const p of stale){expect(sha(await physical(f,p.execution.tempPath))).toBe(sha(bytes));await database.cancel(p,f.proof);}
  await evidence(id,'result',{malformedVariants:variants.length,revokedAuthority:true,actualCompetingOverwrite:true,noGroupOnFailure:true,retainedOriginalBytes:true});
 }finally{vi.restoreAllMocks();await f.close();}
},90000);

it('resolves a lost CAS publication acknowledgement by the same durable receipts without duplicate versions',async()=>{
 const id='n01-cas-set-lost-ack',f=await activeFixture(id,'windows',migration),{files}=composition(f);
 let releaseVerified=()=>{},verifiedTimer:ReturnType<typeof setTimeout>|undefined,completionJoin:Promise<unknown>|undefined;
 try{
  const seed=await seeded(f),bytes=Buffer.alloc(49152,172),prepared=[];
  for(const [n,old]of seed.old.entries())prepared.push(await files.prepareCatalogUpload(f.uploadInput('cas-'+String(n)+'.bin',bytes,previous(old)),f.proof));
  const send=f.writer.catalogUploadBatch.bind(f.writer);let lost=0;
  vi.spyOn(f.writer,'catalogUploadBatch').mockImplementation(async(...args)=>{const value=await send(...args);if(args[0]==='publish-cas-set'&&lost++===0)throw Error('Injected lost SQL publication ACK');return value;});
  // Qualify one four-member ready set while retaining all real verified writes.
  // The grouping must not depend on host fsync scheduling before the ACK fault.
  const writeVerified=f.executor.writeVerifiedOnce.bind(f.executor),verifiedGate=new Promise<void>(resolve=>{releaseVerified=resolve;});
  let verifiedReady=0,verifiedExpired=false;
  verifiedTimer=setTimeout(()=>{verifiedExpired=true;releaseVerified();},5000);
  vi.spyOn(f.executor,'writeVerifiedOnce').mockImplementation(async(...args)=>{
   const proof=await writeVerified(...args);verifiedReady++;
   if(verifiedReady===prepared.length){clearTimeout(verifiedTimer);releaseVerified();}
   await verifiedGate;if(verifiedExpired)throw Error('Lost-ACK CAS fixture did not reach four real verified originals');return proof;
  });
  const completing=prepared.map(p=>files.completeSmallCatalogUpload(p,f.proof,bytes));
  completionJoin=Promise.allSettled(completing);const results=await Promise.all(completing);
  expect(verifiedReady).toBe(4);expect(verifiedExpired).toBe(false);
  expect(lost).toBe(1);expect(results.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
  expect(results.map(p=>previous(p).nodeId)).toEqual(seed.old.map(p=>previous(p).nodeId));
  for(const [n,p]of results.entries()){expect(sha(await physical(f,p.execution.targetPath))).toBe(sha(bytes));expect(sha(await physical(f,fixtureValue(p.execution.archivePath)))).toBe(sha(fixtureValue(seed.bytes[n])));}
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(8);
  await evidence(id,'result',{lostAckAfterSqlCommit:1,sameOriginalReceipts:true,versions:8,fullShaAndOldArchives:true});
 }finally{releaseVerified();clearTimeout(verifiedTimer);await completionJoin;vi.restoreAllMocks();await f.close();}
},90000);

it('does not bypass a rejected CAS set through per-member publication when its last version is stale',async()=>{
 const id='n01-cas-stale-no-fallback',f=await activeFixture(id,'windows',migration),{database,files}=composition(f);
 try{
  const seed=await seeded(f,2),bytes=Buffer.alloc(49152,169),prepared=[];
  for(const [n,old]of seed.old.entries())prepared.push(await files.prepareCatalogUpload(f.uploadInput('cas-'+String(n)+'.bin',bytes,previous(old)),f.proof));
  const competing=Buffer.alloc(49152,170);
  await f.upload(f.uploadInput('cas-1.bin',competing,previous(fixtureValue(seed.old[1]))),competing);
  const effects=vi.spyOn(f.raw,'rename');
  const commands=vi.spyOn(f.writer,'catalogUploadBatch');
  // The premise is one two-member ready set. Independent fsync arrivals may
  // legitimately form separate publications under the real tail deadline.
  // Hold only post-verification admission; all real writes/SQL/timers remain.
  const outcomes=await readySmallPublications(f,{database,files},prepared.map(p=>({prepared:p,bytes})));
  const claims=commands.mock.calls.filter(([command])=>command==='claim-cas-set');
  expect(claims).toHaveLength(1);expect(fixtureValue(claims[0])[2]).toHaveLength(2);
  expect(commands.mock.calls.filter(([command])=>command==='publish-cas-set')).toHaveLength(0);
  expect(outcomes.every(x=>x.status==='rejected'&&String(x.reason).includes('precondition_failed'))).toBe(true);
  expect(effects).not.toHaveBeenCalled();
  expect(sha(await physical(f,fixtureValue(prepared[0]).execution.targetPath))).toBe(sha(fixtureValue(seed.bytes[0])));
  expect(sha(await physical(f,fixtureValue(prepared[1]).execution.targetPath))).toBe(sha(competing));
  for(const p of prepared)expect(sha(await physical(f,p.execution.tempPath))).toBe(sha(bytes));
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(3);
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM catalog_upload_publication_groups`)).toHaveLength(0);
  await evidence(id,'result',{actualCompetingWriter:true,staleLastVersion:true,noPerMemberFallback:true,noNewPhysicalEffects:true,originalBytesRetained:true,oneActualTwoMemberCasClaim:true});
 }finally{vi.restoreAllMocks();await f.close();}
},90000);

it('retains both generations and every original after a partial CAS group effect without blind retry',async()=>{
 const id='n01-cas-set-partial',f=await activeFixture(id,'windows',migration),{database,files}=composition(f);
 let releaseVerified=()=>{},verifiedTimer:ReturnType<typeof setTimeout>|undefined,completionJoin:Promise<unknown>|undefined;
 try{
  const seed=await seeded(f),bytes=Buffer.alloc(49152,188),prepared:PreparedCatalogUpload[]=[];
  for(const [n,old]of seed.old.entries())prepared.push(await files.prepareCatalogUpload(f.uploadInput('cas-'+String(n)+'.bin',bytes,previous(old)),f.proof));
  const rename=f.raw.rename.bind(f.raw);let injected=false;
  const calls=vi.spyOn(f.raw,'rename').mockImplementation(async(a,b)=>{await rename(a,b);if(!injected&&a===fixtureValue(prepared[2]).execution.targetPath){injected=true;throw Error('Injected response loss after old-version archive rename');}});
  // Inject a partial effect into one genuinely ready four-member CAS set.
  // A slower real verified write must not change this into several sets.
  const writeVerified=f.executor.writeVerifiedOnce.bind(f.executor),verifiedGate=new Promise<void>(resolve=>{releaseVerified=resolve;});
  let verifiedReady=0,verifiedExpired=false;
  verifiedTimer=setTimeout(()=>{verifiedExpired=true;releaseVerified();},5000);
  vi.spyOn(f.executor,'writeVerifiedOnce').mockImplementation(async(...args)=>{
   const proof=await writeVerified(...args);verifiedReady++;
   if(verifiedReady===prepared.length){clearTimeout(verifiedTimer);releaseVerified();}
   await verifiedGate;if(verifiedExpired)throw Error('Partial CAS fixture did not reach four real verified originals');return proof;
  });
  const completing=prepared.map(p=>files.completeSmallCatalogUpload(p,f.proof,bytes));
  completionJoin=Promise.allSettled(completing);const outcomes=await Promise.allSettled(completing);
  expect(verifiedReady).toBe(4);expect(verifiedExpired).toBe(false);
  expect(injected).toBe(true);expect(outcomes.every(x=>x.status==='rejected')).toBe(true);
  const originalRows=await state(f),unresolved=originalRows.filter(r=>r.sync_result===null);
  expect(unresolved).toHaveLength(4);expect(unresolved.every(r=>['physical_pending','reconciliation_required'].includes(String(r.upload_effect_state)))).toBe(true);
  for(const [n,p]of prepared.entries()){
   const newPath=await f.raw.exists(p.execution.tempPath)?p.execution.tempPath:p.execution.targetPath;
   expect(sha(await physical(f,newPath))).toBe(sha(bytes));
   const oldPath=await f.raw.exists(fixtureValue(p.execution.archivePath))?fixtureValue(p.execution.archivePath):p.execution.targetPath;
   expect(sha(await physical(f,oldPath))).toBe(sha(fixtureValue(seed.bytes[n])));
  }
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(4);
  const effects=calls.mock.calls.length,writes=vi.spyOn(f.raw,'write');
  for(const p of prepared){await expect(files.completeSmallCatalogUpload(p,f.proof,bytes)).rejects.toThrow();await expect(database.cancel(p,f.proof)).rejects.toThrow();}
  expect(calls.mock.calls).toHaveLength(effects);expect(writes).not.toHaveBeenCalled();
  await expect(files.prepareCatalogUpload(f.uploadInput('new-after-unknown.bin',bytes),f.proof)).rejects.toThrow();
  expect((await state(f)).map(r=>r.id)).toEqual(originalRows.map(r=>r.id));
  await evidence(id,'result',{partialEffectAfterArchive:true,oldAndNewBytesRetained:true,originals:4,versionsUnchanged:4,noBlindRetry:true,newAdmissionBlocked:true,automaticReconciliationProved:false});
 }catch(error){await evidence(id,'assertion-failure',{message:String(error),stack:error instanceof Error?error.stack:undefined,originalRows:await state(f)});throw error;}
 finally{
  releaseVerified();clearTimeout(verifiedTimer);await completionJoin;
  vi.restoreAllMocks();
  try{await expect(f.executor.close()).rejects.toThrow('backend_close_unconfirmed');}
  finally{await Promise.all([f.runtime.close(),f.writer.close(),f.admin.close()]);}
 }
},90000);

it('keeps a small replacement of a large predecessor on the ordinary bounded path',async()=>{
 const id='n01-cas-set-large-before',f=await activeFixture(id,'windows',migration),{files}=composition(f);
 try{
  const seed=await seeded(f,4,262145),bytes=Buffer.alloc(4096,114),prepared=[];
  for(const [n,old]of seed.old.entries())prepared.push(await files.prepareCatalogUpload(f.uploadInput('cas-'+String(n)+'.bin',bytes,previous(old)),f.proof));
  const calls=vi.spyOn(f.writer,'catalogUploadBatch');
  const result=await Promise.all(prepared.map(p=>files.completeSmallCatalogUpload(p,f.proof,bytes)));
  expect(calls.mock.calls.some(([c])=>c==='claim-cas-set'||c==='publish-cas-set')).toBe(false);
  expect(result.map(p=>previous(p).nodeId)).toEqual(seed.old.map(p=>previous(p).nodeId));
  for(const [n,p]of result.entries()){expect(sha(await physical(f,p.execution.targetPath))).toBe(sha(bytes));expect(sha(await physical(f,fixtureValue(p.execution.archivePath)))).toBe(sha(fixtureValue(seed.bytes[n])));}
  await evidence(id,'result',{oldSize:262145,newSize:4096,ordinaryFallback:true,files:4,fullShaAndArchives:true});
 }finally{vi.restoreAllMocks();await f.close();}
},90000);

it('preserves an independent fresh CAS completion while a later stale original is rejected',async()=>{
 const id='n01-cas-independent-ready-members',f=await activeFixture(id,'windows',migration),{files}=composition(f);
 let releaseSecond=()=>{},timer:ReturnType<typeof setTimeout>|undefined,completionJoin:Promise<PromiseSettledResult<PreparedCatalogUpload>[]>|undefined;
 try{
  const seed=await seeded(f,2),bytes=Buffer.alloc(49152,169),prepared:PreparedCatalogUpload[]=[];
  for(const [n,old]of seed.old.entries())prepared.push(await files.prepareCatalogUpload(f.uploadInput('cas-'+String(n)+'.bin',bytes,previous(old)),f.proof));
  const competing=Buffer.alloc(49152,170);
  await f.upload(f.uploadInput('cas-1.bin',competing,previous(fixtureValue(seed.old[1]))),competing);
  const existing=await f.admin.withSql(sql=>sql<{id:string}[]>`SELECT id FROM file_versions ORDER BY id`);
  const write=f.executor.writeVerifiedOnce.bind(f.executor),gate=new Promise<void>(resolve=>{releaseSecond=resolve;});let verified=0,expired=false;
  timer=setTimeout(()=>{expired=true;releaseSecond();},5000);
  vi.spyOn(f.executor,'writeVerifiedOnce').mockImplementation(async(...args)=>{
   const proof=await write(...args);verified++;
   if(args[1]===fixtureValue(prepared[1]).execution.tempPath)await gate;
   return proof;
  });
  const completing=prepared.map(p=>files.completeSmallCatalogUpload(p,f.proof,bytes));completionJoin=Promise.allSettled(completing);
  void fixtureValue(completing[0]).then(()=>{clearTimeout(timer);releaseSecond();},()=>{clearTimeout(timer);releaseSecond();});
  const outcomes=await completionJoin;expect(expired).toBe(false);expect(verified).toBe(2);
  const first=fixtureValue(outcomes[0]),last=fixtureValue(outcomes[1]);
  expect(first.status).toBe('fulfilled');expect(last.status).toBe('rejected');
  if(first.status!=='fulfilled'||last.status!=='rejected')throw Error('Independent CAS fixture did not reach declared outcomes');
  expect(first.value.status.result?.status).toBe('PUBLISHED');expect(previous(first.value).nodeId).toBe(previous(fixtureValue(seed.old[0])).nodeId);
  expect(String(last.reason)).toContain('precondition_failed');
  expect(sha(await physical(f,fixtureValue(prepared[0]).execution.targetPath))).toBe(sha(bytes));
  expect(sha(await physical(f,fixtureValue(fixtureValue(prepared[0]).execution.archivePath)))).toBe(sha(fixtureValue(seed.bytes[0])));
  expect(sha(await physical(f,fixtureValue(prepared[1]).execution.targetPath))).toBe(sha(competing));
  expect(sha(await physical(f,fixtureValue(prepared[1]).execution.tempPath))).toBe(sha(bytes));
  const after=await f.admin.withSql(sql=>sql<{id:string}[]>`SELECT id FROM file_versions ORDER BY id`);
  expect(after).toHaveLength(4);expect(existing.every(row=>after.some(next=>next.id===row.id))).toBe(true);
  expect(await f.admin.withSql(sql=>sql`SELECT id FROM catalog_upload_publication_groups`)).toHaveLength(0);
  await evidence(id,'result',{separateRealPostVerificationArrivals:true,productTailTimerUnchanged:true,freshOriginalPublished:true,staleOriginalRetained:true,competingBytesPreserved:true,fullPhysicalSha:true,allPriorVersionIdsPreserved:true,versions:4});
 }finally{releaseSecond();clearTimeout(timer);await completionJoin;vi.restoreAllMocks();await f.close();}
},90000);
