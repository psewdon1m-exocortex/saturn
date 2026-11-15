import {expect,it,vi} from 'vitest';
import {activeFixture,evidence} from './stage3-chat-a.fixture.js';
import {PostgresSyncSnapshotStage} from '../../../packages/sync/src/sync-snapshot-stage.js';
import {PostgresSyncSnapshotReader} from '../../../packages/sync/src/sync-snapshot-read.js';
import {collectExpiredSyncSnapshots} from '../../../packages/sync/src/sync-snapshot-maintenance.js';
import {buildWorker} from '../../worker/src/worker.js';
import type {SaturnConfig} from '@saturn/config';

it('worker automatically recovers expired snapshot capacity without touching live snapshots or catalog data',async()=>{
 const f=await activeFixture('targeted-snapshots','windows',119);
 const scope={wire:f.wireBinding,guard:{rootId:f.rootId,epoch:f.binding.epoch,bindingVersion:f.binding.bindingVersion,guardRevision:f.binding.guardRevision}};
 const stage=new PostgresSyncSnapshotStage(f.runtime,f.issuer,scope);
 const reader=new PostgresSyncSnapshotReader(f.runtime,f.issuer,scope,'test',[{id:'test',secret:Buffer.alloc(32,31)}]);
 let app:ReturnType<typeof buildWorker>['app']|undefined;
 try{
  const live=await stage.start(f.proof);
  for(let n=0;n<63;n++){
   const expired=await stage.start(f.proof);
   await f.admin.withSql(sql=>sql`UPDATE sync_snapshot_stage SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${expired.snapshotId}`);
  }
  await expect(stage.start(f.proof)).rejects.toMatchObject({code:'admission_full'});
  await f.admin.withSql(sql=>sql`UPDATE sync_snapshot_stage SET lease_until=clock_timestamp()-interval '1 second' WHERE id<>${live.snapshotId}`);
  const rows=await f.admin.withSql(sql=>sql`SELECT * FROM resources ORDER BY id`);
  const liveBefore=await f.admin.withSql(sql=>sql`SELECT * FROM sync_snapshot_stage WHERE id=${live.snapshotId}`);
  const collect=vi.fn(()=>collectExpiredSyncSnapshots({stage,reader}));
  const worker=buildWorker({logLevel:'silent',worker:{reconciliationIntervalMs:600000},recovery:{backupIntervalMs:600000}} as SaturnConfig,
   {ping:async()=>0,upsertWorkerHeartbeat:async()=>{},close:async()=>{}},{check:async()=>({state:'pass'})},
   {reconcile:async()=>{},snapshots:collect});app=worker.app;worker.startBackgroundJobs();
  await vi.waitFor(async()=>expect((await f.admin.withSql(sql=>sql`SELECT id FROM sync_snapshot_stage`)).length).toBeLessThan(64),{timeout:5000});
  expect((await stage.start(f.proof)).snapshotId).not.toBe(live.snapshotId);
  expect(await f.admin.withSql(sql=>sql`SELECT * FROM sync_snapshot_stage WHERE id=${live.snapshotId}`)).toEqual(liveBefore);
  expect(await f.admin.withSql(sql=>sql`SELECT * FROM resources ORDER BY id`)).toEqual(rows);
  await app.close();app=undefined;const calls=collect.mock.calls.length;
  await new Promise(r=>setTimeout(r,2100));expect(collect.mock.calls.length).toBe(calls);
  await evidence('targeted-snapshots','result',{status:'PASS',initialHeaders:64,expired:63,livePreserved:true,catalogUnchanged:true,automaticWorkerCalls:calls,stopped:true});
 }finally{await app?.close();await f.close();}
},30000);
