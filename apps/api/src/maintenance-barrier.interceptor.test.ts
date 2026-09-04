import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import type { Database } from "@saturn/database";
import { lastValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { MaintenanceBarrierInterceptor } from "./maintenance-barrier.interceptor.js";

function context(method: string, url: string): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ method, url }) }) } as unknown as ExecutionContext;
}

describe("MaintenanceBarrierInterceptor", () => {
  it("holds a shared lease for ordinary mutations and excludes recovery orchestration", async () => {
    const events: string[] = [];
    const database = {
      withSharedMaintenance: vi.fn(async (action: () => Promise<unknown>) => {
        events.push("locked");
        try { return await action(); }
        finally { events.push("released"); }
      }),
    } as unknown as Database;
    const interceptor = new MaintenanceBarrierInterceptor(database);
    const handler = { handle: () => { events.push("handled"); return of("ok"); } } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context("POST", "/api/v1/folders"), handler))).resolves.toBe("ok");
    expect(events).toEqual(["locked", "handled", "released"]);
    events.length = 0;
    await expect(lastValueFrom(interceptor.intercept(context("POST", "/api/v1/operator/recovery/restores/x/apply"), handler))).resolves.toBe("ok");
    expect(events).toEqual(["handled"]);
  });
});
