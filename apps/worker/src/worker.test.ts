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
  it("cancels reconciliation on close, joins its in-flight item, and starts no later maintenance step", async () => {
    let enter!: () => void, release!: () => void, observed: AbortSignal | undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const closed = vi.fn(async () => undefined), scrub = vi.fn(async () => undefined), purge = vi.fn(async () => undefined);
    const runtime = buildWorker({ ...config, worker: { ...config.worker, reconciliationIntervalMs: 5 } }, database({ close: closed }),
      { check: async () => ({ state: "pass" }) }, { reconcile: async signal => { observed = signal;enter();await held;signal?.throwIfAborted(); }, scrub, purge });
    await runtime.app.ready();runtime.startBackgroundJobs();await entered;
    const closing = runtime.app.close();
    try { await vi.waitFor(() => expect(observed?.aborted).toBe(true));expect(closed).not.toHaveBeenCalled(); }
    finally { release();await closing; }
    expect(closed).toHaveBeenCalledOnce();expect(scrub).not.toHaveBeenCalled();expect(purge).not.toHaveBeenCalled();
  });

  it("still joins an accepted transfer instead of aborting it when reconciliation is cancelled", async () => {
    let release!: () => void;const held = new Promise<void>(resolve => { release = resolve; });
    const closed = vi.fn(async () => undefined);let completed = false;
    const runtime = buildWorker({ ...config, worker: { ...config.worker, reconciliationIntervalMs: 60000 }, drop: { drainIntervalMs: 60000 } as SaturnConfig["drop"] },
      database({ close: closed }), { check: async () => ({ state: "pass" }) }, { reconcile: async () => undefined, drain: async () => { await held;completed = true; } });
    await runtime.app.ready();runtime.startBackgroundJobs();await Promise.resolve();const closing = runtime.app.close();
    try { await new Promise(resolve => setTimeout(resolve, 20));expect(completed).toBe(false);expect(closed).not.toHaveBeenCalled(); }
    finally { release();await closing; }
    expect(completed).toBe(true);expect(closed).toHaveBeenCalledOnce();
  });
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

  it.each(["archive", "sharePackage"] as const)("keeps draining later Drop work during a held %s, without overlapping drainers or heavy jobs", async (heavyKind) => {
    let releaseHeavy!: () => void, releaseDrop!: () => void, enteredHeavy!: () => void, enteredDrop!: () => void;
    const heavyHeld = new Promise<void>(resolve => { releaseHeavy = resolve; });
    const dropHeld = new Promise<void>(resolve => { releaseDrop = resolve; });
    const heavyEntered = new Promise<void>(resolve => { enteredHeavy = resolve; });
    const dropEntered = new Promise<void>(resolve => { enteredDrop = resolve; });
    let drains = 0, liveDrains = 0, maxDrains = 0, liveHeavy = 0, maxHeavy = 0;
    const archive = vi.fn(async () => {
      liveHeavy++;maxHeavy = Math.max(maxHeavy, liveHeavy);
      try { if (heavyKind === "archive") { enteredHeavy();await heavyHeld; } } finally { liveHeavy--; }
    });
    const sharePackage = vi.fn(async () => {
      liveHeavy++;maxHeavy = Math.max(maxHeavy, liveHeavy);
      try { if (heavyKind === "sharePackage") { enteredHeavy();await heavyHeld; } } finally { liveHeavy--; }
    });
    const transferLocks: string[] = [];
    const runtime = buildWorker({ ...config, worker: { ...config.worker, reconciliationIntervalMs: 60_000 }, drop: { drainIntervalMs: 5 } as SaturnConfig["drop"] },
      database({ withAdvisoryLock: async (key, action) => { transferLocks.push(key);return action(); } }),
      { check: async () => ({ state: "pass" }) }, {
        reconcile: async () => undefined, archive, sharePackage,
        drain: async () => {
          drains++;liveDrains++;maxDrains = Math.max(maxDrains, liveDrains);
          try { if (drains === 2) { enteredDrop();await dropHeld; } } finally { liveDrains--; }
        },
      });
    await runtime.app.ready();runtime.startBackgroundJobs();
    try {
      await heavyEntered;
      await vi.waitFor(() => expect(drains).toBe(2), { timeout: 1000, interval: 5 });await dropEntered;
      expect(liveHeavy).toBe(1);expect(liveDrains).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(drains).toBe(2);expect(maxDrains).toBe(1);expect(maxHeavy).toBe(1);
      expect(transferLocks).toEqual(["saturn-worker:transfers"]);
      expect(archive).toHaveBeenCalledOnce();
      expect(sharePackage).toHaveBeenCalledTimes(heavyKind === "archive" ? 0 : 1);
    } finally { releaseHeavy();releaseDrop();await runtime.app.close(); }
    expect(maxDrains).toBe(1);expect(maxHeavy).toBe(1);
  });

  it("joins both accepted Drop and package work on shutdown, retaining the shared maintenance and transfers locks until both finish", async () => {
    let releaseHeavy!: () => void, releaseDrop!: () => void;
    const heavyHeld = new Promise<void>(resolve => { releaseHeavy = resolve; });
    const dropHeld = new Promise<void>(resolve => { releaseDrop = resolve; });
    let drains = 0, packageStarted = false, lockHeld = false, maintenanceHeld = false;
    const closed = vi.fn(async () => { expect(lockHeld).toBe(false);expect(maintenanceHeld).toBe(false); });
    const runtime = buildWorker({ ...config, worker: { ...config.worker, reconciliationIntervalMs: 60_000 }, drop: { drainIntervalMs: 5 } as SaturnConfig["drop"] },
      database({ close: closed,
        withAdvisoryLock: async (key, action) => { expect(key).toBe("saturn-worker:transfers");lockHeld = true;try { return await action(); } finally { lockHeld = false; } },
        withSharedMaintenance: async action => { maintenanceHeld = true;try { return await action(); } finally { maintenanceHeld = false; } },
      }), { check: async () => ({ state: "pass" }) }, {
        reconcile: async () => undefined,
        drain: async () => { drains++;if (drains === 2) await dropHeld; },
        sharePackage: async () => { packageStarted = true;await heavyHeld; },
      });
    await runtime.app.ready();runtime.startBackgroundJobs();let closing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => { expect(packageStarted).toBe(true);expect(drains).toBe(2); }, { timeout: 1000, interval: 5 });
      closing = runtime.app.close();await new Promise(resolve => setTimeout(resolve, 20));
      expect(closed).not.toHaveBeenCalled();expect(lockHeld).toBe(true);expect(maintenanceHeld).toBe(true);
      releaseHeavy();await new Promise(resolve => setTimeout(resolve, 20));
      expect(closed).not.toHaveBeenCalled();expect(lockHeld).toBe(true);expect(maintenanceHeld).toBe(true);expect(drains).toBe(2);
    } finally { releaseHeavy();releaseDrop();await (closing ?? runtime.app.close()); }
    expect(closed).toHaveBeenCalledOnce();expect(drains).toBe(2);
  });

  it("keeps the existing distributed transfers key while another worker holds a package", async () => {
    let release!: () => void;const held = new Promise<void>(resolve => { release = resolve; });
    let owner: string | undefined, packageStarted = false;
    const keys: string[] = [], competitorDrop = vi.fn(async () => undefined), competitorPackage = vi.fn(async () => undefined);
    const lockedDatabase = (id: string) => database({ withAdvisoryLock: async (key, action) => {
      keys.push(key);if (owner !== undefined) throw new Error("advisory_lock_busy");owner = id;
      try { return await action(); } finally { owner = undefined; }
    } });
    const settings = { ...config, worker: { ...config.worker, reconciliationIntervalMs: 60_000 }, drop: { drainIntervalMs: 5 } as SaturnConfig["drop"] };
    const first = buildWorker(settings, lockedDatabase("first"), { check: async () => ({ state: "pass" }) }, {
      reconcile: async () => undefined, drain: async () => undefined, sharePackage: async () => { packageStarted = true;await held; },
    });
    const second = buildWorker(settings, lockedDatabase("second"), { check: async () => ({ state: "pass" }) }, {
      reconcile: async () => undefined, drain: competitorDrop, sharePackage: competitorPackage,
    });
    await Promise.all([first.app.ready(), second.app.ready()]);first.startBackgroundJobs();
    try {
      await vi.waitFor(() => expect(packageStarted).toBe(true), { timeout: 1000, interval: 5 });second.startBackgroundJobs();
      await vi.waitFor(() => expect(keys.length).toBeGreaterThan(2), { timeout: 1000, interval: 5 });
      expect(owner).toBe("first");expect(new Set(keys)).toEqual(new Set(["saturn-worker:transfers"]));
      expect(competitorDrop).not.toHaveBeenCalled();expect(competitorPackage).not.toHaveBeenCalled();
    } finally { const closing = Promise.all([first.app.close(), second.app.close()]);release();await closing; }
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
