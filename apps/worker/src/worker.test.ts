import { afterEach, describe, expect, it } from "vitest";
import type { SaturnConfig } from "@saturn/config";
import { buildWorker, type WorkerDatabasePort } from "./worker.js";

const config = {
  logLevel: "silent",
  readinessRequireStorage: true,
  readinessTimeoutMs: 3_000,
  worker: { heartbeatIntervalMs: 5_000 },
} as SaturnConfig;

const openApps: Array<ReturnType<typeof buildWorker>["app"]> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function database(overrides: Partial<WorkerDatabasePort> = {}): WorkerDatabasePort {
  return {
    ping: async () => 2,
    upsertWorkerHeartbeat: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

describe("worker health", () => {
  it("exposes independent liveness and readiness", async () => {
    const runtime = buildWorker(config, database(), { check: async () => ({ state: "pass" }) });
    openApps.push(runtime.app);
    const live = await runtime.app.inject({ method: "GET", url: "/health/live" });
    const ready = await runtime.app.inject({ method: "GET", url: "/health/ready" });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ok", checks: { database: { state: "pass" } } });
  });

  it("returns 503 when a required dependency is down", async () => {
    const runtime = buildWorker(
      config,
      database({ ping: async () => { throw new Error("offline"); } }),
      { check: async () => ({ state: "fail", detail: "storage_unavailable" }) },
    );
    openApps.push(runtime.app);
    const response = await runtime.app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      checks: { database: { state: "fail" }, storage: { state: "fail" } },
    });
  });

  it("returns bounded 503 when dependency checks stall", async () => {
    const stalled = new Promise<never>(() => undefined);
    const runtime = buildWorker(
      { ...config, readinessTimeoutMs: 10 },
      database({ ping: async () => stalled }),
      { check: async () => stalled },
    );
    openApps.push(runtime.app);
    const started = performance.now();
    const response = await runtime.app.inject({ method: "GET", url: "/health/ready" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(response.statusCode).toBe(503);
  });
});
