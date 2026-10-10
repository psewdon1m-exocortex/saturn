import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Database, migrate } from '@saturn/database';
import { LocalStorageAdapter } from '@saturn/storage';
import { expect, it, vi } from 'vitest';
import { FileService } from './file.service.js';
import { PostgresFileRepository } from './postgres-file.repository.js';
import { DROP_POINT_RESOURCE_ID, SYNC_RESOURCE_ID } from './models.js';

const baseUrl = process.env.PIPELINE_TEST_DATABASE_URL;
it.skipIf(!baseUrl)('persists deferred cancellation cleanup across a worker restart', async () => {
  if (!baseUrl) throw new Error('PIPELINE_TEST_DATABASE_URL is required');
  const name = `audit_${randomUUID().replaceAll('-', '')}`, root = await fs.mkdtemp(path.join(os.tmpdir(), 'saturn-cancel-restart-'));
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined }), storage = new LocalStorageAdapter(root);
  let db: Database | undefined, created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    const url = new URL(baseUrl); url.pathname = '/'+name;
    await migrate(url.toString()); await storage.initialize();
    db = new Database(url.toString(), { max: 1, maintenanceBarrier: true });
    const service = new FileService(new PostgresFileRepository(db), storage); await service.initializeStorage();
    const upload = await service.createUpload({ parentId: SYNC_RESOURCE_ID, filename: 'cancelled.txt', expectedSize: 8, idempotencyKey: 'cancel-restart-file' });
    await service.appendUpload(upload.id, 0, 8, Readable.from('valuable'));
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('Storage disconnected'));
    await service.abandonUpload(upload.id);
    expect(await storage.exists(upload.tempPath)).toBe(true);
    await db.close(); db = new Database(url.toString(), { max: 1, maintenanceBarrier: true });
    const restarted = new FileService(new PostgresFileRepository(db), storage);
    expect((await restarted.getUpload(upload.id)).status).toBe('abandoned');
    expect(await restarted.cleanupAbandonedUploads()).toEqual({ attempted: 1 });
    expect(await storage.exists(upload.tempPath)).toBe(false);
    await db.withSql(async sql => { expect(await sql`SELECT 1 FROM operation_journal WHERE upload_id=${upload.id} AND error_code='cleanup_pending'`).toHaveLength(0); });
    expect(await restarted.cleanupAbandonedUploads()).toEqual({ attempted: 0 });
    // One-shot device PUTs cannot resume a server session ID. A failed empty
    // attempt may outlive immediate cancellation if its old writer held a lease.
    const empty = await restarted.createUpload({ parentId: SYNC_RESOURCE_ID, filename: 'empty-device.txt', expectedSize: 8, idempotencyKey: 'dav-upload-empty-device', auditActor: { type: 'device_token', id: 'fixture-device' } });
    const partial = await restarted.createUpload({ parentId: SYNC_RESOURCE_ID, filename: 'partial-device.txt', expectedSize: 8, idempotencyKey: 'dav-upload-partial-device', auditActor: { type: 'device_token', id: 'fixture-device' } });
    const owner = await restarted.createUpload({ parentId: SYNC_RESOURCE_ID, filename: 'owner-resume.txt', expectedSize: 8, idempotencyKey: 'dav-upload-owner-control' });
    const repository = new PostgresFileRepository(db);
    for (const item of [empty, partial, owner]) await repository.setUploadState(item.id, 'failed_retryable');
    await db.withSql(async sql => {
      await sql`UPDATE upload_sessions SET updated_at=now()-interval '3 minutes' WHERE id IN (${empty.id},${partial.id},${owner.id})`;
      await sql`UPDATE upload_sessions SET received_size=1 WHERE id=${partial.id}`;
    });
    const lease = randomUUID();
    await repository.acquireLocks(lease, ['upload:'+empty.id], new Date(Date.now()+60_000));
    expect(await restarted.cleanupAbandonedUploads()).toEqual({ attempted: 0 });
    await repository.releaseLocks(lease);
    expect(await restarted.cleanupAbandonedUploads()).toEqual({ attempted: 1 });
    expect((await restarted.getUpload(empty.id)).status).toBe('abandoned');
    expect((await restarted.getUpload(partial.id)).status).toBe('failed_retryable');
    expect((await restarted.getUpload(owner.id)).status).toBe('failed_retryable');
    const expired = await restarted.createUpload({ parentId: SYNC_RESOURCE_ID, filename: 'expired-owner.txt', expectedSize: 8, idempotencyKey: 'expired-owner-resume' });
    await restarted.appendUpload(expired.id,0,4,Readable.from('part'));
    await db.withSql(sql=>sql`UPDATE upload_sessions SET expires_at=now()-interval '1 day' WHERE id=${expired.id}`);
    await expect(restarted.appendUpload(expired.id,4,4,Readable.from('ial!'))).rejects.toThrow('expired');
    const held=randomUUID();await repository.acquireLocks(held,['upload:'+expired.id],new Date(Date.now()+60000));
    expect(await restarted.cleanupAbandonedUploads()).toEqual({attempted:0});
    // Drop has already acknowledged its durable local buffer. Its delivery
    // attempt may outlive ordinary upload TTL during a prolonged SFTP outage.
    const channel=randomUUID(),session=randomUUID(),delivery=randomUUID();
    await db.withSql(async sql=>{
      await sql`INSERT INTO drop_channels(id,state,created_at,expires_at,max_files,max_bytes) VALUES(${channel},'active',now(),now()+interval '1 hour',10,1024)`;
      await sql`INSERT INTO drop_sessions(id,channel_id,token_hash,csrf_hash,user_agent_hash,state,created_at,last_seen_at,expires_at,max_files,max_bytes) VALUES(${session},${channel},${'a'.repeat(64)},${'b'.repeat(64)},${'c'.repeat(64)},'active',now(),now(),now()+interval '1 hour',10,1024)`;
      await sql`INSERT INTO drop_uploads(id,session_id,channel_id,client_key_hash,filename,expected_size,received_size,local_path,state,created_at,updated_at,continuation_until) VALUES(${delivery},${session},${channel},${'d'.repeat(64)},'buffered-expiry.txt',8,8,'protected-buffer.part','transferring',now(),now(),now()+interval '1 hour')`;
    });
    const buffered=await restarted.createUpload({parentId:DROP_POINT_RESOURCE_ID,filename:'buffered-expiry.txt',expectedSize:8,idempotencyKey:'drop-drain:'+delivery,auditActor:{type:'drop_worker',id:delivery}});
    await restarted.appendUpload(buffered.id,0,4,Readable.from('valu'));
    await db.withSql(sql=>sql`UPDATE upload_sessions SET expires_at=now()-interval '1 day' WHERE id=${buffered.id}`);
    expect(await restarted.cleanupAbandonedUploads()).toEqual({attempted:0});
    expect(await repository.isBufferedDeliveryUpload(buffered.id)).toBe(true);
    await expect(restarted.abandonUpload(buffered.id)).rejects.toThrow('recovering');
    await restarted.appendUpload(buffered.id,4,4,Readable.from('able'));
    expect((await restarted.completeUpload(buffered.id)).resource.sizeBytes).toBe(8);
    await db.withSql(sql=>sql`UPDATE drop_uploads SET state='cancelled' WHERE id=${delivery}`);
    const cancelledDelivery=await restarted.createUpload({parentId:DROP_POINT_RESOURCE_ID,filename:'cancelled-buffer.txt',expectedSize:8,idempotencyKey:'drop-drain:'+delivery+':cancel',auditActor:{type:'drop_worker',id:delivery}});
    await db.withSql(async sql=>{await sql`UPDATE drop_uploads SET upload_id=${cancelledDelivery.id} WHERE id=${delivery}`;await sql`UPDATE upload_sessions SET expires_at=now()-interval '1 day' WHERE id=${cancelledDelivery.id}`;});
    expect(await repository.isBufferedDeliveryUpload(cancelledDelivery.id)).toBe(false);
    expect(await restarted.cleanupAbandonedUploads()).toEqual({attempted:1});
    await repository.releaseLocks(held);
    const recovery = await restarted.createUpload({parentId:SYNC_RESOURCE_ID,filename:'accepted-recovery.txt',expectedSize:8,idempotencyKey:'expired-recovery'});
    await restarted.appendUpload(recovery.id,0,8,Readable.from('valuable'));
    await repository.setUploadState(recovery.id,'verifying',{errorCode:'verification_interrupted'});
    await db.withSql(sql=>sql`UPDATE upload_sessions SET expires_at=now()-interval '1 day' WHERE id=${recovery.id}`);
    expect(await restarted.cleanupAbandonedUploads()).toEqual({attempted:1});
    expect((await restarted.getUpload(expired.id)).status).toBe('abandoned');
    expect(await storage.exists(expired.tempPath)).toBe(false);
    expect(await storage.exists(recovery.tempPath)).toBe(true);
    await expect(restarted.abandonUpload(recovery.id)).rejects.toThrow('recovering');
    expect((await restarted.completeUpload(recovery.id)).resource.sha256).toBeDefined();
    expect(await restarted.cleanupAbandonedUploads()).toEqual({attempted:0});
  } finally { await db?.close(); await storage.close(); if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`); await admin.end(); await fs.rm(root, { recursive: true, force: true }); }
}, 20_000);

it.skipIf(!baseUrl)('retires only dead one-shot DAV attempts and preserves recoverable payloads and newer acknowledged bytes', async () => {
  if (!baseUrl) throw new Error('PIPELINE_TEST_DATABASE_URL is required');
  const name = `audit_${randomUUID().replaceAll('-', '')}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saturn-dav-restart-'));
  const admin = postgres(baseUrl, { max: 1, onnotice: () => undefined });
  const storage = new LocalStorageAdapter(root);
  let db: Database | undefined, created = false;
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const work: Promise<unknown>[] = [];
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    const url = new URL(baseUrl); url.pathname = '/'+name;
    await migrate(url.toString()); await storage.initialize();
    db = new Database(url.toString(), { max: 1, maintenanceBarrier: true });
    const database = db, repository = new PostgresFileRepository(db);
    const service = new FileService(repository, storage); await service.initializeStorage();
    const dav = (filename: string, size: number, fields: Partial<Parameters<FileService['createUpload']>[0]> = {}) => service.createUpload({
      parentId: SYNC_RESOURCE_ID, filename, expectedSize: size, idempotencyKey: 'dav-upload-'+randomUUID(), auditActor: { type: 'device_token', id: 'fixture-device' }, ...fields,
    });
    const interrupted = await dav('setting-0.conf', 8);
    await repository.setUploadState(interrupted.id, 'uploading');
    await storage.write(interrupted.tempPath, Readable.from('partial'), { offset: 0, create: true });
    const owner = await dav('owner.txt', 8, { auditActor: { type: 'owner_bootstrap', id: 'owner' } });
    const resumable = await dav('resumable-device.txt', 8, { idempotencyKey: 'device-resumable-'+randomUUID() });
    for (const upload of [owner, resumable]) await service.appendUpload(upload.id, 0, 4, Readable.from('part'));
    const accepted = await dav('recoverable.txt', 8);
    await service.appendUpload(accepted.id, 0, 8, Readable.from('valuable'));
    await repository.setUploadState(accepted.id, 'verifying');
    const original = await dav('setting-1.conf', 3);
    await service.appendUpload(original.id, 0, 3, Readable.from('old'));
    const resource = (await service.completeUpload(original.id)).resource;
    const expectedVersionId = resource.currentVersionId;
    if (expectedVersionId === undefined) throw new Error('Initial version was not committed');
    const obsolete = await dav('setting-1.conf', 5, { expectedVersionId });
    await service.appendUpload(obsolete.id, 0, 5, Readable.from('stale'));
    await repository.setUploadState(obsolete.id, 'verifying');
    const newer = await dav('setting-1.conf', 3, { expectedVersionId });
    await service.appendUpload(newer.id, 0, 3, Readable.from('new'));
    const acknowledged = (await service.completeUpload(newer.id)).resource;
    const removed = await dav('removed.conf', 4);
    await service.appendUpload(removed.id, 0, 4, Readable.from('gone'));
    const removedResource = (await service.completeUpload(removed.id)).resource;
    if (removedResource.currentVersionId === undefined) throw new Error('Version missing');
    const deletedRetry = await dav('removed.conf', 5, { expectedVersionId: removedResource.currentVersionId });
    await service.appendUpload(deletedRetry.id, 0, 5, Readable.from('stale'));
    await repository.setUploadState(deletedRetry.id, 'verifying');
    const trashed = await service.trashResource(removedResource.id, { idempotencyKey: 'fixture-trash-before-recovery' });
    // Startup recovery must wait for a live filesystem request, even with no
    // short chunk lease held at this instant.
    let entered: () => void = () => undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    work.push(database.withSharedMaintenance(async () => { entered(); await held; }));
    await started;
    const recovery = database.reconcileInactiveFileLocks(); work.push(recovery);
    await new Promise(resolve => setTimeout(resolve, 30));
    // Use the fixture admin connection: ordinary status queries correctly wait
    // behind exclusive startup maintenance while the admitted writer drains.
    const inspect = postgres(url.toString(), { max: 1 });
    try { expect((await inspect`SELECT status FROM upload_sessions WHERE id=${interrupted.id}`)[0]?.status).toBe('uploading'); }
    finally { await inspect.end(); }
    release(); await recovery;
    expect((await service.getUpload(interrupted.id)).status).toBe('abandoned');
    expect((await service.getUpload(owner.id)).status).toBe('uploading');
    expect((await service.getUpload(resumable.id)).status).toBe('uploading');
    expect((await service.getUpload(accepted.id)).status).toBe('failed_retryable');
    expect(await service.cleanupAbandonedUploads()).toEqual({ attempted: 1 });
    expect(await storage.exists(interrupted.tempPath)).toBe(false);
    expect(await storage.exists(owner.tempPath)).toBe(true);
    expect(await storage.exists(resumable.tempPath)).toBe(true);
    await db.withSql(sql => sql`UPDATE upload_sessions SET updated_at=now()-interval '3 minutes' WHERE id IN (${accepted.id},${obsolete.id},${deletedRetry.id})`);
    expect(await service.recoverInterruptedUploads()).toEqual({ recovered: 1, pending: 0 });
    expect((await service.getUpload(obsolete.id)).status).toBe('abandoned');
    expect((await service.getUpload(deletedRetry.id)).status).toBe('abandoned');
    expect(await storage.exists(deletedRetry.tempPath)).toBe(false);
    expect((await service.getResource(removedResource.id)).status).toBe('trashed');
    expect((await storage.stat(trashed.storagePath)).size).toBe(4);
    expect(await storage.exists(obsolete.tempPath)).toBe(false);
    const download = await service.openDownload(acknowledged.id), chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('new');
    expect(download.resource.sha256).toBe(acknowledged.sha256);
    const versions = await service.listVersions(acknowledged.id);
    expect(versions).toHaveLength(2);
    await service.appendUpload(owner.id, 4, 4, Readable.from('more'));
    expect((await service.completeUpload(owner.id)).resource.sizeBytes).toBe(8);
  } finally {
    release(); await Promise.allSettled(work); await db?.close(); await storage.close();
    if (created) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end(); await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);
