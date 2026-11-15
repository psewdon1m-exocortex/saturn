import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { Database } from '@saturn/database';
import { activeFixture, uid, sha } from './stage3-chat-a.fixture.js';
import { CatalogUploadDatabaseCoordinator } from '../../../packages/file-core/src/catalog-upload-database.js';
import { CatalogUploadTransferExecutor } from '../../../packages/file-core/src/catalog-upload-transfer.js';
import { DurableBackendExecutor, type BackendCommand } from '../../../packages/storage/src/durable-backend-executor.js';
import { BackendPayloadStore } from '../../../packages/storage/src/backend-payload-store.js';
import { reconcileCompletedCatalogEffects } from '../../../packages/recovery/src/completed-catalog-effects.js';
import { recoverOriginalCatalogUpload } from '../../../packages/recovery/src/original-upload-recovery.js';

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE).each(['write', 'rename'] as const)('reconciles only a fully proved original %s after the physical owner drains', async kind => {
  const f = await activeFixture('completed-catalog-effect-' + kind, 'pluto', 124), operator = new Database(f.url, { maintenanceBarrier: true, max: 2 });
  await f.executor.close(); let ownerClosed = false;
  const command: BackendCommand = async (name, identity, payload) => {
    if (name === 'complete') {
      const [task] = await f.admin.withSql(sql => sql<{ command: string }[]>`SELECT command FROM sync_backend_tasks WHERE id=${String(payload.id)}::uuid`);
      // Controlled fixture fault after real physical I/O, before its SQL ACK.
      if (task?.command === kind) throw Object.assign(Error('injected lost physical completion ACK'), { code: 'ECONNRESET' });
    }
    return f.command(name, identity, payload);
  };
  const owner = new DurableBackendExecutor(f.raw, command, f.backendIdentity, f.generation, 268435456, undefined,
    { payloads: new BackendPayloadStore(f.directory + '/payloads', f.backendIdentity, f.generation), workers: 4 });
  try {
    await owner.start(); const bytes = randomBytes(5389), coordinator = new CatalogUploadDatabaseCoordinator(f.writer, f.issuer, '1073741824', true);
    const transfer = new CatalogUploadTransferExecutor(coordinator, owner, 1073741824, f.admission);
    let original = await coordinator.prepare(f.uploadInput('original.bin', bytes), f.proof);
    if (kind === 'write') await expect(transfer.append(original, f.proof, '0', bytes)).rejects.toThrow('reconciliation_required');
    else {
      original = await transfer.append(original, f.proof, '0', bytes);
      original = await coordinator.verifyAndClaim(original, f.proof, 'application/octet-stream', uid());
      await expect(owner.rename(original.execution.tempPath, original.execution.targetPath)).rejects.toThrow('reconciliation_required'); await coordinator.markUnknown(original);
    }
    await expect(owner.close()).rejects.toThrow('backend_close_unconfirmed'); ownerClosed = true;
    const [task] = await f.admin.withSql(sql => sql<{ id: string }[]>`SELECT id FROM sync_backend_tasks WHERE backend_identity=${f.backendIdentity} AND state='UNKNOWN'`);
    if (!task) throw Error('expected_original_unknown');
    const input = { recoveryId: uid(), backendIdentity: f.backendIdentity, generation: f.generation, ownerId: owner.identity.ownerId, fencingToken: owner.identity.fencingToken,
      tasks: [{ taskId: task.id, operationId: original.status.session.uploadId, nodeId: original.execution.nodeId, versionId: original.execution.versionId,
        claimToken: original.claimToken ?? null, sha256: sha(bytes), sizeBytes: String(bytes.length) }] };
    const fence = { assertFenced: async () => { if (!ownerClosed) throw Error('writer_live'); return { evidenceSha256: 'a'.repeat(64) }; } };
    const snapshot = () => f.admin.withSql(sql => sql`SELECT to_jsonb(t) task FROM sync_backend_tasks t WHERE backend_identity=${f.backendIdentity} ORDER BY id`);
    const before = JSON.stringify(await snapshot());
    const [countersBefore] = await f.admin.withSql(sql => sql<{ completed: string; written: string }[]>`SELECT completed_effects::text completed,written_bytes::text written FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity}`);
    await expect(reconcileCompletedCatalogEffects(operator, f.raw, fence, { ...input, ownerId: uid() })).rejects.toThrow('offline_owner_changed');
    const reviewed = input.tasks[0]; if (!reviewed) throw Error('reviewed_task_required');
    await expect(reconcileCompletedCatalogEffects(operator, f.raw, fence, { ...input, tasks: [{ ...reviewed, nodeId: uid() }] })).rejects.toThrow('reviewed_original_changed');
    const path = kind === 'write' ? original.execution.tempPath : original.execution.targetPath;
    await f.raw.write(path, Readable.from(Buffer.alloc(bytes.length)), { offset: 0, create: false, truncate: true });
    await expect(reconcileCompletedCatalogEffects(operator, f.raw, fence, input)).rejects.toThrow('physical_effect_unproved');
    await f.raw.write(path, Readable.from(bytes), { offset: 0, create: false, truncate: true });
    expect(JSON.stringify(await snapshot())).toBe(before);
    const runtimeUrl = new URL(f.url); runtimeUrl.username = f.roles.runtimeRole;
    const denied = new Database(runtimeUrl.toString(), { maintenanceBarrier: true });
    try { await expect(reconcileCompletedCatalogEffects(denied, f.raw, fence, input)).rejects.toThrow('recovery_operator_required'); } finally { await denied.close(); }
    const result = await reconcileCompletedCatalogEffects(operator, f.raw, fence, input);
    expect(result).toMatchObject({ status: 'RECONCILED_COMPLETED_CATALOG_EFFECTS', originalTaskIds: [task.id], physicalReplay: false });
    expect(await reconcileCompletedCatalogEffects(operator, f.raw, fence, input)).toEqual(result);
    const [countersAfter] = await f.admin.withSql(sql => sql<{ completed: string; written: string }[]>`SELECT completed_effects::text completed,written_bytes::text written FROM sync_backend_executor WHERE backend_identity=${f.backendIdentity}`);
    expect(Number(countersAfter?.completed) - Number(countersBefore?.completed)).toBe(1);
    expect(Number(countersAfter?.written) - Number(countersBefore?.written)).toBe(kind === 'write' ? bytes.length : 0);
    const [done] = await f.admin.withSql(sql => sql<{ state: string; result: unknown }[]>`SELECT state,result FROM sync_backend_tasks WHERE id=${task.id}::uuid`);
    expect(done).toEqual({ state: 'DONE', result: kind === 'write' ? bytes.length : null });
    if (kind === 'rename') {
      if (!original.claimToken) throw Error('original_claim_required');
      const publication = await recoverOriginalCatalogUpload(operator, f.raw, fence, { rootId: f.rootId, operationId: original.status.session.uploadId,
        backendIdentity: f.backendIdentity, generation: f.generation, nodeId: original.execution.nodeId, versionId: original.execution.versionId,
        claimToken: original.claimToken, sha256: sha(bytes), sizeBytes: String(bytes.length) });
      expect(publication.publication).toMatchObject({ status: 'PUBLISHED', operationId: original.status.session.uploadId });
    }
  } finally { await operator.close(); await f.streams.close(); await f.close(); }
}, 60000);
