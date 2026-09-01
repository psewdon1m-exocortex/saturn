import { ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OwnerAuthenticationError, type OwnerAuthService, type OwnerSession } from "@saturn/auth";
import type { SaturnConfig } from "@saturn/config";
import { fastifyCookie } from "@fastify/cookie";
import type { FastifyRequest } from "fastify";
import { APP_CONFIG, AUTH_SERVICE } from "./tokens.js";

const recentReauthenticationKey = "vault:recent-reauthentication";
export const RequireRecentReauthentication = () => SetMetadata(recentReauthenticationKey, true);
export const OWNER_SESSION = Symbol("OWNER_SESSION");

export interface AuthenticatedOwnerRequest extends FastifyRequest {
  [OWNER_SESSION]?: OwnerSession;
}

function cookieNames(config: SaturnConfig): { readonly session: string; readonly csrf: string } {
  return config.environment === "production"
    ? { session: "__Host-vault_session", csrf: "__Host-vault_csrf" }
    : { session: "vault_session_dev", csrf: "vault_csrf_dev" };
}

@Injectable()
export class OwnerTokenGuard implements CanActivate {
  readonly #config: SaturnConfig;
  readonly #auth: OwnerAuthService;
  readonly #reflector: Reflector;

  constructor(
    @Inject(APP_CONFIG) config: SaturnConfig,
    @Inject(AUTH_SERVICE) auth: OwnerAuthService,
    @Inject(Reflector) reflector: Reflector,
  ) {
    this.#config = config;
    this.#auth = auth;
    this.#reflector = reflector;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedOwnerRequest>();
    const bearer = request.headers.authorization;
    if (bearer?.startsWith("Bearer ") === true && this.#auth.verifyBootstrap(bearer.slice(7))) return true;
    const names = cookieNames(this.#config);
    let cookies: Record<string, string>;
    try {
      cookies = fastifyCookie.parse(request.headers.cookie ?? "");
    } catch {
      throw new UnauthorizedException();
    }
    const token = cookies[names.session];
    if (token === undefined) throw new UnauthorizedException();
    const method = request.method.toUpperCase();
    const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const requireRecentReauthentication = this.#reflector.getAllAndOverride<boolean>(recentReauthenticationKey, [
      context.getHandler(),
      context.getClass(),
    ]);
    try {
      request[OWNER_SESSION] = await this.#auth.validateSession({
        token,
        userAgent: request.headers["user-agent"] ?? "",
        isMutation,
        ...(request.headers.origin === undefined ? {} : { origin: request.headers.origin }),
        ...(cookies[names.csrf] === undefined ? {} : { csrfCookie: cookies[names.csrf] }),
        ...(request.headers["x-vault-csrf"] === undefined ? {} : { csrfHeader: String(request.headers["x-vault-csrf"]) }),
        requireRecentReauthentication,
      });
      return true;
    } catch (error) {
      if (error instanceof OwnerAuthenticationError && error.code === "reauth_required") {
        throw new ForbiddenException({ code: "reauth_required" });
      }
      if (error instanceof OwnerAuthenticationError && error.code === "csrf_rejected") {
        throw new ForbiddenException({ code: "csrf_rejected" });
      }
      throw new UnauthorizedException();
    }
  }
}

export function ownerCookieNames(config: SaturnConfig): { readonly session: string; readonly csrf: string } {
  return cookieNames(config);
}
