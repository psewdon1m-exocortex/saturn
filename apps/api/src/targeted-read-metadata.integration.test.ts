import { fixtureValue } from './test-values.fixture.js';
import {expect,it} from 'vitest';
import {Readable} from 'node:stream';
import {backendFixture,evidence,uid} from './stage3-chat-a.fixture.js';

it('reserves metadata progress while slow physical readers occupy the content lane',async()=>{
 const f=await backendFixture('targeted-metadata',119); const readers:Readable[]=[];
 try{
  await f.raw.write('slow.bin',Readable.from(Buffer.alloc(262144,51)),{offset:0,create:true,exclusive:true,truncate:false});
  for(let i=0;i<3;i++)readers.push(await f.executor.openRead('slow.bin'));
  const before=performance.now();
  expect(await f.executor.exists('slow.bin')).toBe(true);
  expect((await f.executor.stat('slow.bin')).size).toBe(262144);
  const ms=performance.now()-before;expect(ms).toBeLessThan(3000);
  const identity={backendIdentity:f.backendIdentity,generation:f.generation,ownerId:uid(),fencingToken:uid()}, fourth=uid();
  const acquire=(id:string,kind:string)=>f.command('read-acquire',identity,{id,priority:'foreground',kind}) as Promise<{acquired:boolean}>;
  expect(await acquire(fourth,'content')).toEqual({acquired:false});
  const metadata=uid();expect(await acquire(metadata,'metadata')).toEqual({acquired:true});
  await expect(acquire(metadata,'content')).rejects.toThrow('operation_reused');
  const fifth=uid();expect(await acquire(fifth,'metadata')).toEqual({acquired:false});
  expect((await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_read_slots WHERE state='ACTIVE'`)).length).toBe(4);
  await f.command('read-release',identity,{id:metadata});await f.command('read-release',identity,{id:fifth});await f.command('read-release',identity,{id:fourth});
  for(const r of readers){r.resume();for await(const chunk of r){void chunk;}}
  await evidence('targeted-metadata','result',{status:'PASS',metadataMs:ms,contentReaders:3,peakTotalReaders:4,identityReplayRefused:true});
 }finally{for(const r of readers)r.destroy();await f.close();}
},30000);

it('reproduces the old four-reader metadata timeout before migration and recovers only after physical close',async()=>{
 const f=await backendFixture('targeted-metadata-before',112);const readers:Readable[]=[];
 try{
  await f.raw.write('slow.bin',Readable.from(Buffer.alloc(262144,51)),{offset:0,create:true,exclusive:true,truncate:false});
  for(let i=0;i<4;i++)readers.push(await f.executor.openRead('slow.bin'));
  const start=performance.now();await expect(f.executor.stat('slow.bin')).rejects.toMatchObject({code:'admission_full'});
  const elapsedMs=performance.now()-start;expect(elapsedMs).toBeGreaterThanOrEqual(9900);
  for await(const chunk of fixtureValue(readers[0])){void chunk;}
  expect((await f.executor.stat('slow.bin')).size).toBe(262144);
  await evidence('targeted-metadata-before','result',{status:'REPRODUCED',code:'admission_full',activeDownloads:4,elapsedMs,recoveredAfterPhysicalClose:true,migrationCutoff:112});
 }finally{for(const r of readers)r.destroy();await f.close();}
},30000);
