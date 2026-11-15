import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it} from 'vitest';
import {activeFixture,databaseFixture,migrations,uid} from './stage3-chat-a.fixture.js';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';

it('requires the validated upload constraint and restores the exact predecessor on rollback',async()=>{
  const f=await databaseFixture('smallfile-admission-migration',74);
  const up=await fs.readFile(path.join(migrations,'0075_upload_admission_projection.up.sql'),'utf8');
  const down=await fs.readFile(path.join(migrations,'0075_upload_admission_projection.down.sql'),'utf8');
  try{
    const before=await f.db.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure) AS definition`);
    await f.db.withSql(sql=>sql.unsafe('ALTER TABLE operation_journal DROP CONSTRAINT operation_catalog_upload_shape; ALTER TABLE operation_journal ADD CONSTRAINT operation_catalog_upload_shape CHECK(catalog_upload_shape(operation_journal) IS TRUE) NOT VALID'));
    await expect(f.db.transaction(sql=>sql.unsafe(up))).rejects.toThrow('validated catalog upload shape prerequisite missing');
    await f.db.withSql(sql=>sql.unsafe('ALTER TABLE operation_journal VALIDATE CONSTRAINT operation_catalog_upload_shape'));
    await f.db.transaction(sql=>sql.unsafe(up));
    await f.db.transaction(sql=>sql.unsafe(down));
    expect(await f.db.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure) AS definition`)).toEqual(before);
    await f.db.transaction(sql=>sql.unsafe(up));
  }finally{await f.close();}
},60000);

it('admits private transports but keeps claimed and unknown originals as root barriers',async()=>{
  const f=await activeFixture('smallfile-admission-barriers','windows',75);
  try{
    const bytes=Buffer.from('sealed original'),a=f.uploadInput('a.bin',bytes),b=f.uploadInput('b.bin',bytes),c=f.uploadInput('c.bin',bytes);
    let first=await f.files.prepareCatalogUpload(a,f.proof);
    await f.files.prepareCatalogUpload(b,f.proof);
    first=await f.files.appendCatalogUpload(first,f.proof,'0',bytes);
    const coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
    first=await coordinator.prepare(a,f.proof,first.status.session.uploadId);
    first=await coordinator.verify(first,f.proof,'application/octet-stream');
    first=await coordinator.claim(first,f.proof,uid());
    await expect(f.files.prepareCatalogUpload(c,f.proof)).rejects.toMatchObject({code:'reconciliation_required'});
    await coordinator.markUnknown(first);
    await expect(f.files.prepareCatalogUpload(c,f.proof)).rejects.toMatchObject({code:'binding_invalid'});
    const retained=await coordinator.status(first,f.proof);
    expect(retained.status.session.uploadId).toBe(first.status.session.uploadId);
    expect(retained.status.session.phase).toBe('reconciliation_required');
  }finally{await f.close();}
},60000);
