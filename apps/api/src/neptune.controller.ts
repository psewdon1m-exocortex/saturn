import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { RecoveryWorkflowService } from "./recovery-workflow.service.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const scheduleSchema = z.object({ enabled: z.boolean(), interval_hours: z.number().int().min(1).max(8760) }).strict();
const mirrorScheduleSchema = z.object({ enabled: z.boolean(), interval_minutes: z.number().int().min(1).max(10_080) }).strict();
const installSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) }).strict();
const initializeSchema = z.object({ enrollment_code: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict();
type JsonObject = Record<string, unknown>;

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function safeBearer(authorization: string | undefined, tokenFile: string): boolean {
  if (!authorization?.startsWith("Bearer ") || !fs.existsSync(tokenFile)) return false;
  const supplied = Buffer.from(authorization.slice(7).trim());
  const expected = Buffer.from(fs.readFileSync(tokenFile, "utf8").trim());
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function unixJson(socketPath: string, host: string, method: string, route: string, tokenHeader?: [string, string], body?: JsonObject, timeout = 30_000): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = http.request({
      socketPath, host, path: route, method, timeout,
      headers: {
        Host: host, Accept: "application/json", ...(tokenHeader === undefined ? {} : { [tokenHeader[0]]: tokenHeader[1] }),
        ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": String(payload.length) }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error("Local agent response exceeds 1 MB"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        let parsed: JsonObject = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as JsonObject; }
        catch { reject(new Error("Local agent returned invalid JSON")); return; }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) reject(new Error(typeof parsed.error === "string" ? parsed.error : `Local agent returned HTTP ${String(response.statusCode)}`));
        else resolve(parsed);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Local agent request timed out")));
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function neptune(method: string, route: string, body?: JsonObject) {
  const project = process.env.NEPTUNE_PROJECT_ID?.trim() || "saturn";
  const token = fs.readFileSync(required("NEPTUNE_CONTROL_TOKEN_FILE"), "utf8").trim();
  return unixJson(process.env.NEPTUNE_SOCKET_PATH?.trim() || "/run/neptune/neptuned.sock", "neptune.local", method, `/v1/projects/${encodeURIComponent(project)}${route}`, ["X-Neptune-Token", token], body);
}

export function updater(route: string, body: JsonObject, timeout?: number) {
  return unixJson(process.env.UPDATER_SOCKET_PATH?.trim() || "/run/exocortex/updater.sock", "updater.local", "POST", route, ["X-Updater-Token", updaterToken()], body, timeout);
}
export function updaterToken(): string {
  const filename = process.env.UPDATER_CONTROL_TOKEN_FILE;
  if (filename === undefined) return required("UPDATER_CONTROL_TOKEN");
  if (fs.statSync(filename).size > 8192) throw new Error("Invalid Updater credential file");
  const token = fs.readFileSync(filename, "utf8").trim();
  if (token.length < 32) throw new Error("Invalid Updater credential");
  return token;
}

function neptuneHealth() {
  return unixJson(process.env.NEPTUNE_SOCKET_PATH?.trim() || "/run/neptune/neptuned.sock", "neptune.local", "GET", "/v1/health");
}

@Controller("internal/neptune")
@UseFilters(SaturnApiExceptionFilter)
export class NeptuneExportController {
  constructor(@Inject(RecoveryWorkflowService) private readonly recovery: RecoveryWorkflowService) {}

  @Post("backup")
  async backup(@Headers("authorization") authorization: string | undefined, @Res() reply: FastifyReply): Promise<void> {
    const tokenFile = process.env.NEPTUNE_EXPORT_TOKEN_FILE?.trim() || "";
    if (!tokenFile || !safeBearer(authorization, tokenFile)) {
      reply.status(401).send({ error: "Neptune authentication required" });
      return;
    }
    const result = await this.recovery.createSnapshot();
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Length", result.created.archiveBytes)
      .header("X-Neptune-Archive-Sha256", result.created.archiveSha256)
      .header("X-Neptune-Source-Version", process.env.VAULT_RELEASE_VERSION ?? "unknown")
      .send(result.stream);
  }
}

@Controller("operator/neptune")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class NeptuneOwnerController {
  @Get("initializations/:id")
  initialization(@Param("id") id: string) {
    if (!/^neptune-[0-9]+-[a-f0-9]{16}$/.test(id)) throw new Error("Invalid initialization job ID");
    const headId = process.env.UPDATER_HEAD_ID?.trim() || "saturn";
    return unixJson(process.env.UPDATER_SOCKET_PATH?.trim() || "/run/exocortex/updater.sock", "updater.local", "GET",
      `/v1/components/neptune-linux/initializations/${encodeURIComponent(id)}?head_id=${encodeURIComponent(headId)}`,
      ["X-Updater-Token", updaterToken()]);
  }
  @Get("status") status() { return neptune("GET", "/status"); }

  @Get("availability")
  async availability() {
    try {
      const health = await neptuneHealth();
      try { return { installed: true, linked: true, state: "linked", ...(await this.status()) }; }
      catch { return { installed: true, linked: false, state: "unlinked", version: typeof health.version === "string" ? health.version : null }; }
    } catch { return { installed: false, linked: false, state: "unavailable", version: null }; }
  }

  @Post("initialize")
  @RequireRecentReauthentication()
  async initialize(@Body() body: unknown) {
    const input = initializeSchema.parse(body);
    return updater("/v1/components/neptune-linux/initialize", {
      request_id: crypto.randomUUID(), head_id: process.env.UPDATER_HEAD_ID?.trim() || "saturn", project_id: "saturn",
      export_url: "http://127.0.0.1:3000/api/v1/internal/neptune/backup", enrollment_code: input.enrollment_code,
    });
  }

  @Put("schedule")
  @HttpCode(204)
  async schedule(@Body() body: unknown): Promise<void> {
    const input = scheduleSchema.parse(body);
    await neptune("PUT", "/schedule", { enabled: input.enabled, intervalHours: input.interval_hours });
  }

  @Post("runs")
  run() { return neptune("POST", "/runs"); }

  @Put("mirror/schedule")
  @HttpCode(204)
  async mirrorSchedule(@Body() body: unknown): Promise<void> {
    const input = mirrorScheduleSchema.parse(body);
    await neptune("PUT", "/mirror/schedule", { enabled: input.enabled, intervalMinutes: input.interval_minutes });
  }

  @Post("mirror/runs")
  mirrorRun() { return neptune("POST", "/mirror/runs"); }

  @Post("update/check")
  async check() {
    const status = await neptune("GET", "/status");
    if (typeof status.version !== "string") throw new Error("Neptune returned an invalid version");
    return updater("/v1/components/neptune-linux/check", {
      head_id: process.env.UPDATER_HEAD_ID?.trim() || "saturn",
      current_version: status.version,
    });
  }

  @Post("update/install")
  async install(@Body() body: unknown) {
    const input = installSchema.parse(body);
    const checked = await this.check();
    if (checked.update_available !== true || checked.available_version !== input.version) throw new Error("Requested Neptune version is not the current upgrade candidate");
    return updater("/v1/components/neptune-linux/update", {
      head_id: process.env.UPDATER_HEAD_ID?.trim() || "saturn",
      version: input.version,
    }, 300_000);
  }
}
