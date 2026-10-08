import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Req, Res, UnauthorizedException, UseFilters } from "@nestjs/common";
import type { OwnerAuthService } from "@saturn/auth";
import type { DeviceService } from "@saturn/sync";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { AUTH_SERVICE, DEVICE_SERVICE } from "./tokens.js";

const resumableUploadSchema = z.object({ path: z.string().min(1).max(4096), expectedSize: z.number().int().nonnegative(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/), ifMatch: z.string().max(100).optional(), ifNoneMatch: z.literal("*").optional() }).strict();

@Controller("sync")
@UseFilters(SaturnApiExceptionFilter)
export class SyncClientController {
  constructor(
    @Inject(DEVICE_SERVICE) private readonly devices: DeviceService,
    @Inject(AUTH_SERVICE) private readonly owner: OwnerAuthService,
  ) {}

  @Post("uploads")
  async createUpload(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const input = resumableUploadSchema.parse(body);
    return this.devices.createResumableUpload(await this.devices.authenticate(authorization), {
      path: input.path, expectedSize: input.expectedSize, expectedSha256: input.expectedSha256, idempotencyKey: input.idempotencyKey,
      ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }), ...(input.ifNoneMatch === undefined ? {} : { ifNoneMatch: input.ifNoneMatch }),
    });
  }

  @Get("uploads/:id")
  async inspectUpload(@Headers("authorization") authorization: string | undefined, @Param("id") id: string) {
    return this.devices.inspectResumableUpload(await this.devices.authenticate(authorization), z.uuid().parse(id));
  }

  @Post("uploads/cancel")
  async cancelUpload(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const input = z.object({ idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(body);
    return this.devices.cancelResumableUpload(await this.devices.authenticate(authorization), input.idempotencyKey);
  }

  @Patch("uploads/:id")
  async appendUpload(@Headers("authorization") authorization: string | undefined, @Param("id") id: string, @Req() request: FastifyRequest) {
    const context = await this.devices.authenticate(authorization);
    if (!(request.body instanceof Readable)) throw new Error("Upload body is invalid");
    const offset = z.coerce.number().int().nonnegative().parse(request.headers["upload-offset"]);
    const length = z.coerce.number().int().positive().parse(request.headers["content-length"]);
    return this.devices.appendResumableUpload(context, z.uuid().parse(id), offset, length, request.body);
  }

  @Post("uploads/:id/complete")
  async completeUpload(@Headers("authorization") authorization: string | undefined, @Param("id") id: string) {
    return this.devices.completeResumableUpload(await this.devices.authenticate(authorization), z.uuid().parse(id));
  }

  @Get("preferences")
  async preferences(@Headers("authorization") authorization: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    try { await this.devices.authenticate(authorization); }
    catch { throw new UnauthorizedException({ code: "device_authentication_required" }); }
    const preferences = await this.owner.getPreferences();
    reply.header("Cache-Control", "no-store");
    return { accentColor: preferences.accentColor, updatedAt: preferences.updatedAt };
  }
}
