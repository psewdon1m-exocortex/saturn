import { describe, expect, it } from "vitest";
import type { SaturnConfig } from "@saturn/config";
import { HealthService, type HealthDatabasePort, type StorageHealthPort } from "./health.service.js";

const config = {
  readinessRequireStorage: true,
  readinessTimeoutMs: 3_000,
  worker: { staleAfterMs: 20_000 },
} as SaturnConfig;

describe("HealthService", () => {
  it("reports independent database, storage and worker checks", async () => {
    const database: HealthDatabasePort = {
      ping: async () => 3,
      getWorkerHeartbeat: async () => ({ role: "primary", instanceId: "worker-1", lastSeenAt: new Date() }),
    };
    const storage: StorageHealthPort = { check: async () => ({ state: "pass", latencyMs: 5 }) };
    const result = await new HealthService(config, database, storage).readiness();
    expect(result.status).toBe("ok");
    expect(result.checks).toMatchObject({
      database: { state: "pass" },
      storage: { state: "pass" },
      worker: { state: "pass" },
    });
  });

  it("fails readiness without hiding which dependency failed", async () => {
    const database: HealthDatabasePort = {
      ping: async () => { throw new Error("offline"); },
      getWorkerHeartbeat: async () => undefined,
    };
    const storage: StorageHealthPort = { check: async () => ({ state: "fail", detail: "storage_unavailable" }) };
    const result = await new HealthService(config, database, storage).readiness();
    expect(result.status).toBe("degraded");
    expect(result.checks.database?.detail).toBe("database_unavailable");
    expect(result.checks.storage?.detail).toBe("storage_unavailable");
    expect(result.checks.worker?.detail).toBe("worker_missing");
  });

  it("bounds stalled dependency checks and reports degradation", async () => {
    const stalled = new Promise<never>(() => undefined);
    const database: HealthDatabasePort = {
      ping: async () => stalled,
      getWorkerHeartbeat: async () => stalled,
    };
    const storage: StorageHealthPort = { check: async () => stalled };
    const started = performance.now();
    const result = await new HealthService({ ...config, readinessTimeoutMs: 10 }, database, storage).readiness();
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.status).toBe("degraded");
    expect(result.checks).toMatchObject({
      database: { state: "fail" },
      storage: { state: "fail" },
      worker: { state: "fail" },
    });
  });
});
