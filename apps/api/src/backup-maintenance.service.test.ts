import type { BackupIngestService } from "@saturn/backup-ingest";
import type { Database } from "@saturn/database";
import { Logger } from "@nestjs/common";
import { afterEach, expect, it, vi } from "vitest";
import { BackupMaintenanceService } from "./backup-maintenance.service.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";

it("holds the restore barrier throughout both storage reconciliation and retention", async () => {
  let protectedByBarrier = false;
  const database = { withSharedMaintenance: vi.fn(async (action: () => Promise<void>) => {
    protectedByBarrier = true; try { await action(); } finally { protectedByBarrier = false; }
  }) };
  const backups = {
    expireIncompleteRuns: vi.fn(async (_now: Date, isPaused: (runId: string) => boolean) => {
      expect(protectedByBarrier).toBe(true); expect(isPaused("paused-run")).toBe(true); expect(isPaused("running-run")).toBe(false);
      return { scanned: 0, expired: 0, recovered: 0, failed: 0 };
    }),
    reconcileCatalog: vi.fn(async () => { expect(protectedByBarrier).toBe(true); return { scanned: 0, published: 0, failed: 0 }; }),
    applyRetention: vi.fn(async () => { expect(protectedByBarrier).toBe(true); return { candidates: 0, purged: 0, failed: 0 }; }),
  };
  const transfers = new TransferMonitorService(); transfers.control("backup:paused-run", "pause");
  const maintenance = new BackupMaintenanceService(backups as unknown as BackupIngestService, database as unknown as Database, transfers);
  try { await maintenance.onApplicationBootstrap(); }
  finally { await maintenance.onApplicationShutdown(); }
  expect(database.withSharedMaintenance).toHaveBeenCalledOnce(); expect(backups.expireIncompleteRuns).toHaveBeenCalledOnce(); expect(backups.applyRetention).toHaveBeenCalledOnce(); expect(protectedByBarrier).toBe(false);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = () => { done(); }; });
  return { promise, resolve };
}

function controlledMaintenance() {
  const started = deferred(), released = deferred();
  let blocked = false, fails = false, barriers = 0;
  const backups = {
    expireIncompleteRuns: vi.fn(async () => {
      if (blocked) {
        started.resolve(); await released.promise;
        if (fails) throw new Error("deferred maintenance failure");
      }
      return { scanned: 0, expired: 0, recovered: 0, failed: 0 };
    }),
    reconcileCatalog: vi.fn(async () => ({ scanned: 0, published: 0, failed: 0 })),
    applyRetention: vi.fn(async () => ({ candidates: 0, purged: 0, failed: 0 })),
  };
  const database = { withSharedMaintenance: vi.fn(async (action: () => Promise<void>) => {
    barriers++; try { await action(); } finally { barriers--; }
  }) };
  const maintenance = new BackupMaintenanceService(backups as unknown as BackupIngestService,
    database as unknown as Database, new TransferMonitorService());
  return { maintenance, backups, database, started, released,
    block: (fail = false) => { blocked = true; fails = fail; },
    barriers: () => barriers,
    drain: async () => { await Promise.allSettled(database.withSharedMaintenance.mock.results.map(result => result.type === "return" ? result.value : Promise.resolve())); },
  };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("joins deferred startup maintenance before shutdown releases its restore barrier", async () => {
  vi.useFakeTimers(); const f = controlledMaintenance(); f.block();
  const bootstrap = f.maintenance.onApplicationBootstrap(); await f.started.promise;
  let shutdownFinished = false;
  const shutdown = Promise.resolve(f.maintenance.onApplicationShutdown()).then(() => { shutdownFinished = true; });
  try {
    await Promise.resolve();
    expect(shutdownFinished).toBe(false); expect(f.barriers()).toBe(1);
  } finally {
    f.released.resolve(); await bootstrap; await shutdown; await f.drain();
    await f.maintenance.onApplicationShutdown();
  }
  expect(f.barriers()).toBe(0);
  expect(f.backups.applyRetention).toHaveBeenCalledOnce();
});

it("does not rearm the interval when shutdown races deferred bootstrap", async () => {
  vi.useFakeTimers(); const f = controlledMaintenance(); f.block();
  const bootstrap = f.maintenance.onApplicationBootstrap(); await f.started.promise;
  const shutdown = f.maintenance.onApplicationShutdown();
  try {
    f.released.resolve(); await bootstrap; await shutdown;
    expect(vi.getTimerCount()).toBe(0);
  } finally { await f.maintenance.onApplicationShutdown(); await f.drain(); }
});

it("joins the same deferred interval pass for concurrent shutdown callers", async () => {
  vi.useFakeTimers(); const f = controlledMaintenance(); await f.maintenance.onApplicationBootstrap();
  f.block(); vi.advanceTimersByTime(15 * 60_000); await f.started.promise;
  let completed = 0;
  const shutdowns = [f.maintenance.onApplicationShutdown(), f.maintenance.onApplicationShutdown()]
    .map(async shutdown => { await shutdown; completed++; });
  try {
    await Promise.resolve(); expect(completed).toBe(0); expect(f.barriers()).toBe(1);
    f.released.resolve(); await Promise.all(shutdowns); await f.drain();
    expect(completed).toBe(2); expect(f.barriers()).toBe(0);
    vi.advanceTimersByTime(60 * 60_000);
    expect(f.backups.expireIncompleteRuns).toHaveBeenCalledTimes(2);
  } finally { f.released.resolve(); await Promise.all(shutdowns); await f.drain(); await f.maintenance.onApplicationShutdown(); }
});

it("awaits deferred maintenance errors and barrier cleanup during shutdown", async () => {
  vi.useFakeTimers(); const log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  const f = controlledMaintenance(); await f.maintenance.onApplicationBootstrap();
  f.block(true); vi.advanceTimersByTime(15 * 60_000); await f.started.promise;
  let shutdownFinished = false;
  const shutdown = Promise.resolve(f.maintenance.onApplicationShutdown()).then(() => { shutdownFinished = true; });
  try {
    await Promise.resolve(); expect(shutdownFinished).toBe(false);
    f.released.resolve(); await shutdown; await f.drain();
    expect(f.barriers()).toBe(0);
    expect(log).toHaveBeenCalledWith("Backup catalog reconciliation failed", expect.stringContaining("deferred maintenance failure"));
    expect(f.backups.reconcileCatalog).toHaveBeenCalledOnce();
    expect(f.backups.applyRetention).toHaveBeenCalledOnce();
  } finally { f.released.resolve(); await shutdown; await f.drain(); await f.maintenance.onApplicationShutdown(); }
});

it("refuses an already queued interval callback after shutdown has completed", async () => {
  vi.useFakeTimers(); const intervals = vi.spyOn(globalThis, "setInterval"); const f = controlledMaintenance();
  await f.maintenance.onApplicationBootstrap();
  const callback = intervals.mock.calls[0]?.[0];
  expect(typeof callback).toBe("function");
  await f.maintenance.onApplicationShutdown();
  if (typeof callback === "function") callback();
  await f.drain();
  expect(f.backups.expireIncompleteRuns).toHaveBeenCalledOnce();
  expect(f.backups.applyRetention).toHaveBeenCalledOnce();
});
