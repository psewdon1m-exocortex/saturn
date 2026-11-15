import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {activeFixture,uid,sha} from './stage3-chat-a.fixture.js';
import {readSmallBatchPlan} from '../../../packages/file-core/src/small-batch-plan.js';

it.each(['windows','pluto'] as const)('T08 effective installed job contract rejects valid %s CAS before durable admission and keeps individual CAS',async kind=>{
 const f=await activeFixture('acceptance-a-job-CAS-'+kind,kind,111);
 try{
  const oldBytes=Buffer.alloc(1024,12),old=await f.upload(f.uploadInput('existing.bin',oldBytes),oldBytes),published=old.status.result;
  if(published?.status!=='PUBLISHED')throw Error('Published baseline required');
  const desc=published.publishedDescription,bytes=Buffer.alloc(2048,13);
  const input=f.uploadInput('existing.bin',bytes,{nodeId:desc.node_id,metadataVersion:desc.version,versionId:fixtureValue(desc.content_version_id)});
  const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'acceptance-a-CAS',items:[{
   operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:input.intent.idempotencyKey,parent_id:input.intent.parentId,
   name:input.intent.name,size_bytes:input.intent.sizeBytes,sha256:input.intent.sha256,expected:{kind:'version',node_id:desc.node_id,version:desc.version},
  }]};
  const wire=JSON.stringify({manifest,inputs:[input]});expect(readSmallBatchPlan({manifest,inputs:[input]},f.wireBinding).inputs).toHaveLength(1);
  const state=()=>f.admin.withSql(async sql=>({
   originals:await sql`SELECT id,upload_intent_hash,upload_effect_state,sync_result FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`,
   jobs:await sql`SELECT id,manifest_sha256,members FROM sync_small_execution_jobs WHERE root_id=${f.rootId} ORDER BY id`,
   versions:await sql`SELECT id,resource_id,sha256,size_bytes FROM file_versions ORDER BY id`,
   uploads:await sql`SELECT id,status,received_size FROM upload_sessions ORDER BY id`,
  }));
  const before=await state(),credential=f.issuer.deviceCredential(f.proof,f.rootId);
  const definition=fixtureValue((await f.admin.withSql(sql=>sql<{definition:string}[]>`SELECT pg_get_functiondef('public.catalog_upload_accept_job_v1(jsonb,jsonb)'::regprocedure) AS definition`))[0]).definition;
  expect(definition).toContain("a->'intent'->>'targetId' IS NOT NULL");expect(definition).toContain("a->'intent'->>'expectedVersionId' IS NOT NULL");
  for(const command of ['accept-job','execute-job'] as const){
   await expect(f.writer.catalogUploadBatch(command,credential,{planBytes:wire})).rejects.toThrow('invalid_input');expect(await state()).toEqual(before);
  }
  // The CAS publication increment does not turn CAS into a small execution
  // job. The existing individual-original protocol must remain functional.
  const completed=await f.upload(input,bytes);expect(completed.status.result?.status).toBe('PUBLISHED');
  if(completed.status.result?.status!=='PUBLISHED')throw Error('Individual CAS failed');
  expect(completed.status.result.publishedDescription.node_id).toBe(desc.node_id);
  expect(completed.status.result.publishedDescription.content_version_id).not.toBe(desc.content_version_id);
  const chunks:Buffer[]=[];const read=await f.raw.openRead(completed.execution.targetPath);for await(const chunk of fixtureChunks(read))chunks.push(Buffer.from(chunk));await read.storageClosed;
  expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));
  const final=await state();expect(final.jobs).toHaveLength(0);expect(final.originals).toHaveLength(before.originals.length+1);expect(final.versions).toHaveLength(before.versions.length+1);
  const out=process.env.STAGE3_CHAT_A_EVIDENCE;if(!out)throw Error('Evidence directory required');await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(out,'job-CAS-'+kind+'.json'),JSON.stringify({kind,cutoff:111,definitionSha256:sha(definition),validWire:true,acceptAndExecuteRejected:true,noDurableAdmission:true,individualCAS:true,nodeIdPreserved:true,physicalSHA:true},null,2));
 }finally{await f.close();}
},60000);
