import fs from "node:fs";
import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Post, Put, UseFilters, UseGuards } from "@nestjs/common";
import type { OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import type { Database } from "@saturn/database";
import { SATURN_COMMAND_CATALOG } from "@saturn/drop";
import { z } from "zod";
import { APP_CONFIG, DATABASE } from "./tokens.js";
import { registeredOrigin } from "./kernel-discovery.js";
import { unixJson } from "./neptune.controller.js";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const statusSchema = z.object({
  schema: z.literal("exocortex.gryphon.service-status.v1"),
  version: z.string().min(1),
  serviceId: z.literal("saturn"),
  state: z.string(),
  connected: z.boolean(),
  commandPrefix: z.string().nullable(),
  commands: z.array(z.object({ name: z.string(), description: z.string(), adapterCommand: z.string() })).optional(),
  bot: z.object({ id: z.string(), alias: z.string(), username: z.string().optional(), state: z.string() }).nullable(),
  binding: z.object({ linkedAt: z.string() }).nullable(),
});
const botsSchema = z.object({
  schema: z.literal("exocortex.gryphon.service-bots.v1"),
  serviceId: z.literal("saturn"),
  bots: z.array(z.object({ id: z.string(), alias: z.string(), username: z.string().optional(), state: z.string(), selected: z.boolean() })),
});
const connectionSchema = z.object({ botId: z.string().min(1).max(200) }).strict();
const catalogSchema = z.object({
  schema: z.literal("exocortex.telegram.command-catalog.v1"),
  serviceId: z.literal("saturn"),
  commands: z.array(z.object({ name: z.string(), description: z.string(), adapterCommand: z.string() })),
});
type JsonObject = Record<string, unknown>;

function commandCatalogIsCurrent(commands: z.infer<typeof statusSchema>["commands"]): boolean {
  return commands !== undefined && commands.length === SATURN_COMMAND_CATALOG.length
    && commands.every((item) => {
      const expected = SATURN_COMMAND_CATALOG.find((candidate) => candidate.name === item.name);
      return expected !== undefined && item.name === expected.name
        && item.description === expected.description && item.adapterCommand === expected.adapterCommand;
    });
}

@Controller("operator/gryphon")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class GryphonOwnerController implements OnApplicationBootstrap, OnApplicationShutdown {
  private commandCatalogTimer: ReturnType<typeof setInterval> | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: SaturnConfig, @Inject(DATABASE) private readonly database: Database) {}

  onApplicationBootstrap(): void {
    if (this.commandCatalogTimer !== undefined) return;
    void this.reconcileCommandCatalog();
    this.commandCatalogTimer = setInterval(() => { void this.reconcileCommandCatalog(); }, 60_000);
    this.commandCatalogTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.commandCatalogTimer !== undefined) clearInterval(this.commandCatalogTimer);
    this.commandCatalogTimer = undefined;
  }

  @Post("initialize")
  initialize() { throw new ForbiddenException("Manage the shared Gryphon gateway with sudo updater tui"); }

  private request(method: string, route: string, body?: JsonObject) {
    const tokenFile = this.config.gryphon.serviceTokenFile;
    if (!this.config.gryphon.enabled || tokenFile === undefined || !fs.existsSync(tokenFile)) throw new NotFoundException("Gryphon is not configured");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    return unixJson(this.config.gryphon.socketPath, "gryphon.local", method, route, ["Authorization", `Bearer ${token}`], body, this.config.gryphon.timeoutMs);
  }

  @Get("status") async status() { return statusSchema.parse(await this.request("GET", "/v1/service")); }

  @Get("management") management() { throw new ForbiddenException("Manage bots with sudo updater tui"); }

  @Get("bots") async bots() { return botsSchema.parse(await this.request("GET", "/v1/service/bots")); }

  @Put("connection") async connect(@Body() body: unknown) {
    const input = connectionSchema.parse(body);
    const status = statusSchema.parse(await this.request("PUT", "/v1/service/connection", {
      botId: input.botId,
      commandPrefix: "saturn",
      adapterUrl: new URL("/internal/gryphon/command", await registeredOrigin(this.database, this.config, "saturn")()).toString(),
    }));
    await this.syncCommandCatalog().catch(() => undefined);
    return status;
  }

  @Delete("connection") disconnect() { return this.request("DELETE", "/v1/service/connection"); }

  @Post("link-challenge")
  linkChallenge() { throw new ForbiddenException("Bot pairing is managed with sudo updater tui"); }

  @Put("binding") attachOwner() { return this.request("PUT", "/v1/service/binding"); }

  @Delete("link-challenge")
  cancelChallenge() { return this.request("DELETE", "/v1/service/link-challenges"); }

  @Delete("binding")
  async revokeBinding() {
    const result = await this.request("DELETE", "/v1/service/binding");
    if ((await this.status()).binding !== null) throw new ConflictException("Telegram binding revocation is not confirmed");
    return result;
  }

  async syncCommandCatalog() {
    return catalogSchema.parse(await this.request("PUT", "/v1/service/command-catalog", {
      schema: "exocortex.telegram.command-catalog.v1",
      commands: SATURN_COMMAND_CATALOG,
    }));
  }

  private async reconcileCommandCatalog(): Promise<void> {
    try {
      const status = await this.status();
      if (status.connected && !commandCatalogIsCurrent(status.commands)) await this.syncCommandCatalog();
    } catch {
      // Startup readiness is independent; the next interval retries reconciliation.
    }
  }

  @Post("update/check")
  check() { throw new ForbiddenException("Check shared Gryphon releases with sudo updater tui"); }

  @Post("update/install")
  install() { throw new ForbiddenException("Update the shared Gryphon gateway with sudo updater tui"); }
}
