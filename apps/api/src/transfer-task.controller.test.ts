import type { BackupIngestService } from "@saturn/backup-ingest";
import type { FileService } from "@saturn/file-core";
import { describe, expect, it, vi } from "vitest";
import { TransferMonitorService } from "./transfer-monitor.service.js";
import { TransferTaskController } from "./transfer-task.controller.js";

const uploadId = "01900000-0000-7000-8000-000000000081";
const backupRunId = "01900000-0000-7000-8000-000000000082";

function controller(input: { readonly uploadStatus?: string; readonly backupState?: string } = {}) {
  const files = {
    getUpload: vi.fn().mockResolvedValue({ id: uploadId, status: input.uploadStatus ?? "uploading" }),
    abandonUpload: vi.fn().mockResolvedValue({ id: uploadId, status: "abandoned" }),
  };
  const backups = {
    getRunForOwner: vi.fn().mockResolvedValue({ id: backupRunId, state: input.backupState ?? "uploading" }),
    cancelRunForOwner: vi.fn().mockResolvedValue(undefined),
  };
  const transfers = new TransferMonitorService();
  return {
    files,
    backups,
    transfers,
    value: new TransferTaskController(transfers, files as unknown as FileService, backups as unknown as BackupIngestService),
  };
}

describe("TransferTaskController", () => {
  it("pauses and resumes an active owner upload", async () => {
    const fixture = controller();
    await expect(fixture.value.control(uploadId, { action: "pause" })).resolves.toEqual({ id: uploadId, state: "paused" });
    expect(fixture.transfers.controlState(uploadId)).toBe("paused");
    await expect(fixture.value.control(uploadId, { action: "resume" })).resolves.toEqual({ id: uploadId, state: "running" });
    expect(fixture.transfers.controlState(uploadId)).toBe("running");
  });

  it("cancels and abandons an unfinished owner upload", async () => {
    const fixture = controller();
    await expect(fixture.value.control(uploadId, { action: "cancel" })).resolves.toEqual({ id: uploadId, state: "cancelled" });
    expect(fixture.files.abandonUpload).toHaveBeenCalledWith(uploadId);
  });

  it("cancels an unfinished producer backup", async () => {
    const fixture = controller();
    await expect(fixture.value.control(`backup:${backupRunId}`, { action: "cancel" })).resolves.toEqual({ id: `backup:${backupRunId}`, state: "cancelled" });
    expect(fixture.backups.cancelRunForOwner).toHaveBeenCalledWith(backupRunId);
  });
});
