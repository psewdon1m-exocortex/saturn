import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID as uid } from "node:crypto";
import { parseHostConfig } from "../../../packages/storage-verifier/src/authority.js";
import { createVerifierServer } from "../../../packages/storage-verifier/src/server.js";
import { StorageVerifierClient } from "../../../packages/storage/src/storage-verifier.client.js";
import type { StorageVerifyRequest } from "../../../packages/contracts/src/storage-verifier.js";

assert.equal(process.platform, "linux");
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex"), base = await fs.mkdtemp("/tmp/stage3-a-k4-"), content = path.join(base, "content"), registry = path.join(base, "registry");
for (const p of [content + "/private", registry + "/owners", registry + "/operations"]) await fs.mkdir(p, { recursive: true, mode: 0o700 });
const bytes = Buffer.alloc(65537, 31), relativePath = "private/Агентность, локус контроля, инициативность.md", secretFile = base + "/token", token = "fixture-" + uid();
await fs.writeFile(content + "/" + relativePath, bytes, { mode: 0o600 }); await fs.writeFile(secretFile, token, { mode: 0o600 });
const request: StorageVerifyRequest = { schema: "saturn.storage-verify.v1", requestId: uid(), backendIdentity: "stage3-a-native", backendGeneration: uid(), ownerId: uid(), fencingToken: uid(), rootId: uid(), operationId: uid(), intentSha256: sha("original"), contentVersionId: uid(), relativePath, sizeBytes: String(bytes.length), sha256: sha(bytes), maximumBytes: String(bytes.length), timeoutMs: 30000, requireDurability: "file-sync" };
const owner = { schema: "saturn.storage-verifier-owner.v1", state: "ACTIVE", backendIdentity: request.backendIdentity, backendGeneration: request.backendGeneration, ownerId: request.ownerId, fencingToken: request.fencingToken };
await fs.writeFile(registry + "/owners/" + sha(request.backendIdentity) + ".json", JSON.stringify(owner), { mode: 0o600 });
const object = { contentVersionId: request.contentVersionId, relativePath, sizeBytes: request.sizeBytes, sha256: request.sha256 }, operation = { ...owner, schema: "saturn.storage-verifier-operation.v1", state: "SEALED", rootId: request.rootId, operationId: request.operationId, intentSha256: request.intentSha256 };
const save = async (value: object) => fs.writeFile(registry + "/operations/" + request.operationId + ".json", JSON.stringify(value), { mode: 0o600 });
const host = await createVerifierServer(parseHostConfig({ schema: "saturn.storage-verifier-host.v1", listenHost: "127.0.0.1", port: 12345, secretFile, registryDirectory: registry, roots: [{ rootId: request.rootId, backendIdentity: request.backendIdentity, directory: content, prefixes: ["private"] }], maximumActive: 4, maximumBytes: "1073741824" }));
await new Promise<void>(r => host.server.listen(0, "127.0.0.1", r)); const address = host.server.address(); assert(address && typeof address !== "string");
const client = new StorageVerifierClient({ url: `http://127.0.0.1:${String(address.port)}`, token }), results: { name: string; status: string }[] = [];
try {
  for (const count of [1, 16]) {
    await save({ ...operation, objects: [object, ...Array.from({ length: count - 1 }, () => ({ ...object, contentVersionId: uid() }))] });
    const result = await client.verify(request); assert.equal(result.sha256, sha(bytes)); assert.equal(result.durability, "file-sync"); results.push({ name: "A01/A12 objects[" + String(count) + "]", status: "PASS" });
  }
  await save({ ...operation, ...object }); assert.equal((await client.verify(request)).sha256, sha(bytes)); results.push({ name: "A12 single-object legacy registry", status: "PASS" });
  for (const count of [0, 17, 2]) {
    await save({ ...operation, objects: Array.from({ length: count }, () => object) });
    await assert.rejects(client.verify(request), { code: "identity_mismatch" }); results.push({ name: count === 2 ? "A01 duplicate exact object" : "A01 objects[" + String(count) + "]", status: "PASS" });
  }
  await save({ ...operation, objects: [object] });
  for (const field of ["ownerId", "rootId", "intentSha256"] as const) {
    await assert.rejects(client.verify({ ...request, [field]: field === "intentSha256" ? sha("wrong") : uid() }), { code: field === "rootId" ? "scope_denied" : "identity_mismatch" }); results.push({ name: "A01 wrong " + field, status: "PASS" });
  }
  await assert.rejects(client.verify({ ...request, authority: true } as StorageVerifyRequest), { code: "invalid_input" }); results.push({ name: "A01 extra HTTP authority", status: "PASS" });
  assert.equal(sha(await fs.readFile(content + "/" + relativePath)), request.sha256); assert.equal(host.verifier.activeRequests, 0);
  const result = { schema: "stage3-chat-a-k4-evidence.v1", platform: process.platform, cases: results, bytes: bytes.length, request, receipt: await client.verify(request), hostActive: host.verifier.activeRequests };
  await fs.writeFile("/work/result.json", JSON.stringify(result, null, 2)); console.log(JSON.stringify({ selected: results.length, passed: results.length, failed: 0, result: "/work/result.json" }));
} finally { await host.shutdown(); }
