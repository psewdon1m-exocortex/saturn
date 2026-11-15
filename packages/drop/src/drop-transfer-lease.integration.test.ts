import { requireTestValue } from "../../contracts/src/test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database, migrate } from "@saturn/database";
import { PostgresDropRepository } from "./postgres-drop.repository.js";
import { DROP_TRANSFER_LEASE_MS } from "./transfer-lease.js";

const url = process.env.SATURN_DROP_TEST_DATABASE_URL;
const migrations = process.env.SATURN_DROP_TEST_MIGRATIONS_DIR ?? fileURLToPath(new URL("../../database/migrations/", import.meta.url));
const hash = () => randomBytes(32).toString("hex");
describe.skipIf(url === undefined)("PostgreSQL Drop lease recovery and migration", () => {
  let db: Database, otherDb: Database, repo: PostgresDropRepository, other: PostgresDropRepository;
  const databases: Database[] = [];
  let channel: string, session: string;
  beforeAll(async () => {
    const target = new URL(requireTestValue(url));
    if (!["localhost", "127.0.0.1"].includes(target.hostname) || !target.pathname.startsWith("/saturn_test_") || !migrations) throw new Error("Dedicated local database and migration directory required");
    await migrate(requireTestValue(url), migrations);
    db = new Database(requireTestValue(url), { max: 2 }); databases.push(db);
    otherDb = new Database(requireTestValue(url), { max: 2 }); databases.push(otherDb);
    repo = new PostgresDropRepository(db); other = new PostgresDropRepository(otherDb);
  });
  beforeEach(async () => {
    channel = randomUUID(); session = randomUUID();
    await db.withSql(async sql => {
      await sql`INSERT INTO drop_channels(id,state,created_at,activated_at,expires_at,max_files,max_bytes)
        VALUES(${channel},'active',now(),now(),now()+interval '1 day',100,1048576)`;
      await sql`INSERT INTO drop_sessions(id,channel_id,token_hash,csrf_hash,user_agent_hash,state,created_at,last_seen_at,expires_at,max_files,max_bytes,reserved_files,reserved_bytes)
        VALUES(${session},${channel},${hash()},${hash()},${hash()},'active',now(),now(),now()+interval '1 day',100,1048576,0,0)`;
    });
  });
  afterEach(async () => { await db.withSql(async sql => {
    await sql`DELETE FROM drop_uploads WHERE channel_id=${channel}`;
    await sql`DELETE FROM drop_sessions WHERE channel_id=${channel}`;
    await sql`DELETE FROM drop_channels WHERE id=${channel}`;
  }); });
  afterAll(async () => { await Promise.all(databases.map(database => database.close())); });
  async function seed(state = "buffered") {
    const id = randomUUID(), sha = hash();
    await db.withSql(async sql => { await sql`INSERT INTO drop_uploads(id,session_id,channel_id,client_key_hash,filename,expected_size,expected_sha256,state,local_path,received_size,actual_sha256,created_at,updated_at,continuation_until)
      VALUES(${id},${session},${channel},${hash()},${id + '.bin'},16,${sha},${state},${id + '.part'},16,${sha},now(),now(),now()+interval '1 day')`; });
    return id;
  }

  it("migrates interrupted legacy transfers without changing originals and roundtrips an idle rollback", async () => {
    const ids = await Promise.all([seed("transferring"), seed("verifying"), seed()]);
    const before = await db.withSql(sql => sql`SELECT id,filename,state,actual_sha256,local_path,transfer_attempts FROM drop_uploads WHERE channel_id=${channel} ORDER BY id`);
    const down = await fs.readFile(path.join(migrations, "0112_drop_transfer_lease.down.sql"), "utf8");
    const up = await fs.readFile(path.join(migrations, "0112_drop_transfer_lease.up.sql"), "utf8");
    await db.transaction(async sql => { await sql.unsafe(down); });
    const started = Date.now();
    await db.transaction(async sql => { await sql.unsafe(up); });
    const after = await db.withSql(sql => sql`SELECT id,filename,state,actual_sha256,local_path,transfer_attempts FROM drop_uploads WHERE channel_id=${channel} ORDER BY id`);
    expect([...after]).toEqual([...before]); expect(ids).toHaveLength(3);
    const legacy = await db.withSql(sql => sql<{ transfer_lease_until: Date | string; transfer_lease_token: string | null }[]>`SELECT transfer_lease_until,transfer_lease_token FROM drop_uploads WHERE channel_id=${channel} AND state IN ('transferring','verifying')`);
    for (const row of legacy) {
      expect(row.transfer_lease_token).toBeNull();
      expect(new Date(row.transfer_lease_until).getTime()).toBeGreaterThanOrEqual(started + DROP_TRANSFER_LEASE_MS - 1000);
      expect(new Date(row.transfer_lease_until).getTime()).toBeLessThan(Date.now() + DROP_TRANSFER_LEASE_MS + 1000);
    }
    expect(await migrate(requireTestValue(url), migrations)).toBe(0);
  });
  it("claims each upload only once under concurrent workers and reclaims an abandoned original at 60 seconds", async () => {
    const id = await seed(), now = new Date();
    const claims = await Promise.all([repo.claimBufferedUpload(now), other.claimBufferedUpload(now)]);
    const first = requireTestValue(claims.find(Boolean));
    expect(claims.filter(Boolean)).toHaveLength(1); expect(first.id).toBe(id); expect(first.transferLeaseToken).toBeTruthy();
    expect(await other.claimBufferedUpload(new Date(now.getTime() + 59_999))).toBeUndefined();
    const second = await other.claimBufferedUpload(new Date(now.getTime() + 60_001));
    expect(second?.id).toBe(id); expect(second?.transferLeaseToken).not.toBe(first.transferLeaseToken);
    expect(second?.actualSha256).toBe(first.actualSha256); expect(second?.localPath).toBe(first.localPath);
  });
  it("a heartbeat keeps a slow live transfer out of the reclaim queue", async () => {
    await seed(); const now = new Date(), first = requireTestValue((await repo.claimBufferedUpload(now)));
    expect(await repo.renewTransferLease(first.id, requireTestValue(first.transferLeaseToken), new Date(now.getTime() + 50_000))).toBe(true);
    expect(await other.claimBufferedUpload(new Date(now.getTime() + 61_000))).toBeUndefined();
    expect(await other.claimBufferedUpload(new Date(now.getTime() + 110_001))).toMatchObject({ id: first.id });
  });
  it("rejects every stale owner's state mutation and refuses to revive an expired lease", async () => {
    await seed(); const now = new Date(), first = requireTestValue((await repo.claimBufferedUpload(now))), expired = new Date(now.getTime() + 60_001);
    expect(await repo.renewTransferLease(first.id, requireTestValue(first.transferLeaseToken), expired)).toBe(false);
    const second = requireTestValue((await other.claimBufferedUpload(expired)));
    expect(await repo.renewTransferLease(first.id, requireTestValue(first.transferLeaseToken), expired)).toBe(false);
    await expect(repo.markUploadVerifying(first.id, randomUUID(), expired, first.transferLeaseToken)).rejects.toThrow();
    await expect(repo.markUploadFailed(first.id, "old_failure", expired, first.transferLeaseToken)).rejects.toThrow();
    await repo.retryUpload(first.id, "old_retry", expired, first.transferLeaseToken);
    const current = requireTestValue((await other.getDropUpload(channel, first.id)));
    expect(current.state).toBe("transferring"); expect(current.transferLeaseToken).toBe(second.transferLeaseToken); expect(current.failureCode).toBeUndefined();
    await db.withSql(async sql => { await sql`UPDATE drop_uploads SET state='verifying' WHERE id=${first.id}`; });
    await expect(repo.markUploadStored(first.id, randomUUID(), hash(), expired, first.transferLeaseToken)).rejects.toThrow();
    await expect(repo.markUploadFailed(first.id, "missing_token", expired)).rejects.toThrow();
  });
  it("preserves retry backoff and rejects rollback while a transfer owns a lease", async () => {
    await seed(); const now = new Date(), first = requireTestValue((await repo.claimBufferedUpload(now)));
    const down = await fs.readFile(path.join(migrations, "0112_drop_transfer_lease.down.sql"), "utf8");
    await expect(db.transaction(async sql => { await sql.unsafe(down); })).rejects.toThrow(/drained/);
    await repo.retryUpload(first.id, "transfer_append_failed", now, first.transferLeaseToken);
    expect(await other.claimBufferedUpload(new Date(now.getTime() + 9_999))).toBeUndefined();
    expect(await other.claimBufferedUpload(new Date(now.getTime() + 10_001))).toMatchObject({ id: first.id });
  });
});
