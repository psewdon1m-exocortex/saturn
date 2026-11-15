import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database } from "../../../packages/database/src/index.js";
import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { CatalogFolderAuthorityIssuer } from "../../../packages/file-core/src/catalog-folder-authority.js";
import type { CatalogFolderRequestV2 } from "../../../packages/file-core/src/catalog-folder-v2-intent.js";
import { guardedSyncFolderHttp } from "./guarded-sync-folder-http.js";

async function fixture() {
  const app = Fastify(), rootId = randomUUID(), deviceId = randomUUID(), calls: CatalogFolderRequestV2[] = [];
  const binding: SyncRootBinding = { protocol: "neptune-sync/1", descriptor_schema: "saturn.current-namespace.v1", server_identity: "isolated-adapter-unit", root_id: rootId, server_epoch: randomUUID(), policy_version: "1", binding_version: randomUUID() };
  const input: CatalogFolderRequestV2 = { operationId: randomUUID(), idempotencyKey: "original-folder-key", rootId, epoch: randomUUID(), bindingVersion: randomUUID(), parentId: rootId, name: "e\u0301\ud83d\ude00", mode: "ensure", parentTopology: [{ nodeId: rootId, parentId: null, name: "fixture-root" }] };
  let authorizations = 0, unavailable = false, fault: string | undefined;
  // This unit only exercises the envelope and real private issuer identity.
  // Database/physical/CAS behavior has separate PostgreSQL/HTTP qualification.
  const authority = new CatalogFolderAuthorityIssuer({} as Database, { authenticateDevice: async authorization => {
    authorizations++;
    if (authorization !== "Bearer fixture") throw Object.assign(new Error("denied"), { code: "authority_invalid" });
    return { device: { id: deviceId, tokenHash: "a".repeat(64), deviceKind: "windows_sync", syncRootId: rootId, scopeIds: [rootId], rights: { write: true } } };
  } });
  await app.register(guardedSyncFolderHttp, { root: async requested => requested === rootId && !unavailable ? { binding, authority, files: { ensureCatalogFolderV2: async (original, proof) => {
    expect(authority.actor(proof, rootId)).toEqual({ type: "device_token", id: deviceId });
    if (fault) throw Object.assign(new Error("private-diagnostic-never-exported"), { code: fault });
    calls.push(original);
    return { replayed: calls.length > 1, result: { schema: "saturn.catalog-folder-result.v2", operationId: original.operationId, intentHash: "b".repeat(64), rootId, status: "EXISTING", description: { node_id: deviceId, parent_id: rootId, name: original.name, type: "folder", size_bytes: "0", content_sha256: null, content_version_id: null, version: randomUUID(), availability: "AVAILABLE" } } };
  } } } : undefined });
  const send = (payload: unknown = { binding, input }, authorization = "Bearer fixture") => app.inject({ method: "POST", url: `/sync/v1/roots/${rootId}/directories/ensure-v2`, headers: { "content-type": "application/json", authorization }, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });
  return { app, binding, input, calls, send, authorizations: () => authorizations, unavailable: () => { unavailable = true; }, fault: (code: string) => { fault = code; } };
}
describe("guarded modern folder HTTP envelope", () => {
  it("preserves original binding, exact Unicode and UUID on replay while obtaining current private proof", async () => {
    const f = await fixture(); try {
      const first = await f.send(), replay = await f.send();
      expect(first.statusCode).toBe(200); expect(first.headers["cache-control"]).toBe("no-store"); expect(replay.json<{replayed:boolean}>().replayed).toBe(true);
      expect(f.calls).toEqual([f.input, f.input]); expect(f.authorizations()).toBe(2);
      expect(f.calls[0]?.bindingVersion).not.toBe(f.binding.binding_version); expect(first.body).not.toContain("claimToken");
    } finally { await f.app.close(); }
  });
  it("refuses foreign outer binding and foreign sealed root before a command", async () => {
    const f = await fixture(); try {
      expect((await f.send({ binding: { ...f.binding, binding_version: randomUUID() }, input: f.input })).statusCode).toBe(409);
      expect((await f.send({ binding: f.binding, input: { ...f.input, rootId: randomUUID() } })).statusCode).toBe(400); expect(f.calls).toHaveLength(0);
    } finally { await f.app.close(); }
  });
  it("authenticates every accepted-result replay and refuses unavailable roots", async () => {
    const f = await fixture(); try {
      expect((await f.send()).statusCode).toBe(200); expect((await f.send(undefined, "Bearer revoked")).statusCode).toBe(401);
      f.unavailable(); expect((await f.send()).statusCode).toBe(410); expect(f.calls).toHaveLength(1);
    } finally { await f.app.close(); }
  });
  it("rejects duplicate keys, old parent-only input and caller-supplied authority", async () => {
    const f = await fixture(); try {
      const json = JSON.stringify({ binding: f.binding, input: f.input });
      expect((await f.send(json.replace('"mode":"ensure"', '"mode":"create","mode":"ensure"'))).statusCode).toBe(400);
      const old={...f.input,parentTopology:undefined};
      expect((await f.send({ binding: f.binding, input: old })).statusCode).toBe(400);
      expect((await f.send({ binding: f.binding, input: { ...f.input, actor: { type: "owner_web", id: "owner" } } })).statusCode).toBe(400); expect(f.calls).toHaveLength(0);
    } finally { await f.app.close(); }
  });
  it("rejects oversized bodies before the issuer and SQL coordinator", async () => {
    const f = await fixture(); try {
      expect((await f.send(" ".repeat(40 * 1024 + 1))).statusCode).toBe(413); expect(f.authorizations()).toBe(0); expect(f.calls).toHaveLength(0);
    } finally { await f.app.close(); }
  });
  it.each([["authorization_changed", 403], ["membership_changed", 409], ["counter_exhausted", 409], ["admission_full", 429], ["private_fault", 500]] as const)("maps %s without leaking private diagnostics", async (code, status) => {
    const f = await fixture(); try {
      f.fault(code); const response = await f.send(); expect(response.statusCode).toBe(status); expect(response.body).not.toContain("private-diagnostic"); expect(response.json<{code:string}>().code).toBe(status === 500 ? "sync_internal_error" : code);
    } finally { await f.app.close(); }
  });
});
