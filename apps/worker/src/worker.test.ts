import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("continues independent maintenance steps after a reconciliation or scrub failure", async () => {
    const purge = vi.fn(async () => undefined), maintain = vi.fn(async () => undefined);
    const scrub = vi.fn(async () => { throw new Error("storage unavailable"); });
    const runtime = buildWorker({ ...config, worker: { ...config.worker, reconciliationIntervalMs: 10 } },
      database(), { check: async () => ({ state: "pass" }) }, {
        reconcile: async () => { throw new Error("interrupted run"); }, scrub, purge, maintain,
      });
    openApps.push(runtime.app);
    runtime.startBackgroundJobs();
    await vi.waitFor(() => expect(maintain).toHaveBeenCalled());
    expect(scrub).toHaveBeenCalled();
    expect(purge).toHaveBeenCalled();
  });

  it("continues archive and shared package processing when Drop delivery fails", async () => {
    const archive = vi.fn(async () => undefined), sharePackage = vi.fn(async () => undefined);
    const runtime = buildWorker({ ...config, drop: { drainIntervalMs: 60_000 } as SaturnConfig["drop"] },
      database(), { check: async () => ({ state: "pass" }) }, {
        reconcile: async () => undefined, drain: async () => { throw new Error("Drop unavailable"); }, archive, sharePackage,
      });
    openApps.push(runtime.app);
    runtime.startBackgroundJobs();
    await vi.waitFor(() => expect(sharePackage).toHaveBeenCalled());
    expect(archive).toHaveBeenCalled();
  });

  it("runs catalog tasks outside the outer shared barrier so their atomic commit can acquire exclusive maintenance", async () => {
    const shared = vi.fn(async (action: () => Promise<unknown>) => action());
    const task = vi.fn(async () => undefined);
    const runtime = buildWorker({ ...config, worker: { ...config.worker, reconciliationIntervalMs: 60_000 } },
      database({ withSharedMaintenance: shared as NonNullable<WorkerDatabasePort["withSharedMaintenance"]> }),
      { check: async () => ({ state: "pass" }) }, { reconcile: async () => undefined, storageCatalog: task });
    openApps.push(runtime.app);
    runtime.startBackgroundJobs();
    await Promise.resolve();
    expect(task).toHaveBeenCalledOnce();
    expect(shared).not.toHaveBeenCalled();
  });
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
