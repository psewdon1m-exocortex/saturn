import { expect, it } from "vitest";
import { activeFixture, barrier } from "./stage3-chat-a.fixture.js";
import { PostgresSyncSnapshotStage } from "../../../packages/sync/src/sync-snapshot-stage.js";
import { PostgresSyncSnapshotReader } from "../../../packages/sync/src/sync-snapshot-read.js";

it("idle snapshot collection does not contend with publication, but expired collection retains admission", async () => {
  const f = await activeFixture("snapshot-idle-gc", "windows", 70);
  const scope = { wire: f.wireBinding, guard: { rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, guardRevision: f.binding.guardRevision } };
  const stage = new PostgresSyncSnapshotStage(f.runtime, f.issuer, scope);
  const reader = new PostgresSyncSnapshotReader(f.runtime, f.issuer, scope, "test", [{ id: "test", secret: Buffer.alloc(32, 73) }]);
  const held = barrier(), release = barrier(); let owner: Promise<void> | undefined;
  try {
    const original = await stage.start(f.proof);
    owner = f.admin.transaction(async sql => { await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn.sync.snapshot.admission.v1',0))`; held.release(); await release.entered; });
    await held.entered;
    expect(await reader.collectExpired()).toEqual({ snapshotId: null, tokensRemoved: 0 });
    expect(await stage.collectExpired()).toEqual({ snapshotId: null, entriesRemoved: 0, frontierRemoved: 0, headerRemoved: false });
    await f.admin.withSql(sql => sql`UPDATE sync_snapshot_stage SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${original.snapshotId}`);
    await expect(stage.collectExpired()).rejects.toMatchObject({ code: "admission_full" });
    release.release(); await owner;
    expect(await stage.collectExpired()).toMatchObject({ snapshotId: original.snapshotId, entriesRemoved: 1, headerRemoved: true });
    expect(await f.admin.withSql(sql => sql`SELECT id FROM resources WHERE id=${f.rootId}`)).toHaveLength(1);
  } finally { release.release(); await owner; await f.close(); }
}, 60000);
