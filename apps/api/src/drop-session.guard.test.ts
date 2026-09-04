import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import type { DropService, DropSession } from "@saturn/drop";
import { describe, expect, it, vi } from "vitest";
import { DROP_SESSION, DropSessionGuard, type AuthenticatedDropRequest } from "./drop-session.guard.js";

vi.mock("@fastify/cookie", () => ({
  fastifyCookie: {
    parse: (value: string): Record<string, string> => Object.fromEntries(value.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      return separator < 1 ? [] : [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]];
    })),
  },
}));

const activeSession: DropSession = {
  id: "00000000-0000-7000-8000-000000000001",
  channelId: "00000000-0000-7000-8000-000000000002",
  tokenHash: "token-hash",
  csrfHash: "csrf-hash",
  userAgentHash: "agent-hash",
  state: "active",
  createdAt: new Date("2026-09-03T00:00:00.000Z"),
  lastSeenAt: new Date("2026-09-03T00:00:00.000Z"),
  expiresAt: new Date("2026-09-03T01:00:00.000Z"),
  maxFiles: 20,
  maxBytes: 1024,
  reservedFiles: 0,
  reservedBytes: 0,
};

function fixture(channelHint: string): {
  readonly guard: DropSessionGuard;
  readonly request: AuthenticatedDropRequest;
  readonly context: ExecutionContext;
} {
  const request = {
    method: "GET",
    headers: {
      cookie: "vault_drop_session_dev=opaque-token",
      "user-agent": "guard-test",
      "x-saturn-drop-channel": channelHint,
    },
    params: {},
    query: {},
    body: {},
  } as unknown as AuthenticatedDropRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const drop = { validateSession: vi.fn(async () => activeSession) } as unknown as DropService;
  return {
    guard: new DropSessionGuard({ environment: "development" } as SaturnConfig, drop),
    request,
    context,
  };
}

describe("DropSessionGuard channel binding", () => {
  it("accepts the session when the tab channel matches", async () => {
    const value = fixture(activeSession.channelId);
    await expect(value.guard.canActivate(value.context)).resolves.toBe(true);
    expect(value.request[DROP_SESSION]).toBe(activeSession);
  });

  it("rejects a valid cookie that belongs to another tab channel", async () => {
    const value = fixture("00000000-0000-7000-8000-000000000099");
    await expect(value.guard.canActivate(value.context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(value.request[DROP_SESSION]).toBeUndefined();
  });
});
