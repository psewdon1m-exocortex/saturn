import type { BackupIngestService } from "@saturn/backup-ingest";
import type { Database } from "@saturn/database";
import { expect, it, vi } from "vitest";
import { BackupMaintenanceService } from "./backup-maintenance.service.js";

it("holds the restore barrier throughout both storage reconciliation and retention", async () => {
  let protectedByBarrier = false;
  const database = { withSharedMaintenance: vi.fn(async (action: () => Promise<void>) => {
    protectedByBarrier = true; try { await action(); } finally { protectedByBarrier = false; }
  }) };
  const backups = {
    reconcileCatalog: vi.fn(async () => { expect(protectedByBarrier).toBe(true); return { scanned: 0, published: 0, failed: 0 }; }),
    applyRetention: vi.fn(async () => { expect(protectedByBarrier).toBe(true); return { candidates: 0, purged: 0, failed: 0 }; }),
  };
  const maintenance = new BackupMaintenanceService(backups as unknown as BackupIngestService, database as unknown as Database);
  try { await maintenance.onApplicationBootstrap(); }
  finally { maintenance.onApplicationShutdown(); }
  expect(database.withSharedMaintenance).toHaveBeenCalledOnce(); expect(backups.applyRetention).toHaveBeenCalledOnce(); expect(protectedByBarrier).toBe(false);
});
