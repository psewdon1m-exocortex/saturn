import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import {expect,it,vi} from 'vitest';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,uid,sha} from './stage3-chat-a.fixture.js';
const migration=Number(process.env.SMALL_FILE_CLAIM_SET_MIGRATION??95);
type Fixture=Awaited<ReturnType<typeof activeFixture>>;
async function ready(f:Fixture){
  const items=[];
  for(let n=0;n<4;n++){
    const bytes=Buffer.from('claim-set original '+String(n)),input=f.uploadInput('claim-'+String(n)+'.bin',bytes);
    let p=await f.files.prepareCatalogUpload(input,f.proof);p=await f.files.appendCatalogUpload(p,f.proof,'0',bytes);
    items.push({input,p,bytes,request:{input,originalUploadId:p.status.session.uploadId,claimToken:uid(),mimeType:'application/octet-stream'}});
  }
  return items;
}
const state=(f:Fixture)=>f.admin.withSql(sql=>sql`SELECT id,upload_intent,upload_execution,upload_effect_state,upload_claim_token,upload_publication_group,upload_transfer,sync_result FROM operation_journal ORDER BY id`);
async function claim(f:Fixture,items:unknown){const credential=f.issuer.deviceCredential(f.proof,f.rootId);return f.writer.catalogUploadBatch('claim-set',credential,items);}

it('claims the full set once, then publishes individual receipts with exact stored bytes',async()=>{
  const f=await activeFixture('claim-set-publish','windows',migration);
  try{
    const items=await ready(f),coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true),calls=vi.spyOn(f.writer,'catalogUploadBatch');
    const adopted=await Promise.all(items.map(i=>coordinator.prepare(i.input,f.proof,i.p.status.session.uploadId)));
    const claimed=await coordinator.verifyAndClaimGroup(items.map((i,n)=>({prepared:fixtureValue(adopted[n]),mimeType:i.request.mimeType,claimToken:i.request.claimToken})),f.proof);
    expect(calls.mock.calls.some(c=>c[0]==='claim-set')).toBe(true);
    expect(claimed.map(p=>p.claimToken)).toEqual(items.map(i=>i.request.claimToken));
    for(const p of claimed)await f.executor.rename(p.execution.tempPath,p.execution.targetPath);
    const committed=await coordinator.commitSet(claimed.map(prepared=>({prepared,mimeType:'application/octet-stream'})),f.proof);
    expect(committed.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(4);
    for(const [n,p]of committed.entries()){
      const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(p.execution.targetPath)))chunks.push(Buffer.from(chunk));
      expect(sha(Buffer.concat(chunks))).toBe(sha(fixtureValue(items[n]).bytes));
    }
    const after=await state(f);await expect(claim(f,items.map(i=>i.request))).rejects.toThrow();expect(await state(f)).toEqual(after);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('checks every individual intent, original, epoch, parent and transfer before changing any member',async()=>{
  const f=await activeFixture('claim-set-invalid','windows',migration);
  try{
    const items=await ready(f),payload=items.map(i=>i.request),before=await state(f);
    const variants:unknown[]=[null,[],{},[...payload,payload[0]],[payload[0],payload[0],payload[2],payload[3]],
      payload.map((p,n)=>n===3?{...p,originalUploadId:uid()}:p),
      payload.map((p,n)=>n===3?{...p,claimToken:null}:p),
      payload.map((p,n)=>n===3?{...p,input:{...p.input,epoch:uid()}}:p),
      payload.map((p,n)=>n===3?{...p,input:{...p.input,intent:{...p.input.intent,parentId:uid()}}}:p),
      payload.map((p,n)=>n===3?{...p,input:{...p.input,intent:{...p.input.intent,sha256:sha('wrong')}}}:p),
      payload.map((p,n)=>n===3?{...p,transfer:{token:uid(),offset:'0',length:'1',originalUploadId:p.originalUploadId}}:p),
      payload.map((p,n)=>n===3?{...p,extra:true}:p)];
    for(const v of variants){await expect(claim(f,v)).rejects.toThrow();expect(await state(f)).toEqual(before);}
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM catalog_upload_publication_groups`)).toHaveLength(0);
    await f.admin.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE sync_root_id=${f.rootId}`);
    await expect(claim(f,payload)).rejects.toThrow('authorization_changed');expect(await state(f)).toEqual(before);
  }finally{await f.close();}
},60000);
