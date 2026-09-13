import "reflect-metadata";
import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { PublicReachabilityController } from "./health.controller.js";
import type { HealthService } from "./health.service.js";

function reply() {
  const status = vi.fn();
  return { response: { status } as unknown as FastifyReply, status };
}

describe("PublicReachabilityController", () => {
  it("publishes redacted readiness without dependency details", async () => {
    const health = {
      readiness: vi.fn().mockResolvedValue({
        status: "ok",
        service: "api",
        timestamp: new Date().toISOString(),
        checks: { database: { state: "pass" }, storage: { state: "pass" }, worker: { state: "pass" } },
      }),
    } as unknown as HealthService;
    const { response, status } = reply();

    const result = await new PublicReachabilityController(health).reachability(response);

    expect(status).toHaveBeenCalledWith(200);
    expect(result).toEqual({ schema: "saturn.public-reachability.v1", status: "ready" });
    expect(result).not.toHaveProperty("checks");
  });

  it("returns unavailable without naming the failed dependency", async () => {
    const health = {
      readiness: vi.fn().mockResolvedValue({
        status: "degraded",
        service: "api",
        timestamp: new Date().toISOString(),
        checks: { storage: { state: "fail", detail: "storage_unavailable" } },
      }),
    } as unknown as HealthService;
    const { response, status } = reply();

    const result = await new PublicReachabilityController(health).reachability(response);

    expect(status).toHaveBeenCalledWith(503);
    expect(result).toEqual({ schema: "saturn.public-reachability.v1", status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("storage");
  });
});
