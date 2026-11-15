import {expect,it,vi} from 'vitest';
import {Database} from '@saturn/database';
import {databaseFixture,barrier} from './stage3-chat-a.fixture.js';
import {freshFixtureLogin} from './fresh-login.fixture.js';

it('a writer role reuses an admitted request before queued exclusive maintenance without inheriting its SQL identity',async()=>{
  const f=await databaseFixture('smallfile-maintenance-scope',88),role='wr_'+f.suffix;
  const runtime=new Database(f.url,{max:1,maintenanceBarrier:true});
  const login=freshFixtureLogin(f.url,role);
  await f.db.withSql(sql=>sql.unsafe(login.createRoleSql));
  const options={max:1,maintenanceBarrier:true,maintenanceScope:runtime};
  const writer=new Database(login.url,options),entered=barrier(),release=barrier();
  const order:string[]=[];let action:Promise<void>|undefined,exclusive:Promise<void>|undefined;
  try{
    action=runtime.withSharedMaintenance(async()=>{
      entered.release();await release.entered;
      expect(await writer.withSql(sql=>sql`SELECT session_user::text AS role`)).toEqual([{role}]);order.push('writer');
    });void action.catch(()=>undefined);await entered.entered;
    exclusive=runtime.withExclusiveMaintenance(async()=>{order.push('exclusive');});void exclusive.catch(()=>undefined);
    await vi.waitFor(async()=>expect((await f.db.withSql(sql=>sql`SELECT pid FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND objid=1397967206 AND mode='ExclusiveLock' AND NOT granted`)).length).toBe(1),{timeout:3000});
    release.release();
    await Promise.race([Promise.all([action,exclusive]),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Admitted writer deadlocked behind exclusive maintenance')),1500))]);
    expect(order).toEqual(['writer','exclusive']);
  }finally{
    release.release();
    await f.db.withSql(sql=>sql`SELECT pg_cancel_backend(a.pid) FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database() AND a.usename=${role} AND l.locktype='advisory' AND l.mode='ShareLock' AND NOT l.granted`);
    await Promise.allSettled([action,exclusive]);await writer.close();await runtime.close();
    await f.db.withSql(sql=>sql.unsafe(`DROP ROLE ${role}`));await f.close();
  }
},30000);

it('a child created inside a shared scope must reacquire admission after that scope ends',async()=>{
  const f=await databaseFixture('smallfile-maintenance-lifetime',88),runtime=new Database(f.url,{maintenanceBarrier:true});
  const options={maintenanceBarrier:true,maintenanceScope:runtime},writer=new Database(f.url,options),release=barrier();let child:Promise<number>|undefined;
  try{
    await runtime.withSharedMaintenance(async()=>{child=(async()=>{await release.entered;return writer.ping();})();void child.catch(()=>undefined);});
    await f.db.withSql(sql=>sql`CREATE SCHEMA _saturn_restore_guard`);
    release.release();await expect(child).rejects.toThrow('Interrupted recovery');
  }finally{release.release();await child?.catch(()=>undefined);await writer.close();await runtime.close();await f.close();}
},30000);

it('an admitted scope cannot bypass another databases recovery guard',async()=>{
  const a=await databaseFixture('smallfile-maintenance-db-a',88),b=await databaseFixture('smallfile-maintenance-db-b',88);
  const runtime=new Database(a.url,{maintenanceBarrier:true}),options={maintenanceBarrier:true,maintenanceScope:runtime},other=new Database(b.url,options);
  try{
    await b.db.withSql(sql=>sql`CREATE SCHEMA _saturn_restore_guard`);
    await expect(runtime.withSharedMaintenance(()=>other.ping())).rejects.toThrow('Interrupted recovery');
  }finally{await other.close();await runtime.close();await a.close();await b.close();}
},30000);
