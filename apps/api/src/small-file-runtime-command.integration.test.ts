import {expect,it} from 'vitest';
import {Database} from '@saturn/database';
import {createGuardedBackendCommand} from '../../../packages/sync/src/guarded-runtime.js';
import {BackendExecutorError} from '../../../packages/storage/src/durable-backend-executor.js';
import {backendFixture,barrier,uid} from './stage3-chat-a.fixture.js';

it('keeps runtime backend deadlines isolated from ordinary writer connections on success and refusal',async()=>{
  const f=await backendFixture('smallfile-runtime-command-limits',85),command=createGuardedBackendCommand(f.writer),identity=f.executor.identity;
  try{
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_backend_limits(lock_timeout text,statement_timeout text);
      CREATE FUNCTION observer_backend_limits() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
        INSERT INTO public.observer_backend_limits VALUES(current_setting('lock_timeout'),current_setting('statement_timeout'));RETURN NEW;END $$;
      CREATE TRIGGER observer_backend_limits AFTER INSERT OR UPDATE ON sync_backend_tasks FOR EACH ROW EXECUTE FUNCTION observer_backend_limits();`));
    await command('acquire',identity,{});const id=uid();
    await command('submit',identity,{id,command:'mkdir',body:{path:'deadline'},reservedBytes:'0'});
    expect(await command('claim',identity,{})).toMatchObject({id});await command('complete',identity,{id,result:null});
    const fail=command('claim',{...identity,generation:uid()},{});
    await expect(fail).rejects.toBeInstanceOf(BackendExecutorError);await expect(fail).rejects.toMatchObject({code:'binding_invalid'});
    expect(await f.admin.withSql(sql=>sql`SELECT DISTINCT * FROM observer_backend_limits`)).toEqual([{lock_timeout:'2s',statement_timeout:'3s'}]);
    // Parallel reads cover every connection already used by the small writer pool.
    const limits=await Promise.all(Array.from({length:4},()=>f.writer.withSql(sql=>sql<{l:string;s:string}[]>`SELECT current_setting('lock_timeout') AS l,current_setting('statement_timeout') AS s`)));
    expect(limits.every(rows=>rows[0]?.l==='0'&&rows[0].s==='0')).toBe(true);
    await command('drain',identity,{});await command('stopped',identity,{connectionsClosed:true});
  }finally{await f.close();}
},60000);

it('cancels slow and lock-blocked atomic commands without partial state, including after connection replacement',async()=>{
  const f=await backendFixture('smallfile-runtime-command-atomic-timeouts',88),command=createGuardedBackendCommand(f.writer),identity=f.executor.identity;
  const held=barrier(),release=barrier();let blocker:Promise<unknown>|undefined;
  try{
    await command('acquire',identity,{});
    await f.admin.withSql(sql=>sql.unsafe(`CREATE FUNCTION observer_backend_sleep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(4);RETURN NEW;END $$;
      CREATE TRIGGER observer_backend_sleep BEFORE INSERT ON sync_backend_tasks FOR EACH ROW EXECUTE FUNCTION observer_backend_sleep();`));
    const id=uid(),payload={id,command:'mkdir',body:{path:'atomic-timeout'},reservedBytes:'0'};
    const start=performance.now();await expect(command('submit',identity,payload)).rejects.toMatchObject({code:'57014'});
    expect(performance.now()-start).toBeLessThan(5000);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks WHERE id=${id}`)).toHaveLength(0);
    await f.admin.withSql(sql=>sql.unsafe('DROP TRIGGER observer_backend_sleep ON sync_backend_tasks'));
    blocker=f.admin.transaction(async sql=>{await sql`SELECT 1 FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity} FOR UPDATE`;held.release();await release.entered;});
    await held.entered;
    const lockStart=performance.now();await expect(command('submit',identity,payload)).rejects.toMatchObject({code:'55P03'});
    expect(performance.now()-lockStart).toBeLessThan(3500);
    release.release();await blocker;
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks WHERE id=${id}`)).toHaveLength(0);
    await f.admin.withSql(sql=>sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${f.roles.writerLogin} AND application_name='saturn_backend_command'`);
    // The socket close may arrive on the next use. It must surface, not become
    // a hidden retry of a mutation. Only this read-only probe is repeated.
    try{await command('inspect',identity,{});}catch(error){expect(error).toMatchObject({code:'CONNECTION_CLOSED'});}
    await command('inspect',identity,{});
    await f.admin.withSql(sql=>sql.unsafe('CREATE TRIGGER observer_backend_sleep BEFORE INSERT ON sync_backend_tasks FOR EACH ROW EXECUTE FUNCTION observer_backend_sleep()'));
    await expect(command('submit',identity,payload)).rejects.toMatchObject({code:'57014'});
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM sync_backend_tasks WHERE id=${id}`)).toHaveLength(0);
    await f.admin.withSql(sql=>sql.unsafe('DROP TRIGGER observer_backend_sleep ON sync_backend_tasks'));
    await command('submit',identity,payload);expect(await command('claim',identity,{})).toMatchObject({id});await command('complete',identity,{id,result:null});
    await command('drain',identity,{});await command('stopped',identity,{connectionsClosed:true});
    const ordinary=await f.writer.withSql(sql=>sql`SELECT current_setting('lock_timeout') AS l,current_setting('statement_timeout') AS s`);
    expect(ordinary).toEqual([{l:'0',s:'0'}]);
  }finally{release.release();await blocker;await f.close();}
},60000);

it('keeps the configured maintenance barrier around runtime backend transactions',async()=>{
  const f=await backendFixture('smallfile-runtime-command-maintenance',85),url=new URL(f.url);url.username=f.roles.writerLogin;
  const writer=new Database(url.toString(),{max:1,maintenanceBarrier:true}),maintenance=new Database(f.url,{max:1,maintenanceBarrier:true}),command=createGuardedBackendCommand(writer);
  const held=barrier(),release=barrier();let exclusive:Promise<unknown>|undefined,pending:Promise<unknown>|undefined;
  try{
    exclusive=maintenance.withExclusiveMaintenance(async()=>{held.release();await release.entered;});await held.entered;
    let finished=false;pending=command('acquire',f.executor.identity,{}).then(value=>{finished=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,50));expect(finished).toBe(false);
    expect((await f.admin.withSql(sql=>sql`SELECT state FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity}`))[0]?.state).toBe('STOPPED');
    release.release();await exclusive;expect(await pending).toMatchObject({owned:true});
    await command('drain',f.executor.identity,{});await command('stopped',f.executor.identity,{connectionsClosed:true});
    await f.admin.withSql(sql=>sql`CREATE SCHEMA _saturn_restore_guard`);
    await expect(command('acquire',f.executor.identity,{})).rejects.toThrow('Interrupted recovery');
    expect((await f.admin.withSql(sql=>sql`SELECT state FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity}`))[0]?.state).toBe('STOPPED');
    await f.admin.withSql(sql=>sql`DROP SCHEMA _saturn_restore_guard`);
  }finally{release.release();await exclusive;await pending;await writer.close();await maintenance.close();await f.close();}
},60000);
