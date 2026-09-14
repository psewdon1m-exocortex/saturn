import { describe, expect, it, vi } from "vitest";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import { SATURN_COMMAND_CATALOG } from "@saturn/drop";
import { GryphonOwnerController } from "./gryphon-owner.controller.js";

function controller() {
  return new GryphonOwnerController({} as SaturnConfig, {} as Database);
}

describe("GryphonOwnerController command catalog", () => {
  it("publishes the three global Drop commands", async () => {
    const value = controller();
    const request = vi.spyOn(value as unknown as {
      request(method: string, route: string, body?: Record<string, unknown>): Promise<unknown>;
    }, "request").mockResolvedValue({
      schema: "exocortex.telegram.command-catalog.v1",
      serviceId: "saturn",
      commands: SATURN_COMMAND_CATALOG,
    });

    await value.syncCommandCatalog();

    expect(request).toHaveBeenCalledWith("PUT", "/v1/service/command-catalog", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: SATURN_COMMAND_CATALOG,
    });
    expect(SATURN_COMMAND_CATALOG.map((item) => [item.name, item.adapterCommand])).toEqual([
      ["drop", "drop"],
      ["drop_status", "status"],
      ["drop_revoke", "revoke"],
    ]);
  });

  it("reconciles an existing connection without blocking on transient failure", async () => {
    const value = controller();
    vi.spyOn(value, "status").mockResolvedValue({ connected: true } as Awaited<ReturnType<typeof value.status>>);
    const sync = vi.spyOn(value, "syncCommandCatalog")
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof value.syncCommandCatalog>>);

    await (value as unknown as { reconcileCommandCatalog(): Promise<void> }).reconcileCommandCatalog();
    await (value as unknown as { reconcileCommandCatalog(): Promise<void> }).reconcileCommandCatalog();

    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("does not republish an already current catalog", async () => {
    const value = controller();
    vi.spyOn(value, "status").mockResolvedValue({
      connected: true,
      commands: [...SATURN_COMMAND_CATALOG].reverse(),
    } as Awaited<ReturnType<typeof value.status>>);
    const sync = vi.spyOn(value, "syncCommandCatalog");

    await (value as unknown as { reconcileCommandCatalog(): Promise<void> }).reconcileCommandCatalog();

    expect(sync).not.toHaveBeenCalled();
  });
});
