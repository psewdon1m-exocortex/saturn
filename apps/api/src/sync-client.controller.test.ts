import type { OwnerAuthService } from "@saturn/auth";
import type { DeviceService } from "@saturn/sync";
import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { SyncClientController } from "./sync-client.controller.js";

describe("Sync client appearance", () => {
  it("returns Saturn's complete base palette to an authenticated Neptune client", async () => {
    const devices = { authenticate: vi.fn().mockResolvedValue({}) };
    const owner = { getPreferences: vi.fn().mockResolvedValue({ accentColor: "#7357ff", updatedAt: new Date("2026-10-11T12:00:00Z") }) };
    const reply = { header: vi.fn() };
    const controller = new SyncClientController(
      devices as unknown as DeviceService,
      owner as unknown as OwnerAuthService,
    );

    await expect(controller.preferences("Bearer device", reply as unknown as FastifyReply)).resolves.toEqual({
      accentColor: "#7357ff",
      blackColor: "#000000",
      whiteColor: "#ffffff",
      updatedAt: new Date("2026-10-11T12:00:00Z"),
    });
    expect(devices.authenticate).toHaveBeenCalledWith("Bearer device");
    expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
});
