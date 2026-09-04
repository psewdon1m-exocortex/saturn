import { Readable } from "node:stream";
import { Body, Controller, Delete, Get, Headers, HttpCode, HttpException, HttpStatus, Inject, type MessageEvent, Param, Patch, Post, Req, Res, Sse, UnauthorizedException, UseFilters, UseGuards } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import { DropServiceError, type DropService } from "@saturn/drop";
import { fastifyCookie } from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { from, interval, type Observable, timer } from "rxjs";
import { distinctUntilChanged, map, startWith, switchMap, takeUntil } from "rxjs/operators";
import { z } from "zod";
import { DROP_SESSION, DropSessionGuard, dropCookieNames } from "./drop-session.guard.js";
import type { AuthenticatedDropRequest } from "./drop-session.guard.js";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { APP_CONFIG, DROP_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const redeemSchema = z.object({ code: z.string().min(1).max(32) }).strict();
const createSchema = z.object({
  filename: z.string().min(1).max(255),
  expectedSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
}).strict();
const completeSchema = z.object({ uploadId: z.uuid() }).strict();

function requestCookies(request: FastifyRequest): Record<string, string> {
  try { return fastifyCookie.parse(request.headers.cookie ?? ""); } catch { return {}; }
}

function integerHeader(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

@Controller("drop")
@UseFilters(SaturnApiExceptionFilter)
export class DropController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: SaturnConfig,
    @Inject(DROP_SERVICE) private readonly drop: DropService,
  ) {}

  #setCookies(reply: FastifyReply, created: { readonly token: string; readonly csrfToken: string; readonly session: { readonly expiresAt: Date } }): void {
    const names = dropCookieNames(this.config);
    const common = { path: "/", sameSite: "strict" as const, secure: this.config.environment === "production", expires: new Date(created.session.expiresAt.getTime() + this.config.drop.continuationTtlMs) };
    reply.header("Set-Cookie", [
      fastifyCookie.serialize(names.session, created.token, { ...common, httpOnly: true }),
      fastifyCookie.serialize(names.csrf, created.csrfToken, { ...common, httpOnly: false }),
    ]);
  }

  #clearCookies(reply: FastifyReply): void {
    const names = dropCookieNames(this.config);
    const common = { path: "/", sameSite: "strict" as const, secure: this.config.environment === "production", expires: new Date(0), maxAge: 0 };
    reply.header("Set-Cookie", [
      fastifyCookie.serialize(names.session, "", { ...common, httpOnly: true }),
      fastifyCookie.serialize(names.csrf, "", { ...common, httpOnly: false }),
    ]);
  }

  @Post("codes")
  @UseGuards(OwnerTokenGuard)
  issueCode() {
    return this.drop.issueDropCode();
  }

  @Post("internal/session")
  @UseGuards(OwnerTokenGuard)
  async internalSession(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const now = new Date();
    const challenge = await this.drop.issueDropCode(now);
    const created = await this.drop.redeem(challenge.code, `owner:${request.ip}`, request.headers["user-agent"] ?? "", now);
    this.#setCookies(reply, created);
    return {
      state: "upload_only",
      channelId: created.session.channelId,
      expiresAt: created.session.expiresAt,
      maxFiles: created.session.maxFiles,
      maxBytes: created.session.maxBytes,
      reservedFiles: created.session.reservedFiles,
      reservedBytes: created.session.reservedBytes,
      buffer: await this.drop.bufferCapacity(),
    };
  }

  @Get("buffer")
  @UseGuards(OwnerTokenGuard)
  async buffer() {
    return {
      capacity: await this.drop.bufferCapacity(),
      sessionTtlMs: this.config.drop.sessionTtlMs,
      continuationTtlMs: this.config.drop.continuationTtlMs,
      workers: this.config.drop.drainWorkers,
      intervalMs: this.config.drop.drainIntervalMs,
    };
  }

  @Post("redeem")
  async redeem(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const expectedOrigin = new URL(this.config.publicOrigin).origin;
    let actualOrigin: string;
    try { actualOrigin = new URL(request.headers.origin ?? "").origin; }
    catch { throw new UnauthorizedException(); }
    if (actualOrigin !== expectedOrigin) throw new UnauthorizedException();
    try {
      const created = await this.drop.redeem(redeemSchema.parse(body).code, request.ip, request.headers["user-agent"] ?? "");
      this.#setCookies(reply, created);
      return { state: "upload_only", channelId: created.session.channelId, expiresAt: created.session.expiresAt, maxFiles: created.session.maxFiles, maxBytes: created.session.maxBytes };
    } catch (error) {
      if (error instanceof DropServiceError && error.code === "rate_limited") {
        throw new HttpException({ code: "drop_unavailable" }, HttpStatus.TOO_MANY_REQUESTS);
      }
      if (error instanceof DropServiceError) throw new UnauthorizedException({ code: "drop_code_rejected" });
      throw error;
    }
  }

  @Post("uploads")
  @UseGuards(DropSessionGuard)
  async createUpload(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedDropRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = request[DROP_SESSION];
    if (session === undefined || idempotencyKey === undefined) throw new UnauthorizedException();
    try {
      const input = createSchema.parse(body);
      const upload = await this.drop.createUpload(session, {
        filename: input.filename,
        expectedSize: input.expectedSize,
        ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
        idempotencyKey,
      });
      reply.header("Location", `/api/v1/drop/uploads/${upload.id}/status`);
      return upload;
    } catch (error) {
      if (error instanceof DropServiceError && error.code === "quota_exhausted") throw new HttpException({ code: "drop_quota_exhausted" }, HttpStatus.PAYLOAD_TOO_LARGE);
      throw error;
    }
  }

  @Get("session")
  @UseGuards(DropSessionGuard)
  async session(@Req() request: AuthenticatedDropRequest) {
    const session = request[DROP_SESSION];
    if (session === undefined) throw new UnauthorizedException();
    return {
      state: "upload_only",
      channelId: session.channelId,
      expiresAt: session.expiresAt,
      maxFiles: session.maxFiles,
      maxBytes: session.maxBytes,
      reservedFiles: session.reservedFiles,
      reservedBytes: session.reservedBytes,
      buffer: await this.drop.bufferCapacity(),
    };
  }

  @Get("uploads")
  @UseGuards(DropSessionGuard)
  uploads(@Req() request: AuthenticatedDropRequest) {
    const session = request[DROP_SESSION];
    if (session === undefined) throw new UnauthorizedException();
    return this.drop.listUploads(session);
  }

  @Sse("events")
  @UseGuards(DropSessionGuard)
  events(@Req() request: AuthenticatedDropRequest): Observable<MessageEvent> {
    const session = request[DROP_SESSION];
    if (session === undefined) throw new UnauthorizedException();
    const remainingMs = Math.max(1, session.expiresAt.getTime() - Date.now());
    return interval(750).pipe(
      startWith(0),
      switchMap(() => from(this.drop.listUploads(session))),
      map((uploads) => ({ uploads, fingerprint: JSON.stringify(uploads) })),
      distinctUntilChanged((left, right) => left.fingerprint === right.fingerprint),
      map(({ uploads }) => ({ type: "uploads", data: uploads })),
      takeUntil(timer(remainingMs)),
    );
  }

  @Get("uploads/:id/status")
  @UseGuards(DropSessionGuard)
  status(@Param("id") id: string, @Req() request: AuthenticatedDropRequest) {
    const session = request[DROP_SESSION];
    if (session === undefined) throw new UnauthorizedException();
    return this.drop.inspectUpload(session, id);
  }

  @Patch("uploads/:id")
  @HttpCode(204)
  @UseGuards(DropSessionGuard)
  async append(
    @Param("id") id: string,
    @Headers("upload-offset") rawOffset: string | undefined,
    @Headers("content-length") rawLength: string | undefined,
    @Req() request: AuthenticatedDropRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = request[DROP_SESSION];
    if (session === undefined) throw new UnauthorizedException();
    const status = await this.drop.appendUpload(session, id, integerHeader(rawOffset, "Upload-Offset"), integerHeader(rawLength, "Content-Length"), Readable.from(request.body as AsyncIterable<Uint8Array>));
    reply.header("Upload-Offset", status.receivedSize).status(204).send();
  }

  @Post("complete")
  @UseGuards(DropSessionGuard)
  complete(@Body() body: unknown, @Req() request: AuthenticatedDropRequest) {
    const session = request[DROP_SESSION];
    if (session === undefined) throw new UnauthorizedException();
    return this.drop.completeUpload(session, completeSchema.parse(body).uploadId);
  }

  @Delete("uploads/:id")
  @UseGuards(DropSessionGuard)
  cancel(@Param("id") id: string, @Req() request: AuthenticatedDropRequest) {
    const session = request[DROP_SESSION];
    if (session === undefined) throw new UnauthorizedException();
    return this.drop.cancelUpload(session, id);
  }

  @Post("logout")
  @UseGuards(DropSessionGuard)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const names = dropCookieNames(this.config);
    await this.drop.revokeSession(requestCookies(request)[names.session] ?? "");
    this.#clearCookies(reply);
    return { state: "anonymous" };
  }
}
