import { fixtureValue } from './test-values.fixture.js';
import {setTimeout as delay} from 'node:timers/promises';import {randomUUID} from 'node:crypto';import {beforeAll,afterAll,describe,it,expect} from 'vitest';import {Database} from '@saturn/database';
const url=process.env.SATURN_DROP_RETRY_TEST_DATABASE_URL;const gate=()=>{let release=()=>{};const promise=new Promise<void>(r=>{release=r;});return{promise,release};};
describe.skipIf(!url)('startup maintenance allows existing cross-process work to drain',()=>{
 let admin:Database,request:Database,peer:Database,startup:Database;
 beforeAll(()=>{const u=new URL(fixtureValue(url));if(u.hostname!=='127.0.0.1'||!u.pathname.startsWith('/saturn_test_matrix_drop18_'))throw Error('Dedicated local test DB required');admin=new Database(fixtureValue(url),{max:1});request=new Database(fixtureValue(url),{max:1,maintenanceBarrier:true});peer=new Database(fixtureValue(url),{max:1,maintenanceBarrier:true});startup=new Database(fixtureValue(url),{max:1,maintenanceBarrier:true});});
 afterAll(async()=>{await Promise.all([admin.close(),request.close(),peer.close(),startup.close()]);});
 it('does not queue startup cleanup ahead of the backend needed by an admitted request',async()=>{
  const entered=gate(),release=gate();let done=false;const held=request.withSharedMaintenance(async()=>{entered.release();await release.promise;});await entered.promise;
  const cleanup=startup.reconcileInactiveFileLocks().then(()=>{done=true;});void cleanup.catch(()=>{});let dependent:Promise<number>|undefined;
  try{await delay(80);expect(done).toBe(false);dependent=peer.ping();const progressed=await Promise.race([dependent.then(()=>true),delay(600).then(()=>false)]);expect(progressed,'Independent backend must finish while original request holds its shared lease').toBe(true);expect(done).toBe(false);}
  finally{release.release();await Promise.allSettled([held,cleanup,dependent]);}
  expect(done).toBe(true);
 });
 it('cleans interrupted metadata only after genuine exclusive ownership and preserves original IDs',async()=>{
  const upload=randomUUID(),operation=randomUUID(),key='startup23-'+operation;await admin.withSql(async s=>{const row=(await s<{id:string}[]>`SELECT id FROM resources WHERE storage_path='# sync windows'`)[0];if(!row)throw Error('Required sync windows fixture root missing');const root=row.id;await s`INSERT INTO upload_sessions(id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,received_size,status,expires_at) VALUES(${upload},${upload},${root},'retained.bin',${'_system/temp/'+upload},${'sync/'+upload},1,1,'verifying',now()+interval '1 hour')`;await s`INSERT INTO operation_journal(id,operation_type,state,idempotency_key,upload_id) VALUES(${operation},'upload','verifying',${operation},${upload})`;await s`INSERT INTO operation_locks(lock_key,operation_id,expires_at) VALUES(${key},${operation},now()+interval '1 hour')`;});
  const entered=gate(),release=gate();const held=request.withSharedMaintenance(async()=>{entered.release();await release.promise;});await entered.promise;let cleanup:Promise<void>|undefined;
  try{cleanup=startup.reconcileInactiveFileLocks();await delay(80);expect((await admin.withSql(s=>s`SELECT status FROM upload_sessions WHERE id=${upload}`))[0]?.status).toBe('verifying');expect(await admin.withSql(s=>s`SELECT lock_key FROM operation_locks WHERE lock_key=${key}`)).toHaveLength(1);release.release();await held;await cleanup;expect((await admin.withSql(s=>s`SELECT id,status FROM upload_sessions WHERE id=${upload}`))[0]).toEqual({id:upload,status:'failed_retryable'});expect((await admin.withSql(s=>s`SELECT id,error_code FROM operation_journal WHERE id=${operation}`))[0]).toEqual({id:operation,error_code:'verification_interrupted'});expect(await admin.withSql(s=>s`SELECT lock_key FROM operation_locks WHERE lock_key=${key}`)).toHaveLength(0);}
  finally{release.release();await Promise.allSettled([held,cleanup]);await admin.withSql(async s=>{await s`DELETE FROM operation_locks WHERE lock_key=${key}`;await s`DELETE FROM operation_journal WHERE id=${operation}`;await s`DELETE FROM upload_sessions WHERE id=${upload}`;});}
 });
 it('bounds nonqueued exclusive admission without entering callback or clearing another lease',async()=>{
  const entered=gate(),release=gate();const held=request.withSharedMaintenance(async()=>{entered.release();await release.promise;});await entered.promise;let invoked=false;
  try{await expect(startup.withExclusiveTransaction(async()=>{invoked=true;},100)).rejects.toThrow('Maintenance admission deadline exceeded');expect(invoked).toBe(false);await peer.ping();}finally{release.release();await held;}
 });
 it('preserves exclusive exclusion, rollback and release on callback failure',async()=>{
  const entered=gate(),release=gate();let peerEntered=false;const exclusive=startup.withExclusiveTransaction(async s=>{await s`CREATE TABLE matrix23_rollback_guard(id int)`;entered.release();await release.promise;throw Error('injected callback failure');},2000);const outcome=exclusive.catch((e: unknown)=>e);await entered.promise;const pending=peer.ping().then(()=>{peerEntered=true;});try{await delay(80);expect(peerEntered).toBe(false);}finally{release.release();}expect(await outcome).toMatchObject({message:'injected callback failure'});await pending;expect((await admin.withSql(s=>s`SELECT to_regclass('matrix23_rollback_guard') value`))[0]?.value).toBeNull();
 });
 it.each([0,-1,120001,NaN])('refuses invalid admission bound %s without invoking callback',async bound=>{let invoked=false;await expect(startup.withExclusiveMaintenance(async()=>{invoked=true;},bound)).rejects.toThrow('Maintenance wait deadline is invalid');expect(invoked).toBe(false);});
});
