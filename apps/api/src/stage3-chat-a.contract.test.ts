import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import fs from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { syncNameKey, parseSyncNamespacePolicy, parseSyncMutationInput, parseSyncDeletePlan, SYNC_EXTENSION_REVISIONS } from "../../../packages/contracts/src/sync-extensions.js";
import { parseStorageVerifyRequest, parseStorageVerifyResult, storageVerifyResult } from "../../../packages/contracts/src/storage-verifier.js";
import { parseSyncJson, encodeSyncJson } from "../../../packages/contracts/src/sync-protocol.js";
import { parseCatalogFolderBatch, executeCatalogFolderBatch } from "../../../packages/file-core/src/catalog-folder-batch.js";
import { parseGuardedRuntimeManifest } from "../../../packages/sync/src/guarded-runtime-manifest.js";
import { guardedMetadataParser } from "./guarded-metadata-http.js";
import { guardedSyncHttp, type GuardedSyncHttpRoot } from "./guarded-sync-http.js";
import { uid, sha, functionsV3, functionsV2, functionsV1, evidence } from "./stage3-chat-a.fixture.js";

const vectors: { name: string; codec: "legacy" | "portable_v1"; accepted: boolean; key?: string; code?: string }[] = (JSON.parse(await fs.readFile(new URL("../../../packages/contracts/fixtures/name-codec-v1.json", import.meta.url), "utf8")) as {vectors:typeof vectors}).vectors;
it.each(vectors)("A01 codec $codec $name", v => {
  if (v.accepted) expect(syncNameKey(v.name, v.codec)).toBe(v.key);
  else expect(() => syncNameKey(v.name, v.codec)).toThrow(v.code);
});
it("A01 canonical mutation/approval bytes and exact authority fields", () => {
  const rootId = uid(), input = { schema: "saturn.namespace-mutation.v1", operationId: uid(), idempotencyKey: uid(), rootId, epoch: uid(), bindingVersion: uid(), expected: { kind: "absent" }, kind: "create-empty", parentId: rootId, name: "COMLPT1.md" };
  expect(parseSyncMutationInput(parseSyncJson(encodeSyncJson(input), 65536))).toEqual(input);
  expect(sha(encodeSyncJson(parseSyncMutationInput(input)))).toBe(sha(encodeSyncJson(input)));
  expect(() => parseSyncMutationInput({ ...input, authority: { owner: true } })).toThrow();
  expect(() => parseSyncMutationInput({ ...input, schema: "saturn.namespace-mutation.v2" })).toThrow();
  const plan = { schema: "saturn.delete-plan.v1", planId: uid(), planDigest: sha("plan"), items: [{ nodeId: uid(), version: uid() }] };
  expect(parseSyncDeletePlan(plan)).toEqual(plan);
  expect(() => parseSyncDeletePlan({ ...plan, items: [...plan.items, ...plan.items] })).toThrow();
  expect(() => parseSyncDeletePlan({ ...plan, owner: true })).toThrow();
  expect(SYNC_EXTENSION_REVISIONS).toEqual({ K1: 2, K2: 2, K3: 2, K4: 1 });
});
it("A01 K4 strict request/result identity and digest/durability", () => {
  const r = { schema: "saturn.storage-verify.v1" as const, requestId: uid(), backendIdentity: "fixture", backendGeneration: uid(), ownerId: uid(), fencingToken: uid(), rootId: uid(), operationId: uid(), intentSha256: sha("intent"), contentVersionId: uid(), relativePath: "root/file", sizeBytes: "1", sha256: sha("x"), maximumBytes: "1", timeoutMs: 30000, requireDurability: "file-sync" as const };
  expect(parseStorageVerifyRequest(r)).toEqual(r);
  const result = storageVerifyResult(r, "file-sync");
  for (const key of ["ownerId", "rootId", "operationId", "backendGeneration", "fencingToken"]) expect(() => parseStorageVerifyResult({ ...result, [key]: uid() }, r)).toThrow("identity_mismatch");
  expect(() => parseStorageVerifyResult({ ...result, intentSha256: sha("other") }, r)).toThrow("identity_mismatch");
  expect(() => parseStorageVerifyRequest({ ...r, authority: true })).toThrow();
  expect(() => parseStorageVerifyResult({ ...result, sha256: sha("z") }, r)).toThrow("verification_failed");
  expect(() => parseStorageVerifyResult({ ...result, sizeBytes: "2" }, r)).toThrow("verification_failed");
  expect(() => parseStorageVerifyResult({ ...result, durability: "readback" }, r)).toThrow();
});
it.each([["v1", functionsV1], ["v2", functionsV2], ["v3", functionsV3]] as const)("A01 manifest %s exact entry points", (revision, signatures) => {
  const rootId = uid();
  const manifest = { schema: "saturn.guarded-runtime." + revision, serverIdentity: uid(), policyVersion: "fixture", qualificationReceiptFile: "C:/fixture/q", qualificationReceiptSha256: sha("q"), writerDatabaseUrlFile: "C:/fixture/w", cursorKeyFile: "C:/fixture/c", cursorKeyId: "key", maximumFileBytes: "1073741824", roles: { runtimeRole: "rt", writerLogin: "wr", writerOwner: "ow", migratorRole: "mg" }, approvedFunctions: signatures.map(identity => ({ identity: "public." + identity, sourceSha256: sha(identity) })), backend: { identity: "backend", profileId: "bootstrap", profileRevision: 1, generation: uid(), fenceReceiptFile: "C:/fixture/f", fenceReceiptSha256: sha("f"), caseSensitive: true }, roots: [{ rootId, epoch: uid(), bindingVersion: uid(), guardRevision: uid(), activationReceiptSha256: sha("activation") }], ...(revision === "v3" ? { extensions: { features: [], verifier: null } } : {}) };
  expect(parseGuardedRuntimeManifest(manifest).schema).toBe(manifest.schema);
  expect(() => parseGuardedRuntimeManifest({ ...manifest, schema: "saturn.guarded-runtime.v4" })).toThrow();
  if (revision === "v3") expect(() => parseGuardedRuntimeManifest({ ...manifest, approvedFunctions: manifest.approvedFunctions.filter(f => !f.identity.includes("sync_retention_command")) })).toThrow();
});
function folder(n = 0, rootId = uid()) { return { ref: String(n), input: { operationId: uid(), idempotencyKey: uid(), rootId, epoch: uid(), bindingVersion: uid(), parentId: rootId, name: "folder" + String(n), mode: "ensure", parentTopology: [{ nodeId: rootId, parentId: null, name: "root" }] } }; }
it("A05 directory batches 1/500/501, dependency cycle and independent rejection", async () => {
  expect(parseCatalogFolderBatch([folder()])).toHaveLength(1);
  const batch = Array.from({ length: 500 }, (_, n) => folder(n));
  expect(parseCatalogFolderBatch(batch)).toHaveLength(500);
  expect(() => parseCatalogFolderBatch([...batch, folder(500)])).toThrow();
  expect(() => parseCatalogFolderBatch([{ ...batch[0], parentRef: "0" }])).toThrow();
  expect(() => parseCatalogFolderBatch([{ ...batch[0], parentRef: "1" }, batch[1]])).toThrow();
  const called: string[] = [];
  const outcomes = await executeCatalogFolderBatch(parseCatalogFolderBatch(batch.slice(0, 2)), async i => { called.push(i.operationId); throw Object.assign(Error("conflict"), { code: "precondition_failed" }); });
  expect(outcomes).toEqual([{ ref: "0", code: "precondition_failed" }, { ref: "1", code: "precondition_failed" }]);
  expect(called).toEqual(batch.slice(0, 2).map(b => b.input.operationId));
});
it("A05 gzip threshold, negotiation, expanded bounds/truncation and binary", async () => {
  const app = Fastify(); let effects = 0;
  guardedMetadataParser(app, 20000, async request => request.headers["x-feature"] === "on");
  app.setErrorHandler((e: { code?: string }, _q, r) => r.code(400).send({ code: e.code }));
  app.post("/metadata", async r => { effects++; return r.body; });
  app.get("/metadata", async r => ({ text: "a".repeat(Number((r.query as { size: string }).size) - 11) }));
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_q, b, done) => done(null, b));
  app.post("/binary", async r => r.body);
  try {
    for (const size of [16384, 16385]) {
      const plain = await app.inject({ url: "/metadata?size=" + String(size) }); expect(plain.rawPayload.length).toBe(size);
      const zipped = await app.inject({ url: "/metadata?size=" + String(size), headers: { "accept-encoding": "gzip", "x-feature": "on" } });
      // Contract says compression starts above 16 KiB, not at the boundary.
      expect(zipped.headers["content-encoding"]).toBe(size === 16384 ? undefined : "gzip");
      expect(size === 16384 ? zipped.rawPayload : gunzipSync(zipped.rawPayload)).toEqual(plain.rawPayload);
    }
    const body = Buffer.from(JSON.stringify({ a: "z".repeat(17000) }));
    const send = (payload: Buffer, enabled = true) => app.inject({ method: "POST", url: "/metadata", payload, headers: { "content-type": "application/json", "content-encoding": "gzip", "x-feature": enabled ? "on" : "off" } });
    expect((await send(gzipSync(body))).json()).toEqual(JSON.parse(body.toString()));
    expect((await send(gzipSync(body), false)).json<{code:string}>().code).toBe("unsupported_encoding");
    expect((await send(gzipSync(Buffer.from(JSON.stringify({ a: "z".repeat(20001) }))))).json<{code:string}>().code).toBe("page_limit");
    expect((await send(gzipSync(body).subarray(0, 12))).json<{code:string}>().code).toBe("invalid_json");
    expect(effects).toBe(1);
    const binary = await app.inject({ method: "POST", url: "/binary", payload: body, headers: { "content-type": "application/octet-stream", "content-encoding": "gzip" } });
    expect(binary.json<{code:string}>().code).toBe("unsupported_encoding");
  } finally { await app.close(); }
});
it("A05 directory metadata exact 4 MiB boundary and one byte over", () => {
  const batch = Array.from({ length: 500 }, (_, n) => {
    const ids = Array.from({ length: 30 }, () => uid()), entry = folder(n, ids.at(-1));
    return { ...entry, input: { ...entry.input, parentId: requireDefined(ids[0]), parentTopology: ids.map((nodeId, index) => ({ nodeId, parentId: ids[index + 1] ?? null, name: "p" })) } };
  });
  let remaining = 4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(batch));
  for (const item of batch) for (const parent of item.input.parentTopology) { const extra = Math.min(254, remaining); parent.name += "x".repeat(extra); remaining -= extra; }
  expect(remaining).toBe(0); expect(Buffer.byteLength(JSON.stringify(batch))).toBe(4194304); expect(parseCatalogFolderBatch(batch)).toHaveLength(500);
  requireDefined(requireDefined(batch.at(-1)).input.parentTopology.at(-1)).name += "x";
  expect(Buffer.byteLength(JSON.stringify(batch))).toBe(4194305); expect(() => parseCatalogFolderBatch(batch)).toThrow("invalid_input");
});
it("A10 explicit policy names and immutable original survive include/exclude policy revisions", async () => {
  const originals = [".git", "node_modules", ".audit"].map(name => ({ name, operationId: uid() }));
  const before = JSON.stringify(originals), policy1 = parseSyncNamespacePolicy({ codec: "portable_v1", policyHash: sha("include-all") }), policy2 = parseSyncNamespacePolicy({ codec: "portable_v1", policyHash: sha("exclude-reviewed") });
  for (const item of originals) expect(syncNameKey(item.name, policy1.codec)).toBe(item.name);
  expect(policy1.policyHash).not.toBe(policy2.policyHash); expect(JSON.stringify(originals)).toBe(before);
  await evidence("A10", "policy-contract", { originalSha256: sha(before), policies: [policy1, policy2], scope: "parser only; CLI preview and runtime diagnostics require integration" });
});

it("A05 long-poll event race uses one cursor; negotiated off, gap, max wait and cancellation", async () => {
  const rootId = uid(), binding = { protocol: "neptune-sync/1" as const, descriptor_schema: "saturn.current-namespace.v1" as const, server_identity: uid(), root_id: rootId, server_epoch: uid(), policy_version: "stage3", binding_version: uid() };
  let available = true, mode = "event", reads = 0, waits = 0;
  const root = { binding, extensions: ["changes-wait-v1"], authority: { device: async () => ({ proof: "fixture" }) }, reader: {
    changesAvailable: async (cursor: string) => { expect(cursor).toBe("original"); waits++; if (mode === "gap") throw Object.assign(Error("gap"), { code: "journal_gap" }); return available; },
    changes: async (cursor: string) => { expect(cursor).toBe("original"); reads++; return encodeSyncJson({ cursor: "next", changes: available ? ["event"] : [] }); },
  } } as unknown as GuardedSyncHttpRoot;
  const app = Fastify(); await app.register(guardedSyncHttp, { root: async () => root });
  const request = (wait_ms: number) => app.inject({ method: "POST", url: `/sync/v1/roots/${rootId}/changes`, payload: { binding, cursor: "original", wait_ms } });
  try {
    expect((await request(25000)).json()).toEqual({ cursor: "next", changes: ["event"] }); expect(reads).toBe(1);
    expect((await request(25001)).statusCode).toBe(400); expect(reads).toBe(1);
    mode = "gap"; expect((await request(25000)).json<{code:string}>().code).toBe("journal_gap"); expect(reads).toBe(1);
    mode = "event"; available = false;
    Object.assign(root, { extensions: [] }); const waitsBeforeOff = waits;
    expect((await request(25000)).json<{changes:unknown[]}>().changes).toEqual([]); expect(waits).toBe(waitsBeforeOff); Object.assign(root, { extensions: ["changes-wait-v1"] });
    // Move the deadline with a controlled clock; there is no 25-second sleep.
    let now = 0; const clock = vi.spyOn(Date, "now").mockImplementation(() => { now += 30000; return now; });
    try { expect((await request(25000)).json<{changes:unknown[]}>().changes).toEqual([]); } finally { clock.mockRestore(); }
    await app.listen({ host: "127.0.0.1", port: 0 }); const address = app.server.address(); if (!address || typeof address === "string") throw Error("loopback missing");
    const controller = new AbortController(), beforeWaits = waits;
    const pending = fetch(`http://127.0.0.1:${String(address.port)}/sync/v1/roots/${rootId}/changes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ binding, cursor: "original", wait_ms: 25000 }), signal: controller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(waits).toBeGreaterThan(beforeWaits)); controller.abort(); expect(await pending).toBeInstanceOf(Error);
    available = true; expect((await request(25000)).statusCode).toBe(200);
    await evidence("A05", "poll", { reads, waits, cancelled: true, exactCursor: "original" });
  } finally { await app.close(); }
});
