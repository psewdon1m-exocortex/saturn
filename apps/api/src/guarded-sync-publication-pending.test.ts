import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { CatalogRootAdmission } from "../../../packages/file-core/src/catalog-root-admission.js";
import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { guardedSyncHttp, type GuardedSyncHttpRoot } from "./guarded-sync-http.js";

async function fixture(admitted = true) {
  const app = Fastify();
  const binding: SyncRootBinding = { protocol: "neptune-sync/1", descriptor_schema: "saturn.current-namespace.v1", server_identity: "publication-read", root_id: randomUUID(), server_epoch: randomUUID(), policy_version: "1", binding_version: randomUUID() };
  const state = { pending: true, pendingDuringRead: true, code: "reconciliation_required", calls: 0 };
  const denied = async () => { state.calls++; state.pending = state.pendingDuringRead; await Promise.resolve(); throw Object.assign(Error(state.code), { code: state.code }); };
  const root = { binding, ...(admitted ? { admission: new CatalogRootAdmission() } : {}), authority: { device: async () => ({}) }, stage: { start: denied, step: denied }, reader: { ready: denied, entries: denied, changes: denied, changesAvailable: denied }, streams: { get hasPendingCompletion() { return state.pending; } } } as unknown as GuardedSyncHttpRoot;
  await app.register(guardedSyncHttp, { root: async () => root });
  const post = (endpoint: string) => app.inject({ method: "POST", url: `/sync/v1/roots/${binding.root_id}/${endpoint}`, payload: { binding, ...(endpoint.startsWith("snapshots/") ? { snapshot_id: randomUUID() } : { cursor: "opaque" }) } });
  return { app, post, state };
}

it.each(["snapshots/start", "snapshots/step", "snapshots/ready", "entries", "changes"])("refuses %s with a retry hint during an owned publication without returning namespace data", async endpoint => {
  const f = await fixture();
  try {
    const response = await f.post(endpoint);
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ code: "publication_pending", retry_after_ms: 2000 });
    expect(f.state.calls).toBe(1);
  } finally { await f.app.close(); }
});

it.each([[true, false], [false, true]])("retains the retry classification across a completion transition %s to %s", async (before, during) => {
  const f = await fixture();
  try {
    f.state.pending = before; f.state.pendingDuringRead = during;
    const response = await f.post("changes");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "publication_pending", retry_after_ms: 2000 });
  } finally { await f.app.close(); }
});

it("keeps an unowned reconciliation failure terminal", async () => {
  const f = await fixture();
  try {
    f.state.pending = false; f.state.pendingDuringRead = false;
    const response = await f.post("changes");
    expect(response.statusCode).toBe(409); expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.json()).toEqual({ code: "reconciliation_required" });
  } finally { await f.app.close(); }
});

it.each([["binding_invalid", 409], ["authority_invalid", 401], ["authorization_changed", 403], ["journal_gap", 409], ["stage_unavailable", 410]] as const)("preserves %s while a publication is active", async (code, status) => {
  const f = await fixture();
  try { f.state.code = code; const response = await f.post("changes"); expect(response.statusCode).toBe(status); expect(response.headers["retry-after"]).toBeUndefined(); expect(response.json()).toEqual({ code }); }
  finally { await f.app.close(); }
});

it("preserves refusal and retry classification in a composition without a local writer queue", async () => {
  const f = await fixture(false);
  try { const response = await f.post("changes"); expect(response.statusCode).toBe(503); expect(response.json()).toEqual({ code: "publication_pending", retry_after_ms: 2000 }); }
  finally { await f.app.close(); }
});
