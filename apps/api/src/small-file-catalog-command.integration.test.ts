import { fixtureChunks, fixtureValue } from './test-values.fixture.js';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {Database} from '@saturn/database';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,barrier,sha} from './stage3-chat-a.fixture.js';
import {Readable} from 'node:stream';

it('uses atomic catalog calls for batched originals and grouped publication with isolated deadlines',async()=>{
  const f=await activeFixture('smallfile-catalog-command','windows',88);
  const coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:coordinator});
  let releaseReadbacks=()=>{},readbackTimer:ReturnType<typeof setTimeout>|undefined,completionJoin:Promise<unknown>|undefined;
  try{
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_catalog_limits(l text,s text,i text);
      CREATE FUNCTION observer_catalog_limits() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
        INSERT INTO public.observer_catalog_limits VALUES(current_setting('lock_timeout'),current_setting('statement_timeout'),current_setting('idle_in_transaction_session_timeout'));RETURN NEW;END $$;
      CREATE TRIGGER observer_catalog_limits AFTER INSERT OR UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION observer_catalog_limits();`));
    const transaction=vi.spyOn(f.writer,'transaction');
    const items=Array.from({length:4},(_,n)=>{const bytes=Buffer.alloc(4096,n+1);return {bytes,input:f.uploadInput('atomic-'+String(n)+'.bin',bytes)};});
    const prepared=await Promise.all(items.map(i=>files.prepareSmallCatalogUpload(i.input,f.proof)));
    // Group width tests four ready siblings. Physical I/O scheduling alone does
    // not guarantee readiness within the production 50ms partial-group tail.
    // Keep every real byte read and its physical CLOSE; hold only stream EOF
    // until all four originals have completed that independent readback.
    const temporaryPaths=new Set(prepared.map(p=>p.execution.tempPath)),readbacks=new Set<string>(),gate=new Promise<void>(resolve=>{releaseReadbacks=resolve;});
    let readbackExpired=false;
    readbackTimer=setTimeout(()=>{readbackExpired=true;releaseReadbacks();},5000);
    const openRead=f.raw.openRead.bind(f.raw);
    vi.spyOn(f.raw,'openRead').mockImplementation(async(storagePath,options)=>{
      const physical=await openRead(storagePath,options);
      if(!temporaryPaths.has(storagePath)||options?.length!==undefined||(options?.offset??0)!==0)return physical;
      const wrapped=Readable.from((async function*(){
        try{
          for await(const chunk of physical)yield chunk;
          await physical.storageClosed;
          readbacks.add(storagePath);
          if(readbacks.size===temporaryPaths.size){clearTimeout(readbackTimer);releaseReadbacks();}
          await gate;if(readbackExpired)throw Error('Four physical readbacks did not reach the fixture barrier');
        }finally{physical.destroy();}
      })());
      Object.defineProperty(wrapped,'storageClosed',{value:physical.storageClosed});return wrapped;
    });
    const completing=prepared.map((p,n)=>files.completeSmallCatalogUpload(p,f.proof,fixtureValue(items[n]).bytes));
    completionJoin=Promise.allSettled(completing);
    const published=await Promise.all(completing);
    expect(readbacks.size).toBe(4);expect(readbackExpired).toBe(false);
    expect(published.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT cardinality(members) AS n FROM catalog_upload_publication_groups`)).toEqual([{n:4}]);
    expect(await f.admin.withSql(sql=>sql`SELECT DISTINCT * FROM observer_catalog_limits`)).toEqual([{l:'2s',s:'2s',i:'2s'}]);
    for(const [n,p]of published.entries()){
      const chunks:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(p.execution.targetPath)))chunks.push(Buffer.from(chunk));
      expect(sha(Buffer.concat(chunks))).toBe(sha(fixtureValue(items[n]).bytes));
    }
    const versions=await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`);
    expect(versions).toHaveLength(4);
    expect((await Promise.all(published.map(p=>coordinator.status(p,f.proof)))).map(p=>p.status.result)).toEqual(published.map(p=>p.status.result));
    expect(await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`)).toEqual(versions);
    expect(await f.writer.withSql(sql=>sql`SELECT current_setting('lock_timeout') AS l,current_setting('statement_timeout') AS s,current_setting('idle_in_transaction_session_timeout') AS i`)).toEqual([{l:'0',s:'0',i:'0'}]);
    expect(transaction).not.toHaveBeenCalled();
  }finally{clearTimeout(readbackTimer);releaseReadbacks();await completionJoin;vi.restoreAllMocks();await f.close();}
},60000);

it('rolls back every batch member on statement or lock timeout and retains deadlines on replacement connections',async()=>{
  const f=await activeFixture('smallfile-catalog-timeouts','windows',88),held=barrier(),release=barrier();let blocker:Promise<unknown>|undefined;
  const coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  const inputs=['first.bin','slow.bin'].map(name=>f.uploadInput(name,Buffer.from(name)));
  const prepare=()=>Promise.allSettled(inputs.map(input=>coordinator.prepareSmall(input,f.proof)));
  try{
    await f.admin.withSql(sql=>sql.unsafe(`CREATE FUNCTION observer_catalog_sleep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.upload_intent->>'name'='slow.bin' THEN PERFORM pg_sleep(3);END IF;RETURN NEW;END $$;
      CREATE TRIGGER observer_catalog_sleep BEFORE INSERT ON operation_journal FOR EACH ROW EXECUTE FUNCTION observer_catalog_sleep();`));
    const started=performance.now(),timedOut=await prepare();
    expect(timedOut).toMatchObject([{status:'rejected',reason:{code:'57014'}},{status:'rejected',reason:{code:'57014'}}]);
    expect(performance.now()-started).toBeLessThan(4000);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId}`)).toHaveLength(0);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM upload_sessions`)).toHaveLength(0);
    await f.admin.withSql(sql=>sql.unsafe('DROP TRIGGER observer_catalog_sleep ON operation_journal'));
    blocker=f.admin.transaction(async sql=>{await sql`SELECT root_id FROM sync_root_clock WHERE root_id=${f.rootId} FOR UPDATE`;held.release();await release.entered;});
    await held.entered;
    const locked=await prepare();
    expect(locked.every(r=>r.status==='rejected'&&['55P03','57014'].includes((r.reason as {code:string}).code))).toBe(true);
    release.release();await blocker;
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId}`)).toHaveLength(0);
    const prepared=await coordinator.prepareSmall(fixtureValue(inputs[0]),f.proof);
    await f.admin.withSql(sql=>sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND usename=${f.roles.writerLogin} AND application_name='saturn_catalog_command'`);
    // Reconnect only through an explicit read-only probe; mutations never retry here.
    try{await coordinator.status(prepared,f.proof);}catch(error){expect(error).toMatchObject({code:'CONNECTION_CLOSED'});}
    await coordinator.status(prepared,f.proof);
    await f.admin.withSql(sql=>sql.unsafe('CREATE TRIGGER observer_catalog_sleep BEFORE INSERT ON operation_journal FOR EACH ROW EXECUTE FUNCTION observer_catalog_sleep()'));
    await expect(coordinator.prepareSmall(fixtureValue(inputs[1]),f.proof)).rejects.toMatchObject({code:'57014'});
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId}`)).toEqual([{id:prepared.status.session.uploadId}]);
    expect(await f.writer.withSql(sql=>sql`SELECT current_setting('statement_timeout') AS s,current_setting('lock_timeout') AS l`)).toEqual([{s:'0',l:'0'}]);
  }finally{release.release();await blocker;await f.close();}
},60000);

it('recovers the original reservations after a committed batch response is lost without repeating writes',async()=>{
  const f=await activeFixture('smallfile-catalog-lost-response','windows',88);
  const coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  const items=Array.from({length:4},(_,n)=>{const bytes=Buffer.alloc(4096,n+5);return {bytes,input:f.uploadInput('lost-'+String(n)+'.bin',bytes)};});
  try{
    const command=f.writer.catalogUploadBatch.bind(f.writer);
    vi.spyOn(f.writer,'catalogUploadBatch').mockImplementationOnce(async(...args)=>{await command(...args);throw Error('lost committed reservation response');});
    const lost=await Promise.allSettled(items.map(i=>coordinator.prepareSmall(i.input,f.proof)));
    expect(lost.every(r=>r.status==='rejected')).toBe(true);
    const originals=await f.admin.withSql(sql=>sql<{id:string;upload_intent_hash:string;upload_transfer:{token:string}}[]>`SELECT id,upload_intent_hash,upload_transfer FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`);
    expect(originals).toHaveLength(4);
    const resumed=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
    const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:resumed});
    const prepared=await Promise.all(items.map(i=>files.prepareSmallCatalogUpload(i.input,f.proof)));
    expect(prepared.map(p=>p.status.session.uploadId).sort()).toEqual(originals.map(r=>r.id).sort());
    const write=vi.spyOn(f.raw,'write');
    const published=await Promise.all(prepared.map((p,n)=>files.completeSmallCatalogUpload(p,f.proof,fixtureValue(items[n]).bytes)));
    expect(published.every(p=>p.status.result?.status==='PUBLISHED')).toBe(true);expect(write).toHaveBeenCalledTimes(4);
    expect(await f.admin.withSql(sql=>sql`SELECT id,upload_intent_hash FROM operation_journal WHERE sync_root_id=${f.rootId} ORDER BY id`)).toEqual(originals.map(({id,upload_intent_hash})=>({id,upload_intent_hash})));
    expect((await f.admin.withSql(sql=>sql<{id:string}[]>`SELECT id FROM sync_backend_tasks WHERE command='write' ORDER BY id`)).map(r=>r.id)).toEqual(originals.map(r=>r.upload_transfer.token).sort());
    const versions=await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`);
    for(const [n,p]of published.entries()){
      expect((await files.completeSmallCatalogUpload(p,f.proof,fixtureValue(items[n]).bytes)).status.result).toEqual(p.status.result);
      const chunks:Buffer[]=[];for await(const part of fixtureChunks(await f.raw.openRead(p.execution.targetPath)))chunks.push(Buffer.from(part));
      expect(sha(Buffer.concat(chunks))).toBe(sha(fixtureValue(items[n]).bytes));
    }
    expect(write).toHaveBeenCalledTimes(4);
    expect(await f.admin.withSql(sql=>sql`SELECT id,resource_id FROM file_versions ORDER BY id`)).toEqual(versions);
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('waits for maintenance before consuming catalog slots and refuses interrupted recovery',async()=>{
  const f=await activeFixture('smallfile-catalog-maintenance','windows',88),url=new URL(f.url);url.username=f.roles.writerLogin;
  const writer=new Database(url.toString(),{max:1,maintenanceBarrier:true}),maintenance=new Database(f.url,{max:1,maintenanceBarrier:true});
  const coordinator=new CatalogUploadDatabaseCoordinator(writer,f.issuer,'1073741824',true,true),held=barrier(),release=barrier();
  let exclusive:Promise<unknown>|undefined,pending:Promise<unknown>|undefined;
  try{
    exclusive=maintenance.withExclusiveMaintenance(async()=>{held.release();await release.entered;});await held.entered;
    let finished=false;pending=coordinator.prepare(f.uploadInput('wait.bin',Buffer.from('wait')),f.proof).then(value=>{finished=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,50));expect(finished).toBe(false);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId}`)).toHaveLength(0);
    release.release();await exclusive;await pending;
    await f.admin.withSql(sql=>sql`CREATE SCHEMA _saturn_restore_guard`);
    await expect(coordinator.prepare(f.uploadInput('blocked.bin',Buffer.from('blocked')),f.proof)).rejects.toThrow('Interrupted recovery');
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId}`)).toHaveLength(1);
  }finally{release.release();await exclusive;await pending;await writer.close();await maintenance.close();await f.close();}
},60000);
