import { createHash, randomUUID } from "node:crypto";
import { Database } from "@saturn/database";
import { PostgresDeviceRepository } from "@saturn/sync";
import { expect, it } from "vitest";

const databaseUrl = process.env.DEVICE_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)("persists a Windows folder assignment through enrollment, presence, expiry changes and token replacement", async () => {
  if (!databaseUrl) throw new Error("DEVICE_TEST_DATABASE_URL is required after migrations");
  const db = new Database(databaseUrl), repository = new PostgresDeviceRepository(db);
  const root = randomUUID(), deviceId = randomUUID(), now = new Date();
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const oldHash = hash(deviceId), replacementHash = hash("replacement-" + deviceId), codeHash = hash("code-" + deviceId);
  try {
    await db.withSql(sql => sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
      VALUES(${root},'folder','00000000-0000-7000-8000-000000000004',${"qa-" + root},${"drive/sync/qa-" + root},'active')`);
    const created = await repository.create({ id: deviceId, name: "Office PC", deviceKind: "windows_sync", syncRootId: root,
      scopeIds: [root], rights: { read: true, write: true, move: true, delete: true }, tokenHash: oldHash, createdAt: now });
    expect(created.syncRootId).toBe(root);
    await repository.createEnrollment({ id: randomUUID(), deviceId, codeHash, expiresAt: new Date(now.getTime() + 60000), createdAt: now });
    const redeemed = await repository.redeemEnrollment(codeHash, replacementHash, now);
    expect(redeemed).toMatchObject({ syncRootId: root, scopeIds: [root], tokenHash: replacementHash });
    expect(await repository.authenticate(oldHash, now)).toBeUndefined();
    expect(await repository.authenticate(replacementHash, now)).toMatchObject({ syncRootId: root });
    expect(await repository.redeemEnrollment(codeHash, oldHash, now)).toBeUndefined();
    expect(await repository.recordPresence(deviceId, "windows", "test", now)).toMatchObject({ syncRootId: root, clientVersion: "test" });
    expect(await repository.update(deviceId, { expiresAt: null }, now)).toMatchObject({ syncRootId: root, tokenHash: replacementHash });
    expect(await repository.getById(deviceId)).toMatchObject({ syncRootId: root, scopeIds: [root] });
  } finally {
    await db.withSql(async sql => { await sql`DELETE FROM devices WHERE id=${deviceId}`; await sql`DELETE FROM resources WHERE id=${root}`; });
    await db.close();
  }
});
