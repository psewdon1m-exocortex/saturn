import { BadRequestException, Body, ConflictException, Controller, Inject, Optional, Param, Patch, UseFilters, UseGuards } from "@nestjs/common";
import type { BackupIngestService } from "@saturn/backup-ingest";
import type { ArchiveJobRepository, ArchiveService } from "@saturn/archive";
import type { FileService } from "@saturn/file-core";
import { z } from "zod";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { ARCHIVE_REPOSITORY, ARCHIVE_SERVICE, BACKUP_INGEST_SERVICE, FILE_SERVICE } from "./tokens.js";
import { TransferMonitorService, type TransferTaskAction } from "./transfer-monitor.service.js";

const actionSchema = z.object({ action: z.enum(["pause", "resume", "cancel"]) }).strict();
const taskIdPattern = /^(?:backup:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUTABLE_UPLOAD_STATES = new Set(["created", "uploading", "failed_retryable"]);
const MUTABLE_BACKUP_STATES = new Set(["pending", "uploading", "appending"]);

@Controller("operator/tasks")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class TransferTaskController {
  constructor(
    @Inject(TransferMonitorService) private readonly transfers: TransferMonitorService,
    @Inject(FILE_SERVICE) private readonly files: FileService,
    @Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService,
    @Optional() @Inject(ARCHIVE_REPOSITORY) private readonly archiveRepository?: ArchiveJobRepository,
    @Optional() @Inject(ARCHIVE_SERVICE) private readonly archives?: ArchiveService,
  ) {}

  @Patch(":id")
  async control(@Param("id") id: string, @Body() body: unknown) {
    if (!taskIdPattern.test(id)) throw new BadRequestException({ code: "invalid_task_id" });
    const { action } = actionSchema.parse(body);
    if (this.transfers.hasDownload(id)) return this.#controlDownload(id, action);
    if (id.startsWith("backup:")) return this.#controlBackup(id, id.slice("backup:".length), action);
    if (this.archiveRepository !== undefined && this.archives !== undefined && await this.archiveRepository.get(id) !== undefined) {
      return this.archives.control(id, action);
    }
    return this.#controlUpload(id, action);
  }

  #controlDownload(id: string, action: TransferTaskAction) {
    const state = this.transfers.downloadState(id);
    const mutable = state === "downloading" || state === "paused";
    if (!mutable || (action === "resume" && state !== "paused")) throw new ConflictException({ code: "task_not_controllable" });
    return { id, state: this.transfers.control(id, action) };
  }

  async #controlUpload(id: string, action: TransferTaskAction) {
    const upload = await this.files.getUpload(id);
    if (!MUTABLE_UPLOAD_STATES.has(upload.status)) throw new ConflictException({ code: "task_not_controllable" });
    if (action === "resume" && this.transfers.controlState(id) !== "paused") throw new ConflictException({ code: "task_not_paused" });
    if (action !== "cancel") return { id, state: this.transfers.control(id, action) };
    this.transfers.control(id, "cancel");
    try {
      await this.#abandonUpload(id);
      return { id, state: "cancelled" as const };
    } catch (error) {
      this.transfers.clearControl(id);
      throw error;
    }
  }

  async #controlBackup(taskId: string, runId: string, action: TransferTaskAction) {
    const run = await this.backups.getRunForOwner(runId);
    if (!MUTABLE_BACKUP_STATES.has(run.state)) throw new ConflictException({ code: "task_not_controllable" });
    if (action === "resume" && this.transfers.controlState(taskId) !== "paused") throw new ConflictException({ code: "task_not_paused" });
    if (action !== "cancel") return { id: taskId, state: this.transfers.control(taskId, action) };
    this.transfers.control(taskId, "cancel");
    try {
      await this.backups.cancelRunForOwner(runId);
      return { id: taskId, state: "cancelled" as const };
    } catch (error) {
      this.transfers.clearControl(taskId);
      throw error;
    }
  }

  async #abandonUpload(id: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (let attempt = 0; attempt < 101; attempt += 1) {
      try {
        await this.files.abandonUpload(id);
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/locked/i.test(error.message) || Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new ConflictException({ code: "task_locked" });
  }
}
