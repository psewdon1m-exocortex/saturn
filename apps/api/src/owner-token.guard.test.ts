import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OwnerAuthenticationError, OwnerAuthService, type OwnerAuthRepository, type OwnerSession } from "@saturn/auth";
import type { SaturnConfig } from "@saturn/config";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { FileController } from "./file.controller.js";
import { ShareOwnerController } from "./share.controller.js";
import { BackupOwnerController } from "./backup.controller.js";
import { DeviceController } from "./device.controller.js";
import { StorageConnectionController } from "./storage-connection.controller.js";

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
  it.each([
    [BackupOwnerController, "createEnrollment"],
    [BackupOwnerController, "enrollment"],
    [BackupOwnerController, "rotate"],
    [BackupOwnerController, "revoke"],
    [DeviceController, "create"],
    [DeviceController, "revoke"],
    [StorageConnectionController, "analyze"],
    [StorageConnectionController, "synchronize"],
  ] as const)("authorizes owner management %s.%s with an older session while enforcing CSRF and session validity", async (controller, method) => {
    const sessions = new Map<string, OwnerSession>();
    const repository = {
      getCredentialVerifier: async () => undefined,
      countRecentFailures: async () => 0,
      recordAttempt: async () => undefined,
      createSession: async (session: OwnerSession) => { sessions.set(session.tokenHash, session); },
      touchSession: async (tokenHash: string, userAgentHash: string, now: Date) => {
        const session = sessions.get(tokenHash);
        return session?.state === "active" && session.userAgentHash === userAgentHash
          && session.idleExpiresAt > now && session.expiresAt > now ? session : undefined;
      },
    } as unknown as OwnerAuthRepository;
    const auth = new OwnerAuthService({
      repository,
      ownerAccessKey: "owner-access-key-that-is-at-least-32-characters-long",
      pepper: "authentication-pepper-at-least-32-characters-long",
      options: {
        publicOrigin: "http://127.0.0.1:5173",
        sessionIdleTtlMs: 15 * 60_000,
        sessionAbsoluteTtlMs: 12 * 60 * 60_000,
        reauthTtlMs: 5 * 60_000,
        failureLimit: 5,
        failureWindowMs: 15 * 60_000,
      },
    });
    const created = await auth.authenticate(
      "owner-access-key-that-is-at-least-32-characters-long", "127.0.0.1", "guard-test",
      new Date(Date.now() - 10 * 60_000),
    );
    const route = context();
    const request = route.switchToHttp().getRequest<FastifyRequest>();
    request.headers.cookie = `vault_session_dev=${created.token}; vault_csrf_dev=${created.csrfToken}`;
    request.headers["x-vault-csrf"] = created.csrfToken;
    const routeContext = {
      ...route,
      getHandler: () => Reflect.get(controller.prototype, method) as object,
      getClass: () => controller,
    } as unknown as ExecutionContext;
    const guard = new OwnerTokenGuard({ environment: "development" } as SaturnConfig, auth, new Reflector());
    expect(Reflect.getMetadata("__guards__", controller)).toContain(OwnerTokenGuard);
    await expect(guard.canActivate(routeContext)).resolves.toBe(true);

    request.headers["x-vault-csrf"] = "wrong-csrf";
    await expect(guard.canActivate(routeContext)).rejects.toMatchObject({ response: { code: "csrf_rejected" }, status: 403 });
    request.headers["x-vault-csrf"] = created.csrfToken;
    request.headers.origin = "https://another-origin.example";
    await expect(guard.canActivate(routeContext)).rejects.toMatchObject({ response: { code: "csrf_rejected" }, status: 403 });
    request.headers.origin = "http://127.0.0.1:5173";
    sessions.set(created.session.tokenHash, { ...created.session, state: "revoked" });
    await expect(guard.canActivate(routeContext)).rejects.toBeInstanceOf(UnauthorizedException);
    delete request.headers.cookie;
    await expect(guard.canActivate(routeContext)).rejects.toBeInstanceOf(UnauthorizedException);
  });

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

  it("allows an authenticated owner session to create and revoke shares without recent proof", () => {
    // Decorator metadata is attached to the handler functions themselves.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const create = ShareOwnerController.prototype.create;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const update = ShareOwnerController.prototype.update;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const revoke = ShareOwnerController.prototype.revoke;
    expect(Reflect.getMetadata("vault:recent-reauthentication", create)).toBeUndefined();
    expect(Reflect.getMetadata("vault:recent-reauthentication", revoke)).toBeUndefined();
    expect(Reflect.getMetadata("vault:recent-reauthentication", update)).toBe(true);
  });

  it("allows permanent Trash deletion in an authenticated owner session", () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const purge = FileController.prototype.purgeTrashResource;
    expect(Reflect.getMetadata("vault:recent-reauthentication", purge)).toBeUndefined();
  });
});
