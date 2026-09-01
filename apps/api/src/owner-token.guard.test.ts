import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OwnerAuthenticationError, type OwnerAuthService } from "@saturn/auth";
import type { SaturnConfig } from "@saturn/config";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { OwnerTokenGuard } from "./owner-token.guard.js";

vi.mock("@fastify/cookie", () => ({
  fastifyCookie: {
    parse: (value: string): Record<string, string> => {
      const result: Record<string, string> = {};
      for (const item of value.split(";")) {
        const separator = item.indexOf("=");
        if (separator > 0) result[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
      }
      return result;
    },
  },
}));

function context(): ExecutionContext {
  const request = {
    method: "POST",
    headers: {
      cookie: "vault_session_dev=session; vault_csrf_dev=csrf",
      origin: "http://127.0.0.1:5173",
      "user-agent": "guard-test",
      "x-vault-csrf": "csrf",
    },
  } as unknown as FastifyRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => context,
    getClass: () => OwnerTokenGuard,
  } as unknown as ExecutionContext;
}

function guardFor(error: OwnerAuthenticationError): { readonly guard: OwnerTokenGuard; readonly validateSession: ReturnType<typeof vi.fn> } {
  const validateSession = vi.fn(async () => { throw error; });
  const auth = {
    verifyBootstrap: vi.fn(() => false),
    validateSession,
  } as unknown as OwnerAuthService;
  return {
    guard: new OwnerTokenGuard(
      { environment: "development" } as SaturnConfig,
      auth,
      new Reflector(),
    ),
    validateSession,
  };
}

describe("OwnerTokenGuard", () => {
  it("reports a CSRF or Origin rejection as forbidden without invalidating the UI session", async () => {
    const fixture = guardFor(new OwnerAuthenticationError("csrf_rejected"));
    const result = fixture.guard.canActivate(context());
    expect(fixture.validateSession).toHaveBeenCalledOnce();
    await expect(result).rejects.toBeInstanceOf(ForbiddenException);
    await expect(result).rejects.toMatchObject({ response: { code: "csrf_rejected" }, status: 403 });
  });

  it("keeps an invalid session as unauthorized", async () => {
    await expect(guardFor(new OwnerAuthenticationError("invalid_session")).guard.canActivate(context()))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});
