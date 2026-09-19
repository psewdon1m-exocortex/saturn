import "reflect-metadata";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SELF_DECLARED_DEPS_METADATA } from "@nestjs/common/constants.js";
import type { AuditService } from "@saturn/audit";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import type { RuntimeStorageManager } from "@saturn/storage";
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ used_bytes: "4096", file_count: "2", directory_count: "6" }]);
    const controller = new OperatorController(
      { withSql } as unknown as Database,
      { environment: "development" } as SaturnConfig,
      { write: vi.fn() } as unknown as AuditService,
      new TransferMonitorService(),
      {
        current: vi.fn().mockReturnValue({ config: { host: "storage.example" } }),
        statFs: vi.fn().mockResolvedValue({ totalBytes: 16_384, availableBytes: 8_192 }),
      } as unknown as RuntimeStorageManager,
      { check: vi.fn().mockResolvedValue({ state: "pass", latencyMs: 4 }) },
    );

    const result = await controller.overview();
    expect(result.cpu.state).toBe("available");
    expect(result.ram.state).toBe("available");
    expect(result.uptime.state).toBe("available");
    expect(result.storage).toMatchObject({ state: "available", indexedBytes: 4096, fileCount: 2, directoryCount: 6 });
    expect(result.storage.capacity).toMatchObject({ state: "available", totalBytes: 16_384, availableBytes: 8_192, usedBytes: 8_192 });
    expect(result.storageReachability).toMatchObject({ state: "available", latencyMs: 4 });
    expect(result.transfers).toMatchObject({ activeCount: 0, queuedCount: 0, tasks: [] });
    if (result.disk.state === "available") {
      expect(result.disk.totalBytes).toBeGreaterThan(0);
      expect(result.disk.usedBytes).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not expose the host disk as capacity for the local DEV SFTP profile", async () => {
    const withSql = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ used_bytes: "20552089", file_count: "7", directory_count: "6" }]);
    const statFs = vi.fn().mockResolvedValue({ totalBytes: 1_000_081_453_056, availableBytes: 104_079_671_296 });
    const controller = new OperatorController(
      { withSql } as unknown as Database,
      { environment: "development" } as SaturnConfig,
      { write: vi.fn() } as unknown as AuditService,
      new TransferMonitorService(),
      {
        current: vi.fn().mockReturnValue({ config: { host: "127.0.0.1" } }),
        statFs,
      } as unknown as RuntimeStorageManager,
      { check: vi.fn().mockResolvedValue({ state: "fail", detail: "storage_unavailable" }) },
    );

    const result = await controller.overview();
    expect(statFs).not.toHaveBeenCalled();
    expect(result.storage).toMatchObject({
      state: "available",
      indexedBytes: 20_552_089,
      fileCount: 7,
      directoryCount: 6,
      capacity: { state: "unavailable" },
    });
    expect(result.storageReachability).toEqual({ state: "unavailable", reason: "storage_unavailable" });
    if (result.storage.capacity.state !== "unavailable") throw new Error("Local DEV capacity was unexpectedly exposed");
    expect(result.storage.capacity.reason).toContain("Local DEV SFTP");
  });

  it("includes the public Drop buffer pipeline without exposing controls", async () => {
    const now = new Date("2026-09-19T12:00:00.000Z");
    const withSql = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "01900000-0000-7000-8000-000000000001",
        filename: "large-video.mp4",
        expected_size: String(420 * 1024 * 1024),
        received_size: String(420 * 1024 * 1024),
        state: "verifying",
        created_at: now,
        updated_at: now,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ used_bytes: "0", file_count: "0", directory_count: "6" }]);
    const controller = new OperatorController(
      { withSql } as unknown as Database,
      { environment: "development" } as SaturnConfig,
      { write: vi.fn() } as unknown as AuditService,
      new TransferMonitorService(),
      {
        current: vi.fn().mockReturnValue({ config: { host: "storage.example" } }),
        statFs: vi.fn().mockResolvedValue({ totalBytes: 16_384, availableBytes: 8_192 }),
      } as unknown as RuntimeStorageManager,
      { check: vi.fn().mockResolvedValue({ state: "pass", latencyMs: 4 }) },
    );

    const result = await controller.overview();
    expect(result.transfers).toMatchObject({ activeCount: 1, queuedCount: 0 });
    expect(result.transfers.tasks[0]).toMatchObject({
      id: "drop:01900000-0000-7000-8000-000000000001",
      filename: "large-video.mp4",
      state: "verifying",
      percent: 100,
      canPause: false,
      canResume: false,
      canCancel: false,
    });
  });

  it("reports Kernel ready through the authenticated Register contract", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "saturn-kernel-status-"));
    const tokenFile = path.join(directory, "kernel.token");
    writeFileSync(tokenFile, "kernel-service-token-at-least-32-characters\n", { mode: 0o600 });
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(" ");
      if (statement.includes("SELECT kernel_url")) {
        return [{ kernel_url: "https://kernel.test", public_identity: null, revision: "1" }];
      }
      return [];
    });
    const database = {
      transaction: async (action: (client: typeof sql) => Promise<unknown>) => action(sql),
      withSql: async (action: (client: typeof sql) => Promise<unknown>) => action(sql),
    } as unknown as Database;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer kernel-service-token-at-least-32-characters");
      return Response.json({
        schema: "exocortex.register.resolution.v1",
        values: {
          "services.saturn.sni": { value: "saturn.example.test" },
          "services.saturn.port": { value: "443" },
        },
      });
    });
    try {
      const controller = new OperatorController(
        database,
        { environment: "production", kernel: { urlSeed: "https://kernel.test", tokenFile, timeoutMs: 1_000 } } as SaturnConfig,
        { write: vi.fn() } as unknown as AuditService,
        new TransferMonitorService(),
        {} as RuntimeStorageManager,
        { check: vi.fn() },
      );
      await expect(controller.kernel()).resolves.toMatchObject({
        url: "https://kernel.test",
        identity: "exocortex-kernel",
        revision: 1,
        configured: true,
        reachability: "ready",
      });
    } finally {
      fetchMock.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
