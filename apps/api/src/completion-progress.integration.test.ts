import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { databaseFixture, uid } from './stage3-chat-a.fixture.js';
import { completionProgress, registerCompletionProgress } from './completion-progress.fixture.js';

it('observes only committed active descendants in the requested owned root, with a bounded response', async () => {
  const f = await databaseFixture('completion-progress', 78), rootId = uid(), sibling = uid(), vault = uid(), nested = uid(), hidden = uid();
  const app = Fastify();
  try {
    await f.db.transaction(async sql => {
      for (const row of [
        { id: rootId, parent: null, name: 'owner', type: 'folder', status: 'active', size: '0' },
        { id: sibling, parent: null, name: 'other', type: 'folder', status: 'active', size: '0' },
        { id: vault, parent: rootId, name: 'vault', type: 'folder', status: 'active', size: '0' },
        { id: nested, parent: vault, name: 'nested', type: 'folder', status: 'active', size: '0' },
        { id: hidden, parent: vault, name: 'hidden', type: 'folder', status: 'trashed', size: '0' },
        { id: uid(), parent: vault, name: 'a', type: 'file', status: 'active', size: '9007199254740993' },
        { id: uid(), parent: nested, name: 'b', type: 'file', status: 'active', size: '7' },
        { id: uid(), parent: hidden, name: 'not-visible', type: 'file', status: 'active', size: '99' },
        { id: uid(), parent: vault, name: 'pending', type: 'file', status: 'pending', size: '99' },
        { id: uid(), parent: sibling, name: 'outside', type: 'file', status: 'active', size: '99' },
      ]) await sql`INSERT INTO resources(id,parent_id,name,type,status,storage_path,size_bytes) VALUES(${row.id},${row.parent},${row.name},${row.type},${row.status},${'oracle/'+row.id},${row.size})`;
    });
    const fixture = { admin: f.db, rootId };
    expect(await completionProgress(fixture, 'vault')).toEqual({ schema: 'saturn.completion-progress.v1', rootId,
      folder: 'vault', found: true, files: '2', folders: '2', bytes: '9007199254741000' });
    expect(await completionProgress(fixture, 'vault/nested')).toMatchObject({ found: true, files: '1', folders: '1', bytes: '7' });
    expect(await completionProgress(fixture, 'vault/absent')).toMatchObject({ found: false, files: '0', folders: '0', bytes: '0' });
    expect(await completionProgress({ admin: f.db, rootId: sibling }, 'vault')).toMatchObject({ found: false });
    registerCompletionProgress(app, [fixture]);
    const response = await app.inject({ method: 'POST', url: '/__completion/progress', payload: { kind: 'windows', folder: 'vault' } });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.byteLength).toBeLessThan(512);
    expect(response.json()).not.toHaveProperty('status');
    expect((await app.inject({ method: 'POST', url: '/__completion/progress', payload: { kind: 'unknown', folder: 'vault' } })).statusCode).toBe(400);
    for (const folder of ['../vault', '/vault', 'vault/', 'vault\\nested', '.', 'vault/../other'])
      await expect(completionProgress(fixture, folder)).rejects.toThrow('owned root-relative');
  } finally { await app.close(); await f.close(); }
}, 60000);
