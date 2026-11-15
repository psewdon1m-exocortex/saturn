import { fixtureValue } from './test-values.fixture.js';
import {expect,it,vi} from 'vitest';
import {activeFixture,uid} from './stage3-chat-a.fixture.js';
const migration=Number(process.env.SMALL_FILE_PIPELINE_MIGRATION??97);
type Fixture=Awaited<ReturnType<typeof activeFixture>>;
function plan(f:Fixture,prefix:string){
 const bytes=Buffer.alloc(1024,71),inputs=Array.from({length:16},(_,n)=>f.uploadInput(`${prefix}-${String(n)}.bin`,bytes));
 const manifest={...f.wireBinding,schema:'saturn.small-file-batch.v1',batch_id:uid(),rules_version:'pipeline-test-v1',items:inputs.map(input=>({
  operation_id:input.intent.idempotencyKey,source_generation:'1',source_identity:input.intent.idempotencyKey,parent_id:input.intent.parentId,
  name:input.intent.name,size_bytes:input.intent.sizeBytes,sha256:input.intent.sha256,expected:{kind:'absent'},
 }))};
 return {manifest,inputs};
}
async function accept(f:Fixture,p:ReturnType<typeof plan>){
 const credential=f.issuer.deviceCredential(f.proof,f.rootId);
 return f.writer.withSql(async sql=>fixtureValue((await sql<{value:{items:{originalUploadId:string}[]}}[]>`SELECT catalog_upload_command('accept-job','{}'::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify({planBytes:JSON.stringify(p)})}::text::jsonb) AS value`)[0]).value);
}
it('admits only two distinct private sibling jobs and keeps UNKNOWN ahead of new work',async()=>{
 const f=await activeFixture('smallfile-two-private-jobs','windows',migration);
 try{
  const one=plan(f,'one'),two=plan(f,'two');const first=await accept(f,one);
  const collision=plan(f,'one');await expect(accept(f,collision)).rejects.toThrow(/precondition_failed|admission_full/);
  const second=await accept(f,two);expect(second.items).toHaveLength(16);
  expect((await accept(f,one)).items.map(i=>i.originalUploadId)).toEqual(first.items.map(i=>i.originalUploadId));
  await expect(accept(f,plan(f,'three'))).rejects.toThrow('admission_full');
  const read=()=>f.runtime.withSql(async sql=>fixtureValue((await sql<{allowed:boolean}[]>`SELECT catalog_guard_read_admission(g.root_id,c.epoch,c.binding_version,g.guard_revision) AS allowed FROM catalog_guard_roots g JOIN sync_root_clock c ON c.root_id=g.root_id WHERE g.root_id=${f.rootId}`)[0]).allowed);
  expect(await read()).toBe(true);
  // Drive a real stored original to the physical boundary, then lose rename.
  // No direct row rewrite or disabled trigger manufactures the UNKNOWN state.
  let original=await f.files.prepareCatalogUpload(fixtureValue(one.inputs[0]),f.proof,fixtureValue(first.items[0]).originalUploadId);
  original=await f.files.appendCatalogUpload(original,f.proof,'0',Buffer.alloc(1024,71));
  vi.spyOn(f.raw,'rename').mockRejectedValueOnce(Error('lost physical rename'));
  await expect(f.files.completeCatalogUpload(original,f.proof)).rejects.toThrow('reconciliation_required');
  expect(await read()).toBe(false);
  await expect(accept(f,plan(f,'after-unknown'))).rejects.toThrow(/admission_full|binding_invalid/);
  const count=await f.admin.withSql(sql=>sql<{count:number}[]>`SELECT count(*)::int AS count FROM operation_journal WHERE sync_root_id=${f.rootId} AND upload_execution_job IS NOT NULL`);
  expect(fixtureValue(count[0]).count).toBe(32);
 }finally{
  vi.restoreAllMocks();
  try{await f.executor.close();}catch(error){const message:unknown=expect.stringMatching(/backend_close_unconfirmed|reconciliation_required/);expect(error).toMatchObject({message});}
  await Promise.all([f.runtime.close(),f.writer.close(),f.admin.close()]);
 }
},60000);
