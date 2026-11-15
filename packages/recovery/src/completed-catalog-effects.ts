import { createHash } from 'node:crypto';
import type { Database } from '@saturn/database';
import type { StorageAdapter } from '@saturn/storage';
import type { OfflineBackendFence } from './absent-backup-part-reconciliation.js';

export interface CompletedCatalogEffectsInput {
  recoveryId: string; backendIdentity: string; generation: string; ownerId: string; fencingToken: string;
  tasks: readonly { taskId: string; operationId: string; nodeId: string; versionId: string; claimToken: string | null; sha256: string; sizeBytes: string }[];
}
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map((item: unknown) => canonical(item)).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => JSON.stringify(key) + ':' + canonical(value)).join(',') + '}';
  return JSON.stringify(v);
};
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('catalog_effect_proof_invalid');
  return v as Record<string, unknown>;
}

/** Operator-only, witnessed offline reconciliation of exact completed private
 * writes / create renames. Does not reset a root, publish a journal, replay I/O,
 * reject an original, infer absence from a transport error or adopt overwrites.
 * The live supervisor fence must prove the exact writer and all peers closed. */
export async function reconcileCompletedCatalogEffects(database: Database,
  storage: Pick<StorageAdapter, 'exists' | 'stat' | 'openRead'>,
  fence: OfflineBackendFence, input: CompletedCatalogEffectsInput): Promise<Record<string, unknown>> {
  const first = await fence.assertFenced();
  if (!/^[a-f0-9]{64}$/.test(first.evidenceSha256) || input.tasks.length < 1 || input.tasks.length > 4
    || new Set(input.tasks.map(t => t.taskId)).size !== input.tasks.length) throw Error('offline_fence_required');
  return database.withExclusiveMaintenance(() => database.transaction(async sql => {
    await sql`SET LOCAL lock_timeout='2s'`; await sql`SET LOCAL statement_timeout='30s'`;
    const [operator] = await sql<{ valid: boolean }[]>`SELECT current_user=session_user AND current_user=pg_get_userbyid(c.relowner) AS valid
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='saturn_owner_recovery' AND c.relname='history'`;
    if (!operator?.valid) throw Error('recovery_operator_required');
    const [prior] = await sql<{ proof: { input: unknown }; result: Record<string, unknown> }[]>`SELECT proof,result FROM saturn_owner_recovery.history WHERE id=${input.recoveryId}::uuid`;
    if (prior) { if (digest(prior.proof.input) !== digest(input)) throw Error('recovery_proof_changed'); return prior.result; }
    const [backend] = await sql<Record<string, unknown>[]>`SELECT * FROM sync_backend_executor WHERE backend_identity=${input.backendIdentity} FOR UPDATE`;
    if (!backend || backend.state !== 'DRAINING' || backend.generation !== input.generation || backend.owner_id !== input.ownerId
      || backend.fencing_token !== input.fencingToken) throw Error('offline_owner_changed');
    const tasks = await sql<Record<string, unknown>[]>`SELECT * FROM sync_backend_tasks WHERE backend_identity=${input.backendIdentity}
      AND state IN ('QUEUED','RUNNING','UNKNOWN') ORDER BY id FOR UPDATE`;
    if (tasks.length !== input.tasks.length || tasks.some(t => t.state !== 'UNKNOWN' || t.generation !== input.generation
      || t.owner_id !== input.ownerId || t.fencing_token !== input.fencingToken || !input.tasks.some(x => x.taskId === t.id))) throw Error('recovery_effect_unresolved');
    if ((await sql`SELECT id FROM sync_backend_read_slots WHERE backend_identity=${input.backendIdentity} LIMIT 1`).length) throw Error('recovery_readers_not_drained');
    const evidence: unknown[] = [], effects: { id: string; result: number | null }[] = [];
    for (const task of tasks) {
      const reviewed = input.tasks.find(x => x.taskId === task.id);
      if (!reviewed || !/^[a-f0-9]{64}$/.test(reviewed.sha256) || !/^[1-9][0-9]{0,6}$/.test(reviewed.sizeBytes)
        || BigInt(reviewed.sizeBytes) > 8388608n) throw Error('reviewed_original_changed');
      const [row] = await sql<{ journal: Record<string, unknown>; session: Record<string, unknown> }[]>`
        SELECT to_jsonb(j) journal,to_jsonb(u) session FROM operation_journal j JOIN upload_sessions u ON u.id=j.id WHERE j.id=${reviewed.operationId}::uuid FOR UPDATE OF j,u`;
      if (!row) throw Error('reviewed_original_changed');
      const j = row.journal, u = row.session, e = object(j.upload_execution), i = object(j.upload_intent), p = object(task.payload);
      if (j.sync_result !== null || j.upload_claim_token !== reviewed.claimToken || e.nodeId !== reviewed.nodeId || e.versionId !== reviewed.versionId
        || e.backendIdentity !== input.backendIdentity || e.before !== null || e.archivePath !== null
        || i.schema !== 'saturn.upload-intent.v2' || i.requireAbsent !== true || i.targetId !== null || i.expectedVersionId !== null
        || i.sha256 !== reviewed.sha256 || i.sizeBytes !== reviewed.sizeBytes || u.expected_sha256 !== reviewed.sha256
        || String(u.expected_size) !== reviewed.sizeBytes || e.tempPath !== '_system/incoming/' + reviewed.operationId + '.part'
        || typeof e.targetPath !== 'string' || typeof e.tempPath !== 'string') throw Error('reviewed_original_changed');
      let path: string;
      if (task.command === 'write') {
        const options = object(p.options), ref = object(p.payloadRef), transfer = object(j.upload_transfer);
        if (p.schema !== 'saturn.backend-write-once.v1' || p.path !== e.tempPath || options.offset !== 0 || options.create !== true
          || options.exclusive !== true || options.truncate !== false || ref.sha256 !== reviewed.sha256 || ref.size !== reviewed.sizeBytes
          || transfer.token !== task.id || transfer.offset !== '0' || transfer.length !== reviewed.sizeBytes
          || transfer.originalUploadId !== reviewed.operationId || j.upload_effect_state !== 'transport' || reviewed.claimToken !== null
          || Number(u.received_size) !== 0 || await storage.exists(e.targetPath)) throw Error('unsupported_catalog_effect');
        path = e.tempPath;
      } else if (task.command === 'rename') {
        const transfer = object(j.upload_last_transfer);
        if (p.source !== e.tempPath || p.destination !== e.targetPath || j.upload_effect_state !== 'reconciliation_required'
          || !reviewed.claimToken || j.upload_transfer !== null || Number(u.received_size) !== Number(reviewed.sizeBytes)
          || u.actual_sha256 !== reviewed.sha256 || await storage.exists(e.tempPath)) throw Error('unsupported_catalog_effect');
        const [written] = await sql<Record<string, unknown>[]>`SELECT * FROM sync_backend_tasks WHERE id=${String(transfer.token)}::uuid FOR SHARE`;
        if (!written || written.state !== 'DONE' || written.command !== 'write' || written.backend_identity !== input.backendIdentity
          || written.generation !== input.generation || written.owner_id !== input.ownerId || written.fencing_token !== input.fencingToken
          || object(written.payload).path !== e.tempPath || object(object(written.payload).payloadRef).sha256 !== reviewed.sha256
          || String(written.result) !== reviewed.sizeBytes || transfer.offset !== '0' || transfer.length !== reviewed.sizeBytes) throw Error('original_effect_receipt_invalid');
        path = e.targetPath;
      } else throw Error('unsupported_catalog_effect');
      const before = await storage.stat(path); if (before.type !== 'file' || String(before.size) !== reviewed.sizeBytes) throw Error('physical_effect_unproved');
      const hash = createHash('sha256'); let bytes = 0;
      const stream = await storage.openRead(path);
      for await (const value of stream) { const chunk: unknown = value; if (!(chunk instanceof Uint8Array)) throw Error('physical_effect_unproved'); bytes += chunk.length;
        if (bytes > Number(reviewed.sizeBytes)) throw Error('physical_effect_unproved'); hash.update(chunk); }
      await stream.storageClosed;
      const after = await storage.stat(path);
      if (bytes !== Number(reviewed.sizeBytes) || hash.digest('hex') !== reviewed.sha256 || after.type !== 'file'
        || after.size !== before.size || after.modifiedAt.getTime() !== before.modifiedAt.getTime()) throw Error('physical_effect_unproved');
      evidence.push({ task, journalSha256: digest(j), sessionSha256: digest(u), path, bytes, sha256: reviewed.sha256, physicalOutcome: 'COMPLETED_FULL_SHA' });
      effects.push({ id: String(task.id), result: task.command === 'write' ? bytes : null });
    }
    if ((await fence.assertFenced()).evidenceSha256 !== first.evidenceSha256) throw Error('offline_fence_changed');
    const proof = { schema: 'saturn.completed-catalog-effects-proof.v1', input, backend, evidence, fenceSha256: first.evidenceSha256 }, proofSha256 = digest(proof);
    for (const effect of effects) await sql`UPDATE sync_backend_tasks SET state='DONE',result=${JSON.stringify(effect.result)}::text::jsonb,error_code=NULL,updated_at=now() WHERE id=${effect.id}::uuid`;
    const receipt = { schema: 'saturn.offline-completed-catalog-owner-release.v1', recoveryId: input.recoveryId, proofSha256,
      ownerId: input.ownerId, fencingToken: input.fencingToken, generation: input.generation, connectionsClosed: true, completedTaskIds: effects.map(e => e.id) };
    const writtenBytes = effects.reduce((sum, effect) => sum + (effect.result ?? 0), 0);
    await sql`UPDATE sync_backend_executor SET completed_effects=completed_effects+${effects.length},written_bytes=written_bytes+${writtenBytes},
      state='STOPPED',owner_id=NULL,fencing_token=NULL,liveness_owner_id=NULL,liveness_fencing_token=NULL,
      liveness_at=NULL,stopped_receipt=${JSON.stringify(receipt)}::text::jsonb,updated_at=now() WHERE backend_identity=${input.backendIdentity}`;
    const result = { status: 'RECONCILED_COMPLETED_CATALOG_EFFECTS', recoveryId: input.recoveryId, originalTaskIds: effects.map(e => e.id), proofSha256, physicalReplay: false };
    await sql`INSERT INTO saturn_owner_recovery.history(id,proof_sha256,proof,receipt,result) VALUES(${input.recoveryId}::uuid,${proofSha256},
      ${JSON.stringify(proof)}::text::jsonb,${JSON.stringify(receipt)}::text::jsonb,${JSON.stringify(result)}::text::jsonb)`;
    return result;
  }));
}
