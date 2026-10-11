import type { BackupIngestService } from "@saturn/backup-ingest";
import type { Database } from "@saturn/database";
import { expect, it, vi } from "vitest";
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
  finally { maintenance.onApplicationShutdown(); }
  expect(database.withSharedMaintenance).toHaveBeenCalledOnce(); expect(backups.expireIncompleteRuns).toHaveBeenCalledOnce(); expect(backups.applyRetention).toHaveBeenCalledOnce(); expect(protectedByBarrier).toBe(false);
});
