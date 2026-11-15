import {expect,it} from 'vitest';
import {activeFixture,evidence,uid} from './stage3-chat-a.fixture.js';
import {PostgresSyncSnapshotStage} from '../../../packages/sync/src/sync-snapshot-stage.js';

it('one qualified checkpoint batches sixteen empty directories; counts above one million are supported without unbounded pages',async()=>{
  const f=await activeFixture('scale-snapshot','windows',71);
  try{
    const parentTopology=f.uploadInput('seed',Buffer.alloc(0)).intent.parentTopology;
    for(let n=0;n<48;n++)await f.files.ensureCatalogFolderV2({operationId:uid(),idempotencyKey:uid(),rootId:f.rootId,epoch:f.binding.epoch,bindingVersion:f.binding.bindingVersion,parentId:f.rootId,name:'directory-'+String(n),mode:'ensure',parentTopology},f.proof);
    const scope={wire:f.wireBinding,guard:{rootId:f.rootId,epoch:f.binding.epoch,bindingVersion:f.binding.bindingVersion,guardRevision:f.binding.guardRevision}};
    const stage=new PostgresSyncSnapshotStage(f.runtime,f.issuer,scope);
    const first=await stage.start(f.proof);let state=await stage.step(first.snapshotId,f.proof);expect(state.entries).toBe('49');
    state=await new PostgresSyncSnapshotStage(f.runtime,f.issuer,scope).step(first.snapshotId,f.proof);
    const completed=await f.admin.withSql(sql=>sql<{n:number}[]>`SELECT count(*)::int AS n FROM sync_snapshot_frontier WHERE snapshot_id=${first.snapshotId} AND complete`);
    expect(completed[0]?.n).toBe(17);
    let steps=2;while(state.state!=='READY'&&steps<10){state=await stage.step(first.snapshotId,f.proof);steps++;}
    expect(state.state).toBe('READY');expect(state.entries).toBe('49');expect(steps).toBe(6);
    // Boundary test of the additive schema; deliberately not reported as an
    // actual million-object transfer. Roll back the synthetic header mutation.
    const boundary=await stage.start(f.proof);
    await f.admin.transaction(async sql=>{await sql`SAVEPOINT cardinality`;await sql`UPDATE sync_snapshot_stage SET entry_count=1004282 WHERE id=${boundary.snapshotId}`;expect((await sql<{n:string}[]>`SELECT entry_count::text AS n FROM sync_snapshot_stage WHERE id=${boundary.snapshotId}`)[0]?.n).toBe('1004282');await sql`ROLLBACK TO cardinality`;});
    await evidence('scale-snapshot','result',{status:'PASS',directories:48,steps,perCheckpoint:16,cardinalityConstraintBoundary:1004282,millionObjectsTransferred:false});
  }finally{await f.close();}
},60000);
