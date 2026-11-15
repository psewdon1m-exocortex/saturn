import {expect,it,vi} from 'vitest';
import {activeFixture,evidence,uid} from './stage3-chat-a.fixture.js';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';

it('SQL upload batch commits valid originals independently and retains their result after an invalid neighbour',async()=>{
  const f=await activeFixture('scale-upload-batch','windows',74);
  try{
    const coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
    const spy=vi.spyOn(f.writer,'catalogUploadBatch');
    const a=f.uploadInput('a',Buffer.from('a')),b=f.uploadInput('b',Buffer.from('b'));
    const outcomes=await Promise.allSettled([coordinator.prepare(a,f.proof),coordinator.prepare({...b,bindingVersion:uid()},f.proof),coordinator.prepare(b,f.proof)]);
    expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.calls[0]?.[0]).toBe('batch');expect(spy.mock.calls[0]?.[2]).toHaveLength(3);expect(outcomes.map(r=>r.status)).toEqual(['fulfilled','rejected','fulfilled']);
    if(outcomes[0].status!=='fulfilled'||outcomes[2].status!=='fulfilled')throw Error('missing independent originals');
    const replay=await coordinator.prepare(a,f.proof);expect(replay.status.session.uploadId).toBe(outcomes[0].value.status.session.uploadId);
    expect((await f.upload(a,Buffer.from('a'))).status.result?.status).toBe('PUBLISHED');
    expect((await f.upload(b,Buffer.from('b'))).status.result?.status).toBe('PUBLISHED');
    await evidence('scale-upload-batch','result',{status:'PASS',sqlTransactionsForThree:1,individualResults:['accepted','binding_invalid','accepted'],replaySameOriginal:true});
  }finally{await f.close();}
},60000);
