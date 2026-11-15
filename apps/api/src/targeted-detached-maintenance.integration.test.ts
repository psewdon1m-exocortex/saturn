import {expect,it} from 'vitest';
import {Database} from '@saturn/database';
import {databaseFixture,barrier,evidence} from './stage3-chat-a.fixture.js';

it('completion owns a maintenance lease beyond its HTTP response and cannot deadlock a queued exclusive owner',async()=>{
 const f=await databaseFixture('targeted-detached-maintenance',119);
 const runtime=new Database(f.url,{max:2,maintenanceBarrier:true});
 const writer=new Database(f.url,{max:2,maintenanceBarrier:true,maintenanceScope:runtime});
 const exclusive=new Database(f.url,{max:1,maintenanceBarrier:true});
 const started=barrier(),finish=barrier();let pending:Promise<void>|undefined,backup:Promise<void>|undefined;
 try{
  await runtime.withSharedMaintenance(async()=>{
   pending=writer.withDetachedSharedMaintenance(async()=>{started.release();await finish.entered;await writer.ping();});
   await started.entered;
  }); // response returned; background effect still owns a separate shared lock
  let backupEntered=false;backup=exclusive.withExclusiveMaintenance(async()=>{backupEntered=true;});
  await new Promise(r=>setTimeout(r,100));expect(backupEntered).toBe(false);
  finish.release();await pending;await backup;expect(backupEntered).toBe(true);
  const request=barrier(),exit=barrier(),exclusiveEntered=barrier(),exclusiveExit=barrier();
  let second:Promise<void>|undefined;
  const outer=runtime.withSharedMaintenance(async()=>{request.release();await exit.entered;second=writer.withDetachedSharedMaintenance(async()=>{await writer.ping();});});
  await request.entered;
  const queued=exclusive.withExclusiveMaintenance(async()=>{exclusiveEntered.release();await exclusiveExit.entered;});
  await new Promise(r=>setTimeout(r,100));exit.release();await outer;
  await exclusiveEntered.entered;exclusiveExit.release();await queued;await second;
  await evidence('targeted-detached-maintenance','result',{status:'PASS',responseLeaseIndependent:true,exclusiveWaitedForCompletion:true,queuedExclusiveNoDeadlock:true});
 }finally{finish.release();await pending;await backup;await writer.close();await runtime.close();await exclusive.close();await f.close();}
},30000);
