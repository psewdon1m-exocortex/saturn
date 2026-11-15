import { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@saturn/database';

export interface ManagedBackendIdentity { backendIdentity: string; generation: string; ownerId: string; fencingToken: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const tickets = new WeakSet<ManagedBackendProcess>();

/** A live parent owns the ChildProcess and its private IPC channel. PID lookup,
 * heartbeat expiry, a caller-supplied JSON receipt or a previous parent's file
 * cannot substitute for this witness. A parent crash needs reviewed fencing.
 */
export class ManagedBackendProcess {
  readonly recoveryId = randomUUID();
  readonly launchedAt = new Date().toISOString();
  readonly commandSha256: string;
  #identity?: ManagedBackendIdentity;
  #closed = false;
  #invalid = false;
  constructor(readonly child: ChildProcess, nonce: string,
    expected: { backendIdentity: string; generation: string }) {
    if (!(child instanceof ChildProcess) || !child.pid || !child.connected || child.exitCode !== null
      || child.signalCode !== null || !/^[a-f0-9]{64}$/.test(nonce) || !uuid.test(expected.generation))
      throw new Error('managed_child_required');
    this.commandSha256 = digest([child.spawnfile, ...child.spawnargs]);
    tickets.add(this);
    child.on('message', value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const m = value as Record<string, unknown>;
      if (m.schema !== 'saturn.backend-owner-process.v1' || m.nonce !== nonce) return;
      const i = m.identity as ManagedBackendIdentity | undefined;
      if (m.pid !== child.pid || m.state !== 'ACTIVE' || !i || Object.keys(i).sort().join(',') !== 'backendIdentity,fencingToken,generation,ownerId'
        || i.backendIdentity !== expected.backendIdentity || i.generation !== expected.generation
        || !uuid.test(i.ownerId) || !uuid.test(i.fencingToken)) { this.#invalid = true; return; }
      if (this.#identity && digest(i) !== digest(this.#identity)) this.#invalid = true;
      else this.#identity = Object.freeze({ ...i });
    });
    child.once('close', () => { this.#closed = true; });
  }
  get registered(): boolean { return !!this.#identity && !this.#invalid; }
  get closed(): boolean { return this.#closed; }
  identity(): ManagedBackendIdentity {
    if (!tickets.has(this) || !this.#identity || this.#invalid) throw new Error('owner_registration_required');
    return { ...this.#identity };
  }
  proof() {
    const identity = this.identity();
    const pid = this.child.pid;
    if (!this.#closed || pid === undefined || this.child.exitCode === null && this.child.signalCode === null) throw new Error('owner_exit_unproved');
    return { schema: 'saturn.backend-owner-process-exit.v1', recoveryId: this.recoveryId,
      identity, pid, launchedAt: this.launchedAt, commandSha256: this.commandSha256,
      exitCode: this.child.exitCode, signal: this.child.signalCode };
  }
}

/** Offline operator boundary: only a witnessed dead writer with NO uncertain or
 * running physical effect can release custody. Queued tasks are never rewritten,
 * rejected or replayed here. A new owner claims them through the ordinary queue.
 * All API/readers must be drained first. No lease/age based takeover exists.
 */
export async function recoverExitedBackendOwner(database: Database, process: ManagedBackendProcess) {
  if (!tickets.has(process)) throw new Error('managed_child_required');
  const proof = process.proof(), i = proof.identity, proofSha256 = digest(proof);
  return database.withExclusiveMaintenance(() => database.transaction(async sql => {
    await sql`SET LOCAL lock_timeout='2s'`;
    await sql`SET LOCAL statement_timeout='10s'`;
    const [operator] = await sql<{ valid: boolean }[]>`SELECT current_user=session_user AND current_user=pg_get_userbyid(c.relowner) AS valid
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='saturn_owner_recovery' AND c.relname='history'`;
    if (!operator?.valid) throw new Error('recovery_operator_required');
    const [b] = await sql<Record<string, unknown>[]>`SELECT * FROM public.sync_backend_executor WHERE backend_identity=${i.backendIdentity} FOR UPDATE`;
    const [prior] = await sql<{ proof_sha256: string; result: unknown }[]>`SELECT proof_sha256,result FROM saturn_owner_recovery.history WHERE id=${proof.recoveryId}::uuid`;
    if (prior) { if (prior.proof_sha256 !== proofSha256) throw new Error('recovery_proof_changed'); return prior.result; }
    if (!b || b.generation !== i.generation || b.state !== 'RUNNING' || b.owner_id !== i.ownerId || b.fencing_token !== i.fencingToken)
      throw new Error('recovery_owner_changed');
    // Root locks match the catalog -> backend ordering through the exclusive
    // maintenance barrier; a caller that has not drained peers is refused below.
    const roots = await sql<{ root_id: string; valid: boolean }[]>`SELECT g.root_id,c.namespace_state='ACTIVE' AND public.catalog_guard_active_valid(g) AS valid
      FROM public.catalog_guard_roots g JOIN public.sync_root_clock c USING(root_id) WHERE g.backend_identity=${i.backendIdentity} ORDER BY g.root_id`;
    if (!roots.length || roots.some(r => !r.valid)) throw new Error('recovery_roots_unqualified');
    const tasks = await sql<Record<string, unknown>[]>`SELECT * FROM public.sync_backend_tasks WHERE backend_identity=${i.backendIdentity}
      AND state IN ('QUEUED','RUNNING','UNKNOWN') ORDER BY id FOR UPDATE`;
    if (tasks.some(t => t.state !== 'QUEUED' || t.generation !== i.generation || t.owner_id !== null || t.fencing_token !== null))
      throw new Error('recovery_effect_unresolved');
    if ((await sql`SELECT id FROM public.sync_backend_read_slots WHERE backend_identity=${i.backendIdentity} LIMIT 1`).length)
      throw new Error('recovery_readers_not_drained');
    process.proof();
    const receipt = { schema: 'saturn.backend-no-effect-owner-release.v1', proofSha256, owner: i,
      queuedTaskIds: tasks.map(t => t.id), queuedTasksSha256: digest(tasks), reason: 'managed_process_exited_no_running_or_unknown_effects' };
    const rows = await sql`UPDATE public.sync_backend_executor SET state='STOPPED',owner_id=NULL,fencing_token=NULL,
      liveness_owner_id=NULL,liveness_fencing_token=NULL,liveness_at=NULL,stopped_receipt=${JSON.stringify(receipt)}::text::jsonb,updated_at=now()
      WHERE backend_identity=${i.backendIdentity} AND generation=${i.generation}::uuid AND owner_id=${i.ownerId}::uuid AND fencing_token=${i.fencingToken}::uuid RETURNING backend_identity`;
    if (rows.length !== 1) throw new Error('recovery_owner_changed');
    const result = { status: 'RELEASED_NO_EFFECT_OWNER', recoveryId: proof.recoveryId, queuedTaskIds: receipt.queuedTaskIds, generation: i.generation };
    await sql`INSERT INTO saturn_owner_recovery.history(id,proof_sha256,proof,receipt,result) VALUES(${proof.recoveryId}::uuid,${proofSha256},
      ${JSON.stringify(proof)}::text::jsonb,${JSON.stringify(receipt)}::text::jsonb,${JSON.stringify(result)}::text::jsonb)`;
    return result;
  }));
}
