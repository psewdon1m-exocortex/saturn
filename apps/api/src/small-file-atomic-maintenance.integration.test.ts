import fs from 'node:fs/promises';
import path from 'node:path';
import {Database} from '@saturn/database';
import {expect,it,vi} from 'vitest';
import {activeFixture,barrier,databaseFixture,migrations} from './stage3-chat-a.fixture.js';

const migration=Number(process.env.SMALL_FILE_ATOMIC_MAINTENANCE_MIGRATION??94);
it('fixed SQL commands retain role isolation and release transaction maintenance admission on success and failure',async()=>{
  const f=await activeFixture('atomic-maintenance-command','windows',migration);
  const url=new URL(f.url);url.username=f.roles.writerLogin;
  const writer=new Database(url.toString(),{max:1,maintenanceBarrier:true});
  try{
    expect(await f.admin.withSql(sql=>sql`SELECT to_regprocedure('public.sync_maintenance_command(text,text,jsonb,jsonb)') IS NOT NULL AS present`)).toEqual([{present:true}]);
    expect(await writer.backendCommand('inspect',f.executor.identity,{})).toMatchObject({state:'RUNNING'});
    await expect(writer.backendCommand('invalid-command',f.executor.identity,{})).rejects.toThrow();
    await expect(f.runtime.withSql(sql=>sql`SELECT sync_maintenance_command('backend','drain',${JSON.stringify(f.executor.identity)}::text::jsonb,'{}'::jsonb)`)).rejects.toMatchObject({code:'42501'});
    await expect(f.writer.transaction(async sql=>{await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;await sql`SELECT sync_maintenance_command('backend','drain',${JSON.stringify(f.executor.identity)}::text::jsonb,'{}'::jsonb)`;})).rejects.toThrow('atomic maintenance requires read committed');
    expect(await writer.backendCommand('inspect',f.executor.identity,{})).toMatchObject({state:'RUNNING'});
    expect(await f.admin.withSql(sql=>sql`SELECT pid FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND objid=1397967206`)).toHaveLength(0);
  }finally{await writer.close();await f.close();}
},30000);

it('observes a recovery guard committed while its atomic command was waiting for exclusive maintenance',async()=>{
  const f=await activeFixture('atomic-maintenance-snapshot','windows',migration),runtime=new Database(f.url,{maintenanceBarrier:true});
  const url=new URL(f.url);url.username=f.roles.writerLogin;
  const writer=new Database(url.toString(),{max:1,maintenanceBarrier:true,maintenanceScope:runtime});
  const entered=barrier(),release=barrier();let exclusive:Promise<void>|undefined,pending:Promise<unknown>|undefined;
  try{
    await writer.backendCommand('inspect',f.executor.identity,{});
    exclusive=runtime.withExclusiveMaintenance(async sql=>{entered.release();await release.entered;await sql`CREATE SCHEMA _saturn_restore_guard`;});void exclusive.catch(()=>undefined);
    await entered.entered;
    pending=writer.backendCommand('drain',f.executor.identity,{});void pending.catch(()=>undefined);
    await vi.waitFor(async()=>expect((await f.admin.withSql(sql=>sql`SELECT pid FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND objid=1397967206 AND mode='ShareLock' AND NOT granted`)).length).toBe(1),{timeout:1500});
    release.release();await exclusive;await expect(pending).rejects.toThrow('Interrupted recovery');
    expect(await f.command('inspect',f.executor.identity,{})).toMatchObject({state:'RUNNING'});
    await expect(writer.catalogUploadBatch('status-job',{},{})).rejects.toThrow('Interrupted recovery');
  }finally{release.release();await Promise.allSettled([exclusive,pending]);await writer.close();await runtime.close();await f.close();}
},30000);

it('an already admitted fixed command completes before queued exclusive maintenance',async()=>{
  const f=await activeFixture('atomic-maintenance-nested','windows',migration),runtime=new Database(f.url,{maintenanceBarrier:true});
  const url=new URL(f.url);url.username=f.roles.writerLogin;
  const writer=new Database(url.toString(),{max:1,maintenanceBarrier:true,maintenanceScope:runtime});
  const entered=barrier(),release=barrier(),order:string[]=[];let work:Promise<void>|undefined,exclusive:Promise<void>|undefined;
  try{
    work=runtime.withSharedMaintenance(async()=>{entered.release();await release.entered;expect(await writer.backendCommand('inspect',f.executor.identity,{})).toMatchObject({state:'RUNNING'});order.push('writer');});void work.catch(()=>undefined);await entered.entered;
    exclusive=runtime.withExclusiveMaintenance(async()=>{order.push('exclusive');});void exclusive.catch(()=>undefined);
    await vi.waitFor(async()=>expect((await f.admin.withSql(sql=>sql`SELECT pid FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND objid=1397967206 AND mode='ExclusiveLock' AND NOT granted`)).length).toBe(1),{timeout:1500});
    release.release();await Promise.all([work,exclusive]);expect(order).toEqual(['writer','exclusive']);
  }finally{release.release();await Promise.allSettled([work,exclusive]);await writer.close();await runtime.close();await f.close();}
},30000);

it('removes the atomic entry point on stopped rollback without altering the original commands',async()=>{
  const f=await databaseFixture('atomic-maintenance-rollback',93);
  try{
    const originals=()=>f.db.withSql(sql=>sql`SELECT oid::regprocedure::text AS id,pg_get_functiondef(oid) AS source FROM pg_proc WHERE oid IN ('sync_backend_command(text,jsonb,jsonb)'::regprocedure,'catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure) ORDER BY id`),before=await originals();
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0094_atomic_maintenance_command.up.sql'),'utf8')));
    expect(await originals()).toEqual(before);
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0094_atomic_maintenance_command.down.sql'),'utf8')));
    expect(await originals()).toEqual(before);
    expect(await f.db.withSql(sql=>sql`SELECT to_regprocedure('public.sync_maintenance_command(text,text,jsonb,jsonb)') AS entry`)).toEqual([{entry:null}]);
  }finally{await f.close();}
},30000);
