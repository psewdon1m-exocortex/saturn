import { fastifyCookie } from "@fastify/cookie";
import type { SaturnConfig } from "@saturn/config";
import type { FastifyRequest } from "fastify";
import { ownerCookieNames } from "./owner-token.guard.js";
import type { GuardedOwnerInput } from "../../../packages/sync/src/guarded-outside-folder.js";

/** Inputs are revalidated by the real owner auth service and fresh SQL issuer.
 * The route guard/audit actor alone is never the reservation authority. */
export function guardedOwnerInput(request: FastifyRequest, config: SaturnConfig): GuardedOwnerInput {
  const bearer = request.headers.authorization;
  if (bearer?.startsWith("Bearer ")) return { bootstrap: bearer.slice(7) };
  const names = ownerCookieNames(config), cookies = fastifyCookie.parse(request.headers.cookie ?? ""), token = cookies[names.session];
  if (!token) throw Error("Owner authentication required");
  return { session: { token, userAgent: request.headers["user-agent"] ?? "", isMutation: true,
    ...(request.headers.origin === undefined ? {} : { origin: request.headers.origin }),
    ...(cookies[names.csrf] === undefined ? {} : { csrfCookie: cookies[names.csrf] }),
    ...(request.headers["x-vault-csrf"] === undefined ? {} : { csrfHeader: String(request.headers["x-vault-csrf"]) }),
  } };
}
