import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { backendFixture, barrier } from './stage3-chat-a.fixture.js';
import { DurableBackendExecutor, type BackendCommand } from '../../../packages/storage/src/durable-backend-executor.js';

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE)('recovers a real rolled-back PostgreSQL claim lock timeout with the same task and owner', async () => {
  const f = await backendFixture('backend-real-lock-recovery', 123);
  const claims = barrier(), locked = barrier(), release = barrier(), timedOut = barrier();
  let timeouts = 0;
  const command: BackendCommand = async (name, identity, payload) => {
    if (name !== 'claim') return f.command(name, identity, payload);
    await claims.entered;
    try {
      return await f.writer.transaction(async sql => {
        await sql`SET LOCAL lock_timeout='50ms'`; await sql`SET LOCAL statement_timeout='500ms'`;
        const [row] = await sql<{ result: unknown }[]>`SELECT sync_backend_command(${name},${JSON.stringify(identity)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) result`;
        return row?.result;
      });
    } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') { timeouts++; timedOut.release(); } throw error; }
  };
  const owner = new DurableBackendExecutor(f.raw, command, f.backendIdentity, f.generation);
  let holding: Promise<unknown> | undefined;
  try {
    await owner.start(); const mkdir = owner.mkdir('same-original-directory');
    let taskId: string | undefined;
    for (let n = 0; n < 100; n++) {
      const [row] = await f.admin.withSql(sql => sql<{ id: string }[]>`SELECT id FROM sync_backend_tasks WHERE backend_identity=${f.backendIdentity} AND state='QUEUED'`);
      if (row) { taskId = row.id; break; } await delay(10);
    }
    expect(taskId).toBeTruthy();
    holding = f.admin.transaction(async sql => { await sql`LOCK TABLE sync_backend_tasks IN ACCESS EXCLUSIVE MODE`; locked.release(); await release.entered; });
    await locked.entered; claims.release(); await timedOut.entered;
    expect(await f.raw.exists('same-original-directory')).toBe(false);
    release.release(); await holding; await mkdir;
    expect(timeouts).toBeGreaterThan(0); expect((await f.raw.stat('same-original-directory')).type).toBe('directory');
    const rows = await f.admin.withSql(sql => sql`SELECT id,state,owner_id,fencing_token FROM sync_backend_tasks WHERE backend_identity=${f.backendIdentity}`);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: taskId, state: 'DONE', owner_id: owner.identity.ownerId, fencing_token: owner.identity.fencingToken });
    await owner.assertReady(); expect(await owner.diagnostics()).toMatchObject({process:{claimFailureCode:null,heartbeatFailureCode:null}});
  } finally { claims.release(); release.release(); await holding; await owner.close(); await f.close(); }
}, 30000);
