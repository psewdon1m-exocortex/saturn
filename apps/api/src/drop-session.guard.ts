import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import { DropServiceError, type DropService, type DropSession } from "@saturn/drop";
import { fastifyCookie } from "@fastify/cookie";
import type { FastifyRequest } from "fastify";
import { APP_CONFIG, DROP_SERVICE } from "./tokens.js";

export const DROP_SESSION = Symbol("DROP_SESSION");

export interface AuthenticatedDropRequest extends FastifyRequest {
  [DROP_SESSION]?: DropSession;
}

export function dropCookieNames(config: SaturnConfig): { readonly session: string; readonly csrf: string } {
  return config.environment === "production"
    ? { session: "__Host-vault_drop_session", csrf: "__Host-vault_drop_csrf" }
    : { session: "vault_drop_session_dev", csrf: "vault_drop_csrf_dev" };
}

function stringProperty(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || !(key in value)) return "";
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : "";
}

@Injectable()
export class DropSessionGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: SaturnConfig,
    @Inject(DROP_SERVICE) private readonly drop: DropService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedDropRequest>();
    let cookies: Record<string, string>;
    try { cookies = fastifyCookie.parse(request.headers.cookie ?? ""); }
    catch { throw new UnauthorizedException(); }
    const names = dropCookieNames(this.config);
    const token = cookies[names.session];
    if (token === undefined) throw new UnauthorizedException();
    const method = request.method.toUpperCase();
    const routeId = stringProperty(request.params, "id");
    const bodyId = stringProperty(request.body, "uploadId");
    const continuationId = routeId || bodyId;
    const channelHint = typeof request.headers["x-saturn-drop-channel"] === "string"
      ? request.headers["x-saturn-drop-channel"]
      : stringProperty(request.query, "channelId");
    try {
      const session = await this.drop.validateSession({
        token,
        userAgent: request.headers["user-agent"] ?? "",
        isMutation: !["GET", "HEAD", "OPTIONS"].includes(method),
        ...(request.headers.origin === undefined ? {} : { origin: request.headers.origin }),
        ...(cookies[names.csrf] === undefined ? {} : { csrfCookie: cookies[names.csrf] }),
        ...(request.headers["x-vault-csrf"] === undefined ? {} : { csrfHeader: String(request.headers["x-vault-csrf"]) }),
        ...((method === "PATCH" || (method === "GET" && routeId !== "") || (method === "POST" && bodyId !== "")) && continuationId !== "" ? { allowExpiredUploadId: continuationId } : {}),
      });
      if (channelHint !== "" && channelHint !== session.channelId) throw new DropServiceError("invalid_session");
      request[DROP_SESSION] = session;
      return true;
    } catch (error) {
      if (error instanceof DropServiceError) throw new UnauthorizedException();
      throw error;
    }
  }
}
