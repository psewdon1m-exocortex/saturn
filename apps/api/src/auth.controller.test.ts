import { BadRequestException } from "@nestjs/common";
import type { OwnerAuthService, OwnerPreferences } from "@saturn/auth";
import type { SaturnConfig } from "@saturn/config";
import { describe, expect, it, vi } from "vitest";
import { AuthController } from "./auth.controller.js";

const preferences: Omit<OwnerPreferences, "updatedAt"> = {
  accentColor: "#00a8ff", sidebarMode: "fixed",
  navigationOrder: ["dashboard", "files", "inbox", "shared", "synchronization", "trash", "settings"],
  dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"],
  settingsOrder: ["appearance", "security", "storage", "backup", "gryphon", "updates", "logs"],
  trashRetentionDays: 30, uploadBufferGiB: 110, maximumUploadFileGiB: 20,
};

function fixture() {
  const updatePreferences = vi.fn().mockImplementation(async (input: unknown) => input);
  const controller = new AuthController({
    getPreferences: vi.fn().mockResolvedValue(preferences), updatePreferences,
  } as unknown as OwnerAuthService, {} as SaturnConfig);
  return { controller, updatePreferences };
}

describe("Settings card preferences", () => {
  it("saves an independently reordered Storage connection card", async () => {
    const { controller, updatePreferences } = fixture();
    const settingsOrder = ["storage", "logs", "backup", "security", "updates", "appearance", "gryphon"];
    await expect(controller.updatePreferences({ ...preferences, settingsOrder })).resolves.toMatchObject({ settingsOrder });
    expect(updatePreferences).toHaveBeenCalledWith({ ...preferences, settingsOrder });
  });

  it("inserts Storage after Security for an older client without resetting its order or limits", async () => {
    const { controller } = fixture();
    await expect(controller.updatePreferences({
      ...preferences, settingsOrder: ["logs", "backup", "security", "updates", "appearance", "gryphon"],
      trashRetentionDays: 45, uploadBufferGiB: 64, maximumUploadFileGiB: 8,
    })).resolves.toMatchObject({
      settingsOrder: ["logs", "backup", "security", "storage", "updates", "appearance", "gryphon"],
      trashRetentionDays: 45, uploadBufferGiB: 64, maximumUploadFileGiB: 8,
    });
  });

  it.each([
    ["appearance", "security", "storage", "backup", "gryphon", "updates"],
    ["appearance", "security", "storage", "backup", "gryphon", "updates", "updates"],
    ["appearance", "security", "storage", "backup", "gryphon", "updates", "unknown"],
  ])("rejects incomplete, duplicate or unknown card lists: %j", async (...settingsOrder) => {
    const { controller, updatePreferences } = fixture();
    await expect(controller.updatePreferences({ ...preferences, settingsOrder })).rejects.toBeInstanceOf(BadRequestException);
    expect(updatePreferences).not.toHaveBeenCalled();
  });
});
