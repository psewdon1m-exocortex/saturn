import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, Body, Controller, Get, Inject, Param, Post, UseFilters, UseGuards } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import { z } from "zod";
import { registeredOrigin } from "./kernel-discovery.js";
import { updater, updaterToken, unixJson } from "./neptune.controller.js";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
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
  @RequireRecentReauthentication()
  rollback(@Param("id") id: string) { return updater(`/v1/jobs/${jobId(id)}/rollback`, {}); }

  @Post("install")
  @RequireRecentReauthentication()
  async install(@Body() body: unknown) {
    const input = versionSchema.parse(body);
    const checked = await this.check();
    if (checked.update_available !== true || checked.available_version !== input.version) throw new BadRequestException("Release is no longer the current update candidate");
    const snapshot = await this.recovery.createSnapshot();
    const chunks: Buffer[] = []; let bytes = 0;
    try {
      for await (const part of snapshot.stream) {
        const chunk: unknown = part;
        if (!Buffer.isBuffer(chunk)) throw new Error("Invalid backup stream");
        bytes += chunk.length; if (bytes > 128 * 1024 * 1024) throw new Error("Update snapshot exceeds the 128 MB local Updater limit"); chunks.push(chunk);
      }
    } finally { snapshot.stream.destroy(); }
    const archive = Buffer.concat(chunks);
    return updater("/v1/updates", { request_id: randomUUID(), head_id: headId(), service: "saturn", version: input.version,
      backup: { filename: snapshot.filename, sha256: createHash("sha256").update(archive).digest("hex"), data_base64: archive.toString("base64") } }, 90_000);
  }
  @Post("updater/install")
  @RequireRecentReauthentication()
  selfUpdate() { return updater("/v1/lifecycle/updater-self-update", { head_id: headId() }); }
}
