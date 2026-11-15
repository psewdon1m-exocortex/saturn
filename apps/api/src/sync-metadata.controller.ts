import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, UseFilters } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import { SYNC_METADATA_MAX_ITEMS } from "@saturn/file-core";
import type { DeviceService } from "@saturn/sync";
import { z } from "zod";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { DEVICE_SERVICE } from "./tokens.js";

const batchBody = z.object({ nodeIds: z.array(z.uuid()).min(1).max(SYNC_METADATA_MAX_ITEMS) }).strict();

@Controller("sync/roots")
@UseFilters(SaturnApiExceptionFilter)
export class SyncMetadataController {
  constructor(@Inject(DEVICE_SERVICE) private readonly devices: DeviceService) {}

  @Get(":rootId/capabilities")
  @RouteConfig({ syncMetadata: true })
  async capabilities(@Param("rootId") rootId: string, @Headers("authorization") authorization: string | undefined) {
    const context = await this.devices.authenticateSyncMetadata(authorization);
    return this.devices.syncMetadataCapabilities(context, z.uuid().parse(rootId).toLowerCase());
  }

  @Post(":rootId/metadata/batch")
  @HttpCode(200)
  @RouteConfig({ syncMetadata: true })
  async batch(@Param("rootId") rootId: string, @Body() body: unknown, @Headers("authorization") authorization: string | undefined) {
    const context = await this.devices.authenticateSyncMetadata(authorization);
    const request = batchBody.parse(body);
    return this.devices.syncMetadataBatch(context, z.uuid().parse(rootId).toLowerCase(), request.nodeIds);
  }
}
