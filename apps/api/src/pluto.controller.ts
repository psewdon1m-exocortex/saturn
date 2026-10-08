import { Readable } from "node:stream";
import { Body, Controller, Get, Headers, Inject, Post, Put, Query, Req, UseFilters } from "@nestjs/common";
import { type DeviceService, type PlutoStatus, resourceEtag } from "@saturn/sync";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { DEVICE_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const redeemSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{32}$/), version: z.string().min(1).max(100) }).strict();
const statusSchema = z.object({ enabled: z.boolean(), intervalSeconds: z.number().int().min(60).max(31536000), uploadedFiles: z.number().int().min(0), lastAttemptAt: z.iso.datetime().optional(), lastSuccessAt: z.iso.datetime().optional(), nextRunAt: z.iso.datetime().optional(), error: z.string().max(1000).optional() }).strict();
const checkInSchema = z.object({ version: z.string().min(1).max(100), status: statusSchema }).strict();

@Controller("pluto")
@UseFilters(SaturnApiExceptionFilter)
export class PlutoController {
  constructor(@Inject(DEVICE_SERVICE) private readonly devices: DeviceService) {}
  @Post("enrollments/redeem") redeem(@Body() body: unknown) { const input = redeemSchema.parse(body); return this.devices.redeemPlutoEnrollment(input.code, input.version); }
  @Post("check-in") checkIn(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) { const input = checkInSchema.parse(body); return this.devices.plutoHeartbeat(authorization, input.version, input.status as PlutoStatus); }
  @Get("files") async metadata(@Headers("authorization") authorization: string | undefined, @Query("path") path: string | undefined) {
    const context = await this.devices.authenticate(authorization);
    const logical = await this.devices.plutoPath(context, path ?? "");
    await this.devices.enforcePlutoRetention(context, logical);
    const entries = await this.devices.propfind(context, logical, 0);
    const resource = entries[0]?.resource;
    if (!resource) throw new Error("File not found");
    return { type: resource.type, sha256: resource.sha256, sizeBytes: resource.sizeBytes, etag: resourceEtag(resource) };
  }
  @Post("folders") async folder(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const input = z.object({ path: z.string().min(1).max(4096) }).strict().parse(body);
    const context = await this.devices.authenticate(authorization), logical = await this.devices.plutoPath(context, input.path);
    return this.devices.createCollection(context, logical);
  }
  @Put("files") async upload(@Headers("authorization") authorization: string | undefined, @Headers("content-length") length: string | undefined, @Headers("x-content-sha256") sha256: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Headers("if-none-match") ifNoneMatch: string | undefined, @Query("path") path: string, @Req() request: FastifyRequest) {
    const size = Number(length);
    if (length === undefined || !Number.isSafeInteger(size) || size < 0 || size > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256 ?? "") || !path) throw new Error("Upload metadata is invalid");
    const context = await this.devices.authenticate(authorization), logical = await this.devices.plutoPath(context, path);
    const stream = request.body instanceof Readable ? request.body : Buffer.isBuffer(request.body) ? Readable.from(request.body) : undefined;
    if (!stream) throw new Error("Upload body is invalid");
    const result = await this.devices.put(context, logical, stream, size, { ...(ifMatch === undefined ? {} : { ifMatch }), ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }), expectedSha256: sha256 as string });
    return { sha256: result.resource.sha256, sizeBytes: result.resource.sizeBytes, etag: resourceEtag(result.resource) };
  }
}
