import "reflect-metadata";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash,createHmac,randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter,type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Database,migrate,listMigrationPairs } from "@saturn/database";
import { FileService,PostgresFileRepository,type UploadPublicationReceipt } from "@saturn/file-core";
import { LocalStorageAdapter } from "@saturn/storage";
import type { RuntimeStorageManager } from "@saturn/storage";
import type { SaturnConfig } from "@saturn/config";
import type { AuditService } from "@saturn/audit";
import { DeviceService,PostgresDeviceRepository } from "@saturn/sync";
import { PostgresCommandToolchain,DatabaseMetadataExporter,guardRecoveryMutation } from "@saturn/recovery";
import { expect,it,vi } from "vitest";
import { SyncClientController } from "./sync-client.controller.js";
import { AUTH_SERVICE,DEVICE_SERVICE } from "./tokens.js";
import { StorageConnectionService } from "./storage-connection.service.js";

const fixtureFile=process.env.SYNC_UPLOAD_RECEIPT_FIXTURE;
const exec=promisify(execFile);
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
interface Status {id:string;status:string;etag?:string;intentHash?:string;receiptState:string;publicationReceipt?:UploadPublicationReceipt}

it.skipIf(!fixtureFile)('qualifies immutable Windows upload publication through actual HTTP, PostgreSQL, lifecycle and backup guards',async()=>{
  if(!fixtureFile)throw new Error('An explicitly owned receipt fixture is required');
  const fixture=JSON.parse(await fs.readFile(fixtureFile,'utf8')) as {containerId:string;runId:string;databaseUrl:string;fixtureDirectory:string};
  const inspected=JSON.parse((await exec('docker',['inspect',fixture.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>};State:{Running:boolean}}[];
  expect(inspected[0]?.Id).toBe(fixture.containerId);expect(inspected[0]?.Config.Labels['exocortex.sync-performance.run']).toBe(fixture.runId);expect(inspected[0]?.State.Running).toBe(true);
  const directory=path.join(fixture.fixtureDirectory,randomUUID().replaceAll('-',''));await fs.mkdir(directory);
  const admin=new Database(fixture.databaseUrl,{max:2}),name='receipt_'+randomUUID().replaceAll('-','');
  await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${name}`));
  const url=new URL(fixture.databaseUrl);url.pathname='/'+name;
  // This regression qualifies the 0048→0049 upgrade/down contract. Later schema
  // compatibility is covered separately by migration-cutoffs.integration.test.ts.
  const sourceMigrations=fileURLToPath(new URL('../../../packages/database/migrations/',import.meta.url));
  const migrations=path.join(directory,'qualified-0049-migrations'),beforeMigrations=path.join(directory,'before-migrations');
  await fs.mkdir(migrations);await fs.mkdir(beforeMigrations);
  for(const pair of await listMigrationPairs(sourceMigrations)){
    const number=Number(pair.name.split('_')[0]);if(number>49)continue;
    for(const file of [pair.up,pair.down]){
      await fs.copyFile(file,path.join(migrations,path.basename(file)));
      if(number<49)await fs.copyFile(file,path.join(beforeMigrations,path.basename(file)));
    }
  }
  expect((await listMigrationPairs(migrations)).at(-1)?.name).toBe('0049_upload_publication_receipt');
  const db=new Database(url.toString(),{max:4});
  const storage=new LocalStorageAdapter(path.join(directory,'storage'));
  const repository=new PostgresFileRepository(db),files=new FileService(repository,storage);
  let app:NestFastifyApplication|undefined;
  const checks:string[]=[];const capturedErrors:unknown[]=[];let passed=false;
  const tool=(database:Database,databaseUrl:string)=>new PostgresCommandToolchain({database,databaseUrl,maximumDumpBytes:32*1024*1024,
    commandTimeoutMs:15000,snapshotTimeoutMs:15000,pgDumpExecutable:'docker',pgRestoreExecutable:'docker',
    pgDumpPrefixArgs:['exec',fixture.containerId,'pg_dump'],pgRestorePrefixArgs:['exec','-i',fixture.containerId,'pg_restore'],
    commandConnectionArgs:['--username','postgres','--dbname',new URL(databaseUrl).pathname.slice(1)]});
  try {
    await migrate(url.toString(),beforeMigrations);
    const profile=randomUUID(),profileRoot=randomUUID();
    await db.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
      VALUES(${profileRoot},'folder','00000000-0000-7000-8000-000000000004','preexisting Windows profile','sync/preexisting Windows profile','active')`);
    await db.withSql(sql=>sql`INSERT INTO devices(id,name,token_hash,state,scope_ids,can_read,can_write,can_move,can_delete,created_at,updated_at,device_kind,sync_root_id,client_platform)
      VALUES(${profile},'preexisting identity',${digest(profile)},'active',ARRAY[${profileRoot}::uuid],true,true,false,false,now(),now(),'windows_sync',${profileRoot},'windows')`);
    const originalProfile=await db.withSql(sql=>sql`SELECT * FROM devices WHERE id=${profile}`);
    await migrate(url.toString(),migrations);
    expect(await db.withSql(sql=>sql`SELECT token_hash FROM devices WHERE id=${profile}`)).toMatchObject([{token_hash:digest(profile)}]);
    expect(await db.withSql(sql=>sql`SELECT * FROM devices WHERE id=${profile}`)).toEqual(originalProfile);
    await db.transaction(async sql=>{await sql.unsafe(await fs.readFile(path.join(migrations,'0049_upload_publication_receipt.down.sql'),'utf8'));});
    await db.transaction(async sql=>{await sql.unsafe(await fs.readFile(path.join(migrations,'0049_upload_publication_receipt.up.sql'),'utf8'));});
    checks.push('additive migration preserves preexisting device identity; empty guarded down/up succeeds');
    await storage.initialize();await files.initializeStorage();
    const deviceRepository=new PostgresDeviceRepository(db);
    const devices=new DeviceService({repository:deviceRepository,files,pepper:'immutable-receipt-fixture-pepper-12345678',options:{enabled:true,publicOrigin:'https://fixture.invalid',uploadChunkMaxBytes:1024*1024,propfindMaxItems:100,deleteMaxItems:10,deleteWindowMs:10000}});
    @Module({controllers:[SyncClientController],providers:[{provide:DEVICE_SERVICE,useValue:devices},{provide:AUTH_SERVICE,useValue:{}}]})
    class TestModule {readonly fixture='receipt';}
    const adapter=new FastifyAdapter({logger:false});adapter.getInstance().addContentTypeParser('application/octet-stream',(_request,payload,done)=>done(null,payload));
    // Drop the network response only after the handler has committed publication.
    adapter.getInstance().addHook('onSend',(request,reply,payload,done)=>{
      if(request.headers['x-fixture-lose-response']==='yes')reply.raw.destroy();done(null,payload);
    });
    app=await NestFactory.create<NestFastifyApplication>(TestModule,adapter,{logger:false});app.setGlobalPrefix('api/v1');await app.listen(0,'127.0.0.1');
    const address=adapter.getInstance().server.address();if(address===null||typeof address==='string')throw new Error('No loopback port');
    const base=`http://127.0.0.1:${String(address.port)}/api/v1/sync/uploads`;
    const enrolled=await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment('Receipt A')).code,'fixture');
    const peer=await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment('Receipt B')).code,'fixture');
    const headers={authorization:`Bearer ${enrolled.token}`},peerHeaders={authorization:`Bearer ${peer.token}`};
    const send=(method:string,endpoint:string,payload?:object|Buffer,extra:Record<string,string>={})=>fetch(endpoint,{method,headers:{...headers,
      ...(payload===undefined?{}:Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{'content-type':'application/json'}),...extra},
      ...(payload===undefined?{}:{body:Buffer.isBuffer(payload)?payload:JSON.stringify(payload)})});
    const json=async(response:Response):Promise<Status>=>{expect(response.status,await response.clone().text()).toBeLessThan(300);return await response.json() as Status;};
    const input=(file:string,value:string,key=digest(randomUUID()),ifMatch?:string)=>({path:'sync/Receipt A/'+file,expectedSize:Buffer.byteLength(value),expectedSha256:digest(value),idempotencyKey:key,
      ...(ifMatch===undefined?{ifNoneMatch:'*'}:{ifMatch})});
    const create=async(payload:ReturnType<typeof input>)=>json(await send('POST',base,payload));
    const append=async(upload:Status,value:string)=>{const bytes=Buffer.from(value);expect((await send('PATCH',base+'/'+upload.id,bytes,{'upload-offset':'0','content-length':String(bytes.length)})).status).toBe(200);};
    const firstInput=input('versioned.txt','first payload'),first=await create(firstInput);expect(first.receiptState).toBe('pending');expect(first.intentHash).toMatch(/^[a-f0-9]{64}$/);
    await append(first,'first payload');
    await expect(send('POST',base+'/'+first.id+'/complete',undefined,{'x-fixture-lose-response':'yes'})).rejects.toThrow();
    const firstReceipt=(await files.getUpload(first.id)).publicationReceipt;expect(firstReceipt).toBeDefined();if(firstReceipt===undefined)throw new Error('No committed receipt');
    expect(firstReceipt).toMatchObject({uploadId:first.id,operationId:first.id,intentHash:first.intentHash,sha256:digest('first payload'),sizeBytes:'13',rootId:enrolled.device.syncRootId});
    const second=await files.createUpload({parentId:firstReceipt.parentId,filename:firstReceipt.name,expectedSize:14,expectedSha256:digest('second payload'),idempotencyKey:'other-actor-'+randomUUID(),
      overwriteResourceId:firstReceipt.resourceId,expectedVersionId:firstReceipt.versionId});
    await files.appendUpload(second.id,0,14,Readable.from('second payload'));await files.completeUpload(second.id);
    const backend=[vi.spyOn(storage,'stat'),vi.spyOn(storage,'exists'),vi.spyOn(storage,'rename'),vi.spyOn(storage,'write'),vi.spyOn(storage,'openRead')];
    const beforeVersions=await db.withSql(sql=>sql`SELECT id FROM file_versions WHERE resource_id=${firstReceipt.resourceId}`);
    for(const response of [await send('GET',base+'/'+first.id),await send('POST',base+'/'+first.id+'/complete'),await send('POST',base,firstInput)]){
      const replay=await json(response);expect(replay.publicationReceipt).toEqual(firstReceipt);expect(replay.etag).toBe(`"sha256-${digest('second payload')}"`);
    }
    backend.forEach(spy=>expect(spy).not.toHaveBeenCalled());backend.forEach(spy=>spy.mockRestore());
    expect(await db.withSql(sql=>sql`SELECT id FROM file_versions WHERE resource_id=${firstReceipt.resourceId}`)).toEqual(beforeVersions);
    checks.push('actual lost HTTP completion response; independent V2 publication; original GET/complete/create return V1 receipt while legacy etag remains V2; no additional backend calls or versions');
    for(const changes of [{ifNoneMatch:undefined},{ifMatch:'"changed"'},{expectedSize:12},{expectedSha256:digest('changed')},{path:'sync/Receipt A/other.txt'}]){
      expect((await send('POST',base,{...firstInput,...changes})).status).toBe(409);
    }
    expect((await fetch(base+'/'+first.id,{headers:peerHeaders})).status).toBe(404);
    const legacyKey=digest(randomUUID()),legacyPayload='legacy payload';
    const legacy=await files.createUpload({parentId:firstReceipt.parentId,filename:'legacy.txt',expectedSize:Buffer.byteLength(legacyPayload),expectedSha256:digest(legacyPayload),
      idempotencyKey:'sync-resume-'+createHmac('sha256','immutable-receipt-fixture-pepper-12345678').update(enrolled.device.id).update('\0').update(legacyKey).digest('hex'),
      auditActor:{type:'device_token',id:enrolled.device.id},requireAbsent:true});
    await files.appendUpload(legacy.id,0,Buffer.byteLength(legacyPayload),Readable.from(legacyPayload));const legacyPublished=await files.completeUpload(legacy.id);
    const legacyNext=await files.createUpload({parentId:firstReceipt.parentId,filename:'legacy.txt',expectedSize:4,expectedSha256:digest('next'),idempotencyKey:'legacy-next-'+randomUUID(),
      overwriteResourceId:legacyPublished.resource.id,...(legacyPublished.resource.currentVersionId===undefined?{}:{expectedVersionId:legacyPublished.resource.currentVersionId})});
    await files.appendUpload(legacyNext.id,0,4,Readable.from('next'));await files.completeUpload(legacyNext.id);
    const legacyStatus=await json(await send('GET',base+'/'+legacy.id));expect(legacyStatus.receiptState).toBe('legacy_unqualified');expect(legacyStatus.publicationReceipt).toBeUndefined();
    expect(legacyStatus.etag).toBe(`"sha256-${digest('next')}"`);
    const sealedFirst=(await files.getUpload(first.id)).publicationIntent;
    await expect(db.withSql(sql=>sql`UPDATE operation_journal SET upload_intent=${sql.json({...sealedFirst})},upload_intent_hash=${first.intentHash ?? ''} WHERE id=${legacy.id}`)).rejects.toThrow('legacy rows cannot be backfilled');
    const overwriteInput=input('versioned.txt','third payload',digest(randomUUID()),`"sha256-${digest('second payload')}"`);
    const overwrite=await create(overwriteInput);await append(overwrite,'third payload');
    const completed=await Promise.all([json(await send('POST',base+'/'+overwrite.id+'/complete')),json(await send('POST',base+'/'+overwrite.id+'/complete'))]);
    expect(completed[0].publicationReceipt).toEqual(completed[1].publicationReceipt);const overwrittenReceipt=completed[0].publicationReceipt;if(!overwrittenReceipt)throw new Error('No overwrite receipt');
    expect(overwrittenReceipt.resourceId).toBe(firstReceipt.resourceId);expect(overwrittenReceipt.versionId).not.toBe(firstReceipt.versionId);
    checks.push('exact changed-condition/key identity conflicts and peer hiding; overwrite publishes distinct immutable version; completion replay stable');
    checks.push('preexisting legacy active session with later version remains unqualified/current-etag-compatible; DB rejects historical intent backfill');
    const concurrentInput=input('concurrent.txt','concurrent payload');
    const duplicateCreate=await Promise.all([create(concurrentInput),create(concurrentInput)]);expect(duplicateCreate[0].id).toBe(duplicateCreate[1].id);
    const concurrent=duplicateCreate[0];await append(concurrent,'concurrent payload');
    const concurrentComplete=await Promise.all([send('POST',base+'/'+concurrent.id+'/complete').then(json),send('POST',base+'/'+concurrent.id+'/complete').then(json)]);
    expect(concurrentComplete[0].publicationReceipt).toEqual(concurrentComplete[1].publicationReceipt);
    expect(await db.withSql(sql=>sql`SELECT count(*)::text AS count FROM file_versions WHERE resource_id=${concurrentComplete[0].publicationReceipt?.resourceId ?? firstReceipt.resourceId}`)).toMatchObject([{count:'1'}]);
    await files.createFolder(firstReceipt.parentId,'parallel-one');await files.createFolder(firstReceipt.parentId,'parallel-two');
    const independent=await Promise.all(['parallel-one','parallel-two'].map(async folder=>{
      const upload=await create(input(folder+'/independent.txt','independent payload'));await append(upload,'independent payload');return upload;
    }));
    const initialCommit=repository.commitUpload.bind(repository);
    vi.spyOn(repository,'commitUpload').mockImplementation(async record=>{try{return await initialCommit(record);}catch(error){capturedErrors.push(error instanceof Error?
      {name:error.name,message:error.message,...('code' in error?{code:error.code}:{}),...('detail' in error?{detail:error.detail}:{})}:String(error));throw error;}});
    const independentResponses=await Promise.all(independent.map(upload=>send('POST',base+'/'+upload.id+'/complete')));vi.restoreAllMocks();
    for(const response of independentResponses)expect((await json(response)).receiptState).toBe('published');
    const abandoned=await create(input('abandon.txt','partial payload'));await files.appendUpload(abandoned.id,0,4,Readable.from('part'));await files.abandonUpload(abandoned.id);
    expect((await files.getUpload(abandoned.id)).status).toBe('abandoned');
    await expect(db.withSql(sql=>sql`DELETE FROM operation_journal WHERE id=${abandoned.id}`)).rejects.toThrow('Sealed');
    checks.push('same-key concurrent creation and concurrent completion have one effect; legitimate pending cancellation preserves accepted sealed key');
    const rollback=await create(input('rollback.txt','rollback payload'));await append(rollback,'rollback payload');
    await db.withSql(sql=>sql.unsafe(`CREATE FUNCTION reject_fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${rollback.id}'::uuid AND NEW.upload_receipt IS NOT NULL THEN RAISE EXCEPTION 'injected receipt commit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_receipt_failure BEFORE UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION reject_fixture_receipt()`));
    expect((await send('POST',base+'/'+rollback.id+'/complete')).status).toBe(500);
    expect((await files.getUpload(rollback.id)).publicationReceipt).toBeUndefined();expect((await files.getUpload(rollback.id)).status).toBe('failed_retryable');
    expect(await db.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${firstReceipt.parentId} AND name='rollback.txt'`)).toHaveLength(0);
    await db.withSql(sql=>sql.unsafe('DROP TRIGGER fixture_receipt_failure ON operation_journal; DROP FUNCTION reject_fixture_receipt()'));
    expect((await json(await send('POST',base+'/'+rollback.id+'/complete'))).receiptState).toBe('published');
    const lostSql=await create(input('sql-loss.txt','sql loss payload'));await append(lostSql,'sql loss payload');
    const commit=repository.commitUpload.bind(repository);vi.spyOn(repository,'commitUpload').mockImplementationOnce(async record=>{await commit(record);throw new Error('injected lost SQL acknowledgement');});
    expect((await json(await send('POST',base+'/'+lostSql.id+'/complete'))).publicationReceipt?.uploadId).toBe(lostSql.id);vi.restoreAllMocks();
    checks.push('receipt SQL failure atomically rolls back catalog/version/session and backend restored to temp; retry completes; lost SQL acknowledgement finds original receipt');
    const tokenRace=await create(input('token-race.txt','token race payload'));await append(tokenRace,'token race payload');
    const originalToken=(await deviceRepository.getById(enrolled.device.id))?.tokenHash;if(originalToken===undefined)throw new Error('Missing token hash');
    const rename=storage.rename.bind(storage);
    vi.spyOn(storage,'rename').mockImplementationOnce(async(from,to)=>{await rename(from,to);await db.withSql(sql=>sql`UPDATE devices SET token_hash=${digest('rotated token')} WHERE id=${enrolled.device.id}`);});
    expect((await send('POST',base+'/'+tokenRace.id+'/complete')).status).toBe(500);vi.restoreAllMocks();
    expect((await files.getUpload(tokenRace.id)).publicationReceipt).toBeUndefined();expect(await db.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${firstReceipt.parentId} AND name='token-race.txt'`)).toHaveLength(0);
    expect((await send('GET',base+'/'+first.id)).status).toBe(401);
    await db.withSql(sql=>sql`UPDATE devices SET token_hash=${originalToken} WHERE id=${enrolled.device.id}`);
    expect((await json(await send('POST',base+'/'+tokenRace.id+'/complete'))).receiptState).toBe('published');
    const outside=await files.createFolder('00000000-0000-7000-8000-000000000004','outside fixture');
    const scopedParent=await files.createFolder(firstReceipt.parentId,'moving-parent');
    const parentRace=await create(input('moving-parent/parent-race.txt','parent race payload'));await append(parentRace,'parent race payload');
    vi.spyOn(storage,'rename').mockImplementationOnce(async(from,to)=>{await rename(from,to);await db.withSql(sql=>sql`UPDATE resources SET parent_id=${outside.id} WHERE id=${scopedParent.id}`);});
    expect((await send('POST',base+'/'+parentRace.id+'/complete')).status).toBe(500);vi.restoreAllMocks();
    expect((await files.getUpload(parentRace.id)).publicationReceipt).toBeUndefined();expect(await db.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${scopedParent.id} AND name='parent-race.txt'`)).toHaveLength(0);
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${firstReceipt.parentId} WHERE id=${scopedParent.id}`);
    expect((await json(await send('POST',base+'/'+parentRace.id+'/complete'))).receiptState).toBe('published');
    // Commit-time worker checks do not require or persist a native token. They
    // still reject inactive/cyclic/deep/outside parent chains before SQL effect.
    const bounded=await create(input('moving-parent/bounded.txt','bounded payload'));await append(bounded,'bounded payload');
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${scopedParent.id} WHERE id=${scopedParent.id}`);
    await expect(files.completeUpload(bounded.id)).rejects.toThrow('authorization changed');expect((await files.getUpload(bounded.id)).publicationReceipt).toBeUndefined();
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${firstReceipt.parentId},status='trashed' WHERE id=${scopedParent.id}`);
    await expect(files.completeUpload(bounded.id)).rejects.toThrow('parent is not active');
    await db.withSql(sql=>sql`UPDATE resources SET status='active' WHERE id=${scopedParent.id}`);
    const depthIds=Array.from({length:129},()=>randomUUID());
    await db.transaction(async sql=>{for(let n=0;n<depthIds.length;n++)await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,size_bytes,status)
      VALUES(${depthIds[n] ?? ''},'folder',${n===0?firstReceipt.parentId:depthIds[n-1] ?? ''},${'depth-'+String(n)},${'depth-fixture/'+String(n)},0,'active')`;
      await sql`UPDATE resources SET parent_id=${depthIds.at(-1) ?? ''} WHERE id=${scopedParent.id}`;});
    await expect(files.completeUpload(bounded.id)).rejects.toThrow('authorization changed');expect((await files.getUpload(bounded.id)).publicationReceipt).toBeUndefined();
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${firstReceipt.parentId} WHERE id=${scopedParent.id}`);
    expect((await files.completeUpload(bounded.id)).publicationReceipt?.uploadId).toBe(bounded.id);
    checks.push('token rotation and cross-root parent change during backend rename reject final SQL publication and restore temp; current-token GET rejected; worker cycles/inactive/depth>128 fail closed, retry after repair publishes once');
    const actualMoveParent=await files.createFolder(firstReceipt.parentId,'actual-move-parent');
    const actualMove=await create(input('actual-move-parent/move-race.txt','move race payload'));await append(actualMove,'move race payload');
    const stat=storage.stat.bind(storage);
    vi.spyOn(storage,'stat').mockImplementationOnce(async name=>{
      const attributes=await stat(name);await files.moveResource(actualMoveParent.id,{parentId:outside.id,idempotencyKey:'actual-cross-root-'+randomUUID()});return attributes;
    });
    expect((await send('POST',base+'/'+actualMove.id+'/complete')).status).toBe(500);vi.restoreAllMocks();
    const movedPending=await files.getUpload(actualMove.id);expect(movedPending.publicationReceipt).toBeUndefined();expect(movedPending.status).toBe('failed_retryable');
    expect(await storage.exists(movedPending.tempPath)).toBe(true);expect(await storage.exists(movedPending.targetPath)).toBe(false);
    await files.moveResource(actualMoveParent.id,{parentId:firstReceipt.parentId,idempotencyKey:'actual-cross-root-return-'+randomUUID()});
    expect((await json(await send('POST',base+'/'+actualMove.id+'/complete'))).receiptState).toBe('published');
    checks.push('actual FileService folder move overlaps upload verification; cross-root publication refused with verified temp retained; move back and original UUID retry complete without deadlock');
    const uncertain=await create(input('unknown-rollback.txt','unknown rollback payload'));await append(uncertain,'unknown rollback payload');
    vi.spyOn(storage,'rename').mockImplementationOnce(async(from,to)=>{
      await rename(from,to);await db.withSql(sql=>sql`UPDATE devices SET state='revoked' WHERE id=${enrolled.device.id}`);
    }).mockRejectedValueOnce(new Error('injected physical rollback uncertainty'));
    expect((await send('POST',base+'/'+uncertain.id+'/complete')).status).toBe(500);vi.restoreAllMocks();
    const uncertainSession=await files.getUpload(uncertain.id);expect(uncertainSession.status).toBe('committing');expect(uncertainSession.publicationReceipt).toBeUndefined();
    expect(await storage.exists(uncertainSession.targetPath)).toBe(true);expect(await storage.exists(uncertainSession.tempPath)).toBe(false);
    expect(await repository.hasUploadRecoveryJournal(uncertain.id)).toBe(true);await expect(files.abandonUpload(uncertain.id)).rejects.toThrow('cannot be abandoned');
    await expect(db.withSql(sql=>sql`DELETE FROM operation_journal WHERE id=${uncertain.id}`)).rejects.toThrow('cannot be deleted');
    await db.withSql(sql=>sql`UPDATE upload_sessions SET expires_at=now()-interval '1 hour' WHERE id=${uncertain.id}`);
    await files.cleanupAbandonedUploads();expect((await files.getUpload(uncertain.id)).status).toBe('committing');expect(await storage.exists(uncertainSession.targetPath)).toBe(true);
    await db.withSql(sql=>sql`UPDATE upload_sessions SET expires_at=now()+interval '1 hour' WHERE id=${uncertain.id}`);
    await expect(files.completeUpload(uncertain.id)).rejects.toThrow('authorization changed');
    expect((await files.getUpload(uncertain.id)).publicationReceipt).toBeUndefined();expect(await db.withSql(sql=>sql`SELECT id FROM resources WHERE name='unknown-rollback.txt' AND parent_id=${firstReceipt.parentId}`)).toHaveLength(0);
    await db.withSql(sql=>sql`UPDATE devices SET state='active' WHERE id=${enrolled.device.id}`);
    expect((await files.completeUpload(uncertain.id)).publicationReceipt?.uploadId).toBe(uncertain.id);
    checks.push('failed physical rollback retains committing/UNKNOWN journal plus verified target bytes; cancel/reset cannot forget key; revoked worker reconciliation publishes nothing, explicit restored authorization retries original UUID once');
    const expiredSealedInput=input('expired-sealed.txt','partial expiry payload');const expiredSealed=await create(expiredSealedInput);await files.appendUpload(expiredSealed.id,0,4,Readable.from('part'));
    const expiredLegacy=await files.createUpload({parentId:firstReceipt.parentId,filename:'expired-legacy.txt',expectedSize:20,idempotencyKey:'expired-legacy-'+randomUUID()});
    await files.appendUpload(expiredLegacy.id,0,4,Readable.from('part'));
    const failedSealed=await create(input('failed-sealed.txt','good'));await append(failedSealed,'evil');
    expect((await send('POST',base+'/'+failedSealed.id+'/complete')).status).toBe(400);expect((await files.getUpload(failedSealed.id)).status).toBe('failed_final');
    await db.withSql(sql=>sql`UPDATE upload_sessions SET expires_at=now()-interval '1 hour' WHERE id=ANY(${[expiredSealed.id,expiredLegacy.id,failedSealed.id,first.id]}::uuid[])`);
    const transientDelete=storage.delete.bind(storage);vi.spyOn(storage,'delete').mockRejectedValueOnce(new Error('fixture unavailable delete')).mockImplementation(transientDelete);
    const mixedCleanup=await files.cleanupAbandonedUploads();vi.restoreAllMocks();expect(mixedCleanup.attempted).toBe(3);
    await files.cleanupAbandonedUploads();
    for(const id of [expiredSealed.id,expiredLegacy.id,failedSealed.id]){const cleaned=await files.getUpload(id);expect(cleaned.status).toBe('abandoned');expect(await storage.exists(cleaned.tempPath)).toBe(false);}
    expect((await files.getUpload(first.id)).publicationReceipt).toEqual(firstReceipt);expect((await files.getUpload(first.id)).status).toBe('active');
    expect((await send('POST',base,expiredSealedInput)).status).toBe(409);expect((await files.getUpload(expiredSealed.id)).status).toBe('abandoned');
    checks.push('mixed sealed/legacy expiry and failed-final cleanup removes only temp bytes, retries unavailable deletion, preserves abandoned accepted keys and final receipts; UNKNOWN committing bytes excluded from cleanup');
    const oldVersion=await files.getVersion(firstReceipt.resourceId,firstReceipt.versionId);await files.limitVersions(firstReceipt.resourceId,1);
    expect(await storage.exists(oldVersion.storagePath)).toBe(false);expect((await repository.getVersion(firstReceipt.resourceId,firstReceipt.versionId))?.state).toBe('expired');
    expect((await json(await send('GET',base+'/'+first.id))).publicationReceipt).toEqual(firstReceipt);
    const moved=await files.moveResource(firstReceipt.resourceId,{parentId:firstReceipt.parentId,name:'moved.txt',idempotencyKey:'fixture-move-'+randomUUID()});
    expect(moved.name).toBe('moved.txt');await files.trashResource(moved.id,{idempotencyKey:'fixture-trash-'+randomUUID()});
    await files.purgeTrashResource(moved.id,{idempotencyKey:'fixture-purge-'+randomUUID()});
    expect((await files.getResource(moved.id)).status).toBe('purged');expect(await storage.exists(moved.storagePath)).toBe(false);
    expect((await json(await send('GET',base+'/'+first.id))).publicationReceipt).toEqual(firstReceipt);
    expect((await json(await send('POST',base+'/'+first.id+'/complete'))).publicationReceipt).toEqual(firstReceipt);
    checks.push('actual version retention removes old bytes but retains metadata identity/FK; move/trash/purge preserve historical receipt without claiming current presence');
    const reboundRoot=await files.createFolder("00000000-0000-7000-8000-000000000004","Rebound fixture");
    await db.withSql(sql=>sql`UPDATE devices SET sync_root_id=${reboundRoot.id},scope_ids=ARRAY[${reboundRoot.id}::uuid] WHERE id=${enrolled.device.id}`);
    expect((await send('GET',base+'/'+first.id)).status).toBe(404);
    await db.withSql(sql=>sql`UPDATE devices SET sync_root_id=${enrolled.device.syncRootId ?? null},scope_ids=ARRAY[${enrolled.device.syncRootId ?? null}::uuid] WHERE id=${enrolled.device.id}`);
    await db.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE id=${enrolled.device.id}`);
    expect((await send('GET',base+'/'+first.id)).status).toBe(403);
    await db.withSql(sql=>sql`UPDATE devices SET can_write=true WHERE id=${enrolled.device.id}`);
    await db.withSql(sql=>sql`UPDATE resources SET status='trashed' WHERE id=${firstReceipt.rootId}`);
    expect((await send('GET',base+'/'+first.id)).status).toBe(403);
    await db.withSql(sql=>sql`UPDATE resources SET status='active' WHERE id=${firstReceipt.rootId}`);
    await expect(db.withSql(sql=>sql`DELETE FROM file_versions WHERE id=${firstReceipt.versionId}`)).rejects.toThrow('foreign key constraint');
    await expect(db.withSql(sql=>sql`UPDATE operation_journal SET upload_receipt='{}'::jsonb WHERE id=${first.id}`)).rejects.toThrow('immutable');
    await expect(db.withSql(sql=>sql`UPDATE upload_sessions SET require_absent=false WHERE id=${first.id}`)).rejects.toThrow('immutable');
    await expect(db.withSql(sql=>sql.unsafe('TRUNCATE operation_journal CASCADE'))).rejects.toThrow('cannot be truncated');
    await expect(db.withSql(sql=>sql.unsafe('TRUNCATE upload_sessions CASCADE'))).rejects.toThrow('cannot be truncated');
    await expect(db.transaction(async sql=>{await sql.unsafe(await fs.readFile(path.join(migrations,'0049_upload_publication_receipt.down.sql'),'utf8'));})).rejects.toThrow('sealed identities preserved');
    await expect(db.transaction(sql=>guardRecoveryMutation(sql))).rejects.toThrow('explicit backend reconciliation');
    const runtimeCurrent=vi.fn(),runtimeDirectory=vi.fn();const runtime={current:runtimeCurrent,runtimeDirectory} as unknown as RuntimeStorageManager;
    const switchService=new StorageConnectionService(db,runtime,{} as SaturnConfig,{write:vi.fn()} as unknown as AuditService);
    await expect(switchService.switch({host:'127.0.0.1',port:1,username:'fixture',root:'/unused',hostFingerprint:'fixture',authMode:'password_file',credential:'fixture'})).rejects.toThrow('explicit backend reconciliation');
    expect(runtimeCurrent).not.toHaveBeenCalled();expect(runtimeDirectory).not.toHaveBeenCalled();
    const dump=path.join(directory,'receipt.dump'),metadata=path.join(directory,'metadata');await tool(db,url.toString()).createCoherentBackup(dump,metadata,new DatabaseMetadataExporter(db));
    const manifest=JSON.parse(await fs.readFile(path.join(metadata,'coherence.json'),'utf8')) as {journal:{registeredRoots:string;uploadIntents:string;uploadReceipts:string;dumpPolicy:string}};
    expect(manifest.journal.registeredRoots).toBe('0');expect(BigInt(manifest.journal.uploadIntents)).toBeGreaterThan(0n);expect(manifest.journal.dumpPolicy).toBe('durable-journal-with-upload-dependencies');
    const targetName='receipt_restore_'+randomUUID().replaceAll('-','');await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${targetName}`));
    const targetUrl=new URL(fixture.databaseUrl);targetUrl.pathname='/'+targetName;const targetDb=new Database(targetUrl.toString(),{max:2});
    try {const targetTool=tool(targetDb,targetUrl.toString());await targetTool.restoreDump(dump,'clean');
      expect((await new PostgresFileRepository(targetDb).getUpload(first.id))?.publicationReceipt).toEqual(firstReceipt);
      expect(await targetDb.withSql(sql=>sql`SELECT count(*)::text AS count FROM sync_root_clock`)).toMatchObject([{count:'0'}]);
      await expect(targetTool.verifyRestoredDatabase()).rejects.toThrow('explicit backend reconciliation');await expect(targetTool.commitReplacement()).rejects.toThrow('explicit backend reconciliation');
      await expect(tool(targetDb,targetUrl.toString()).checkReady()).rejects.toThrow('Interrupted restore');await targetTool.rollbackReplacement();
    } finally {await targetDb.close();await admin.withSql(sql=>sql.unsafe(`DROP DATABASE ${targetName} WITH (FORCE)`));}
    await expect(tool(db,url.toString()).beginReplacement()).rejects.toThrow('explicit backend reconciliation');
    checks.push('unregistered-root receipts preserved in coherent dump/dependency restore; current-source reset/replacement/down and restarted restored-source guards retain fencing');
    await db.transaction(async sql=>{await sql.unsafe('ALTER TABLE operation_journal RENAME COLUMN upload_receipt TO fixture_unknown_receipt');});
    await expect(tool(db,url.toString()).createDump(path.join(directory,'unknown.dump'))).rejects.toThrow('Unknown or incomplete upload');
    await db.transaction(async sql=>{await sql.unsafe('ALTER TABLE operation_journal RENAME COLUMN fixture_unknown_receipt TO upload_receipt');});
    await devices.revokeDevice(enrolled.device.id);expect((await send('GET',base+'/'+first.id)).status).toBe(401);
    passed=true;
  } finally {
    await app?.close();await db.close();await storage.close();
    await admin.withSql(sql=>sql.unsafe(`DROP DATABASE ${name} WITH (FORCE)`));await admin.close();
    await fs.writeFile(path.join(directory,'results.json'),JSON.stringify({passed,checks,capturedErrors,runId:fixture.runId,containerId:fixture.containerId,
      historicalReceiptOnly:true,legacyFieldsUnchanged:true,capabilityEnabled:false,rootJournalEnabled:false,createdAt:new Date().toISOString()},null,2)+'\n');
  }
},90000);
