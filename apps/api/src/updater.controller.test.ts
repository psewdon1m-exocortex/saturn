import { describe, expect, it } from "vitest";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import type { RecoveryWorkflowService } from "./recovery-workflow.service.js";
import { UpdaterController } from "./updater.controller.js";

function controller() {
  return new UpdaterController({} as RecoveryWorkflowService, {} as Database, {} as SaturnConfig);
}

describe("Updater service boundary", () => {
  it("rejects every service route that would check or update Updater", async () => {
    const value = controller();
    expect(() => value.selfUpdate()).toThrow(/updater tui/);
    await expect(value.flowCheck({ component: "updater" })).rejects.toThrow(/updater tui/);
    await expect(value.flowInstall("updater", { version: "1.2.3", request_id: "01234567-0123-4123-8123-012345678901" }))
      .rejects.toThrow(/updater tui/);
  });
});
