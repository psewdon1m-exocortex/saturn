import { requireTestValue } from "../../contracts/src/test-support.js";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "@saturn/database";
import { PostgresDropRepository } from "./postgres-drop.repository.js";

const url = process.env.SATURN_DROP_TEST_DATABASE_URL;
const tokenHash = () => randomBytes(32).toString("hex");
describe.skipIf(url === undefined)("PostgreSQL Drop admission replay and quota", () => {
  let database: Database, repository: PostgresDropRepository;
  const databases: Database[] = [];
  let channelId: string, sessionId: string;
  let existingBufferBytes: number;
  const now = new Date();
  beforeAll(() => {
    const target = new URL(requireTestValue(url));
    if (!["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname === "/u03" || target.pathname.startsWith("/saturn_test_"))) throw new Error("Explicit isolated local test database required");
    database = new Database(requireTestValue(url), { max: 2 }); databases.push(database); repository = new PostgresDropRepository(database);
  });
  beforeEach(async () => {
    channelId = randomUUID(); sessionId = randomUUID();
    existingBufferBytes = await database.withSql(async sql => Number(requireTestValue((await sql<{ bytes: string }[]>`SELECT COALESCE(sum(expected_size),0)::text AS bytes FROM drop_uploads WHERE local_path IS NOT NULL OR state='reserved'`)[0]).bytes));
    await database.transaction(async sql => {
      await sql`INSERT INTO drop_channels(id,state,created_at,activated_at,expires_at,max_files,max_bytes) VALUES(${channelId},'active',${now},${now},${new Date(now.getTime() + 60_000)},10,1000)`;
      await sql`INSERT INTO drop_sessions(id,channel_id,token_hash,csrf_hash,user_agent_hash,state,created_at,last_seen_at,expires_at,max_files,max_bytes,reserved_files,reserved_bytes)
        VALUES(${sessionId},${channelId},${tokenHash()},${tokenHash()},${tokenHash()},'active',${now},${now},${new Date(now.getTime() + 60_000)},10,1000,0,0)`;
    });
  });
  afterEach(async () => {
    await database.transaction(async sql => {
      await sql`DELETE FROM drop_uploads WHERE channel_id=${channelId}`;
      await sql`DELETE FROM drop_sessions WHERE channel_id=${channelId}`;
      await sql`DELETE FROM drop_challenges WHERE channel_id=${channelId}`;
      await sql`DELETE FROM drop_channels WHERE id=${channelId}`;
    });
  });
  afterAll(async () => { await Promise.all(databases.map(connection => connection.close())); });
  const input = () => ({ id: randomUUID(), sessionId, channelId, clientKeyHash: tokenHash(), filename: "content.bin", expectedSize: 60, expectedSha256: "a".repeat(64), now, globalMaxBytes: existingBufferBytes + 92 });
  it("replays the same intent at full global capacity without a second reservation", async () => {
    const request = input(), first = await repository.reserveUpload(request);
    const replay = await repository.reserveUpload({ ...request, id: randomUUID(), globalMaxBytes: 60, refuseNewReservation: true });
    expect(replay.created).toBe(false); expect(replay.value.id).toBe(first.value.id);
    await expect(repository.reserveUpload({ ...request, id: randomUUID(), clientKeyHash: tokenHash(), refuseNewReservation: true })).rejects.toThrow(/quota/);
    const counts = await database.withSql(async sql => (await sql<{ reserved_files: number; reserved_bytes: string }[]>`SELECT reserved_files,reserved_bytes FROM drop_channels WHERE id=${channelId}`)[0]);
    expect(counts?.reserved_files).toBe(1); expect(Number(counts?.reserved_bytes)).toBe(60);
  });
  it("rejects changed immutable parameters before returning an existing receipt", async () => {
    const request = input(); await repository.reserveUpload(request);
    for (const change of [{ filename: "other.bin" }, { expectedSize: 61 }, { expectedSha256: "b".repeat(64) }]) {
      await expect(repository.reserveUpload({ ...request, ...change, id: randomUUID(), refuseNewReservation: true })).rejects.toThrow(/different upload parameters/);
    }
  });
  it("concurrent retries share one identity and two new keys cannot oversubscribe capacity", async () => {
    const request = input();
    const replayed = await Promise.all([repository.reserveUpload(request), repository.reserveUpload({ ...request, id: randomUUID() })]);
    expect(new Set(replayed.map(result => result.value.id)).size).toBe(1);
    expect(replayed.filter(result => result.created)).toHaveLength(1);
    await expect(repository.reserveUpload({ ...request, id: randomUUID(), clientKeyHash: tokenHash() })).rejects.toThrow(/quota/);
  });
  it("revalidates revoked session authority before replay under pressure", async () => {
    const request = input(); await repository.reserveUpload(request);
    await database.withSql(async sql => { await sql`UPDATE drop_sessions SET state='revoked' WHERE id=${sessionId}`; });
    await expect(repository.reserveUpload({ ...request, id: randomUUID(), refuseNewReservation: true })).rejects.toThrow(/not active/);
  });
  it("reauthenticates with the original active code and replays the old channel original without resetting quota", async () => {
    const request = input(), first = await repository.reserveUpload(request);
    const codeHash = tokenHash(), challengeId = randomUUID();
    await database.withSql(async sql => {
      await sql`INSERT INTO drop_challenges(id,channel_id,code_hash,state,created_at,expires_at) VALUES(${challengeId},${channelId},${codeHash},'active',${now},${new Date(now.getTime()+60_000)})`;
    });
    const reauthenticated = await repository.redeemDropChallenge({ codeHash, tokenHash: tokenHash(), csrfHash: tokenHash(), userAgentHash: tokenHash(), sessionId: randomUUID(), now,
      expiresAt: new Date(now.getTime()+60_000), maxFiles: 99, maxBytes: 99999 });
    expect(reauthenticated?.channelId).toBe(channelId);
    expect(reauthenticated?.id).not.toBe(sessionId);
    const replay = await repository.reserveUpload({ ...request, id: randomUUID(), sessionId: requireTestValue(reauthenticated).id, refuseNewReservation: true, globalMaxBytes: 0 });
    expect(replay.created).toBe(false); expect(replay.value.id).toBe(first.value.id);
    const row = await database.withSql(async sql => requireTestValue((await sql<{ reserved_files: number; reserved_bytes: string; max_files: number; max_bytes: string }[]>`SELECT reserved_files,reserved_bytes,max_files,max_bytes FROM drop_channels WHERE id=${channelId}`)[0]));
    expect(row.reserved_files).toBe(1); expect(Number(row.reserved_bytes)).toBe(60); expect(row.max_files).toBe(10); expect(Number(row.max_bytes)).toBe(1000);
  });
});
