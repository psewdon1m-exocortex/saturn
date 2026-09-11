import http from "node:http";
import { Body, Controller, Post, Res, UseFilters, UseGuards } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { updaterToken } from "./neptune.controller.js";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const schema = z.object({ passphrase: z.string().min(16).max(1024), archive_base64: z.string().max(180 * 1024 * 1024).optional(), confirmation: z.literal("RESTORE HELPERS").optional() }).strict();
@Controller("operator/helper-recovery")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class HelperRecoveryController {
  @Post("export")
  @RequireRecentReauthentication()
  export(@Body() body: unknown, @Res() reply: FastifyReply) { return this.proxy("export", body, reply); }

  @Post("restore")
  @RouteConfig({ bodyLimit: 190 * 1024 * 1024 })
  @RequireRecentReauthentication()
  restore(@Body() body: unknown, @Res() reply: FastifyReply) { return this.proxy("restore", body, reply); }

  private async proxy(action: string, body: unknown, reply: FastifyReply): Promise<void> {
    const input = schema.parse(body);
    if (action === "export" && (input.archive_base64 !== undefined || input.confirmation !== undefined)) throw new Error("Unexpected export parameters");
    const payload = Buffer.from(JSON.stringify({ ...input, head_id: process.env.UPDATER_HEAD_ID?.trim() || "saturn" }));
    const token = updaterToken();
    await new Promise<void>((resolve, reject) => {
      const request = http.request({ socketPath: process.env.UPDATER_SOCKET_PATH?.trim() || "/run/exocortex/updater.sock", host: "updater.local", method: "POST", path: `/v1/host-recovery/${action}`, timeout: 180_000,
        headers: { Host: "updater.local", "X-Updater-Token": token, "Content-Type": "application/json", "Content-Length": payload.length } }, response => {
        reply.status(response.statusCode ?? 502).header("Cache-Control", "no-store").header("Content-Type", response.headers["content-type"] ?? "application/json");
        if (action === "export" && response.statusCode === 200) reply.header("Content-Disposition", `attachment; filename="exocortex-helpers-${new Date().toISOString().replaceAll(":", "-")}.exorecovery"`);
        reply.send(response); resolve();
      });
      request.on("timeout", () => request.destroy(new Error("Helper recovery timed out")));
      request.on("error", reject); request.end(payload);
    });
  }
}
