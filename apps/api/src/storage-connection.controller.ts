import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { StorageCatalogError, StorageCatalogService } from "@saturn/protection";
import { z } from "zod";
import { OwnerTokenGuard } from "./owner-token.guard.js";
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
  constructor(@Inject(StorageConnectionService) private readonly storage: StorageConnectionService,
    @Inject(StorageCatalogService) private readonly catalog: StorageCatalogService) {}

  @Get("analysis")
  analysis(@Query("offset") offset = "0") {
    const parsed = z.coerce.number().int().min(0).max(100_000).safeParse(offset);
    if (!parsed.success) throw new BadRequestException({ code: "invalid_storage_analysis_offset" });
    return this.catalog.latest(parsed.data);
  }

  @Post("analysis")
  async analyze() {
    try { return await this.catalog.start(); }
    catch (error) { if (error instanceof StorageCatalogError) throw new ConflictException({ code: error.code }); throw error; }
  }

  @Post("analysis/:id/synchronize")
  async synchronize(@Param("id") id: string, @Body() body: unknown) {
    if (!z.uuid().safeParse(id).success || !z.object({ confirmation: z.literal("SYNCHRONIZE CATALOG") }).strict().safeParse(body).success) {
      throw new BadRequestException({ code: "invalid_storage_synchronization" });
    }
    try { return await this.catalog.synchronize(id); }
    catch (error) { if (error instanceof StorageCatalogError) throw new ConflictException({ code: error.code }); throw error; }
  }

  @Get()
  status() {
    return this.storage.status();
  }

  @Post("test")
  async test(@Body() body: unknown) {
    const parsed = connectionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ code: "invalid_storage_connection" });
    try { return await this.storage.test(parsed.data); }
    catch { throw new BadRequestException({ code: "storage_connection_failed" }); }
  }

  @Post("switch")
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
