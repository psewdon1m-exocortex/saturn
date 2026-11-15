import { fixtureRecord, fixtureString, fixtureValue } from './test-values.fixture.js';
import Fastify from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { activeFixture, evidence } from "./stage3-chat-a.fixture.js";
import { guardedSyncHttp } from "./guarded-sync-http.js";
import { PostgresSyncSnapshotStage } from "../../../packages/sync/src/sync-snapshot-stage.js";
import { PostgresSyncSnapshotReader } from "../../../packages/sync/src/sync-snapshot-read.js";
import { SyncCursorCodec } from "../../../packages/sync/src/sync-cursor.js";

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE)("returns 410 for an expired signed cursor on a still-live PostgreSQL snapshot", async () => {
  const f = await activeFixture("cursor-expiry-http"), app = Fastify();
  try {
    const guard = { rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, guardRevision: f.binding.guardRevision };
    const scope = { wire: f.wireBinding, guard }, keys = [{ id: "expiry", secret: Buffer.alloc(32, 83) }];
    const stage = new PostgresSyncSnapshotStage(f.runtime, f.issuer, scope);
    const reader = new PostgresSyncSnapshotReader(f.runtime, f.issuer, scope, "expiry", keys);
    await app.register(guardedSyncHttp, { root: async id => id === f.rootId ? {
      binding: f.wireBinding, authority: f.issuer, stage, reader, ensureFolder: async () => { throw Error("No writes in this scenario"); }
    } : undefined });
    const prepare = async () => {
      let p = await stage.start(f.proof);
      for (let n = 0; p.state !== "READY" && n < 20; n++) p = await stage.step(p.snapshotId, f.proof);
      expect(p.state).toBe("READY");
      return reader.ready(p.snapshotId, f.proof);
    };
    const ready = await prepare(), now = Math.floor(Date.now() / 1000);
    const liveCodec = new SyncCursorCodec({ keys, currentKey: "expiry", nowSeconds: () => now, leaseSeconds: 300, absoluteSeconds: 3600 });
    const oldCodec = new SyncCursorCodec({ keys, currentKey: "expiry", nowSeconds: () => now - 301, leaseSeconds: 300, absoluteSeconds: 3600 });
    const oldToken = (token: string) => {
      const state = liveCodec.verify(token.slice(41), { serverIdentity: f.wireBinding.server_identity, rootId: f.rootId,
        serverEpoch: f.wireBinding.server_epoch, policyVersion: f.wireBinding.policy_version, bindingVersion: f.wireBinding.binding_version,
        authorityFingerprint: fixtureString(fixtureRecord(fixtureRecord(JSON.parse(Buffer.from(fixtureValue(token.slice(41).split(".")[2]), "base64url").toString())).binding).authorityFingerprint) });
      return "pg1." + randomUUID() + "." + oldCodec.issue(state.binding, state.position);
    };
    const entries = oldToken(ready.entries_cursor), changes = oldToken(ready.changes_cursor);
    const hash = (v: string) => createHash("sha256").update(v).digest("hex");
    // Fixture ages signed read tokens only; stage lease and all publication state stay real/live.
    await f.admin.transaction(async sql => {
      await sql`UPDATE sync_snapshot_cursor SET token_hash=${hash(entries)} WHERE token_hash=${hash(ready.entries_cursor)}`;
      await sql`UPDATE sync_snapshot_cursor SET token_hash=${hash(changes)} WHERE token_hash=${hash(ready.changes_cursor)}`;
      await sql`UPDATE sync_snapshot_stage SET entries_cursor=${entries},changes_cursor=${changes} WHERE id=${ready.snapshot_id}`;
    });
    const response = await app.inject({ method: "POST", url: `/sync/v1/roots/${f.rootId}/snapshots/ready`, headers: { authorization: f.authorization }, payload: { binding: f.wireBinding, snapshot_id: ready.snapshot_id } });
    expect(response.statusCode).toBe(410); expect(response.json()).toEqual({ code: "cursor_expired" });
    const live = (await f.admin.withSql(sql => sql<{live:boolean}[]>`SELECT lease_until>clock_timestamp() AND absolute_until>clock_timestamp() AS live FROM sync_snapshot_stage WHERE id=${ready.snapshot_id}`))[0]?.live;
    expect(live).toBe(true);
    const next = await prepare(); expect(next.snapshot_id).not.toBe(ready.snapshot_id);
    await evidence("cursor-expiry-http", "result", { status: "PASS", expiredHttpStatus: response.statusCode, originalStageStillLive: live, newQualifiedRead: true, originalSnapshotId: ready.snapshot_id, replacementSnapshotId: next.snapshot_id });
  } finally { await app.close(); await f.close(); }
}, 120000);
