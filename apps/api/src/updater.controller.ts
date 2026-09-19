import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { BadRequestException, Body, Controller, Get, Headers, Inject, Param, Post, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { backupReceipt, savedBackup, readUpdateBytes } from "./update-backup.js";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import { z } from "zod";
import { registeredOrigin } from "./kernel-discovery.js";
import { updater, updaterToken, unixJson } from "./neptune.controller.js";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { RecoveryWorkflowService } from "./recovery-workflow.service.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { APP_CONFIG, DATABASE } from "./tokens.js";

const versionSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) }).strict();
function headId() { return process.env.UPDATER_HEAD_ID?.trim() || "saturn"; }
function agent(method: string, route: string) {
  return unixJson(process.env.UPDATER_SOCKET_PATH?.trim() || "/run/exocortex/updater.sock", "updater.local", method, route, ["X-Updater-Token", updaterToken()]);
}
function jobId(id: string) { if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new BadRequestException("Invalid job ID"); return id; }

@Controller("operator/updates")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class UpdaterController {
  constructor(@Inject(RecoveryWorkflowService) private readonly recovery: RecoveryWorkflowService,
    @Inject(DATABASE) private readonly database: Database, @Inject(APP_CONFIG) private readonly config: SaturnConfig) {}

  @Get()
  async status() {
    const [health, registry] = await Promise.all([
      agent("GET", "/v1/health").catch(() => undefined),
      registeredOrigin(this.database, this.config, "saturn")().then(() => true).catch(() => false),
    ]);
    return { installedVersion: process.env.VAULT_RELEASE_VERSION ?? "0.0.0",
      updater: health === undefined ? { state: "unavailable", reason: "Local Updater is unavailable" } : { state: health.busy === true ? "busy" : "ready", version: health.version },
      registry: { state: registry ? "ready" : "unavailable" }, discoveryEnabled: health !== undefined && registry };
  }
  @Post("check") check() { return updater("/v1/releases/check", { head_id: headId() }, 90_000); }
  @Get("jobs/:id") job(@Param("id") id: string) { return agent("GET", `/v1/jobs/${jobId(id)}`); }
  @Post("jobs/:id/rollback")
  rollback(@Param("id") id: string) { return updater(`/v1/jobs/${jobId(id)}/rollback`, {}); }

  @Post("install")
  install() { throw new BadRequestException("Use the update dialog to save the mandatory pre-update ZIP before installation"); }
  @Post("updater/install")
  selfUpdate() { return updater("/v1/lifecycle/updater-self-update", { head_id: headId() }); }

  @Post("flow/check")
  async flowCheck(@Body() body: unknown) {
    const { component } = z.object({ component: z.enum(["saturn", "updater", "gryphon", "neptune"]) }).strict().parse(body);
    const health = await agent("GET", "/v1/health");
    if (health.update_protocol !== 2) throw new BadRequestException("Updater 0.5.0 or later is required for the saved-copy update protocol");
    return updater("/v2/check", { head_id: headId(), component }, 45_000);
  }

  @Post("flow/backup")
  async flowBackup(@Body() body: unknown, @Res() reply: FastifyReply) {
    const { version } = versionSchema.parse(body);
    const candidate = await this.flowCheck({ component: "saturn" });
    if (candidate.update_available !== true || candidate.available_version !== version) throw new BadRequestException("Release changed; check again");
    const snapshot = await this.recovery.createSnapshot();
    let archive: Buffer;
    try { archive = await readUpdateBytes(snapshot.stream); } finally { snapshot.stream.destroy(); await fs.rm(snapshot.created.archivePath, { force: true }); }
    const receipt = backupReceipt(archive, snapshot.filename, "saturn", headId(), version, updaterToken());
    reply.header("Content-Type", "application/zip").header("Content-Length", archive.length)
      .header("Cache-Control", "no-store").header("X-Update-Receipt", receipt)
      .header("Content-Disposition", `attachment; filename="${snapshot.filename}"`).send(archive);
  }

  @Post("flow/install/:component")
  async flowInstall(@Param("component") component: string, @Body() body: unknown,
    @Headers("x-update-receipt") receipt = "", @Headers("x-update-saved") saved = "") {
    if (component === "saturn") {
      if (saved !== "1") throw new BadRequestException("Save the ZIP on your computer before installing");
      const archive = await readUpdateBytes(body);
      try { return await updater("/v2/updates", savedBackup(archive, receipt, updaterToken(), "saturn", headId()), 90_000); }
      finally { archive.fill(0); }
    }
    if (!["updater", "neptune", "gryphon"].includes(component)) throw new BadRequestException("Unknown component");
    const input = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), request_id: z.string().uuid() }).strict().parse(body);
    return updater(`/v2/components/${component}/updates`, { ...input, head_id: headId() }, 45_000);
  }

  @Get("flow/jobs") flowJobs() { return agent("GET", `/v1/jobs?head_id=${encodeURIComponent(headId())}`); }
  @Get("flow/jobs/:id") flowJob(@Param("id") id: string) { return this.job(id); }
  @Post("flow/jobs/:id/rollback")
  async flowRollback(@Param("id") id: string, @Body() body: unknown) {
    const archive = await readUpdateBytes(body);
    try { return await updater(`/v2/jobs/${jobId(id)}/rollback`, { filename: "backup.zip", sha256: createHash("sha256").update(archive).digest("hex"), data_base64: archive.toString("base64") }, 90_000); }
    finally { archive.fill(0); }
  }
}
