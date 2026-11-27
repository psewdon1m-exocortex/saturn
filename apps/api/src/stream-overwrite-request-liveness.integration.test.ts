import { expect, it, vi } from "vitest";
import { activeFixture, barrier, evidence, sha, uid } from "./stage3-chat-a.fixture.js";
import { assertGuardedNamespaceAdmission } from "../../../packages/file-core/src/catalog-guard-admission.js";
import type { SyncStreamPrepare } from "../../../packages/contracts/src/sync-stream.js";

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE)("keeps a real sealed overwrite completion visible while ordinary namespace reads remain fenced", async () => {
  const id = "stream-overwrite-request-liveness";
  const f = await activeFixture(id, "pluto", 122);
  const entered = barrier(), release = barrier();
  let request: ReturnType<typeof f.streams.completeWithin> | undefined;
  try {
    await f.admin.withSql(sql => sql`UPDATE sync_root_policy SET features=features||'"scale-transfer-v2"'::jsonb WHERE root_id=${f.rootId}`);
    const beforeBytes = Buffer.alloc(1024 * 1024 + 17, 71);
    await f.upload(f.uploadInput("overwrite.bin", beforeBytes), beforeBytes);
    const previous = (await f.admin.withSql(sql => sql<{ nodeId: string; metadataVersion: string; versionId: string }[]>`
      SELECT id AS "nodeId",metadata_version AS "metadataVersion",current_version_id AS "versionId"
      FROM resources WHERE parent_id=${f.rootId} AND name='overwrite.bin'`))[0];
    if (!previous) throw Error("Missing initial publication");
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 73);
    const prepared = f.uploadInput("overwrite.bin", bytes, previous);
    const original: SyncStreamPrepare = { schema: "saturn.stream-upload.v2", operationId: uid(), source: { generation: "2", witnessSha256: sha("overwrite-source") }, chunkBytes: 4194304, prepare: { ...prepared, intent: { ...prepared.intent, sha256: null } } };
    await f.streams.prepare(original, f.proof);
    for (let offset = 0, index = 0; offset < bytes.length; offset += 4194304, index++) {
      const part = bytes.subarray(offset, offset + 4194304);
      await f.streams.append(original, { index, offset: String(offset), length: String(part.length), sha256: sha(part) }, part, f.proof);
    }
    const transaction = f.writer.transaction.bind(f.writer);
    let held = false;
    // Execute and commit the real SQL transaction. Delay only delivery of its
    // SEALED result to the caller, before the detached publication job exists.
    const spy = vi.spyOn(f.writer, "transaction").mockImplementation(async action => {
      const result = await transaction(action);
      const observed = result as { status?: { state: string; operationId: string } } | undefined;
      if (!held && observed?.status?.operationId === original.operationId && observed.status.state === "SEALED") {
        held = true; entered.release(); await release.entered;
      }
      return result;
    });
    request = f.streams.completeWithin(original, f.proof, { sha256: sha(bytes), sourceGeneration: "2", sourceWitnessSha256: original.source.witnessSha256 });
    await Promise.race([entered.entered, request.then(() => { throw Error("Completion settled before the committed seal observation"); })]);
    const sealed = await f.admin.withSql(sql => sql<{ allocatedNode: string; effectiveNode: string; streamState: string; privateRead: boolean; pending: boolean }[]>`
      SELECT s.node_id AS "allocatedNode",j.upload_execution->>'nodeId' AS "effectiveNode",s.state AS "streamState",
        public.catalog_upload_private_read(j) AS "privateRead",j.sync_result IS NULL AS pending
      FROM sync_stream_uploads s JOIN operation_journal j ON j.id=s.operation_id WHERE s.operation_id=${original.operationId}::uuid`);
    const seal = sealed[0]; if (!seal) throw Error("Missing committed stream original");
    await evidence(id, "sealed-observation", { ...seal, operationId: original.operationId, expectedNode: previous.nodeId, hasPendingCompletion: f.streams.hasPendingCompletion, sqlWasCommitted: true });
    expect(seal.streamState).toBe("SEALED");
    expect(seal.pending).toBe(true);
    expect(seal.effectiveNode).toBe(previous.nodeId);
    expect(seal.allocatedNode).not.toBe(previous.nodeId);
    expect(seal.privateRead).toBe(false);
    await expect(f.runtime.transaction(sql => assertGuardedNamespaceAdmission(sql, { rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, guardRevision: f.binding.guardRevision }))).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.streams.hasPendingCompletion).toBe(true);
    release.release();
    await request;
    await f.streams.close();
    spy.mockRestore();
    expect((await f.streams.status(original, f.proof)).state).toBe("PUBLISHED");
    expect(f.streams.hasPendingCompletion).toBe(false);
    await f.runtime.transaction(sql => assertGuardedNamespaceAdmission(sql, { rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, guardRevision: f.binding.guardRevision }));
    const resources = await f.admin.withSql(sql => sql<{ id: string; storage_path: string; sha256: string }[]>`
      SELECT id,storage_path,sha256 FROM resources WHERE parent_id=${f.rootId} AND name='overwrite.bin'`);
    expect(resources).toHaveLength(1);
    const resource = resources[0]; if (!resource) throw Error("Missing final resource");
    expect(resource.id).toBe(previous.nodeId);
    const versions = await f.admin.withSql(sql => sql<{ id: string; sha256: string; storage_path: string }[]>`
      SELECT id,sha256,storage_path FROM file_versions WHERE resource_id=${resource.id}`);
    expect(versions).toHaveLength(2);
    for (const version of versions) {
      const chunks: Buffer[] = []; for await (const part of await f.raw.openRead(version.storage_path)) chunks.push(Buffer.from(part as Uint8Array));
      const actual = Buffer.concat(chunks);
      expect(sha(actual)).toBe(version.sha256);
      expect(actual.equals(version.sha256 === sha(bytes) ? bytes : beforeBytes)).toBe(true);
    }
    expect(resource.sha256).toBe(sha(bytes));
    expect(await f.admin.withSql(sql => sql`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId} AND sync_result IS NULL`)).toHaveLength(0);
    await evidence(id, "result", { status: "PASS_SCOPED_REAL_SQL_LOCAL_STORAGE", operationId: original.operationId, nodeId: resource.id, versions: versions.map(v => ({ id: v.id, sha256: v.sha256 })), guardsStayedClosedUntilPublication: true, noPending: true, completionJoined: true });
  } finally {
    release.release();
    if (request) await Promise.allSettled([request]);
    await f.streams.close();
    vi.restoreAllMocks();
    await f.close();
  }
}, 60000);
