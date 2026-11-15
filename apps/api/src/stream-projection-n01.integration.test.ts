import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {activeFixture,databaseFixture,evidence,migrations,sha,uid} from './stage3-chat-a.fixture.js';
import {CatalogStreamUpload} from '../../../packages/file-core/src/catalog-stream-upload.js';
import type {SyncStreamPrepare,SyncStreamChunk} from '../../../packages/contracts/src/sync-stream.js';

const cutoff=Number(process.env.N01_STREAM_PROJECTION_MIGRATION??111);
if(![105,111].includes(cutoff))throw Error('Owned projection migration required');
const chunkBytes=4194304 as const;
const blocks=()=>[Buffer.alloc(chunkBytes,31),Buffer.alloc(chunkBytes,79),Buffer.alloc(31,127)];
const descriptors=(data:Buffer[]):SyncStreamChunk[]=>data.map((bytes,index)=>({index,offset:String(index*chunkBytes),length:String(bytes.length),sha256:sha(bytes)}));
const originalFor=(f:Awaited<ReturnType<typeof activeFixture>>,data:Buffer[]):SyncStreamPrepare=>{
 const input=f.uploadInput('projection.bin',Buffer.alloc(0));
 return {schema:'saturn.stream-upload.v2',operationId:uid(),source:{generation:'1',witnessSha256:sha('owned-three-distinct-parts')},chunkBytes,
  prepare:{...input,intent:{...input.intent,sizeBytes:String(data.reduce((n,b)=>n+b.length,0)),sha256:null}}};
};
async function enable(f:Awaited<ReturnType<typeof activeFixture>>){await f.admin.withSql(sql=>sql`UPDATE sync_root_policy SET features=features||'"scale-transfer-v2"'::jsonb WHERE root_id=${f.rootId}`);}
async function publishedOracle(f:Awaited<ReturnType<typeof activeFixture>>,expected:string,size:number){
 const row=fixtureValue((await f.admin.withSql(sql=>sql<{id:string;current_version_id:string;storage_path:string;sha256:string;size:string;versions:number}[]>`
  SELECT r.id,r.current_version_id,r.storage_path,r.sha256,r.size_bytes::text AS size,(SELECT count(*)::int FROM file_versions v WHERE v.resource_id=r.id) AS versions
  FROM resources r WHERE r.parent_id=${f.rootId} AND r.name='projection.bin'`))[0]);
 expect(row.sha256).toBe(expected);expect(row.size).toBe(String(size));expect(row.versions).toBe(1);
 const digest=createHash('sha256');let bytes=0;for await(const block of fixtureChunks(await f.raw.openRead(row.storage_path))){digest.update(block);bytes+=block.length;}
 expect(bytes).toBe(size);expect(digest.digest('hex')).toBe(expected);return row;
}

it('v2 ACK projection returns exact distinct descriptors before and after publication and fresh coordinator replay',async()=>{
 const f=await activeFixture('n01-stream-projection','windows',cutoff);
 try{
  await enable(f);const data=blocks(),parts=descriptors(data),original=originalFor(f,data),size=data.reduce((n,b)=>n+b.length,0),expected=sha(Buffer.concat(data));
  await f.streams.prepare(original,f.proof);
  const write=vi.spyOn(f.raw,'write');
  for(const [index,bytes] of data.entries())await f.streams.append(original,fixtureValue(parts[index]),bytes,f.proof);
  const received=await f.streams.status(original,f.proof);
  expect(received.chunks,'ACK descriptors must identify actual persisted parts, not payload-local NULL').toEqual(parts);
  expect((await f.streams.status(original,f.proof,0)).chunks).toEqual(parts.slice(1));
  expect((await f.streams.status(original,f.proof,1)).chunks).toEqual(parts.slice(2));
  expect((await f.streams.status(original,f.proof,2)).chunks).toEqual([]);
  const fresh=new CatalogStreamUpload(f.writer,f.issuer,f.executor,f.files),writes=write.mock.calls.length;
  await fresh.append(original,fixtureValue(parts[1]),fixtureValue(data[1]),f.proof);expect(write.mock.calls).toHaveLength(writes);
  const outcome=await fresh.seal(original,{sha256:expected,sourceGeneration:'1',sourceWitnessSha256:original.source.witnessSha256},f.proof);
  expect(outcome.state).toBe('PUBLISHED');expect(outcome.chunks).toEqual(parts);
  const row=await publishedOracle(f,expected,size);
  const repeated=await fresh.complete(original,f.proof);expect(repeated.state).toBe('PUBLISHED');expect(repeated.chunks).toEqual(parts);
  expect(await publishedOracle(f,expected,size)).toEqual(row);
  await evidence('n01-stream-projection','exact-descriptors',{cutoff,status:'PASS',operationId:original.operationId,parts,resource:row,bytes:size,sha256:expected,replayWrites:0,scope:'actual DB and physical Local; fresh service object, not process restart'});
 }finally{await f.close();}
},60000);

it('projection migration preserves retained published originals, versions and bytes and refuses unsafe rollback',async()=>{
 const f=await activeFixture('n01-stream-projection-retained','windows',105);
 try{
  await enable(f);const data=blocks(),parts=descriptors(data),original=originalFor(f,data),size=data.reduce((n,b)=>n+b.length,0),expected=sha(Buffer.concat(data));
  await f.streams.prepare(original,f.proof);for(const [i,b] of data.entries())await f.streams.append(original,fixtureValue(parts[i]),b,f.proof);
  const old=await f.streams.seal(original,{sha256:expected,sourceGeneration:'1',sourceWitnessSha256:original.source.witnessSha256},f.proof);
  expect(old.state).toBe('PUBLISHED');expect(old.chunks).toEqual([null,null,null]);
  const before=await publishedOracle(f,expected,size);
  await expect(f.admin.withSql(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0111_stream_part_projection.up.sql'),'utf8')))).rejects.toThrow('backend must be stopped before stream projection migration');
  await f.executor.close();
  await f.admin.withSql(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0111_stream_part_projection.up.sql'),'utf8')));
  const after=await f.streams.status(original,f.proof);expect(after.state).toBe('PUBLISHED');expect(after.chunks).toEqual(parts);
  expect(await publishedOracle(f,expected,size)).toEqual(before);
  await expect(f.admin.withSql(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0111_stream_part_projection.down.sql'),'utf8')))).rejects.toThrow('retained v2 state prevents projection rollback');
  await evidence('n01-stream-projection-retained','repair',{status:'PASS',operationId:original.operationId,before,after,physicalBytesUnchanged:true,scope:'reader projection only; live runtime manifests still require normal requalification'});
 }finally{await f.close();}
},60000);

it('projection migration rolls back exactly on an empty stopped fixture and rejects a changed predecessor',async()=>{
 const f=await databaseFixture('n01-stream-projection-rollback',105);
 try{
  const definition=async()=>f.db.withSql(sql=>sql<{definition:string}[]>`SELECT pg_get_functiondef('public.sync_stream_command(text,jsonb,jsonb,jsonb)'::regprocedure) AS definition`);
  const before=await definition(),up=await fs.readFile(path.join(migrations,'0111_stream_part_projection.up.sql'),'utf8'),down=await fs.readFile(path.join(migrations,'0111_stream_part_projection.down.sql'),'utf8');
  await f.db.withSql(sql=>sql.unsafe(up));expect(await definition()).not.toEqual(before);
  await expect(f.db.withSql(sql=>sql.unsafe(up))).rejects.toThrow('stream projection predecessor changed');
  await f.db.withSql(sql=>sql.unsafe(down));expect(await definition()).toEqual(before);
  await evidence('n01-stream-projection-rollback','exact',{status:'PASS',beforeSha256:sha(fixtureValue(before[0]).definition),exactRoundTrip:true});
 }finally{await f.close();}
},30000);
