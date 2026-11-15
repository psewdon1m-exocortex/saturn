import type { Database } from '@saturn/database';
import type { FastifyInstance } from 'fastify';

export interface CompletionProgressFixture { readonly admin: Database; readonly rootId: string }

// Test-only observation. Counts never attest to content, receipts or completion.
export async function completionProgress(fixture: CompletionProgressFixture, folder: string) {
  if (typeof folder !== 'string' || folder.length > 4096) throw Error('owned root-relative folder required');
  const segments = folder.split('/');
  if (!segments.length || segments.some(s => !s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0')))
    throw Error('owned root-relative folder required');
  const row = await fixture.admin.transaction(async sql => {
    await sql`SET LOCAL statement_timeout='5s'`;
    await sql`SET LOCAL lock_timeout='2s'`;
    // Resolve the path and aggregate in ONE statement snapshot. A concurrent move
    // cannot make a previously resolved folder escape the requested root.
    const rows = await sql<{ found: boolean; files: string; folders: string; bytes: string }[]>`
      WITH RECURSIVE target(id,depth) AS (
        SELECT id,0 FROM resources WHERE id=${fixture.rootId} AND type='folder' AND status='active'
        UNION ALL SELECT r.id,t.depth+1 FROM resources r JOIN target t ON r.parent_id=t.id
          WHERE r.type='folder' AND r.status='active' AND t.depth < ${segments.length}
            AND r.name=(${sql.array(segments)}::text[])[t.depth+1]
      ), tree(id,type,size_bytes) AS (
        SELECT r.id,r.type,r.size_bytes FROM resources r JOIN target t ON r.id=t.id WHERE t.depth=${segments.length}
        UNION ALL SELECT r.id,r.type,r.size_bytes FROM resources r JOIN tree t ON r.parent_id=t.id WHERE r.status='active'
      ) SELECT EXISTS(SELECT 1 FROM target WHERE depth=${segments.length}) AS found,
        (count(*) FILTER(WHERE type='file'))::text AS files,
        (count(*) FILTER(WHERE type='folder'))::text AS folders,
        coalesce(sum(size_bytes) FILTER(WHERE type='file'),0)::text AS bytes FROM tree`;
    if (!rows[0]) throw Error('progress aggregate missing');
    return rows[0];
  });
  return { schema: 'saturn.completion-progress.v1', rootId: fixture.rootId, folder, ...row };
}

export function registerCompletionProgress(app: FastifyInstance, fixtures: readonly CompletionProgressFixture[]) {
  app.post<{ Body: { kind: string; folder: string } }>('/__completion/progress', {
    schema: { body: { type: 'object', required: ['kind', 'folder'], additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['windows', 'pluto'] }, folder: { type: 'string', minLength: 1, maxLength: 4096 } } } },
  }, request => {
    const fixture = fixtures[request.body.kind === 'windows' ? 0 : 1];
    if (!fixture) throw Error('owned fixture required');
    return completionProgress(fixture, request.body.folder);
  });
}
