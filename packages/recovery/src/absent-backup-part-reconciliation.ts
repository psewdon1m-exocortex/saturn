import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@saturn/database';
import type { StorageAdapter } from '@saturn/storage';

/** Trusted offline operator boundary. The caller must recheck an authenticated
 * live supervisor's witnessed exits and exact OS identities on every call.
 * A parsed receipt, PID absence, elapsed lease or request body is not a fence.
 * This is manual repair, never automatic owner takeover. */
export interface OfflineBackendFence { assertFenced(): Promise<{ evidenceSha256: string }> }

/** Resolve only a failed cleanup of a zero-offset private backup part which is
 * conclusively absent. No physical operation is replayed and no success receipt
 * is invented. The original task becomes REJECTED with a retained repair record.
 * Any other UNKNOWN, live reader, changed owner/path or extant part refuses. */
export async function reconcileAbsentBackupPart(database: Database, storage: Pick<StorageAdapter, 'exists' | 'stat'>,
  fence: OfflineBackendFence, input: { backendIdentity: string; generation: string; taskId: string }) {
  const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const first = await fence.assertFenced();
  if (!/^[a-f0-9]{64}$/.test(first.evidenceSha256)) throw Error('offline_fence_required');
  return database.withExclusiveMaintenance(() => database.transaction(async sql => {
    await sql`SET LOCAL lock_timeout='2s'`;await sql`SET LOCAL statement_timeout='30s'`;
    const [operator] = await sql<{ valid: boolean }[]>`SELECT current_user=session_user AND current_user=pg_get_userbyid(c.relowner) AS valid
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='saturn_owner_recovery' AND c.relname='history'`;
    if (!operator?.valid) throw Error('recovery_operator_required');
    const [backend] = await sql<Record<string, unknown>[]>`SELECT * FROM public.sync_backend_executor WHERE backend_identity=${input.backendIdentity} FOR UPDATE`;
    if (!backend || backend.generation !== input.generation || backend.state !== 'DRAINING' || !backend.owner_id || !backend.fencing_token) throw Error('offline_owner_changed');
    const tasks = await sql<Record<string, unknown>[]>`SELECT * FROM public.sync_backend_tasks WHERE backend_identity=${input.backendIdentity} AND state IN ('QUEUED','RUNNING','UNKNOWN') ORDER BY id FOR UPDATE`;
    const task = tasks[0], payload = task?.payload as Record<string, unknown> | undefined;
    if (tasks.length !== 1 || task?.id !== input.taskId || task.state !== 'UNKNOWN' || task.command !== 'delete'
      || task.generation !== input.generation || task.owner_id !== backend.owner_id || task.fencing_token !== backend.fencing_token
      || !payload || Object.keys(payload).join(',') !== 'path' || typeof payload.path !== 'string') throw Error('recovery_effect_unresolved');
    const match = /^_system\/incoming\/backups\/([a-f0-9-]{36})\/([a-f0-9-]{36})\.part$/.exec(payload.path);
    if (!match?.[1] || !match[2]) throw Error('backup_part_owner_unknown');
    const [run] = await sql<Record<string, unknown>[]>`SELECT * FROM public.service_backup_runs WHERE id=${match[2]}::uuid AND service_id=${match[1]}::uuid FOR UPDATE`;
    if (!run || run.temp_path !== payload.path || Number(run.received_size) !== 0 || !['pending','uploading'].includes(String(run.state))) throw Error('backup_part_owner_changed');
    if ((await sql`SELECT id FROM public.sync_backend_read_slots WHERE backend_identity=${input.backendIdentity} LIMIT 1`).length) throw Error('recovery_readers_not_drained');
    // A fresh independent adapter probes the exact path and every existing
    // ancestor. Adapter transport/permission failures propagate; only a genuine
    // absence can produce this conclusive no-effect result.
    if (await storage.exists(payload.path)) throw Error('backup_part_present');
    const parts = payload.path.split('/');
    for (let n = 1; n < parts.length; n++) {
      const ancestor = parts.slice(0,n).join('/');if (!(await storage.exists(ancestor))) break;
      if ((await storage.stat(ancestor)).type !== 'directory') throw Error('backup_part_ancestor_invalid');
    }
    const second = await fence.assertFenced();if (second.evidenceSha256 !== first.evidenceSha256) throw Error('offline_fence_changed');
    const recoveryId = randomUUID(), proof = { schema:'saturn.absent-backup-part-proof.v1', input, backend, task, runId:run.id, serviceId:run.service_id, path:payload.path, physicalOutcome:'ABSENT', fence:first };
    const proofSha256 = digest(proof), receipt = { schema:'saturn.absent-backup-part-rejection.v1', recoveryId, originalTaskId:task.id, originalRunId:run.id, originalErrorCode:task.error_code, proofSha256, outcome:'REJECTED_NO_TARGET' };
    await sql`UPDATE public.sync_backend_tasks SET state='REJECTED',error_code='reconciled_absent_backup_part',updated_at=now() WHERE id=${input.taskId}::uuid`;
    const stopped = { schema:'saturn.offline-reconciled-owner-release.v1', recoveryId, proofSha256, previousOwnerId:backend.owner_id, originalGeneration:input.generation, connectionsClosed:true };
    await sql`UPDATE public.sync_backend_executor SET state='STOPPED',owner_id=NULL,fencing_token=NULL,liveness_owner_id=NULL,liveness_fencing_token=NULL,liveness_at=NULL,stopped_receipt=${JSON.stringify(stopped)}::text::jsonb,updated_at=now() WHERE backend_identity=${input.backendIdentity}`;
    const result = { status:'RECONCILED_ABSENT_BACKUP_PART', recoveryId, originalTaskId:task.id, originalRunId:run.id, proofSha256 };
    await sql`INSERT INTO saturn_owner_recovery.history(id,proof_sha256,proof,receipt,result) VALUES(${recoveryId}::uuid,${proofSha256},${JSON.stringify(proof)}::text::jsonb,${JSON.stringify(receipt)}::text::jsonb,${JSON.stringify(result)}::text::jsonb)`;
    return result;
  }));
}
