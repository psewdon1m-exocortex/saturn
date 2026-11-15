import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@saturn/database';
import type { StorageAdapter } from '@saturn/storage';
import type { OfflineBackendFence } from './absent-backup-part-reconciliation.js';

export interface OriginalUploadRecoveryInput {
  rootId: string; operationId: string; backendIdentity: string; generation: string;
  nodeId: string; versionId: string; claimToken: string; sha256: string; sizeBytes: string;
}
interface Snapshot {
  id: string; root_id: string; journal_sha256: string; session_sha256: string; pending_sha256: string;
  expected_clock: Record<string, unknown>; backend_generation: string; backend_identity: string;
  stopped_receipt: Record<string, unknown>; device_token_hash: string; upload_claim_token: string;
  upload_execution: { nodeId: string; versionId: string; bindingVersion: string; targetPath: string; tempPath: string };
  upload_intent: { sha256: string; sizeBytes: string }; write_id: string; rename_id: string;
}

/** Explicit offline operator repair, never an age/lease based takeover. The
 * caller supplies a live supervisor fence and reviewed original identities.
 * Full physical readback is mandatory; SQL123 independently checks every
 * durable precondition before publishing. No physical write is replayed. */
export async function recoverOriginalCatalogUpload(database: Database,
  storage: Pick<StorageAdapter, 'openRead' | 'exists' | 'stat'>,
  fence: OfflineBackendFence, input: OriginalUploadRecoveryInput): Promise<Record<string, unknown>> {
  const first = await fence.assertFenced();
  if (!/^[a-f0-9]{64}$/.test(first.evidenceSha256)) throw Error('offline_fence_required');
  return database.withExclusiveMaintenance(async () => {
    const [row] = await database.withSql(sql => sql<Snapshot[]>`
      SELECT j.id,j.sync_root_id root_id,j.upload_execution,j.upload_intent,j.upload_claim_token,
        encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex') journal_sha256,
        encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex') session_sha256,
        (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb)::text,'UTF8')),'hex')
          FROM operation_journal x WHERE x.sync_root_id=j.sync_root_id AND x.sync_result IS NULL) pending_sha256,
        jsonb_build_object('epoch',cl.epoch,'binding',cl.binding_version,'seq',cl.published_seq::text,'state',cl.namespace_state) expected_clock,
        b.backend_identity,b.generation backend_generation,b.stopped_receipt,d.token_hash device_token_hash,
        j.upload_last_transfer->>'token' write_id,
        (SELECT t.id FROM sync_backend_tasks t WHERE t.backend_identity=b.backend_identity AND t.generation=b.generation
          AND t.command='rename' AND t.state='DONE' AND t.payload=jsonb_build_object('source',j.upload_execution->>'tempPath','destination',j.upload_execution->>'targetPath')) rename_id
      FROM operation_journal j JOIN upload_sessions u ON u.id=j.id JOIN sync_root_clock cl ON cl.root_id=j.sync_root_id
        JOIN catalog_guard_roots g ON g.root_id=j.sync_root_id JOIN sync_backend_executor b ON b.backend_identity=g.backend_identity
        JOIN devices d ON d.id=(j.upload_intent->>'deviceId')::uuid
      WHERE j.id=${input.operationId}::uuid AND j.sync_result IS NULL`);
    if (!row || row.root_id !== input.rootId || row.backend_identity !== input.backendIdentity || row.backend_generation !== input.generation
      || row.upload_execution.nodeId !== input.nodeId || row.upload_execution.versionId !== input.versionId
      || row.upload_claim_token !== input.claimToken || row.upload_intent.sha256 !== input.sha256
      || row.upload_intent.sizeBytes !== input.sizeBytes || !row.write_id || !row.rename_id
      || !/^[a-f0-9]{64}$/.test(input.sha256) || !/^[1-9][0-9]*$/.test(input.sizeBytes)
      || BigInt(input.sizeBytes) > 8388608n) throw Error('reviewed_original_changed');
    const before = await storage.stat(row.upload_execution.targetPath);
    if (before.type !== 'file' || String(before.size) !== input.sizeBytes || await storage.exists(row.upload_execution.tempPath))
      throw Error('physical_recovery_proof_invalid');
    const hash = createHash('sha256'); let bytes = 0n;
    for await (const value of await storage.openRead(row.upload_execution.targetPath)) {
      const chunk: unknown = value;
      if (!(chunk instanceof Uint8Array)) throw Error('physical_recovery_proof_invalid');
      bytes += BigInt(chunk.length); if (bytes > BigInt(input.sizeBytes)) throw Error('physical_recovery_proof_invalid'); hash.update(chunk);
    }
    const after = await storage.stat(row.upload_execution.targetPath);
    if (bytes.toString() !== input.sizeBytes || hash.digest('hex') !== input.sha256 || after.type !== 'file'
      || after.size !== before.size || after.modifiedAt.getTime() !== before.modifiedAt.getTime()
      || await storage.exists(row.upload_execution.tempPath)) throw Error('physical_recovery_proof_invalid');
    const second = await fence.assertFenced();
    if (second.evidenceSha256 !== first.evidenceSha256) throw Error('offline_fence_changed');
    const planId = randomUUID(), physicalProof = { targetPath: row.upload_execution.targetPath, sizeBytes: input.sizeBytes,
      sha256: input.sha256, tempAbsent: true, writeTaskId: row.write_id, renameTaskId: row.rename_id };
    // Persist the proof before applying. A refused plan remains as evidence;
    // the fixed SQL function rechecks CAS hashes and all security boundaries.
    await database.withSql(sql => sql`INSERT INTO catalog_upload_recovery_plans(id,root_id,operation_id,journal_sha256,session_sha256,pending_sha256,
      expected_clock,original_binding,backend_generation,stopped_receipt,device_token_hash,physical_proof,verified_at,fence_sha256)
      VALUES(${planId}::uuid,${input.rootId}::uuid,${input.operationId}::uuid,${row.journal_sha256},${row.session_sha256},${row.pending_sha256},
      ${JSON.stringify(row.expected_clock)}::text::jsonb,${row.upload_execution.bindingVersion}::uuid,${input.generation}::uuid,
      ${JSON.stringify(row.stopped_receipt)}::text::jsonb,${row.device_token_hash},${JSON.stringify(physicalProof)}::text::jsonb,clock_timestamp(),${first.evidenceSha256})`);
    const [result] = await database.transaction(async sql => {
      await sql`SET LOCAL lock_timeout='2s'`; await sql`SET LOCAL statement_timeout='30s'`;
      return sql<{ result: Record<string, unknown> }[]>`SELECT public.catalog_upload_recover_original_v1(${JSON.stringify({planId})}::text::jsonb) result`;
    });
    if (!result) throw Error('recovery_receipt_missing');
    return { ...result.result, physicalProof, fenceSha256: first.evidenceSha256 };
  });
}
