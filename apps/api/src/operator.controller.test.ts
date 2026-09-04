import "reflect-metadata";
import { SELF_DECLARED_DEPS_METADATA } from "@nestjs/common/constants.js";
import type { AuditService } from "@saturn/audit";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import type { StorageAdapter } from "@saturn/storage";
import { describe, expect, it, vi } from "vitest";
import { OperatorController } from "./operator.controller.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";

describe("OperatorController overview", () => {
  it("declares transfer telemetry injection and returns independent host and storage metrics", async () => {
    const dependencies = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, OperatorController) as readonly { readonly index: number; readonly param: unknown }[];
    expect(dependencies).toContainEqual({ index: 3, param: TransferMonitorService });

    const withSql = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ used_bytes: "4096", file_count: "2" }]);
    const controller = new OperatorController(
      { withSql } as unknown as Database,
      {} as SaturnConfig,
      { write: vi.fn() } as unknown as AuditService,
      new TransferMonitorService(),
      { statFs: vi.fn().mockResolvedValue({ totalBytes: 16_384, availableBytes: 8_192 }) } as unknown as StorageAdapter,
    );

    const result = await controller.overview();
    expect(result.cpu.state).toBe("available");
    expect(result.ram.state).toBe("available");
    expect(result.uptime.state).toBe("available");
    expect(result.storage).toMatchObject({ state: "available", indexedBytes: 4096, fileCount: 2 });
    expect(result.storage.capacity).toMatchObject({ state: "available", totalBytes: 16_384, availableBytes: 8_192, usedBytes: 8_192 });
    expect(result.transfers).toMatchObject({ activeCount: 0, queuedCount: 0, tasks: [] });
    if (result.disk.state === "available") {
      expect(result.disk.totalBytes).toBeGreaterThan(0);
      expect(result.disk.usedBytes).toBeGreaterThanOrEqual(0);
    }
  });
});
