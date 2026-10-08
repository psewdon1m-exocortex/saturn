import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, migrate, rollback, listMigrationPairs } from "@saturn/database";
import { LocalStorageAdapter, RuntimeStorageManager } from "@saturn/storage";
import { ROOT_RESOURCE_ID, SYNC_RESOURCE_ID, DROP_POINT_RESOURCE_ID, VOLT_RESOURCE_ID } from "@saturn/file-core";
import type { SaturnConfig } from "@saturn/config";
import { StorageCatalogService } from "./storage-catalog.service.js";

const enabled=process.env.SATURN_CATALOG_INTEGRATION==='1';
const migrations=fileURLToPath(new URL('../../database/migrations/',import.meta.url));
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
describe.skipIf(!enabled)('storage catalog PostgreSQL round trip',()=>{
  const name=`catalog_test_${randomUUID().replaceAll('-','')}`;
  let admin:Database;let database:Database;let databaseUrl:string;let directory:string;
  let manager:RuntimeStorageManager;let storage:LocalStorageAdapter;let service:StorageCatalogService;
  const knownId=randomUUID();const goneId=randomUUID();const versionId=randomUUID();
  const fileShare=randomUUID();const rootShare=randomUUID();const unrelatedShare=randomUUID();
  beforeAll(async()=>{
    const base=process.env.DATABASE_URL;
    if(base===undefined)throw new Error('DATABASE_URL is required for isolated PostgreSQL integration');
    const url=new URL(base);
    if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Integration requires local PostgreSQL');
    admin=new Database(base,{max:1});
    await admin.withSql(async sql=>{await sql`CREATE DATABASE ${sql(name)}`;});
    url.pathname=`/${name}`;databaseUrl=url.toString();
    await migrate(databaseUrl,migrations);
    database=new Database(databaseUrl,{max:5,maintenanceBarrier:true});
    directory=await fs.mkdtemp(path.join(os.tmpdir(),'saturn-catalog-integration-'));
    storage=new LocalStorageAdapter(path.join(directory,'storage'));await storage.initialize();
    manager=new RuntimeStorageManager({host:'localhost',port:22,username:'fixture',root:'.',hostFingerprint:`SHA256:${'a'.repeat(43)}`,
      authMode:'password_file',passwordFile:path.join(directory,'unused'),operationTimeoutMs:10000,healthTimeoutMs:1000,maxConnections:2} satisfies SaturnConfig['storage'],path.join(directory,'runtime'),()=>storage);
    await manager.initialize();
    const roots=await database.withSql(sql=>sql<{storage_path:string}[]>`SELECT storage_path FROM resources WHERE parent_id='00000000-0000-7000-8000-000000000001'`);
    for(const root of roots)await storage.mkdir(root.storage_path);
    await storage.write('sync/known.txt',Readable.from('abd'),{offset:0,create:true});
    await storage.mkdir('sync/new-folder');await storage.write('sync/new-folder/new.txt',Readable.from('new'),{offset:0,create:true});
    await database.withSql(async sql=>{
      await sql`INSERT INTO resources(id,type,parent_id,name,storage_path,size_bytes,sha256,status)
        VALUES (${knownId},'file',${SYNC_RESOURCE_ID},'known.txt','sync/known.txt',3,${hash('abc')},'active'),
          (${goneId},'file',${SYNC_RESOURCE_ID},'gone.txt','sync/gone.txt',3,${hash('old')},'active')`;
      await sql`INSERT INTO file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason)
        VALUES (${versionId},${knownId},'sync/known.txt',${hash('abc')},3,'text/plain','initial')`;
      await sql`UPDATE resources SET current_version_id=${versionId} WHERE id=${knownId}`;
      await sql`INSERT INTO shares(id,token_hash,resource_id,resource_type,mode,state,classification_ceiling,created_at,updated_at)
        VALUES (${fileShare},${hash(fileShare)},${knownId},'file','download','active','internal',now(),now()),
          (${rootShare},${hash(rootShare)},${ROOT_RESOURCE_ID},'folder','browse','active','internal',now(),now()),
          (${unrelatedShare},${hash(unrelatedShare)},${DROP_POINT_RESOURCE_ID},'folder','browse','active','internal',now(),now())`;
    });
    service=new StorageCatalogService(database,manager);
  },60_000);
  afterAll(async()=>{
    // A failing beforeAll may leave the runtime fixture partially initialized.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    await manager?.close();await database?.close();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(admin!==undefined){
      if(!/^catalog_test_[a-f0-9]{32}$/.test(name))throw new Error('Invalid cleanup database name');
      await admin.withSql(async sql=>{await sql`DROP DATABASE IF EXISTS ${sql(name)} WITH (FORCE)`;});await admin.close();
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if(directory!==undefined)await fs.rm(directory,{recursive:true,force:true});
  });
  it('persists a read-only report and refuses concurrent requests',async()=>{
    await service.start();await expect(service.start()).rejects.toMatchObject({code:'storage_analysis_in_progress'});
    await service.runNext();
    const result=await new StorageCatalogService(database,manager).latest();
    expect(result.job?.state).toBe('ready');expect(result.job?.canSynchronize).toBe(true);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({kind:'added',storagePath:'sync/new-folder/new.txt'}),
      expect.objectContaining({kind:'changed',storagePath:'sync/known.txt'}),
      expect.objectContaining({kind:'missing',storagePath:'sync/gone.txt'}),
    ]));
    expect(await storage.exists('sync/new-folder/new.txt')).toBe(true);
    const known=await database.withSql(sql=>sql<{sha256:string}[]>`SELECT sha256 FROM resources WHERE id=${knownId}`);
    expect(known[0]?.sha256).toBe(hash('abc'));
  });
  it('imports new files, preserves IDs, records unavailable old bytes, and applies atomically',async()=>{
    const report=await service.latest();if(report.job===null)throw new Error('Report absent');
    await service.synchronize(report.job.id);await service.synchronize(report.job.id);await service.runNext();
    expect((await service.latest()).job?.state).toBe('synchronized');
    const rows=await database.withSql(sql=>sql<{id:string;storage_path:string;status:string;sha256:string;current_version_id:string}[]>`SELECT id,storage_path,status,sha256,current_version_id FROM resources WHERE type='file'`);
    expect(rows.find(row=>row.id===knownId)?.sha256).toBe(hash('abd'));
    expect(rows.find(row=>row.id===goneId)?.status).toBe('missing');
    expect(rows.find(row=>row.storage_path==='sync/new-folder/new.txt')?.status).toBe('active');
    const old=await database.withSql(sql=>sql<{state:string;sha256:string}[]>`SELECT state,sha256 FROM file_versions WHERE id=${versionId}`);
    expect(old[0]).toMatchObject({state:'missing',sha256:hash('abc')});
    const totals=await database.withSql(sql=>sql<{size_bytes:string}[]>`SELECT size_bytes FROM resources WHERE id=${SYNC_RESOURCE_ID}`);
    expect(Number(totals[0]?.size_bytes)).toBe(6);
    expect(await fs.readFile(path.join(directory,'storage/sync/known.txt'),'utf8')).toBe('abd');
    const shares=await database.withSql(sql=>sql<{id:string;state:string}[]>`SELECT id,state FROM shares`);
    expect(shares.find(row=>row.id===fileShare)?.state).toBe('revoked');
    expect(shares.find(row=>row.id===rootShare)?.state).toBe('revoked');
    expect(shares.find(row=>row.id===unrelatedShare)?.state).toBe('active');
  });
  it('reports no differences after synchronization',async()=>{
    await service.start();await service.runNext();
    const report=await service.latest();
    expect(report.job?.counts).toEqual({added:0,changed:0,missing:0,blocked:0});
    expect(report.job?.canSynchronize).toBe(false);
  });
  it('uses stable Volt role IDs for confidential imports after a folder rename',async()=>{
    await storage.rename('volt','private');
    await database.withSql(async sql=>{await sql`UPDATE resources SET name='private',storage_path='private',updated_at=now() WHERE id=${VOLT_RESOURCE_ID}`;});
    await storage.write('private/vault.kdbx',Readable.from('opaque'),{offset:0,create:true});
    await service.start();await service.runNext();const report=await service.latest();if(report.job===null)throw new Error('Report absent');
    await service.synchronize(report.job.id);await service.runNext();
    expect((await service.latest()).job?.state).toBe('synchronized');
    const imported=await database.withSql(sql=>sql<{retention_class:string;security_classification:string}[]>`SELECT retention_class,security_classification FROM resources WHERE storage_path='private/vault.kdbx'`);
    expect(imported[0]).toMatchObject({retention_class:'keepass',security_classification:'confidential'});
  });
  it('rejects a report after remote contents changed without modifying catalog rows',async()=>{
    await storage.write('sync/known.txt',Readable.from('abe'),{offset:0,create:false,truncate:true});
    await service.start();await service.runNext();const report=await service.latest();if(report.job===null)throw new Error('Report absent');
    await storage.write('sync/known.txt',Readable.from('abf'),{offset:0,create:false,truncate:true});
    await service.synchronize(report.job.id);await service.runNext();
    expect((await service.latest()).job?.state).toBe('stale');
    const known=await database.withSql(sql=>sql<{sha256:string}[]>`SELECT sha256 FROM resources WHERE id=${knownId}`);
    expect(known[0]?.sha256).toBe(hash('abd'));
  });
  it('rolls back the complete catalog transaction when a database write fails',async()=>{
    await service.start();await service.runNext();const report=await service.latest();if(report.job===null)throw new Error('Report absent');
    await database.withSql(async sql=>{await sql.unsafe(`CREATE FUNCTION catalog_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name='known.txt' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER catalog_fixture_fail BEFORE UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION catalog_fixture_fail()`);});
    try{
      await service.synchronize(report.job.id);await service.runNext();
      expect((await service.latest()).job?.state).toBe('failed');
      const known=await database.withSql(sql=>sql<{sha256:string}[]>`SELECT sha256 FROM resources WHERE id=${knownId}`);
      expect(known[0]?.sha256).toBe(hash('abd'));
    }finally{await database.withSql(async sql=>{await sql.unsafe('DROP TRIGGER catalog_fixture_fail ON resources; DROP FUNCTION catalog_fixture_fail()');});}
  });
  it('guards rollback with active jobs and has a working down/up migration',async()=>{
    const newer = (await listMigrationPairs(migrations)).filter(pair => pair.name > '0043_storage_catalog_analysis').reverse();
    for (const pair of newer) expect(await rollback(databaseUrl, migrations)).toBe(pair.name);
    await service.start();await expect(rollback(databaseUrl,migrations)).rejects.toThrow('Finish storage catalog jobs');
    await service.runNext();expect(await rollback(databaseUrl,migrations)).toBe('0043_storage_catalog_analysis');
    expect(await migrate(databaseUrl,migrations)).toBe(newer.length + 1);
  });
  it('recovers a worker lease abandoned during analysis',async()=>{
    const queued=await service.start();
    await database.withSql(async sql=>{await sql`UPDATE storage_catalog_jobs SET state='analyzing',lease_token=${randomUUID()},lease_expires_at=now()-interval '1 minute' WHERE id=${queued.id}`;});
    await new StorageCatalogService(database,manager).runNext();
    expect((await service.latest()).job?.state).toBe('ready');
  });
});
