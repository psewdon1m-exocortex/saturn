import { expect, it } from "vitest";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import { activeFixture, sha, uid } from "./stage3-chat-a.fixture.js";
import { PostgresFileRepository } from "../../../packages/file-core/src/postgres-file.repository.js";
import { FileService } from "../../../packages/file-core/src/file.service.js";
import { CatalogUploadDatabaseCoordinator } from "../../../packages/file-core/src/catalog-upload-database.js";
import { CatalogUploadTransferExecutor } from "../../../packages/file-core/src/catalog-upload-transfer.js";
import { SYNC_RESOURCE_ID } from "../../../packages/file-core/src/models.js";
import { checkpointGuardedLegacyRecovery } from "../../../packages/protection/src/storage-catalog-checkpoint.fixture.js";

const evidence = process.env.SATURN_GUARDED_LEGACY_EVIDENCE_DIR;

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE)("keeps catalog claims and expiry out of legacy recovery while recovering an ordinary upload", async () => {
  const f = await activeFixture("legacy-upload-recovery", "pluto", 121);
  try {
    const coordinator = new CatalogUploadDatabaseCoordinator(f.writer, f.issuer, "1073741824", true);
    const transfer = new CatalogUploadTransferExecutor(coordinator, f.executor, 1073741824, f.admission);
    const bytes = Buffer.from("guarded-original-retained");
    const empty = await coordinator.prepare(f.uploadInput("guarded-expired.bin", Buffer.from("pending")), f.proof);
    let accepted = await coordinator.prepare(f.uploadInput("guarded-pending.bin", bytes), f.proof);
    accepted = await transfer.append(accepted, f.proof, "0", bytes);
    accepted = await coordinator.verifyAndClaim(accepted, f.proof, "application/octet-stream", uid());
    const repository = new PostgresFileRepository(f.admin), legacy = new FileService(repository, f.raw);
    const ordinaryBytes = Buffer.from("legacy recovery stays useful");
    const ordinary = await legacy.createUpload({ parentId: SYNC_RESOURCE_ID, filename: "legacy-recovery.bin", expectedSize: ordinaryBytes.length, idempotencyKey: "legacy-recovery-" + uid() });
    await legacy.appendUpload(ordinary.id, 0, ordinaryBytes.length, Readable.from(ordinaryBytes));
    await repository.setUploadState(ordinary.id, "verifying");
    const snapshot = () => f.admin.withSql(sql => sql`SELECT to_jsonb(j) journal,to_jsonb(u) session FROM operation_journal j JOIN upload_sessions u ON u.id=j.id WHERE j.id IN (${accepted.status.session.uploadId}::uuid,${empty.status.session.uploadId}::uuid) ORDER BY j.id`);
    if (evidence) {
      const name = new URL(f.url).pathname.slice(1);
      const runtime = path.join(f.directory, "runtime");
      await fs.mkdir(runtime);
      await fs.writeFile(path.join(evidence, "ownership.json"), JSON.stringify({ name, directory: f.directory }), { flag: "wx" });
      await fs.writeFile(path.join(runtime, "fixture-authority.private.json"), JSON.stringify({
        name, root: f.rootId, roles: f.roles, binding: f.binding, backend: f.executor.identity,
        deviceId: f.uploadInput("fixture-authority.bin", bytes).intent.deviceId,
        authorization: f.authorization,
      }), { flag: "wx", mode: 0o600 });
      await checkpointGuardedLegacyRecovery("before-legacy-aging", f.admin, f.url, f.directory, evidence);
    }
    // Disposable fixture only: retain real guards/writer identities while aging
    // these two sessions. The production patch changes no clock or authority.
    const helper = "fixture_age_" + f.suffix;
    await f.admin.withSql(sql => sql.unsafe(`CREATE FUNCTION public.${helper}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$ BEGIN UPDATE public.upload_sessions SET updated_at=now()-interval '3 minutes' WHERE id='${accepted.status.session.uploadId}'; UPDATE public.upload_sessions SET expires_at=now()-interval '1 day' WHERE id='${empty.status.session.uploadId}'; END $$; ALTER FUNCTION public.${helper}() OWNER TO ${f.roles.writerOwner}; REVOKE ALL ON FUNCTION public.${helper}() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.${helper}() TO ${f.roles.writerLogin};`));
    try {
      await f.writer.withSql(sql => sql.unsafe(`SELECT public.${helper}()`));
    } finally {
      await f.admin.withSql(sql => sql.unsafe(`DROP FUNCTION public.${helper}()`));
    }
    await f.admin.withSql(sql => sql`UPDATE upload_sessions SET updated_at=now()-interval '3 minutes' WHERE id=${ordinary.id}::uuid`);
    const before = JSON.stringify(await snapshot());
    if (evidence) await checkpointGuardedLegacyRecovery("before-legacy-recovery", f.admin, f.url, f.directory, evidence);
    expect((await repository.listRecoverableUploads(10)).map(x => x.id)).toEqual([ordinary.id]);
    expect((await repository.listAbandonedUploadsForCleanup(100)).map(x => x.id)).not.toContain(empty.status.session.uploadId);
    const recovered = await legacy.recoverInterruptedUploads(), repeated = await legacy.recoverInterruptedUploads();
    expect(recovered).toEqual({ recovered: 1, pending: 0 });
    expect(repeated).toEqual({ recovered: 0, pending: 0 });
    expect(JSON.stringify(await snapshot())).toBe(before);
    const chunks: Buffer[] = [];
    for await (const chunk of await f.raw.openRead(accepted.execution.tempPath)) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(await f.raw.exists(accepted.execution.targetPath)).toBe(false);
    const published = await legacy.getUpload(ordinary.id);
    expect(published.id).toBe(ordinary.id);
    expect(published.status).toBe("active");
    const content: Buffer[] = [];
    for await (const chunk of await f.raw.openRead(published.targetPath)) content.push(Buffer.from(chunk as Uint8Array));
    expect(sha(Buffer.concat(content))).toBe(sha(ordinaryBytes));
    if (evidence) await fs.writeFile(path.join(f.directory, "proof.json"), JSON.stringify({
      root: f.rootId, backend: f.backendIdentity, generation: f.generation, guardedRowsSha256: sha(before),
      guarded: { id: accepted.status.session.uploadId, temporary: accepted.execution.tempPath, target: accepted.execution.targetPath, sha256: sha(bytes), bytes: bytes.length },
      expired: { id: empty.status.session.uploadId, target: empty.execution.targetPath },
      ordinary: { id: ordinary.id, resourceId: published.resourceId, temporary: ordinary.tempPath, target: published.targetPath, sha256: sha(ordinaryBytes), bytes: ordinaryBytes.length },
      recovered, repeated,
    }, null, 2), { flag: "wx" });
  } finally {
    try { await f.streams.close(); }
    finally { await f.close(); }
  }
}, 60000);
