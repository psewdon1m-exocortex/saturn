import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { activeFixture, uid, sha } from './stage3-chat-a.fixture.js';
import { CatalogUploadDatabaseCoordinator } from '../../../packages/file-core/src/catalog-upload-database.js';
import { CatalogUploadTransferExecutor } from '../../../packages/file-core/src/catalog-upload-transfer.js';
import { recoverOriginalCatalogUpload } from '../../../packages/recovery/src/original-upload-recovery.js';
import { DurableBackendExecutor } from '../../../packages/storage/src/durable-backend-executor.js';
import { BackendPayloadStore } from '../../../packages/storage/src/backend-payload-store.js';
import { Database } from '@saturn/database';

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE)('publishes only the reviewed original after full offline physical proof and resumes its pending neighbor', async () => {
  const f = await activeFixture('original-upload-recovery', 'pluto', 123);
  const operator = new Database(f.url, { maintenanceBarrier: true, max: 2 });
  try {
    const coordinator = new CatalogUploadDatabaseCoordinator(f.writer, f.issuer, '1073741824', true);
    const transfer = new CatalogUploadTransferExecutor(coordinator, f.executor, 1073741824, f.admission);
    const bytes = randomBytes(6002), neighborBytes = Buffer.from('pending original');
    const neighbor = await coordinator.prepare(f.uploadInput('neighbor.bin', neighborBytes), f.proof);
    let original = await coordinator.prepare(f.uploadInput('original.bin', bytes), f.proof);
    original = await transfer.append(original, f.proof, '0', bytes);
    original = await coordinator.verifyAndClaim(original, f.proof, 'application/octet-stream', uid());
    await f.executor.rename(original.execution.tempPath, original.execution.targetPath);
    await coordinator.markUnknown(original); await f.executor.close();
    if (!original.claimToken) throw Error('original_claim_required');
    const input = { rootId: f.rootId, operationId: original.status.session.uploadId, backendIdentity: f.backendIdentity,
      generation: f.generation, nodeId: original.execution.nodeId, versionId: original.execution.versionId,
      claimToken: original.claimToken, sha256: sha(bytes), sizeBytes: String(bytes.length) };
    const fence = { assertFenced: async () => ({ evidenceSha256: 'a'.repeat(64) }) };
    const snapshot = () => f.admin.withSql(sql => sql`SELECT to_jsonb(j) journal,to_jsonb(u) session FROM operation_journal j
      JOIN upload_sessions u ON u.id=j.id WHERE j.sync_root_id=${f.rootId} ORDER BY j.id`);
    const before = JSON.stringify(await snapshot());
    await expect(recoverOriginalCatalogUpload(operator, f.raw, fence, { ...input, nodeId: uid() })).rejects.toThrow('reviewed_original_changed');
    let probes = 0;
    await expect(recoverOriginalCatalogUpload(operator, f.raw, { assertFenced: async () => ({ evidenceSha256: (probes++ ? 'b' : 'a').repeat(64) }) }, input)).rejects.toThrow('offline_fence_changed');
    await f.raw.write(original.execution.targetPath, Readable.from(Buffer.alloc(bytes.length)), { offset: 0, create: false, truncate: true });
    await expect(recoverOriginalCatalogUpload(operator, f.raw, fence, input)).rejects.toThrow('physical_recovery_proof_invalid');
    await f.raw.write(original.execution.targetPath, Readable.from(bytes), { offset: 0, create: false, truncate: true });
    expect(JSON.stringify(await snapshot())).toBe(before);
    await expect(f.runtime.withSql(sql => sql`SELECT catalog_upload_recover_original_v1('{}'::jsonb)`)).rejects.toMatchObject({ code: '42501' });
    await expect(f.writer.withSql(sql => sql`SELECT catalog_upload_recover_original_v1('{}'::jsonb)`)).rejects.toMatchObject({ code: '42501' });
    const result = await recoverOriginalCatalogUpload(operator, f.raw, fence, input);
    const publication = result.publication as { publicationReceipt: { resourceId: string; versionId: string } };
    expect(publication.publicationReceipt).toMatchObject({ resourceId: input.nodeId, versionId: input.versionId });
    expect(await f.admin.withSql(sql => sql`SELECT id FROM file_versions WHERE resource_id=${input.nodeId}::uuid`)).toHaveLength(1);
    const [journal] = await f.admin.withSql(sql => sql<{ upload_execution: unknown; upload_claim_token: string }[]>`SELECT upload_execution,upload_claim_token FROM operation_journal WHERE id=${input.operationId}::uuid`);
    expect(journal?.upload_execution).toEqual(original.execution); expect(journal?.upload_claim_token).toBe(input.claimToken);
    const successor = new DurableBackendExecutor(f.raw, f.command, f.backendIdentity, f.generation, 268435456, undefined,
      { payloads: new BackendPayloadStore(f.directory + '/payloads', f.backendIdentity, f.generation), workers: 4 });
    try {
      await successor.start(); const nextTransfer = new CatalogUploadTransferExecutor(coordinator, successor, 1073741824, f.admission);
      let pending = await coordinator.status(neighbor, f.proof);
      expect(pending.status.session.uploadId).toBe(neighbor.status.session.uploadId);
      pending = await nextTransfer.append(pending, f.proof, '0', neighborBytes);
      expect((await nextTransfer.complete(pending, f.proof)).status.result?.status).toBe('PUBLISHED');
    } finally { await successor.close(); }
    const content: Buffer[] = []; for await (const part of await f.raw.openRead(original.execution.targetPath)) content.push(Buffer.from(part as Uint8Array));
    expect(Buffer.concat(content)).toEqual(bytes);
  } finally { await operator.close(); await f.streams.close(); await f.close(); }
}, 60000);
