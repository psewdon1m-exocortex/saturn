import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import { expect, it } from "vitest";
import Fastify from "fastify";
import { activeFixture, evidence } from "./stage3-chat-a.fixture.js";
import { guardedSyncHttp } from "./guarded-sync-http.js";
import { PostgresSyncSnapshotStage } from "../../../packages/sync/src/sync-snapshot-stage.js";
import { PostgresSyncSnapshotReader } from "../../../packages/sync/src/sync-snapshot-read.js";

it("exhausted cursor session requests rebootstrap, preserving replay and global capacity backpressure", async () => {
  const f = await activeFixture("cursor-capacity", "pluto"), app = Fastify();
  const scope = { wire: f.wireBinding, guard: { rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, guardRevision: f.binding.guardRevision } };
  const stage = new PostgresSyncSnapshotStage(f.runtime, f.issuer, scope);
  const reader = new PostgresSyncSnapshotReader(f.runtime, f.issuer, scope, "capacity", [{ id: "capacity", secret: Buffer.alloc(32, 81) }]);
  const fresh = async () => {
    let p = await stage.start(f.proof);
    for (let n = 0; p.state !== "READY" && n < 10; n++) p = await stage.step(p.snapshotId, f.proof);
    expect(p.state).toBe("READY");
    return reader.ready(p.snapshotId, f.proof);
  };
  // Registry pressure only. Each fixture row exists and is charged; these
  // non-presented filler handles are never used as signed cursor evidence.
  const fill = async (id: string, target: number) => f.admin.transaction(async sql => {
    const current = requireDefined((await sql<{ count: number }[]>`SELECT cursor_count AS count FROM sync_snapshot_stage WHERE id=${id} FOR UPDATE`)[0]).count;
    await sql<Record<string, unknown>[]>`INSERT INTO sync_snapshot_cursor(token_hash,snapshot_id,kind,position)
      SELECT md5(${id}||':'||n::text)||md5(n::text||':'||${id}),${id},'feed','{"kind":"feed","afterSeq":"0"}'::jsonb
      FROM generate_series(${String(current)}::int,${String(target - 1)}::int) n`;
    await sql<Record<string, unknown>[]>`UPDATE sync_snapshot_stage SET cursor_count=${String(target)} WHERE id=${id}`;
  });
  const changes = (cursor: string) => app.inject({ method: "POST", url: `/sync/v1/roots/${f.rootId}/changes`, headers: { authorization: f.authorization }, payload: { binding: f.wireBinding, cursor } });
  try {
    await app.register(guardedSyncHttp, { root: async id => id === f.rootId ? { binding: f.wireBinding, authority: f.issuer, stage, reader, ensureFolder: async () => { throw Error("not in this test"); } } : undefined });
    const original = await fresh();
    await fill(original.snapshot_id, 4095);
    const finalPage = await changes(original.changes_cursor);
    expect(finalPage.statusCode).toBe(200);
    const tail = finalPage.json<{next_cursor:string}>().next_cursor;
    const exhausted = await changes(tail);
    expect(exhausted.statusCode).toBe(410);
    expect(exhausted.json()).toEqual({ code: "cursor_expired" });
    expect((await changes(original.changes_cursor)).body).toBe(finalPage.body);
    const freshSession = await fresh();
    expect(freshSession.snapshot_id).not.toBe(original.snapshot_id);
    expect((await changes(freshSession.changes_cursor)).statusCode).toBe(200);
    const all = [original.snapshot_id, freshSession.snapshot_id];
    for (let n = 0; n < 6; n++) all.push((await fresh()).snapshot_id);
    // Keep the target stage below its own cap while exactly filling the
    // separate global quota. A ninth stage holds the remaining three rows.
    const ninth = await fresh();
    for (const id of all) await fill(id, id === freshSession.snapshot_id ? 4093 : 4096);
    await fill(ninth.snapshot_id, 3);
    const next = (await changes(freshSession.changes_cursor)).json<{next_cursor:string}>().next_cursor; // exact sealed replay
    const global = await changes(next);
    expect(global.statusCode).toBe(429);
    expect(global.json()).toEqual({ code: "capacity", retry_after_ms: 1000 });
    expect(global.headers["retry-after"]).toBe("1");
    const totals = await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT sum(cursor_count)::int AS charged,(SELECT count(*)::int FROM sync_snapshot_cursor) AS actual FROM sync_snapshot_stage`);
    expect(totals[0]).toEqual({ charged: 32768, actual: 32768 });
    expect((await changes(original.changes_cursor)).body).toBe(finalPage.body);
    await evidence("cursor-capacity", "result", { status: "PASS", exhaustedStatus: exhausted.statusCode, globalStatus: global.statusCode, exactReplay: true, freshSession: true, totals });
  } finally { await app.close(); await f.close(); }
}, 120000);
