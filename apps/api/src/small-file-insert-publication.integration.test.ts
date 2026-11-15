import { fixtureValue } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {activeFixture,databaseFixture,migrations,sha} from './stage3-chat-a.fixture.js';

it('creates the final resource once, preserves overwrite verification and replays the original receipt',async()=>{
  const f=await activeFixture('smallfile-insert-publication','windows',85);
  try{
    await f.admin.withSql(sql=>sql.unsafe(`CREATE TABLE observer_resource_writes(id uuid,operation text,version_id uuid,availability text);
      CREATE FUNCTION observer_resource_writes() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
        IF NEW.type='file' THEN INSERT INTO public.observer_resource_writes VALUES(NEW.id,TG_OP,NEW.current_version_id,NEW.sync_availability);END IF;RETURN NEW;END $$;
      CREATE TRIGGER observer_resource_writes AFTER INSERT OR UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION observer_resource_writes();`));
    const bytes=Buffer.from('new create proof'),input=f.uploadInput('single-insert.bin',bytes),published=await f.upload(input,bytes);
    expect(published.status.result?.status).toBe('PUBLISHED');
    expect(await f.admin.withSql(sql=>sql`SELECT operation,version_id,availability FROM observer_resource_writes`)).toEqual([{operation:'INSERT',version_id:published.execution.versionId,availability:'AVAILABLE'}]);
    const resource=fixtureValue((await f.admin.withSql(sql=>sql`SELECT id,metadata_version,current_version_id FROM resources WHERE id=${published.execution.nodeId}`))[0]);
    const replacement=Buffer.from('overwrite remains verified'),next=f.uploadInput('single-insert.bin',replacement,{nodeId:String(resource.id),metadataVersion:String(resource.metadata_version),versionId:String(resource.current_version_id)});
    const replaced=await f.upload(next,replacement);expect(replaced.status.result?.status).toBe('PUBLISHED');
    expect(await f.admin.withSql(sql=>sql`SELECT operation,availability FROM observer_resource_writes WHERE operation='UPDATE'`)).toEqual([{operation:'UPDATE',availability:'UNKNOWN'},{operation:'UPDATE',availability:'AVAILABLE'}]);
    for(const [storagePath,content] of [[replaced.execution.targetPath,replacement],[fixtureValue(replaced.execution.archivePath),bytes]] as const){const chunks=[];for await(const b of await f.raw.openRead(storagePath))chunks.push(Buffer.from(b));expect(sha(Buffer.concat(chunks))).toBe(sha(content));}
    const versions=await f.admin.withSql(sql=>sql`SELECT id,resource_id,sha256 FROM file_versions ORDER BY id`);expect(versions).toHaveLength(2);
    expect((await f.files.prepareCatalogUpload(input,f.proof)).status.result).toEqual(published.status.result);
    expect((await f.files.prepareCatalogUpload(next,f.proof)).status.result).toEqual(replaced.status.result);
    expect(await f.admin.withSql(sql=>sql`SELECT id,resource_id,sha256 FROM file_versions ORDER BY id`)).toEqual(versions);
  }finally{await f.close();}
},60000);

it('rolls back publication if the referenced version is missing, retaining the physical original for recovery',async()=>{
  const f=await activeFixture('smallfile-insert-missing-version','windows',85);
  try{
    await f.admin.withSql(sql=>sql.unsafe(`CREATE FUNCTION observer_skip_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL;END $$;
      CREATE TRIGGER observer_skip_version BEFORE INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION observer_skip_version();`));
    const bytes=Buffer.from('deferred foreign key still enforced'),input=f.uploadInput('missing-version.bin',bytes);
    let p=await f.files.prepareCatalogUpload(input,f.proof);p=await f.files.appendCatalogUpload(p,f.proof,'0',bytes);
    const rename=vi.spyOn(f.raw,'rename');await expect(f.files.completeCatalogUpload(p,f.proof)).rejects.toMatchObject({code:'reconciliation_required'});
    expect(rename).toHaveBeenCalledTimes(1);expect(await f.raw.exists(p.execution.targetPath)).toBe(true);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE id=${p.execution.nodeId}`)).toHaveLength(0);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions`)).toHaveLength(0);
    expect((await f.admin.withSql(sql=>sql`SELECT upload_effect_state,sync_result FROM operation_journal WHERE id=${p.status.session.uploadId}`))[0]).toEqual({upload_effect_state:'reconciliation_required',sync_result:null});
  }finally{vi.restoreAllMocks();await f.close();}
},60000);

it('restores the exact publication command on rollback and requires the existing deferred FK',async()=>{
  const f=await databaseFixture('smallfile-insert-publication-rollback',84);
  try{
    const definition=()=>f.db.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure) AS definition`);
    const before=await definition(),up=await fs.readFile(path.join(migrations,'0085_upload_insert_publication.up.sql'),'utf8'),down=await fs.readFile(path.join(migrations,'0085_upload_insert_publication.down.sql'),'utf8');
    await f.db.transaction(sql=>sql.unsafe(up));await f.db.transaction(sql=>sql.unsafe(down));expect(await definition()).toEqual(before);
    await f.db.withSql(sql=>sql`ALTER TABLE resources ALTER CONSTRAINT resources_current_version_fk NOT DEFERRABLE`);
    await expect(f.db.transaction(sql=>sql.unsafe(up))).rejects.toThrow('publication needs the qualified deferred version foreign key');expect(await definition()).toEqual(before);
  }finally{await f.close();}
},60000);
