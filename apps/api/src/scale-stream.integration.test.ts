import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {activeFixture,evidence,sha,uid} from './stage3-chat-a.fixture.js';
import {CatalogStreamUpload} from '../../../packages/file-core/src/catalog-stream-upload.js';
import type {SyncStreamPrepare} from '../../../packages/contracts/src/sync-stream.js';

it('v2 publishes >2GiB with paged ACKs, four parts in flight, retained restart and whole-file SHA readback',async()=>{
  const size=2*1024**3+17,chunkBytes=4194304;
  const f=await activeFixture('scale-stream','windows',74,undefined,String(64*1024**3));
  try{
    await f.admin.withSql(sql=>sql`UPDATE sync_root_policy SET features=features||'"scale-transfer-v2"'::jsonb WHERE root_id=${f.rootId}`);
    const input=f.uploadInput('large-v2.bin',Buffer.alloc(0));
    const original:SyncStreamPrepare={schema:'saturn.stream-upload.v2',operationId:uid(),source:{generation:'1',witnessSha256:sha('immutable-fixture-source')},chunkBytes,prepare:{...input,intent:{...input.intent,sizeBytes:String(size),sha256:null}}};
    let streams=f.streams;
    try{expect((await streams.prepare(original,f.proof)).state).toBe('RECEIVING');}
    catch(error){
      const credential=f.issuer.deviceCredential(f.proof,f.rootId);
      try{await f.writer.withSql(sql=>sql`SELECT sync_stream_command('prepare',${JSON.stringify(original)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,'{}'::jsonb)`);}
      catch(e){await evidence('scale-stream','prepare-failure',{where:(e as {where?:string}).where,message:String(e),rows:await f.admin.withSql(sql=>sql`SELECT state,count(*)::int AS n FROM sync_stream_uploads GROUP BY state`)});}
      throw error;
    }
    const block=Buffer.alloc(chunkBytes,57),blockHash=sha(block),tail=block.subarray(0,17),digest=createHash('sha256');
    const part=(index:number)=>({index,offset:String(index*chunkBytes),length:String(index===512?17:chunkBytes),sha256:index===512?sha(tail):blockHash});
    let active=0,peak=0;const write=f.raw.write.bind(f.raw);
    const writeSpy=vi.spyOn(f.raw,'write').mockImplementation(async(...args)=>{active++;peak=Math.max(peak,active);try{return await write(...args);}finally{active--;}});
    const send=async(index:number)=>streams.append(original,part(index),index===512?tail:block,f.proof);
    const started=performance.now();await send(0);digest.update(block);
    for(let first=1;first<261;first+=4){const indices=Array.from({length:Math.min(4,261-first)},(_,n)=>first+n);await Promise.all(indices.map(send));for(let n=0;n<indices.length;n++)digest.update(block);}
    // Recreate only the protocol object; retained DB/physical IDs are unchanged.
    streams=new CatalogStreamUpload(f.writer,f.issuer,f.executor,f.files);
    const page1=await streams.status(original,f.proof),page2=await streams.status(original,f.proof,fixtureValue(page1.nextIndex));
    expect(page1.chunks).toHaveLength(256);expect(page1.nextIndex).toBe(255);expect(page2.chunks).toHaveLength(5);expect(page2.nextIndex).toBeNull();
    const writes=writeSpy.mock.calls.length;await send(256);expect(writeSpy.mock.calls).toHaveLength(writes);
    await expect(streams.append(original,{...part(256),sha256:sha('wrong')},block,f.proof)).rejects.toMatchObject({code:'invalid_input'});
    for(let first=261;first<=512;first+=4){const indices=Array.from({length:Math.min(4,513-first)},(_,n)=>first+n);await Promise.all(indices.map(send));for(const index of indices)digest.update(index===512?tail:block);}
    const expected=digest.digest('hex');const outcome=await streams.seal(original,{sha256:expected,sourceGeneration:'1',sourceWitnessSha256:original.source.witnessSha256},f.proof);
    expect(outcome.state).toBe('PUBLISHED');expect(outcome.receivedSizeBytes).toBe(String(size));
    const row=fixtureValue((await f.admin.withSql(sql=>sql<{storage_path:string;sha256:string;size:string}[]>`SELECT storage_path,sha256,size_bytes::text AS size FROM resources WHERE parent_id=${f.rootId} AND name='large-v2.bin'`))[0]);
    const readback=createHash('sha256');let bytes=0;const readStarted=performance.now();
    for await(const b of fixtureChunks(await f.raw.openRead(row.storage_path))){bytes+=b.length;readback.update(b);}
    expect(bytes).toBe(size);expect(row.sha256).toBe(expected);expect(readback.digest('hex')).toBe(expected);expect(peak).toBeGreaterThan(1);expect(peak).toBeLessThanOrEqual(4);
    const count=fixtureValue((await f.admin.withSql(sql=>sql<{n:number}[]>`SELECT count(*)::int AS n FROM file_versions WHERE resource_id=(SELECT id FROM resources WHERE parent_id=${f.rootId} AND name='large-v2.bin')`))[0]).n;
    expect((await streams.complete(original,f.proof)).state).toBe('PUBLISHED');expect(count).toBe(1);
    // Tens-of-GiB admission is a metadata/limit test, not a full transfer claim.
    const bigger={...original,operationId:uid(),prepare:{...original.prepare,intent:{...original.prepare.intent,idempotencyKey:uid(),name:'64GiB.bin',sizeBytes:String(64*1024**3)}}};
    expect((await streams.prepare(bigger,f.proof)).receivedSizeBytes).toBe('0');
    await evidence('scale-stream','result',{status:'PASS',size,parts:513,peak,elapsedMs:performance.now()-started,readbackMs:performance.now()-readStarted,sha256:expected,fullReadback:true,retainedRestart:true,replayWrites:0,admissionOnlyBytes:64*1024**3});
  }finally{await f.close();}
},180000);
