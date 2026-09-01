import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, UseFilters, UseGuards } from "@nestjs/common";
import type { DeviceService } from "@saturn/sync";
import { z } from "zod";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { DEVICE_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const rights = z.object({ read: z.boolean(), write: z.boolean(), move: z.boolean(), delete: z.boolean() }).strict();
const createSchema = z.object({
  name: z.string().min(1).max(80),
  scopeIds: z.array(z.uuid()).min(1).max(3),
  rights,
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  scopeIds: z.array(z.uuid()).min(1).max(3).optional(),
  rights: rights.optional(),
  expiresAt: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
}).strict();

@Controller("devices")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class DeviceController {
  constructor(@Inject(DEVICE_SERVICE) private readonly devices: DeviceService) {}

  @Post()
  @RequireRecentReauthentication()
  create(@Body() body: unknown) {
    const input = createSchema.parse(body);
    return this.devices.createDevice({ name: input.name, scopeIds: input.scopeIds, rights: input.rights, ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }) });
  }

  @Get()
  list(@Query("offset") offset?: string, @Query("limit") limit?: string) {
    return this.devices.listDevices(offset === undefined ? 0 : Number(offset), limit === undefined ? 100 : Number(limit));
  }

  @Patch(":id")
  @RequireRecentReauthentication()
  update(@Param("id") id: string, @Body() body: unknown) {
    const input = updateSchema.parse(body);
    return this.devices.updateDevice(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.scopeIds === undefined ? {} : { scopeIds: input.scopeIds }),
      ...(input.rights === undefined ? {} : { rights: input.rights }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt) }),
    });
  }

  @Delete(":id")
  @RequireRecentReauthentication()
  revoke(@Param("id") id: string) { return this.devices.revokeDevice(id); }
}
