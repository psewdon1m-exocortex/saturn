import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { activeFixture, barrier, evidence, sha, uid } from "./stage3-chat-a.fixture.js";
import { sharedBackendFactory } from "./completion-shared-backend.fixture.js";
import { resumeCompletionFixture, type RetainedClient } from "./completion-resume.fixture.js";
import { SmallBatchRegistry } from "../../../packages/file-core/src/small-batch-registry.js";
import { guardedSyncSmallBatchHttp } from "./guarded-sync-small-batch-http.js";

it("retained receiver requires a STOPPED owner and preserves binding, originals, content and versions on replay", async () => {
  const f = await activeFixture("batch-resume", "windows", 70, await sharedBackendFactory());
  const bytes = Buffer.from("retained original"), original = f.uploadInput("unchanged.md", bytes);
  const input: RetainedClient = { kind: "windows", databaseName: "stage3_" + f.suffix, binding: f.wireBinding, backendIdentity: f.backendIdentity,
    authorization: f.authorization, deviceId: original.intent.deviceId, rootName: requireDefined(original.intent.parentTopology[0]).name,
    receipt: sha("isolated-role-proof"), namespace: f.namespace };
  let next: typeof f | undefined;
  try {
    const before = await f.upload(original, bytes); expect(before.status.result?.status).toBe("PUBLISHED");
    await expect(resumeCompletionFixture(input)).rejects.toThrow();
    await f.close(); next = await resumeCompletionFixture(input);
    expect(next.wireBinding).toEqual(f.wireBinding);
    const replay = await next.files.prepareCatalogUpload(original, next.proof); expect(replay.status.result).toEqual(before.status.result);
    expect(await next.admin.withSql(sql => sql`SELECT id FROM file_versions WHERE resource_id=(SELECT id FROM resources WHERE parent_id=${f.rootId} AND name='unchanged.md')`)).toHaveLength(1);
    const more = await next.upload(next.uploadInput("continued.md", bytes), bytes); expect(more.status.result?.status).toBe("PUBLISHED");
    await evidence("batch-resume", "result", { status: "PASS", binding: next.wireBinding, retained: replay.status.result, continued: more.status.result });
  } finally { if (next) await next.close(); else await f.close(); }
}, 60000);

it("two HTTP batches share four publication slots, verify every SHA and replay without new versions", async () => {
  const f = await activeFixture("batch-parallel", "windows", 70, await sharedBackendFactory()), app = Fastify();
  const registry = new SmallBatchRegistry(f.writer, f.issuer), gate = barrier(), four = barrier();
  const bytes = Buffer.alloc(48 * 1024, 42); let active = 0, peak = 0, calls = 0;
  const complete = f.files.completeSmallCatalogUpload.bind(f.files);
  vi.spyOn(f.files, "completeSmallCatalogUpload").mockImplementation(async (...args) => {
    active++; calls++; peak = Math.max(peak, active); if (calls === 4) four.release();
    try { await gate.entered; return await complete(...args); } finally { active--; }
  });
  const plans = Array.from({ length: 2 }, () => {
    const inputs = Array.from({ length: 8 }, () => f.uploadInput(uid() + ".bin", bytes));
    return { manifest: { ...f.wireBinding, schema: "saturn.small-file-batch.v1", batch_id: uid(), rules_version: "1",
      items: inputs.map(i => ({ operation_id: i.intent.idempotencyKey, source_generation: "1", source_identity: uid(), parent_id: f.rootId, name: i.intent.name, size_bytes: String(bytes.length), sha256: sha(bytes), expected: { kind: "absent" } })) }, inputs };
  });
  const wire = (plan: typeof plans[number]) => {
    const boundary = "batch-" + uid(), metadata = Buffer.from(JSON.stringify(plan.manifest));
    const chunks = [Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(metadata.length)}\r\n\r\n`), metadata, Buffer.from("\r\n")];
    for (const item of plan.manifest.items) chunks.push(Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${item.operation_id}>\r\nContent-Length: ${String(bytes.length)}\r\n\r\n`), bytes, Buffer.from("\r\n"));
    chunks.push(Buffer.from(`--${boundary}--\r\n`)); return { type: "multipart/related; boundary=" + boundary, body: Buffer.concat(chunks) };
  };
  try {
    await app.register(guardedSyncSmallBatchHttp, { root: async id => id === f.rootId ? { binding: f.wireBinding, authority: f.issuer, files: f.files, batches: registry, admission: f.admission } : undefined });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const origin = `http://127.0.0.1:${String((app.server.address() as { port: number }).port)}/sync/v1/roots/${f.rootId}/small-batches/`;
    for (const p of plans) { const r = await fetch(origin + "prepare", { method: "POST", headers: { authorization: f.authorization, "Content-Type": "application/json" }, body: JSON.stringify(p) }); expect(r.status).toBe(202); await r.arrayBuffer(); }
    const send = async (p: typeof plans[number]) => { const w = wire(p); const r = await fetch(origin + "data", { method: "POST", headers: { authorization: f.authorization, "Content-Type": w.type }, body: w.body }); expect(r.status).toBe(202); return r.json() as Promise<{ items: { state: string }[] }>; };
    const started = performance.now(), pending = plans.map(send);
    try { await Promise.race([four.entered, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(Error("batch remained serial")), 5000); t.unref(); })]); expect(active).toBe(4); }
    finally { gate.release(); }
    const responses = await Promise.all(pending); expect(responses.flatMap(r => r.items).every(i => i.state === "PUBLISHED")).toBe(true); expect(peak).toBe(4);
    const elapsedMs = performance.now() - started;
    const rows = await f.admin.withSql(sql => sql<{ id: string; storage_path: string; sha256: string }[]>`SELECT id,storage_path,sha256 FROM resources WHERE parent_id=${f.rootId} AND type='file'`);
    expect(rows).toHaveLength(16);
    for (const row of rows) { const chunks = []; for await (const b of await f.raw.openRead(row.storage_path)) chunks.push(Buffer.from(b)); expect(sha(Buffer.concat(chunks))).toBe(sha(bytes)); }
    const before = await f.admin.withSql(sql => sql`SELECT id,resource_id FROM file_versions ORDER BY id`);
    await Promise.all(plans.map(send)); expect(await f.admin.withSql(sql => sql`SELECT id,resource_id FROM file_versions ORDER BY id`)).toEqual(before);
    await evidence("batch-parallel", "result", { status: "PASS", files: 16, peak, elapsedMs, filesPerSecond: 16000 / elapsedMs, fullShaReadback: true, replayUnchangedVersions: true });
  } finally { gate.release(); await app.close(); await f.close(); }
}, 60000);
