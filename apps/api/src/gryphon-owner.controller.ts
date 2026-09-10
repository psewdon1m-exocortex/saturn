import fs from "node:fs";
import { Body, ConflictException, Controller, Delete, Get, Inject, NotFoundException, Post, Put, UseFilters, UseGuards } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import { z } from "zod";
import { APP_CONFIG } from "./tokens.js";
import { updater, unixJson } from "./neptune.controller.js";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const installSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) }).strict();
const statusSchema = z.object({
  schema: z.literal("exocortex.gryphon.service-status.v1"),
  version: z.string().min(1),
  serviceId: z.literal("saturn"),
  state: z.string(),
  connected: z.boolean(),
  commandPrefix: z.string().nullable(),
  bot: z.object({ id: z.string(), alias: z.string(), username: z.string().optional(), state: z.string() }).nullable(),
  binding: z.object({ linkedAt: z.string() }).nullable(),
});
const botsSchema = z.object({
  schema: z.literal("exocortex.gryphon.service-bots.v1"),
  serviceId: z.literal("saturn"),
  bots: z.array(z.object({ id: z.string(), alias: z.string(), username: z.string().optional(), state: z.string(), selected: z.boolean() })),
});
const connectionSchema = z.object({ botId: z.string().min(1).max(200) }).strict();
const challengeSchema = z.object({
  code: z.string().min(1), expiresAt: z.iso.datetime(), command: z.string().min(1), botUsername: z.string().optional(),
});
type JsonObject = Record<string, unknown>;

@Controller("operator/gryphon")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class GryphonOwnerController {
  constructor(@Inject(APP_CONFIG) private readonly config: SaturnConfig) {}

  private request(method: string, route: string, body?: JsonObject) {
    const tokenFile = this.config.gryphon.serviceTokenFile;
    if (!this.config.gryphon.enabled || tokenFile === undefined || !fs.existsSync(tokenFile)) throw new NotFoundException("Gryphon is not configured");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    return unixJson(this.config.gryphon.socketPath, "gryphon.local", method, route, ["Authorization", `Bearer ${token}`], body, this.config.gryphon.timeoutMs);
  }

  @Get("status") async status() { return statusSchema.parse(await this.request("GET", "/v1/service")); }

  @Get("bots") async bots() { return botsSchema.parse(await this.request("GET", "/v1/service/bots")); }

  @Put("connection") async connect(@Body() body: unknown) {
    const input = connectionSchema.parse(body);
    return statusSchema.parse(await this.request("PUT", "/v1/service/connection", {
      botId: input.botId,
      commandPrefix: "saturn",
      adapterUrl: this.config.gryphon.adapterUrl,
    }));
  }

  @Delete("connection") disconnect() { return this.request("DELETE", "/v1/service/connection"); }

  @Post("link-challenge")
  @RequireRecentReauthentication()
  async linkChallenge() { return challengeSchema.parse(await this.request("POST", "/v1/service/link-challenges")); }

  @Post("update/check")
  async check() {
    const status = await this.status();
    return updater("/v1/components/gryphon-linux/check", {
      head_id: process.env.UPDATER_HEAD_ID?.trim() || "saturn",
      current_version: status.version,
    });
  }

  @Post("update/install")
  async install(@Body() body: unknown) {
    const input = installSchema.parse(body);
    const checked = await this.check();
    if (checked.update_available !== true || checked.available_version !== input.version) throw new ConflictException("Requested Gryphon version is not the current upgrade candidate");
    return updater("/v1/components/gryphon-linux/update", {
      head_id: process.env.UPDATER_HEAD_ID?.trim() || "saturn",
      version: input.version,
    }, 300_000);
  }
}
