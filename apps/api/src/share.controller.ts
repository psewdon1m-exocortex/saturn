import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Query, Req, Res, UnauthorizedException, UseFilters, UseGuards } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import type { ShareService } from "@saturn/shares";
import { fastifyCookie } from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { ShareApiExceptionFilter } from "./share-api-exception.filter.js";
import { APP_CONFIG, SHARE_SERVICE } from "./tokens.js";

const mode = z.enum(["view", "download", "browse", "download_folder"]);
const createSchema = z.object({
  resourceId: z.uuid(),
  mode,
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  password: z.string().min(12).max(128).optional(),
  maxDownloads: z.number().int().min(1).max(1_000_000).optional(),
  allowedCidr: z.string().min(3).max(64).optional(),
}).strict();
const updateSchema = z.object({
  mode: mode.optional(),
  expiresAt: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
  password: z.union([z.string().min(12).max(128), z.null()]).optional(),
  maxDownloads: z.union([z.number().int().min(1).max(1_000_000), z.null()]).optional(),
  allowedCidr: z.union([z.string().min(3).max(64), z.null()]).optional(),
}).strict();
const unlockSchema = z.object({ password: z.string().min(1).max(256) }).strict();
const classificationSchema = z.object({ classification: z.enum(["public", "internal", "confidential", "secret"]) }).strict();

function cookies(request: FastifyRequest): Record<string, string> {
  try { return fastifyCookie.parse(request.headers.cookie ?? ""); } catch { return {}; }
}

function sessionName(config: SaturnConfig): string {
  return config.environment === "production" ? "__Host-vault_share_session" : "vault_share_session_dev";
}

function setSessionCookie(config: SaturnConfig, reply: FastifyReply, value: { readonly token: string; readonly session: { readonly expiresAt: Date } }): void {
  reply.header("Set-Cookie", fastifyCookie.serialize(sessionName(config), value.token, {
    path: "/",
    sameSite: "strict",
    secure: config.environment === "production",
    httpOnly: true,
    expires: value.session.expiresAt,
  }));
}

function accessInput(config: SaturnConfig, request: FastifyRequest, overrideToken?: string) {
  const token = overrideToken ?? cookies(request)[sessionName(config)];
  return {
    sourceIp: request.ip,
    userAgent: request.headers["user-agent"] ?? "",
    ...(token === undefined ? {} : { sessionToken: token }),
  };
}

function requireSameOrigin(config: SaturnConfig, request: FastifyRequest): void {
  let origin = "";
  try { origin = new URL(request.headers.origin ?? "").origin; } catch { throw new UnauthorizedException(); }
  if (origin !== new URL(config.publicOrigin).origin) throw new UnauthorizedException();
}

function range(value: string | undefined, size: number): { readonly offset: number; readonly length?: number; readonly partial: boolean } {
  if (value === undefined) return { offset: 0, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === "" && match[2] === "") || size === 0) throw new Error("Range is invalid");
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new Error("Range is invalid");
    const length = Math.min(suffix, size);
    return { offset: size - length, length, partial: true };
  }
  const offset = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || end >= size) throw new Error("Range is invalid");
  return { offset, length: end - offset + 1, partial: true };
}

function disposition(kind: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "shared-file";
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller("shares")
@UseGuards(OwnerTokenGuard)
@UseFilters(ShareApiExceptionFilter)
export class ShareOwnerController {
  constructor(@Inject(SHARE_SERVICE) private readonly shares: ShareService) {}

  @Post()
  @RequireRecentReauthentication()
  async create(@Body() body: unknown) {
    const input = createSchema.parse(body);
    return this.shares.createShare({
      resourceId: input.resourceId,
      mode: input.mode,
      ...(input.expiresAt === undefined ? {} : { expiresAt: new Date(input.expiresAt) }),
      ...(input.password === undefined ? {} : { password: input.password }),
      ...(input.maxDownloads === undefined ? {} : { maxDownloads: input.maxDownloads }),
      ...(input.allowedCidr === undefined ? {} : { allowedCidr: input.allowedCidr }),
    });
  }

  @Get()
  list(@Query("offset") offset?: string, @Query("limit") limit?: string) {
    return this.shares.listShares(offset === undefined ? 0 : Number(offset), limit === undefined ? 100 : Number(limit));
  }

  @Patch(":id")
  @RequireRecentReauthentication()
  async update(@Param("id") id: string, @Body() body: unknown) {
    const input = updateSchema.parse(body);
    return this.shares.updateShare(id, {
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt) }),
      ...(input.password === undefined ? {} : { password: input.password }),
      ...(input.maxDownloads === undefined ? {} : { maxDownloads: input.maxDownloads }),
      ...(input.allowedCidr === undefined ? {} : { allowedCidr: input.allowedCidr }),
    });
  }

  @Delete(":id")
  @RequireRecentReauthentication()
  revoke(@Param("id") id: string) { return this.shares.revokeShare(id); }
}

@Controller("resources")
@UseGuards(OwnerTokenGuard)
@UseFilters(ShareApiExceptionFilter)
export class ResourceClassificationController {
  constructor(@Inject(SHARE_SERVICE) private readonly shares: ShareService) {}

  @Patch(":id/classification")
  @RequireRecentReauthentication()
  classify(@Param("id") id: string, @Body() body: unknown) {
    return this.shares.classifyResource(id, classificationSchema.parse(body).classification);
  }
}

@Controller("public/shares")
@UseFilters(ShareApiExceptionFilter)
export class PublicShareController {
  constructor(@Inject(APP_CONFIG) private readonly config: SaturnConfig, @Inject(SHARE_SERVICE) private readonly shares: ShareService) {}

  @Get(":token")
  async metadata(@Param("token") token: string, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.shares.metadata(token, accessInput(this.config, request));
    if (result.session !== undefined) setSessionCookie(this.config, reply, result.session);
    return result.share;
  }

  @Post(":token/unlock")
  @HttpCode(200)
  async unlock(@Param("token") token: string, @Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    requireSameOrigin(this.config, request);
    const result = await this.shares.unlock(token, unlockSchema.parse(body).password, accessInput(this.config, request));
    setSessionCookie(this.config, reply, result.session);
    return result.share;
  }

  @Get(":token/children")
  async children(@Param("token") token: string, @Query("parentId") parentId: string | undefined, @Req() request: FastifyRequest) {
    return this.shares.listChildren(token, parentId, accessInput(this.config, request));
  }

  @Get(":token/content")
  async content(@Param("token") token: string, @Headers("range") rawRange: string | undefined, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const metadata = await this.shares.metadata(token, accessInput(this.config, request));
    if (metadata.share.locked) throw new UnauthorizedException({ code: "share_locked" });
    if (metadata.session !== undefined) setSessionCookie(this.config, reply, metadata.session);
    let selectedRange: ReturnType<typeof range>;
    try { selectedRange = range(rawRange, metadata.share.resourceSize); }
    catch { reply.status(416).header("Content-Range", `bytes */${String(metadata.share.resourceSize)}`).send({ code: "range_not_satisfiable" }); return; }
    const opened = await this.shares.openContent(token, selectedRange, accessInput(this.config, request, metadata.session?.token));
    const contentLength = selectedRange.length ?? metadata.share.resourceSize;
    reply
      .header("Accept-Ranges", "bytes")
      .header("Content-Length", contentLength)
      .header("Content-Type", opened.resource.mimeType ?? "application/octet-stream")
      .header("Content-Disposition", disposition(opened.share.mode === "view" ? "inline" : "attachment", opened.resource.name));
    if (selectedRange.partial) reply.status(206).header("Content-Range", `bytes ${String(selectedRange.offset)}-${String(selectedRange.offset + contentLength - 1)}/${String(metadata.share.resourceSize)}`);
    reply.send(opened.stream);
  }

  @Post(":token/package")
  async preparePackage(@Param("token") token: string, @Req() request: FastifyRequest) {
    requireSameOrigin(this.config, request);
    return this.shares.preparePackage(token, accessInput(this.config, request));
  }

  @Get(":token/package")
  async packageContent(@Param("token") token: string, @Headers("range") rawRange: string | undefined, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const metadata = await this.shares.metadata(token, accessInput(this.config, request));
    if (metadata.share.locked) throw new UnauthorizedException({ code: "share_locked" });
    if (metadata.session !== undefined) setSessionCookie(this.config, reply, metadata.session);
    const preparedAccess = await this.shares.packageMetadata(token, accessInput(this.config, request, metadata.session?.token));
    const prepared = preparedAccess.package;
    let selectedRange: ReturnType<typeof range>;
    try { selectedRange = range(rawRange, prepared.sizeBytes); }
    catch { reply.status(416).header("Content-Range", `bytes */${String(prepared.sizeBytes)}`).send({ code: "range_not_satisfiable" }); return; }
    const opened = await this.shares.openPackage(token, selectedRange, accessInput(this.config, request, metadata.session?.token));
    const contentLength = selectedRange.length ?? prepared.sizeBytes;
    reply.header("Accept-Ranges", "bytes").header("Content-Length", contentLength).header("Content-Type", "application/zip").header("Content-Disposition", disposition("attachment", `${metadata.share.resourceName}.zip`));
    if (selectedRange.partial) reply.status(206).header("Content-Range", `bytes ${String(selectedRange.offset)}-${String(selectedRange.offset + contentLength - 1)}/${String(prepared.sizeBytes)}`);
    reply.send(opened.stream);
  }
}
