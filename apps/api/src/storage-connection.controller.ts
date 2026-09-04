import { BadRequestException, Body, Controller, Get, Inject, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { StorageConnectionService } from "./storage-connection.service.js";

const connectionSchema = z.object({
  host: z.string().trim().min(1).max(255).regex(/^\S+$/),
  port: z.number().int().min(1).max(65_535),
  username: z.string().trim().min(1).max(255).regex(/^\S+$/),
  root: z.string().trim().min(1).max(1_024),
  hostFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
  authMode: z.enum(["password_file", "private_key_file"]),
  credential: z.string().min(1).max(65_536),
}).strict();

const switchSchema = connectionSchema.extend({
  confirmation: z.literal("SWITCH WITHOUT MIGRATION"),
}).strict();

@Controller("operator/storage")
@UseGuards(OwnerTokenGuard)
export class StorageConnectionController {
  constructor(@Inject(StorageConnectionService) private readonly storage: StorageConnectionService) {}

  @Get()
  status() {
    return this.storage.status();
  }

  @Post("test")
  @RequireRecentReauthentication()
  async test(@Body() body: unknown) {
    const parsed = connectionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "invalid_storage_connection" });
    try { return await this.storage.test(parsed.data); }
    catch { throw new BadRequestException({ code: "storage_connection_failed" }); }
  }

  @Post("switch")
  @RequireRecentReauthentication()
  async switch(@Body() body: unknown) {
    const parsed = switchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "invalid_storage_switch" });
    try { return await this.storage.switch(parsed.data); }
    catch (error) {
      const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "storage_switch_failed";
      throw new BadRequestException({ code });
    }
  }
}
