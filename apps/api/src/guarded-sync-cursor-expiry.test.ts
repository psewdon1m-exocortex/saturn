import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { SyncCursorError } from "../../../packages/sync/src/sync-cursor.js";
import { guardedSyncHttp, type GuardedSyncHttpRoot } from "./guarded-sync-http.js";

describe("snapshot cursor error envelope", () => {
  it.each(["snapshots/ready", "entries", "changes"])("returns recoverable expiry from %s", async route => {
    const app = Fastify();
    const binding: SyncRootBinding = { protocol: "neptune-sync/1", descriptor_schema: "saturn.current-namespace.v1",
      server_identity: "expiry-fixture", root_id: randomUUID(), server_epoch: randomUUID(), policy_version: "1", binding_version: randomUUID() };
    const fail = async () => { throw new SyncCursorError("expired"); };
    const root = { binding, authority: { device: async () => ({}) }, reader: { ready: fail, entries: fail, changes: fail } } as unknown as GuardedSyncHttpRoot;
    await app.register(guardedSyncHttp, { root: async () => root });
    try {
      const response = await app.inject({ method: "POST", url: `/sync/v1/roots/${binding.root_id}/${route}`,
        payload: route === "snapshots/ready" ? { binding, snapshot_id: randomUUID() } : { binding, cursor: "opaque" } });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toEqual({ code: "cursor_expired" });
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally { await app.close(); }
  });

  it("does not classify an unrelated expired error as cursor authority", async () => {
    const app = Fastify();
    const binding: SyncRootBinding = { protocol: "neptune-sync/1", descriptor_schema: "saturn.current-namespace.v1",
      server_identity: "expiry-fixture", root_id: randomUUID(), server_epoch: randomUUID(), policy_version: "1", binding_version: randomUUID() };
    const root = { binding, authority: { device: async () => { throw Object.assign(new Error("private"), { code: "expired" }); } } } as unknown as GuardedSyncHttpRoot;
    await app.register(guardedSyncHttp, { root: async () => root });
    try {
      const response = await app.inject({ method: "POST", url: `/sync/v1/roots/${binding.root_id}/snapshots/ready`, payload: { binding, snapshot_id: randomUUID() } });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ code: "sync_internal_error" });
    } finally { await app.close(); }
  });
});
