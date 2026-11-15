import { expect, it } from "vitest";
import type { SaturnConfig } from "@saturn/config";
import { buildWorker } from "./worker.js";

const config = { logLevel: "silent", readinessTimeoutMs: 30, readinessRequireStorage: true, worker: { heartbeatIntervalMs: 5000 } } as SaturnConfig;
const database = { ping: async () => 1, upsertWorkerHeartbeat: async () => undefined, close: async () => undefined };

it("refuses readiness when the guarded owner is unhealthy despite healthy database and raw storage", async () => {
  const jobs = { reconcile: async () => undefined, ready: async () => { throw Error("backend_owner_unavailable"); } };
  const worker = buildWorker(config, database, { check: async () => ({ state: "pass" }) }, jobs);
  try {
    expect((await worker.app.inject("/health/live")).statusCode).toBe(200);
    const response = await worker.app.inject("/health/ready");
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ checks: { backend: { state: "fail", detail: "backend_owner_unavailable" }, database: { state: "pass" }, storage: { state: "pass" } } });
  } finally { await worker.app.close(); }
});

it("bounds a stalled owner check and recovers readiness only after the owner check passes", async () => {
  let stalled = true;
  const jobs = { reconcile: async () => undefined, ready: async () => { if (stalled) await new Promise<void>(() => undefined); } };
  const worker = buildWorker(config, database, { check: async () => ({ state: "pass" }) }, jobs);
  try {
    expect((await worker.app.inject("/health/ready")).statusCode).toBe(503);
    stalled = false;
    const ready = await worker.app.inject("/health/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ checks: { backend: { state: "pass" } } });
  } finally { await worker.app.close(); }
});
