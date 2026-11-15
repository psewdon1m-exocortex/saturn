import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { expect, vi } from "vitest";
import { SmallBatchRegistry } from "../../../packages/file-core/src/small-batch-registry.js";
import { guardedSyncUploadHttp, GUARDED_UPLOAD_FRAME_TYPE } from "./guarded-sync-upload-http.js";
import { guardedSyncSmallBatchHttp } from "./guarded-sync-small-batch-http.js";
import { activeFixture, evidence, sha, uid } from "./stage3-chat-a.fixture.js";

export async function runChatABenefit(smoke = false, followUp = false) {
  if (process.env.STAGE3_CHAT_A_PERFORMANCE !== "isolated") throw Error("A15 requires isolated performance lane; no other heavy test processes");
  const root = requireDefined(process.env.STAGE3_CHAT_A_EVIDENCE);
  const source = path.join(root, "A15", "source"); await fs.mkdir(source, { recursive: true });
  const dataset: { name: string; file: string; size: number; sha256: string }[] = [];
  for (let n = 0; n < (smoke ? 12 : 1100); n++) {
    const bytes = Buffer.alloc(n < 1000 ? 1024 : 65536); for (let p = 0; p < bytes.length; p++) bytes[p] = (314159 + p * 31 + n) % 251;
    const name = "file-" + String(n).padStart(4, "0") + ".bin", file = path.join(source, name); await fs.writeFile(file, bytes);
    dataset.push({ name, file, size: bytes.length, sha256: sha(bytes) });
  }
  const results: { mode: string; round: number; publishedBytesPerSecond: number; p95Ms: number; durationMs: number; sourceReads: number; sourceReadBytes: number; storageReadBytes: number; metadataCalls: number }[] = [];
  for (let round = followUp ? 3 : 0; round < (smoke ? 1 : followUp ? 4 : 3); round++) for (const mode of ["baseline", "feature"]) {
    const label = `${smoke ? "smoke-" : ""}${String(round + 1)}-${mode}`, f = await activeFixture("A15-" + label), app = Fastify();
    let sourceReads = 0, sourceReadBytes = 0, storageReadBytes = 0, completed = 0;
    const durations: number[] = [], originalRead = f.raw.openRead.bind(f.raw), startedAt = new Date().toISOString();
    vi.spyOn(f.raw, "openRead").mockImplementation(async (p, o) => {
      const stream = await originalRead(p, o);
      return Readable.from((async function* () { for await (const chunk of stream) { const bytes=Buffer.from(chunk as Uint8Array);storageReadBytes += bytes.length; yield bytes; } })());
    });
    const registry = new SmallBatchRegistry(f.writer, f.issuer), scope = { binding: f.wireBinding, authority: f.issuer, files: f.files, batches: registry };
    app.addHook("onRequest", async () => { await delay(10); }); // identical controlled request RTT for both transports
    await app.register(guardedSyncUploadHttp, { root: id => Promise.resolve(id === f.rootId ? scope : undefined) });
    await app.register(guardedSyncSmallBatchHttp, { root: id => Promise.resolve(id === f.rootId ? scope : undefined) });
    await app.listen({ host: "127.0.0.1", port: 0 }); const address = app.server.address(); if (!address || typeof address === "string") throw Error("fixture HTTP address missing");
    const origin = `http://127.0.0.1:${String(address.port)}/sync/v1/roots/${f.rootId}`;
    const request = async (endpoint: string, payload: unknown, method = "POST", type = "application/json") => {
      const response = await fetch(origin + endpoint, { method, headers: { authorization: f.authorization, "content-type": type }, body: Buffer.isBuffer(payload) ? payload : JSON.stringify(payload) });
      const result = await response.json() as { code?:string;session:{uploadId:string};result?:{status:string};items:{state:string}[] };
      if (!response.ok) throw Error(`A15 ${label} ${endpoint}: HTTP ${String(response.status)} ${result.code ?? "unknown"}`);
      return result;
    };
    const readSource = async (index: number) => { const item = requireDefined(dataset[index]), bytes = await fs.readFile(item.file); expect(sha(bytes)).toBe(item.sha256); sourceReads++; sourceReadBytes += bytes.length; return bytes; };
    const inputs = dataset.map(d => { const input = f.uploadInput(d.name, Buffer.alloc(0)); return { ...input, intent: { ...input.intent, sizeBytes: String(d.size), sha256: d.sha256 } }; });
    let next = 0;
    const before = await f.executor.diagnostics(), started = performance.now();
    await evidence("A15", "progress", { label, startedAt, completed: 0, target: dataset.length, controlledRttMs: 10, workers: 4 });
    try {
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (;;) {
          const index = next; next += mode === "feature" ? 10 : 1; if (index >= dataset.length) return;
          const itemStarted = performance.now();
          if (mode === "baseline") {
            const input = requireDefined(inputs[index]), prepared = await request("/catalog-uploads/prepare", { binding: f.wireBinding, input });
            const upload_id = prepared.session.uploadId, bytes = await readSource(index);
            const metadata = Buffer.from(JSON.stringify({ binding: f.wireBinding, input, upload_id, offset: "0" })), length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
            await request("/catalog-uploads/append", Buffer.concat([length, metadata, bytes]), "PATCH", GUARDED_UPLOAD_FRAME_TYPE);
            const done = await request("/catalog-uploads/complete", { binding: f.wireBinding, input, upload_id }); expect(done.result?.status).toBe("PUBLISHED");
            durations.push(performance.now() - itemStarted); completed++;
          } else {
            const group = inputs.slice(index, index + 10), manifest = { ...f.wireBinding, schema: "saturn.small-file-batch.v1", batch_id: uid(), rules_version: "1", items: group.map(i => ({ operation_id: i.intent.idempotencyKey, source_generation: "1", source_identity: uid(), parent_id: f.rootId, name: i.intent.name, size_bytes: i.intent.sizeBytes, sha256: i.intent.sha256, expected: { kind: "absent" } })) };
            await request("/small-batches/prepare", { manifest, inputs: group });
            const boundary = "stage3-" + uid(), json = Buffer.from(JSON.stringify(manifest));
            const parts = [Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(json.length)}\r\n\r\n`), json];
            for (const [n, item] of manifest.items.entries()) parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-ID: <${item.operation_id}>\r\nContent-Length: ${item.size_bytes}\r\n\r\n`), await readSource(index + n));
            parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
            const done = await request("/small-batches/data", Buffer.concat(parts), "POST", `multipart/related; boundary=${boundary}`);
            expect(done.items).toHaveLength(group.length); expect(done.items.every((i: { state: string }) => i.state === "PUBLISHED")).toBe(true);
            durations.push(...group.map(() => performance.now() - itemStarted)); completed += group.length;
          }
          if (completed % 100 === 0) await evidence("A15", "progress", { label, startedAt, completed, target: 1100, elapsedMs: performance.now() - started });
        }
      }));
      const durationMs = performance.now() - started, after = await f.executor.diagnostics();
      const receipts = await f.admin.withSql(sql => sql<{ count: string; bytes: string }[]>`SELECT count(*)::text AS count,sum(u.received_size)::text AS bytes FROM operation_journal j JOIN upload_sessions u ON u.id=j.upload_id WHERE j.sync_root_id=${f.rootId} AND j.sync_result->>'status'='PUBLISHED'`);
      expect(requireDefined(receipts[0]).count).toBe(String(dataset.length)); expect(requireDefined(receipts[0]).bytes).toBe(String(dataset.reduce((sum, d) => sum + d.size, 0))); expect(sourceReads).toBe(dataset.length);
      expect(await f.admin.withSql(sql => sql<Record<string, unknown>[]>`SELECT id FROM operation_journal WHERE sync_root_id=${f.rootId} AND sync_result IS NULL`)).toHaveLength(0);
      durations.sort((a, b) => a - b);
      const result = { mode, round: round + 1, durationMs, publishedBytesPerSecond: Number(requireDefined(receipts[0]).bytes) / (durationMs / 1000), p95Ms: requireDefined(durations[Math.ceil(durations.length * .95) - 1]), sourceReads, sourceReadBytes, storageReadBytes, metadataCalls: (after.process as {metadataCalls:number}).metadataCalls - (before.process as {metadataCalls:number}).metadataCalls };
      results.push(result); await evidence("A15", label, { ...result, startedAt, finishedAt: new Date().toISOString(), controlledRttMs: 10, workers: 4, batchItems: mode === "feature" ? 10 : 1, receipts, rootId: f.rootId, durations, executor: after });
    } finally { await app.close(); await f.close(); }
  }
  if (smoke) { await evidence("A15", "transport-smoke", { results, smokeOnly: true }); return; }
  if (followUp) {
    for (const round of [2, 3]) for (const mode of ["baseline", "feature"]) results.push(JSON.parse(await fs.readFile(path.join(root, "A15", `${String(round)}-${mode}.json`), "utf8")) as typeof results[number]);
    for (const result of results) {
      if (![2, 3, 4].includes(result.round) || !["baseline", "feature"].includes(result.mode) || result.sourceReads !== dataset.length || !Number.isFinite(result.durationMs) || result.durationMs <= 0) throw Error("Current-run follow-up inputs required");
    }
    results.sort((a, b) => a.round - b.round || (a.mode === "baseline" ? -1 : 1));
  }
  const mean = (mode: string, key: "publishedBytesPerSecond" | "p95Ms") => results.filter(r => r.mode === mode).reduce((s, r) => s + r[key], 0) / 3;
  const throughputGain = mean("feature", "publishedBytesPerSecond") / mean("baseline", "publishedBytesPerSecond") - 1, p95Degradation = mean("feature", "p95Ms") / mean("baseline", "p95Ms") - 1;
  await evidence("A15", followUp ? "benefit-summary" : "benefit-preliminary", { results, throughputGain, p95Degradation, benefitGatePassed: throughputGain >= .15 && p95Degradation <= .20, automaticBatching: "OFF", selectedRounds: followUp ? [2, 3, 4] : [1, 2, 3], excludedRounds: followUp ? [{ round: 1, reason: "Predeclared follow-up estimate uses rounds 2, 3 and 4; round 1 remains in the separate preliminary estimate. No external interference is claimed." }] : [], thresholds: { throughputGain: .15, maximumP95Degradation: .20 }, latencyDefinition: "worker claim through authoritative HTTP publication response; batch members receive the aggregate response together" });
}
