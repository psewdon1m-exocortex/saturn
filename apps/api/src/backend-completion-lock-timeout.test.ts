import { afterEach, expect, it, vi } from 'vitest';
import { DurableBackendExecutor, type BackendCommand } from '../../../packages/storage/src/durable-backend-executor.js';
import type { StorageAdapter } from '../../../packages/storage/src/types.js';
vi.mock('node:timers/promises', () => ({ setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) }));
afterEach(() => vi.useRealTimers());
function fixture(failures = 1, code = '55P03', committed = false) {
  const tasks = new Map<string, { id: string; state: string }>(), queue: unknown[] = [];
  const mkdir = vi.fn(async () => {}), raw = { mkdir, close: vi.fn(async () => {}) } as unknown as StorageAdapter;
  const send = vi.fn<BackendCommand>(async (command, _identity, payload) => {
    if (command === 'acquire') return { owned: true };
    if (command === 'claim') { const row = queue.shift() as { id: string } | undefined; if (row) tasks.set(row.id, { id: row.id, state: 'RUNNING' }); return row ?? null; }
    if (command === 'submit') { const id = String(payload.id); tasks.set(id, { id, state: 'QUEUED' }); queue.push({ id, command: payload.command, body: payload.body, reservedBytes: payload.reservedBytes }); return tasks.get(id); }
    if (command === 'status') return tasks.get(String(payload.id));
    if (command === 'complete') {
      const id = String(payload.id); if (committed) tasks.set(id, { id, state: 'DONE' });
      if (failures-- > 0) throw Object.assign(new Error('completion receipt not acknowledged'), { code });
      tasks.set(id, { id, state: 'DONE' }); return tasks.get(id);
    }
    if (command === 'unknown') { const id = String(payload.id); tasks.set(id, { id, state: 'UNKNOWN' }); return {}; }
    if (['drain', 'read-close', 'stopped'].includes(command)) return {};
    throw Error('Unexpected ' + command);
  });
  return { mkdir, tasks, send, executor: new DurableBackendExecutor(raw, send, 'backend', 'generation') };
}
async function close(f: ReturnType<typeof fixture>) { const p = f.executor.close().catch((e: unknown) => e); await vi.advanceTimersByTimeAsync(1); return p; }
it('persists the same completed physical effect after a rolled-back receipt lock timeout', async () => {
  vi.useFakeTimers(); const f = fixture(); await f.executor.start(); const result = f.executor.mkdir('original').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(251); expect(await result).toBeUndefined(); expect(f.mkdir).toHaveBeenCalledExactlyOnceWith('original');
  expect([...f.tasks.values()].map(v => v.state)).toEqual(['DONE']); expect(f.send.mock.calls.filter(([c]) => c === 'submit')).toHaveLength(1);
  expect(f.send.mock.calls.filter(([c]) => c === 'acquire')).toHaveLength(1); expect(await close(f)).toBeUndefined();
});
it('backs off repeated definite receipt rollbacks without replaying physical I/O', async () => {
  vi.useFakeTimers(); const f = fixture(3); await f.executor.start(); const result = f.executor.mkdir('original').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(501); expect(f.mkdir).toHaveBeenCalledTimes(1); expect(f.send.mock.calls.filter(([c]) => c === 'complete')).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(250); expect(await result).toBeUndefined(); expect([...f.tasks.values()].map(v => v.state)).toEqual(['DONE']); await close(f);
});
it('keeps an unresolved receipt UNKNOWN after the bounded retry deadline', async () => {
  vi.useFakeTimers(); const f = fixture(10000); await f.executor.start(); const result = f.executor.mkdir('original').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(60001); expect(await result).toMatchObject({ code: 'reconciliation_required' }); expect(f.mkdir).toHaveBeenCalledTimes(1);
  expect([...f.tasks.values()].map(v => v.state)).toEqual(['UNKNOWN']); expect(f.send.mock.calls.filter(([c]) => c === 'complete').length).toBeLessThanOrEqual(241); await close(f);
});
it.each(['42501', '55000', '57014', '40P01'])('does not retry unrelated completion SQLSTATE %s', async code => {
  vi.useFakeTimers(); const f = fixture(1, code); await f.executor.start(); const result = f.executor.mkdir('original').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(1); expect(await result).toMatchObject({ code: 'reconciliation_required' }); expect(f.send.mock.calls.filter(([c]) => c === 'complete')).toHaveLength(1); await close(f);
});
it('observes an already committed same-task receipt after disconnect without replay', async () => {
  vi.useFakeTimers(); const f = fixture(1, 'ECONNRESET', true); await f.executor.start(); const result = f.executor.mkdir('original').catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(1); expect(await result).toBeUndefined(); expect(f.mkdir).toHaveBeenCalledTimes(1); expect(f.send.mock.calls.filter(([c]) => c === 'complete')).toHaveLength(1); await close(f);
});
