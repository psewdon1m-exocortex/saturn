import { requireTestValue } from "../../contracts/src/test-support.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Database } from '../../database/src/index.js';
import { ManagedBackendProcess, recoverExitedBackendOwner, type ManagedBackendIdentity } from './backend-owner-process.js';

const url=process.env.OWNER_RECOVERY_TEST_DATABASE_URL;
describe.skipIf(!url)('managed owner recovery SQL and OS boundary',()=>{
 let db:Database,backend:Record<string,unknown>,identity:ManagedBackendIdentity,ticket:ManagedBackendProcess,child:ChildProcess;
 const tasks:string[]=[],readers:string[]=[],children:ChildProcess[]=[],databases:Database[]=[];
 const start=async(nonce=randomBytes(32).toString('hex'),sentNonce=nonce)=>{
   const msg={schema:'saturn.backend-owner-process.v1',nonce:sentNonce,state:'ACTIVE',identity};
   const p=spawn(process.execPath,['-e',`process.send({...${JSON.stringify(msg)},pid:process.pid});setInterval(()=>{},1000)`],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(p);
   const t=new ManagedBackendProcess(p,nonce,{backendIdentity:identity.backendIdentity,generation:identity.generation});return{p,t};
 };
 const exit=async(p:ChildProcess,t:ManagedBackendProcess)=>{p.kill();for(let n=0;!t.closed&&n<100;n++)await delay(10);expect(t.closed).toBe(true);};
 const snapshot=()=>db.withSql(async s=>({backend:await s`SELECT * FROM sync_backend_executor ORDER BY backend_identity`,tasks:await s`SELECT * FROM sync_backend_tasks ORDER BY id`,history:await s`SELECT * FROM saturn_owner_recovery.history ORDER BY id`}));
 const refuse=async(reason:string)=>{const before=await snapshot();await expect(recoverExitedBackendOwner(db,ticket)).rejects.toThrow(reason);expect(await snapshot()).toEqual(before);};
 beforeAll(async()=>{
   if(!url||!/^\/matrix02_owner125_[a-f0-9]{12}$/.test(new URL(url).pathname))throw Error('Owned qualification clone required');
   db=new Database(url,{max:2,maintenanceBarrier:true});databases.push(db);[backend]=await db.withSql(s=>s`SELECT * FROM sync_backend_executor`);expect(requireTestValue(backend).state).toBe('STOPPED');
   expect((await db.withSql(s=>s`SELECT id FROM sync_backend_tasks WHERE state IN ('QUEUED','RUNNING','UNKNOWN')`)).length).toBe(0);
 });
 beforeEach(async()=>{
   identity={backendIdentity:String(backend.backend_identity),generation:String(backend.generation),ownerId:randomUUID(),fencingToken:randomUUID()};
   await db.withSql(s=>s`UPDATE sync_backend_executor SET owner_id=${identity.ownerId}::uuid,fencing_token=${identity.fencingToken}::uuid,state='RUNNING',liveness_owner_id=${identity.ownerId}::uuid,liveness_fencing_token=${identity.fencingToken}::uuid,liveness_at=now()-interval '1 day' WHERE backend_identity=${identity.backendIdentity}`);
   const x=await start();child=x.p;ticket=x.t;for(let n=0;!ticket.registered&&n<100;n++)await delay(10);expect(ticket.registered).toBe(true);
 });
 afterAll(async()=>{for(const p of children)if(p.exitCode===null&&p.signalCode===null)p.kill();await Promise.all(databases.map(connection=>connection.close()));});
 afterEach(async()=>{for(const id of tasks)await db.withSql(s=>s`DELETE FROM sync_backend_tasks WHERE id=${id}::uuid`);for(const id of readers)await db.withSql(s=>s`DELETE FROM sync_backend_read_slots WHERE id=${id}::uuid`);});
 it('refuses a living owner despite an expired heartbeat',async()=>{await refuse('owner_exit_unproved');await exit(child,ticket);});
 it('does not accept a caller JSON receipt or unregistered IPC nonce',async()=>{
   await expect(recoverExitedBackendOwner(db,{} as ManagedBackendProcess)).rejects.toThrow('managed_child_required');
   const bad=await start(randomBytes(32).toString('hex'),'bad');await delay(100);expect(bad.t.registered).toBe(false);await exit(bad.p,bad.t);
   await expect(recoverExitedBackendOwner(db,bad.t)).rejects.toThrow('owner_registration_required');await exit(child,ticket);
 });
 it('refuses a changed owner or generation',async()=>{
   await exit(child,ticket);await db.withSql(s=>s`UPDATE sync_backend_executor SET owner_id=${randomUUID()}::uuid WHERE backend_identity=${identity.backendIdentity}`);await refuse('recovery_owner_changed');
 });
 it('refuses every RUNNING or UNKNOWN effect without touching it',async()=>{
   await exit(child,ticket);
   for(const state of ['RUNNING','UNKNOWN']){const id=randomUUID();tasks.push(id);await db.withSql(s=>s`INSERT INTO sync_backend_tasks(id,backend_identity,generation,command,payload,payload_hash,state,owner_id,fencing_token) VALUES(${id}::uuid,${identity.backendIdentity},${identity.generation}::uuid,'mkdir','{"path":"qualification125"}'::jsonb,${'a'.repeat(64)},${state},${identity.ownerId}::uuid,${identity.fencingToken}::uuid)`);await refuse('recovery_effect_unresolved');await db.withSql(s=>s`DELETE FROM sync_backend_tasks WHERE id=${id}::uuid`);}
 });
 it('refuses an active or waiting reader instead of releasing a physical slot',async()=>{
   await exit(child,ticket);for(const state of ['ACTIVE','WAITING']){const id=randomUUID();readers.push(id);await db.withSql(s=>s`INSERT INTO sync_backend_read_slots(id,backend_identity,generation,client_id,priority,state) VALUES(${id}::uuid,${identity.backendIdentity},${identity.generation}::uuid,${randomUUID()}::uuid,'foreground',${state})`);await refuse('recovery_readers_not_drained');await db.withSql(s=>s`DELETE FROM sync_backend_read_slots WHERE id=${id}::uuid`);}
 });
 it('refuses queued tasks that already have a physical claimant',async()=>{
   await exit(child,ticket);const id=randomUUID();tasks.push(id);await db.withSql(s=>s`INSERT INTO sync_backend_tasks(id,backend_identity,generation,command,payload,payload_hash,state,owner_id,fencing_token) VALUES(${id}::uuid,${identity.backendIdentity},${identity.generation}::uuid,'mkdir','{"path":"qualification125"}'::jsonb,${'b'.repeat(64)},'QUEUED',${identity.ownerId}::uuid,${identity.fencingToken}::uuid)`);await refuse('recovery_effect_unresolved');await db.withSql(s=>s`DELETE FROM sync_backend_tasks WHERE id=${id}::uuid`);
 });
 it('rolls back owner release if durable history insertion fails',async()=>{
   await exit(child,ticket);await db.withSql(s=>s.unsafe(`CREATE FUNCTION saturn_owner_recovery.inject125() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected_history_failure'; END$$; CREATE TRIGGER inject125 BEFORE INSERT ON saturn_owner_recovery.history FOR EACH ROW EXECUTE FUNCTION saturn_owner_recovery.inject125()`));
   try{await refuse('injected_history_failure');}finally{await db.withSql(s=>s.unsafe('DROP TRIGGER inject125 ON saturn_owner_recovery.history; DROP FUNCTION saturn_owner_recovery.inject125()'));}
 });
 it('releases only the witnessed dead owner, preserves queued original bytes and is idempotent',async()=>{
   await exit(child,ticket);const id=randomUUID();tasks.push(id);await db.withSql(s=>s`INSERT INTO sync_backend_tasks(id,backend_identity,generation,command,payload,payload_hash,state) VALUES(${id}::uuid,${identity.backendIdentity},${identity.generation}::uuid,'mkdir','{"path":"qualification125"}'::jsonb,${'c'.repeat(64)},'QUEUED')`);
   const before=await db.withSql(s=>s`SELECT * FROM sync_backend_tasks WHERE id=${id}::uuid`),result=await recoverExitedBackendOwner(db,ticket);
   expect(result).toMatchObject({status:'RELEASED_NO_EFFECT_OWNER',queuedTaskIds:[id],generation:identity.generation});expect(await db.withSql(s=>s`SELECT * FROM sync_backend_tasks WHERE id=${id}::uuid`)).toEqual(before);
   expect((await db.withSql(s=>s`SELECT state,owner_id,fencing_token FROM sync_backend_executor`))[0]).toEqual({state:'STOPPED',owner_id:null,fencing_token:null});
   expect(await recoverExitedBackendOwner(db,ticket)).toEqual(result);expect(requireTestValue((await db.withSql(s=>s`SELECT count(*)::int n FROM saturn_owner_recovery.history`))[0]).n).toBe(1);
   await expect(db.withSql(s=>s`DELETE FROM saturn_owner_recovery.history`)).rejects.toThrow('owner_recovery_history_retained');await expect(db.withSql(s=>s`TRUNCATE saturn_owner_recovery.history`)).rejects.toThrow('owner_recovery_history_retained');
 });
});
