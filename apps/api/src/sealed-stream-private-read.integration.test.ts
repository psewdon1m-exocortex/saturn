import { expect, it } from "vitest";
import fs from "node:fs/promises";
import { activeFixture, sha, uid } from "./stage3-chat-a.fixture.js";
import { assertGuardedNamespaceAdmission } from "../../../packages/file-core/src/catalog-guard-admission.js";
import type { SyncStreamPrepare } from "../../../packages/contracts/src/sync-stream.js";

it.skipIf(!process.env.STAGE3_CHAT_A_FIXTURE)("admits only an exact fully sealed private stream and preserves ordinary read fences", async () => {
  const f = await activeFixture("sealed-stream-private-read", "windows", 121);
  try {
    await f.admin.withSql(sql => sql`UPDATE sync_root_policy SET features=features||'"scale-transfer-v2"'::jsonb WHERE root_id=${f.rootId}`);
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 73), prepared = f.uploadInput("sealed-original.bin", bytes);
    const original: SyncStreamPrepare = { schema: "saturn.stream-upload.v2", operationId: uid(), source: { generation: "1", witnessSha256: sha("original") }, chunkBytes: 4194304, prepare: { ...prepared, intent: { ...prepared.intent, sha256: null } } };
    await f.streams.prepare(original, f.proof);
    for (let offset = 0, index = 0; offset < bytes.length; offset += 4194304, index++) {
      const part = bytes.subarray(offset, offset + 4194304);
      await f.streams.append(original, { index, offset: String(offset), length: String(part.length), sha256: sha(part) }, part, f.proof);
    }
    const credential = f.issuer.deviceCredential(f.proof, f.rootId);
    await f.writer.withSql(sql => sql`SELECT public.sync_stream_command('seal',${JSON.stringify(original)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify({ sha256: sha(bytes), sourceGeneration: "1", sourceWitnessSha256: original.source.witnessSha256 })}::text::jsonb)`);
    const allowed = async () => (await f.admin.withSql(sql => sql<{ allowed: boolean }[]>`SELECT public.catalog_upload_private_read(j) allowed FROM operation_journal j WHERE id=${original.operationId}::uuid`))[0]?.allowed;
    expect(await allowed()).toBe(false);
    const up = await fs.readFile(new URL("../../../packages/database/migrations/0122_sealed_stream_private_read.up.sql", import.meta.url), "utf8");
    const down = await fs.readFile(new URL("../../../packages/database/migrations/0122_sealed_stream_private_read.down.sql", import.meta.url), "utf8");
    const snapshot = () => f.admin.withSql(sql => sql`SELECT to_jsonb(j) journal,to_jsonb(u) session,to_jsonb(s) stream FROM operation_journal j JOIN upload_sessions u ON u.id=j.id JOIN sync_stream_uploads s ON s.operation_id=j.id WHERE j.id=${original.operationId}::uuid`);
    const before = JSON.stringify(await snapshot());
    await f.admin.transaction(sql => sql.unsafe(up));
    expect(await allowed()).toBe(true);
    expect(JSON.stringify(await snapshot())).toBe(before);
    await f.runtime.transaction(sql => assertGuardedNamespaceAdmission(sql, { rootId: f.rootId, epoch: f.binding.epoch, bindingVersion: f.binding.bindingVersion, guardRevision: f.binding.guardRevision }));
    const [row] = await f.admin.withSql(sql => sql<{ execution: Record<string, unknown> }[]>`SELECT upload_execution execution FROM operation_journal WHERE id=${original.operationId}::uuid`);
    if (!row) throw Error("Missing original execution");
    const overlays: Record<string, unknown>[] = [
      { resource_id: uid() }, { upload_effect_state: "physical_pending" }, { upload_effect_state: "reconciliation_required" }, { error_code: "reconciliation_required" },
      { upload_execution: { ...row.execution, bindingVersion: uid() } }, { upload_execution: { ...row.execution, backendIdentity: "foreign" } },
      { upload_execution: { ...row.execution, nodeId: uid() } }, { upload_execution: { ...row.execution, versionId: uid() } },
    ];
    for (const overlay of overlays) {
      const [negative] = await f.admin.withSql(sql => sql<{ allowed: boolean }[]>`SELECT public.catalog_upload_private_read(jsonb_populate_record(NULL::public.operation_journal,to_jsonb(j)||${JSON.stringify(overlay)}::text::jsonb)) allowed FROM operation_journal j WHERE id=${original.operationId}::uuid`);
      expect(negative?.allowed).toBe(false);
    }
    const rollback = Error("fixture rollback");
    await expect(f.admin.transaction(async sql => {
      await sql`UPDATE sync_stream_uploads SET state='UNKNOWN' WHERE operation_id=${original.operationId}::uuid`;
      expect((await sql<{ allowed: boolean }[]>`SELECT public.catalog_upload_private_read(j) allowed FROM operation_journal j WHERE id=${original.operationId}::uuid`)[0]?.allowed).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    await expect(f.admin.transaction(async sql => {
      await sql`INSERT INTO sync_stream_parts(operation_id,part_index,chunk,state) VALUES(${original.operationId}::uuid,3,${JSON.stringify({ index: 3, offset: "12582912", length: "1", sha256: "a".repeat(64) })}::text::jsonb,'PENDING')`;
      expect((await sql<{ allowed: boolean }[]>`SELECT public.catalog_upload_private_read(j) allowed FROM operation_journal j WHERE id=${original.operationId}::uuid`)[0]?.allowed).toBe(false);
      throw rollback;
    })).rejects.toBe(rollback);
    await f.admin.transaction(sql => sql.unsafe(down));
    expect(await allowed()).toBe(false);
    await f.admin.transaction(sql => sql.unsafe(up));
    expect(await allowed()).toBe(true);
    expect((await f.streams.complete(original, f.proof)).state).toBe("PUBLISHED");
    const resources = await f.admin.withSql(sql => sql<{ id: string; storage_path: string; sha256: string; current_version_id: string }[]>`SELECT id,storage_path,sha256,current_version_id FROM resources WHERE parent_id=${f.rootId} AND name='sealed-original.bin'`);
    expect(resources).toHaveLength(1);
    const resource = resources[0]; if (!resource) throw Error("Missing published original");
    const chunks: Buffer[] = []; for await (const chunk of await f.raw.openRead(resource.storage_path)) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(resource.sha256).toBe(sha(bytes));
    expect(await f.admin.withSql(sql => sql`SELECT id FROM file_versions WHERE resource_id=${resource.id}`)).toHaveLength(1);
  } finally { await f.streams.close(); await f.close(); }
}, 60000);
