import {expect,it,vi} from 'vitest';
import {buildWorker} from './worker.js';
import type {SaturnConfig} from '@saturn/config';
import {collectExpiredSyncSnapshots} from '../../../packages/sync/src/sync-snapshot-maintenance.js';

it('drains cursor pages before stage rows and never loops an unbounded batch',async()=>{
 const reader={collectExpired:vi.fn(async()=>({snapshotId:'expired',tokensRemoved:500}))};
 const stage={collectExpired:vi.fn()};
 await collectExpiredSyncSnapshots({reader,stage});expect(reader.collectExpired).toHaveBeenCalledTimes(1);expect(stage.collectExpired).not.toHaveBeenCalled();
 reader.collectExpired.mockResolvedValueOnce({snapshotId:null as unknown as string,tokensRemoved:0});
 await collectExpiredSyncSnapshots({reader,stage});expect(stage.collectExpired).toHaveBeenCalledTimes(1);
});
it('snapshot scheduling survives refusal, excludes overlap, and drains before closing dependencies',async()=>{
 vi.useFakeTimers();let release!:()=>void;const pending=new Promise<void>(r=>release=r);
 const snapshots=vi.fn().mockRejectedValueOnce(Error('admission_full')).mockImplementationOnce(()=>pending).mockResolvedValue(undefined);
 const close=vi.fn(async()=>{});const worker=buildWorker({logLevel:'silent',worker:{reconciliationIntervalMs:600000},recovery:{backupIntervalMs:600000}} as SaturnConfig,
 {ping:async()=>0,upsertWorkerHeartbeat:async()=>{},close},{check:async()=>({state:'pass'})},{reconcile:async()=>{},snapshots});
 try{
  worker.startBackgroundJobs();await vi.advanceTimersByTimeAsync(2000);expect(snapshots).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10000);expect(snapshots).toHaveBeenCalledTimes(2);
  const stopped=worker.app.close();await vi.advanceTimersByTimeAsync(1);expect(close).not.toHaveBeenCalled();
  release();await stopped;await vi.advanceTimersByTimeAsync(4000);expect(snapshots).toHaveBeenCalledTimes(2);expect(close).toHaveBeenCalledTimes(1);
 }finally{release();await worker.app.close();vi.useRealTimers();}
});
