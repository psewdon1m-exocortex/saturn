import { fixtureChunks } from './test-values.fixture.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {expect,it,vi} from 'vitest';
import {FileService,PostgresFileRepository} from '@saturn/file-core';
import {CatalogUploadDatabaseCoordinator} from '../../../packages/file-core/src/catalog-upload-database.js';
import {activeFixture,databaseFixture,migrations,sha,uid} from './stage3-chat-a.fixture.js';

const reviewMigration=Number(process.env.SMALL_FILE_REVIEW_MIGRATION??76);
if(![76,79,80,84].includes(reviewMigration))throw Error('Invalid review migration');

function client(f:Awaited<ReturnType<typeof activeFixture>>){
  const coordinator=new CatalogUploadDatabaseCoordinator(f.writer,f.issuer,'1073741824',true,true);
  const files=new FileService(new PostgresFileRepository(f.runtime),f.executor,{uploadMaxBytes:1073741824,catalogBackendIdentity:f.backendIdentity,catalogRootAdmission:f.admission,catalogUploadCoordinator:coordinator});
  return {coordinator,files};
}

it('atomically verifies and claims the same sealed original with the ordinary namespace checks',async()=>{
  const f=await activeFixture('smallfile-compound','windows',reviewMigration);
  try{
    const bytes=Buffer.from('complete immutable bytes'),input=f.uploadInput('compound.bin',bytes);
    let p=await f.files.prepareCatalogUpload(input,f.proof);p=await f.files.appendCatalogUpload(p,f.proof,'0',bytes);
    const credential=f.issuer.deviceCredential(f.proof,f.rootId),claimToken=uid();
    const payload={originalUploadId:p.status.session.uploadId,sizeBytes:String(bytes.length),sha256:input.intent.sha256,mimeType:'application/octet-stream',claimToken};
    const rows=await f.writer.withSql(sql=>sql<{value:{session:{phase:string};claimToken:string}}[]>`SELECT catalog_upload_command('verify-claim',${JSON.stringify(input)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`);
    expect(rows[0]?.value.session.phase).toBe('physical_pending');expect(rows[0]?.value.claimToken).toBe(claimToken);
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${f.rootId} AND name='compound.bin'`)).toHaveLength(0);
    await expect(f.files.prepareCatalogUpload(f.uploadInput('blocked.bin',bytes),f.proof)).rejects.toMatchObject({code:'reconciliation_required'});
  }finally{await f.close();}
},60000);

it('restores the exact qualified predecessor when the compound migration is rolled back',async()=>{
  const f=await databaseFixture('smallfile-compound-rollback',75);
  try{
    const before=await f.db.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure) AS definition`);
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0076_upload_compound_claim.up.sql'),'utf8')));
    await f.db.transaction(async sql=>sql.unsafe(await fs.readFile(path.join(migrations,'0076_upload_compound_claim.down.sql'),'utf8')));
    expect(await f.db.withSql(sql=>sql`SELECT pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure) AS definition`)).toEqual(before);
    expect((await f.db.withSql(sql=>sql`SELECT to_regprocedure('catalog_upload_compound_v1()') IS NULL AS absent`))[0]?.absent).toBe(true);
  }finally{await f.close();}
},60000);

it('retains the original and sealed bytes when the compound claim ACK is lost',async()=>{
  const f=await activeFixture('smallfile-compound-lost-claim','windows',reviewMigration),c=client(f);
  try{
    const bytes=Buffer.from('retain me after uncertain claim'),input=f.uploadInput('lost.bin',bytes);
    let p=await c.files.prepareCatalogUpload(input,f.proof);p=await c.files.appendCatalogUpload(p,f.proof,'0',bytes);
    const original=c.coordinator.verifyAndClaim.bind(c.coordinator);
    vi.spyOn(c.coordinator,'verifyAndClaim').mockImplementationOnce(async(...args)=>{await original(...args);throw Error('lost claim ACK');});
    await expect(c.files.completeCatalogUpload(p,f.proof)).rejects.toThrow('lost claim ACK');
    const restarted=client(f),retained=await restarted.files.prepareCatalogUpload(input,f.proof,p.status.session.uploadId);
    expect(retained.status.session.uploadId).toBe(p.status.session.uploadId);
    expect(retained.status.session.phase).toBe('reconciliation_required');
    const parts:Buffer[]=[];for await(const chunk of fixtureChunks(await f.raw.openRead(p.execution.tempPath)))parts.push(Buffer.from(chunk));expect(sha(Buffer.concat(parts))).toBe(input.intent.sha256);
    expect(await f.raw.exists(p.execution.targetPath)).toBe(false);
    await expect(restarted.files.prepareCatalogUpload(f.uploadInput('next.bin',bytes),f.proof)).rejects.toMatchObject({code:'binding_invalid'});
  }finally{await f.close();}
},60000);

it('recovers after progress and a lost publication ACK without a second write or version',async()=>{
  const f=await activeFixture('smallfile-compound-lost-commit','windows',reviewMigration),c=client(f);
  try{
    const bytes=Buffer.from('resume the same bytes'),input=f.uploadInput('recover.bin',bytes);
    let p=await c.files.prepareCatalogUpload(input,f.proof);p=await c.files.appendCatalogUpload(p,f.proof,'0',bytes);
    const restarted=client(f);p=await restarted.files.prepareCatalogUpload(input,f.proof,p.status.session.uploadId);
    const original=restarted.coordinator.commit.bind(restarted.coordinator);
    vi.spyOn(restarted.coordinator,'commit').mockImplementationOnce(async(...args)=>{await original(...args);throw Error('lost publication ACK');});
    const published=await restarted.files.completeCatalogUpload(p,f.proof);
    expect(published.status.result?.status).toBe('PUBLISHED');
    const versions=await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`),write=vi.spyOn(f.raw,'write'),rename=vi.spyOn(f.raw,'rename');
    const fresh=client(f),same=await fresh.files.prepareCatalogUpload(input,f.proof,p.status.session.uploadId);
    expect((await fresh.files.completeCatalogUpload(same,f.proof)).status.result).toEqual(published.status.result);
    await expect(fresh.files.appendCatalogUpload(same,f.proof,'0',bytes)).rejects.toMatchObject({code:'transfer_unresolved'});
    expect(write).not.toHaveBeenCalled();expect(rename).not.toHaveBeenCalled();
    expect(await f.admin.withSql(sql=>sql`SELECT id FROM file_versions ORDER BY id`)).toEqual(versions);
  }finally{await f.close();}
},60000);

it('a compound verification failure leaves the original transport state unchanged',async()=>{
  const f=await activeFixture('smallfile-compound-negative','windows',reviewMigration);
  try{
    const bytes=Buffer.from('complete immutable bytes'),input=f.uploadInput('compound.bin',bytes);
    let p=await f.files.prepareCatalogUpload(input,f.proof);p=await f.files.appendCatalogUpload(p,f.proof,'0',bytes);
    const credential=f.issuer.deviceCredential(f.proof,f.rootId);
    const payload={originalUploadId:p.status.session.uploadId,sizeBytes:String(bytes.length),sha256:'0'.repeat(64),mimeType:'application/octet-stream',claimToken:uid()};
    await expect(f.writer.withSql(sql=>sql`SELECT catalog_upload_command('verify-claim',${JSON.stringify(input)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb)`)).rejects.toThrow('verification_failed');
    expect((await f.files.inspectCatalogUpload(p,f.proof)).status.session.phase).toBe('transport');
    expect((await f.files.completeCatalogUpload(p,f.proof)).status.result?.status).toBe('PUBLISHED');
  }finally{await f.close();}
},60000);
