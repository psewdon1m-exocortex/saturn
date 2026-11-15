import { Body, Controller, Delete, Get, Headers, Inject, Optional, Param, Patch, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import type { DeviceService } from "@saturn/sync";
import { z } from "zod";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { DEVICE_SERVICE, APP_CONFIG, GUARDED_RUNTIME } from "./tokens.js";
import type { SaturnConfig } from "@saturn/config";
import type { FastifyRequest } from "fastify";
import type { GuardedRuntime } from "../../../packages/sync/src/guarded-runtime.js";
import { guardedOwnerInput } from "./guarded-owner-context.js";
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
const enrollmentCreateSchema = z.object({ name: z.string().min(1).max(80), deviceKind: z.literal("pluto").optional() }).strict();
const enrollmentRedeemSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{32}$/), version: z.string().min(1).max(100) }).strict();
const heartbeatSchema = z.object({ platform: z.enum(["windows", "linux"]), version: z.string().min(1).max(100) }).strict();

@Controller("devices")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class DeviceController {
  constructor(@Inject(DEVICE_SERVICE) private readonly devices: DeviceService,
    @Optional() @Inject(GUARDED_RUNTIME) private readonly guarded?: GuardedRuntime,
    @Optional() @Inject(APP_CONFIG) private readonly config?: SaturnConfig) {}

  @Post()
  create(@Body() body: unknown) {
    const input = createSchema.parse(body);
    return this.devices.createDevice({ name: input.name, scopeIds: input.scopeIds, rights: input.rights, ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }) });
  }

  @Post("enrollments")
  createEnrollment(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = enrollmentCreateSchema.parse(body);
    const action = () => input.deviceKind === "pluto" ? this.devices.createPlutoEnrollment(input.name) : this.devices.createWindowsEnrollment(input.name);
    if (!this.guarded) return action(); if (!this.config) throw Error("Owner auth configuration unavailable");
    return this.guarded.ownerAction(guardedOwnerInput(request, this.config), action);
  }

  @Post(":id/enrollment")
  createReplacementEnrollment(@Param("id") id: string) {
    return this.devices.createWindowsEnrollmentForDevice(id);
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
  revoke(@Param("id") id: string) { return this.devices.revokeDevice(id); }
}

@Controller("device-enrollments")
@UseFilters(SaturnApiExceptionFilter)
export class DeviceEnrollmentController {
  constructor(@Inject(DEVICE_SERVICE) private readonly devices: DeviceService) {}

  @Post("redeem")
  redeem(@Body() body: unknown) {
    const input = enrollmentRedeemSchema.parse(body);
    return this.devices.redeemWindowsEnrollment(input.code, input.version);
  }
}

@Controller("device-session")
@UseFilters(SaturnApiExceptionFilter)
export class DeviceSessionController {
  constructor(@Inject(DEVICE_SERVICE) private readonly devices: DeviceService) {}

  @Post("heartbeat")
  heartbeat(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const input = heartbeatSchema.parse(body);
    return this.devices.heartbeat(authorization, input.platform, input.version);
  }
}
