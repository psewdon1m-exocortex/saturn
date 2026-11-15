import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { Database } from '@saturn/database';
import { activeFixture, uid, sha } from './stage3-chat-a.fixture.js';
import { CatalogUploadDatabaseCoordinator } from '../../../packages/file-core/src/catalog-upload-database.js';
import { CatalogUploadTransferExecutor } from '../../../packages/file-core/src/catalog-upload-transfer.js';
import { DurableBackendExecutor } from '../../../packages/storage/src/durable-backend-executor.js';
import { BackendPayloadStore } from '../../../packages/storage/src/backend-payload-store.js';
import { resumeUnstartedCatalogUpload } from '../../../packages/recovery/src/unstarted-upload-resume.js';

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE)('resumes the exact original claim only when its full private bytes remain and no rename was accepted', async () => {
  const f = await activeFixture('unstarted-upload-resume', 'pluto', 125), operator = new Database(f.url, { maintenanceBarrier: true, max: 2 });
  try {
    const pinned = () => f.admin.withSql(sql => sql`SELECT p.oid::regprocedure::text name,p.prosrc FROM pg_proc p WHERE p.proowner=(SELECT oid FROM pg_roles WHERE rolname=${f.roles.writerOwner}) ORDER BY p.oid`);
    const pinnedBefore = await pinned();
    await f.admin.transaction(async sql => sql.unsafe(await fs.readFile(new URL('../../../packages/database/migrations/0125_unstarted_original_claim.down.sql', import.meta.url), 'utf8')));
    await f.admin.transaction(async sql => sql.unsafe(await fs.readFile(new URL('../../../packages/database/migrations/0125_unstarted_original_claim.up.sql', import.meta.url), 'utf8')));
    expect(await pinned()).toEqual(pinnedBefore);
    const bytes = randomBytes(517), coordinator = new CatalogUploadDatabaseCoordinator(f.writer, f.issuer, '1073741824', true);
    const transfer = new CatalogUploadTransferExecutor(coordinator, f.executor, 1073741824, f.admission);
    const input = f.uploadInput('original.bin', bytes);
    let original = await coordinator.prepare(input, f.proof); original = await transfer.append(original, f.proof, '0', bytes);
    original = await coordinator.verifyAndClaim(original, f.proof, 'application/octet-stream', uid());
    if (!original.claimToken) throw Error('original_claim_required');
    await coordinator.markUnknown(original); await f.executor.close();
    const reviewed = { rootId: f.rootId, operationId: original.status.session.uploadId, backendIdentity: f.backendIdentity, generation: f.generation,
      nodeId: original.execution.nodeId, versionId: original.execution.versionId, claimToken: original.claimToken, sha256: sha(bytes), sizeBytes: String(bytes.length) };
    const fence = { assertFenced: async () => ({ evidenceSha256: 'a'.repeat(64) }) };
    await expect(resumeUnstartedCatalogUpload(operator, f.raw, fence, { ...reviewed, claimToken: uid() })).rejects.toThrow('reviewed_original_changed');
    await expect(f.runtime.withSql(sql => sql`SELECT catalog_upload_resume_unstarted_v1('{}'::jsonb)`)).rejects.toMatchObject({ code: '42501' });
    await expect(f.writer.withSql(sql => sql`SELECT catalog_upload_resume_unstarted_v1('{}'::jsonb)`)).rejects.toMatchObject({ code: '42501' });
    await f.raw.copy(original.execution.tempPath, original.execution.targetPath);
    await expect(resumeUnstartedCatalogUpload(operator, f.raw, fence, reviewed)).rejects.toThrow('physical_recovery_proof_invalid');
    await f.raw.delete(original.execution.targetPath);
    const result = await resumeUnstartedCatalogUpload(operator, f.raw, fence, reviewed);
    expect(result).toMatchObject({ status: 'ORIGINAL_CLAIM_RESUMABLE', operationId: reviewed.operationId, nodeId: reviewed.nodeId, versionId: reviewed.versionId, claimToken: reviewed.claimToken });
    expect(await f.admin.withSql(sql => sql`SELECT id FROM file_versions WHERE id=${reviewed.versionId}::uuid`)).toHaveLength(0);
    const owner = new DurableBackendExecutor(f.raw, f.command, f.backendIdentity, f.generation, 268435456, undefined,
      { payloads: new BackendPayloadStore(f.directory + '/payloads', f.backendIdentity, f.generation), workers: 4 });
    try {
      await owner.start(); const resumed = await coordinator.prepare(input, f.proof, reviewed.operationId);
      expect(resumed.claimToken).toBe(reviewed.claimToken); expect(resumed.status.session.phase).toBe('physical_pending');
      expect(await owner.exists(original.execution.targetPath)).toBe(false);
      await owner.rename(original.execution.tempPath, original.execution.targetPath);
      const published = await coordinator.commit(resumed, f.proof, 'application/octet-stream');
      expect(published.status.result).toMatchObject({ status: 'PUBLISHED', operationId: reviewed.operationId, publicationReceipt: { resourceId: reviewed.nodeId, versionId: reviewed.versionId } });
      expect(published.claimToken).toBe(reviewed.claimToken);
    } finally { await owner.close(); }
    expect(await f.admin.withSql(sql => sql`SELECT id FROM file_versions WHERE resource_id=${reviewed.nodeId}::uuid`)).toHaveLength(1);
    const content: Buffer[] = []; for await (const part of await f.raw.openRead(original.execution.targetPath)) content.push(Buffer.from(part as Uint8Array));
    expect(Buffer.concat(content)).toEqual(bytes); expect(await f.raw.exists(original.execution.tempPath)).toBe(false);
    expect(await pinned()).toEqual(pinnedBefore);
    await expect(f.admin.transaction(async sql => sql.unsafe(await fs.readFile(new URL('../../../packages/database/migrations/0125_unstarted_original_claim.down.sql', import.meta.url), 'utf8')))).rejects.toThrow('recovery_evidence_requires_retention');
  } finally { await operator.close(); await f.streams.close(); await f.close(); }
}, 60000);
