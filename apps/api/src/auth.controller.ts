import { Body, Controller, Delete, Get, HttpException, HttpStatus, Inject, Post, Put, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { OwnerAuthenticationError, type OwnerAuthService } from "@saturn/auth";
import type { SaturnConfig } from "@saturn/config";
import { fastifyCookie } from "@fastify/cookie";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  OWNER_SESSION,
  OwnerTokenGuard,
  RequireRecentReauthentication,
  ownerCookieNames,
  type AuthenticatedOwnerRequest,
} from "./owner-token.guard.js";
import { APP_CONFIG, AUTH_SERVICE } from "./tokens.js";

const accessKeySchema = z.object({ accessKey: z.string().min(1).max(512) }).strict();
const appearanceSchema = z.object({
  darkColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  lightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict();

function requestCookies(request: FastifyRequest): Record<string, string> {
  try {
    return fastifyCookie.parse(request.headers.cookie ?? "");
  } catch {
    return {};
  }
}

@Controller("auth")
export class AuthController {
  readonly #auth: OwnerAuthService;
  readonly #config: SaturnConfig;

  constructor(
    @Inject(AUTH_SERVICE) auth: OwnerAuthService,
    @Inject(APP_CONFIG) config: SaturnConfig,
  ) {
    this.#auth = auth;
    this.#config = config;
  }

  #setCookies(reply: FastifyReply, session: { readonly token: string; readonly csrfToken: string; readonly session: { readonly expiresAt: Date } }): void {
    const names = ownerCookieNames(this.#config);
    const common = {
      path: "/",
      sameSite: "strict" as const,
      secure: this.#config.environment === "production",
      expires: session.session.expiresAt,
    };
    reply.header("Set-Cookie", [
      fastifyCookie.serialize(names.session, session.token, { ...common, httpOnly: true }),
      fastifyCookie.serialize(names.csrf, session.csrfToken, { ...common, httpOnly: false }),
    ]);
  }

  #clearCookies(reply: FastifyReply): void {
    const names = ownerCookieNames(this.#config);
    const common = { path: "/", sameSite: "strict" as const, secure: this.#config.environment === "production", expires: new Date(0), maxAge: 0 };
    reply.header("Set-Cookie", [
      fastifyCookie.serialize(names.session, "", { ...common, httpOnly: true }),
      fastifyCookie.serialize(names.csrf, "", { ...common, httpOnly: false }),
    ]);
  }

  @Post("login")
  async login(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = accessKeySchema.parse(body);
    try {
      const created = await this.#auth.authenticate(input.accessKey, request.ip, request.headers["user-agent"] ?? "");
      this.#setCookies(reply, created);
      return { state: "authenticated", expiresAt: created.session.expiresAt, idleExpiresAt: created.session.idleExpiresAt };
    } catch (error) {
      if (error instanceof OwnerAuthenticationError && error.code === "rate_limited") {
        throw new HttpException({ code: "authentication_unavailable" }, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new UnauthorizedException({ code: "authentication_failed" });
    }
  }

  @Get("session")
  @UseGuards(OwnerTokenGuard)
  session(@Req() request: AuthenticatedOwnerRequest) {
    const session = request[OWNER_SESSION];
    return session === undefined
      ? { state: "break_glass" }
      : { state: "authenticated", expiresAt: session.expiresAt, idleExpiresAt: session.idleExpiresAt, reauthenticatedAt: session.reauthenticatedAt };
  }

  @Post("reauthenticate")
  @UseGuards(OwnerTokenGuard)
  async reauthenticate(
    @Body() body: unknown,
    @Req() request: AuthenticatedOwnerRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const previous = request[OWNER_SESSION];
    if (previous === undefined) throw new UnauthorizedException();
    const names = ownerCookieNames(this.#config);
    const token = requestCookies(request)[names.session];
    if (token === undefined) throw new UnauthorizedException();
    try {
      const replacement = await this.#auth.reauthenticate({
        previous,
        previousToken: token,
        accessKey: accessKeySchema.parse(body).accessKey,
        sourceIp: request.ip,
        userAgent: request.headers["user-agent"] ?? "",
      });
      this.#setCookies(reply, replacement);
      return { state: "reauthenticated", expiresAt: replacement.session.expiresAt };
    } catch {
      throw new UnauthorizedException({ code: "authentication_failed" });
    }
  }

  @Post("logout")
  @UseGuards(OwnerTokenGuard)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const names = ownerCookieNames(this.#config);
    await this.#auth.logout(requestCookies(request)[names.session] ?? "");
    this.#clearCookies(reply);
    return { state: "anonymous" };
  }

  @Delete("sessions")
  @UseGuards(OwnerTokenGuard)
  @RequireRecentReauthentication()
  async revokeAll(@Res({ passthrough: true }) reply: FastifyReply) {
    const revoked = await this.#auth.revokeAll();
    this.#clearCookies(reply);
    return { state: "anonymous", revoked };
  }

  @Get("preferences")
  @UseGuards(OwnerTokenGuard)
  preferences() {
    return this.#auth.getPreferences();
  }

  @Put("preferences")
  @UseGuards(OwnerTokenGuard)
  updatePreferences(@Body() body: unknown) {
    return this.#auth.updatePreferences(appearanceSchema.parse(body));
  }
}
