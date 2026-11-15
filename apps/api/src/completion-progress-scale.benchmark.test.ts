import { fixtureValue } from './test-values.fixture.js';
import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { databaseFixture, evidence, uid } from './stage3-chat-a.fixture.js';
import { registerCompletionProgress } from './completion-progress.fixture.js';

// Explicit metadata-only fixture: no client, storage effects, or upload throughput claim.
it.skipIf(process.env.COMPLETION_PROGRESS_BENCHMARK !== '1')('compares aggregate observation with the full metadata query on a retained-size catalog', async () => {
  const count = 127604, folderCount = 5503;
  const f = await databaseFixture('completion-progress-scale', 78), rootId = uid(), vault = uid(), seed = uid();
  const app = Fastify();
  try {
    await f.db.transaction(async sql => {
      await sql`INSERT INTO resources(id,parent_id,type,name,storage_path,status) VALUES(${rootId},null,'folder','owner',${seed},'active'),(${vault},${rootId},'folder','vault',${seed+'/vault'},'active')`;
      await sql`INSERT INTO resources(id,parent_id,type,name,storage_path,status)
        SELECT md5(${seed}||'/dir/'||n)::uuid,${vault},'folder','dir-'||n,${seed}||'/vault/dir-'||n,'active' FROM generate_series(0,${folderCount-2}) n`;
      await sql`INSERT INTO resources(id,parent_id,type,name,storage_path,status,size_bytes,sha256)
        SELECT md5(${seed}||'/file/'||n)::uuid,md5(${seed}||'/dir/'||(n%${folderCount-1}))::uuid,'file','file-'||n||'.bin',
          ${seed}||'/vault/dir-'||(n%${folderCount-1})||'/file-'||n||'.bin','active',49152,repeat('a',64) FROM generate_series(1,${count}) n`;
      await sql`INSERT INTO file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason)
        SELECT md5(${seed}||'/version/'||n)::uuid,md5(${seed}||'/file/'||n)::uuid,${seed}||'/history/'||n,repeat('a',64),49152,'application/octet-stream','initial' FROM generate_series(1,${count}) n`;
      await sql`UPDATE resources SET current_version_id=md5(${seed}||'/version/'||n)::uuid FROM generate_series(1,${count}) n WHERE resources.id=md5(${seed}||'/file/'||n)::uuid`;
      await sql`ANALYZE resources`;
      await sql`ANALYZE file_versions`;
    });
    registerCompletionProgress(app, [{ admin: f.db, rootId }]);
    // Same full tree, per-row version count, order and JSON projection as the
    // existing completion receiver's metadataOnly path, with folder lookup.
    app.post('/full-metadata', async () => {
      const found = await f.db.withSql(sql => sql<{ id:string }[]>`SELECT id FROM resources WHERE parent_id=${rootId} AND name='vault' AND type='folder' AND status='active'`);
      if (found.length !== 1) throw Error('fixture folder missing');
      const rows = await f.db.withSql(sql => sql<{id:string;type:string;name:string;storage_path:string;sha256:string;size_bytes:string;current_version_id:string;relative_path:string;version_count:number}[]>`
        WITH RECURSIVE tree AS (
          SELECT id,type,name,storage_path,sha256,size_bytes,current_version_id,''::text AS relative_path FROM resources WHERE id=${fixtureValue(found[0]).id} AND status='active'
          UNION ALL SELECT r.id,r.type,r.name,r.storage_path,r.sha256,r.size_bytes,r.current_version_id,CASE WHEN t.relative_path='' THEN r.name ELSE t.relative_path||'/'||r.name END
          FROM resources r JOIN tree t ON r.parent_id=t.id WHERE r.status='active'
        ) SELECT t.*,(SELECT count(*)::int FROM file_versions v WHERE v.resource_id=t.id) AS version_count FROM tree t ORDER BY relative_path`);
      return { files: rows.filter(r=>r.type==='file').map(r=>({path:r.relative_path,id:r.id,version:r.current_version_id,catalogSha256:r.sha256,catalogSize:r.size_bytes,versionCount:r.version_count})), folders:rows.filter(r=>r.type==='folder').map(r=>r.relative_path) };
    });
    const origin = await app.listen({ host:'127.0.0.1', port:0 });
    const samples: {mode:string;headersMs:number;totalMs:number;bytes:number;files:number}[] = [];
    for (let round=0;round<3;round++) for (const mode of round%2===0?['aggregate','full']:['full','aggregate']) {
      const started=performance.now();
      const response=await fetch(origin+(mode==='aggregate'?'/__completion/progress':'/full-metadata'),{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'windows',folder:'vault'}),signal:AbortSignal.timeout(30000) });
      const headersMs=performance.now()-started, body=await response.text(), totalMs=performance.now()-started;
      expect(response.status).toBe(200);
      const result=JSON.parse(body) as {files:string|unknown[];folders:string|unknown[];bytes?:string};
      const files=mode==='aggregate'?Number(result.files):(result.files as unknown[]).length;
      expect(files).toBe(count);
      expect(mode==='aggregate'?Number(result.folders):(result.folders as unknown[]).length).toBe(folderCount);
      if(mode==='aggregate'){expect(result.bytes).toBe(String(count*49152));expect(Buffer.byteLength(body)).toBeLessThan(512);}
      samples.push({mode,headersMs,totalMs,bytes:Buffer.byteLength(body),files});
    }
    await evidence('completion-progress-scale','result',{at:new Date().toISOString(),count,folderCount,samples,
      scope:'owned metadata-only PostgreSQL catalog; reproduced full-metadata query; no physical readback/client/upload throughput',notAcceptance:true});
  } finally { await app.close(); await f.close(); }
}, 240000);
