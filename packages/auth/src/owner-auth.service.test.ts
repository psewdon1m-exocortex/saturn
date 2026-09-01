import { describe, expect, it } from "vitest";
import { OwnerAuthenticationError, OwnerAuthService } from "./owner-auth.service.js";
import type { OwnerAuthRepository, OwnerPreferences, OwnerSession } from "./types.js";

class MemoryRepository implements OwnerAuthRepository {
  sessions = new Map<string, OwnerSession>();
  attempts: Array<{ source: string; outcome: "success" | "failure" | "rate_limited"; at: Date }> = [];
  preferences: OwnerPreferences = {
    darkColor: "#000000",
    lightColor: "#ffffff",
    accentColor: "#00a8ff",
    updatedAt: new Date(0),
  };

  countRecentFailures(sourceIpHash: string, since: Date): Promise<number> {
    return Promise.resolve(this.attempts.filter((item) => item.source === sourceIpHash && item.outcome === "failure" && item.at >= since).length);
  }

  recordAttempt(sourceIpHash: string, outcome: "success" | "failure" | "rate_limited", occurredAt: Date): Promise<void> {
    this.attempts.push({ source: sourceIpHash, outcome, at: occurredAt });
    return Promise.resolve();
  }

  createSession(session: OwnerSession): Promise<void> {
    this.sessions.set(session.tokenHash, session);
    return Promise.resolve();
  }

  touchSession(tokenHash: string, userAgentHash: string, now: Date, idleExpiresAt: Date): Promise<OwnerSession | undefined> {
    const value = this.sessions.get(tokenHash);
    if (value === undefined || value.state !== "active" || value.userAgentHash !== userAgentHash
      || value.idleExpiresAt <= now || value.expiresAt <= now) return Promise.resolve(undefined);
    const touched = { ...value, lastSeenAt: now, idleExpiresAt: new Date(Math.min(value.expiresAt.getTime(), idleExpiresAt.getTime())) };
    this.sessions.set(tokenHash, touched);
    return Promise.resolve(touched);
  }

  rotateSession(previousTokenHash: string, replacement: OwnerSession): Promise<void> {
    const previous = this.sessions.get(previousTokenHash);
    if (previous === undefined || previous.state !== "active") return Promise.reject(new Error("inactive"));
    this.sessions.set(previousTokenHash, { ...previous, state: "revoked" });
    this.sessions.set(replacement.tokenHash, replacement);
    return Promise.resolve();
  }

  revokeSession(tokenHash: string): Promise<void> {
    const value = this.sessions.get(tokenHash);
    if (value !== undefined) this.sessions.set(tokenHash, { ...value, state: "revoked" });
    return Promise.resolve();
  }

  revokeAllSessions(): Promise<number> {
    let count = 0;
    for (const [key, value] of this.sessions) {
      if (value.state === "active") {
        this.sessions.set(key, { ...value, state: "revoked" });
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  getPreferences(): Promise<OwnerPreferences> {
    return Promise.resolve(this.preferences);
  }

  updatePreferences(input: Omit<OwnerPreferences, "updatedAt">): Promise<OwnerPreferences> {
    this.preferences = { ...input, updatedAt: new Date() };
    return Promise.resolve(this.preferences);
  }
}

function fixture(repository = new MemoryRepository()) {
  return {
    repository,
    service: new OwnerAuthService({
      repository,
      ownerAccessKey: "owner-access-key-that-is-at-least-32-characters-long",
      pepper: "authentication-pepper-at-least-32-characters-long",
      options: {
        publicOrigin: "https://vault.example.test",
        sessionIdleTtlMs: 15 * 60_000,
        sessionAbsoluteTtlMs: 12 * 60 * 60_000,
        reauthTtlMs: 5 * 60_000,
        failureLimit: 2,
        failureWindowMs: 15 * 60_000,
      },
    }),
  };
}

describe("OwnerAuthService", () => {
  it("creates an opaque bounded session and enforces origin-bound CSRF", async () => {
    const { service } = fixture();
    const now = new Date("2026-08-26T00:00:00.000Z");
    const created = await service.authenticate("owner-access-key-that-is-at-least-32-characters-long", "127.0.0.1", "browser", now);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(service.validateSession({ token: created.token, userAgent: "browser", isMutation: false, now })).resolves.toMatchObject({ id: created.session.id });
    await expect(service.validateSession({
      token: created.token,
      userAgent: "browser",
      isMutation: true,
      origin: "https://vault.example.test",
      csrfCookie: created.csrfToken,
      csrfHeader: created.csrfToken,
      now,
    })).resolves.toMatchObject({ id: created.session.id });
    await expect(service.validateSession({
      token: created.token,
      userAgent: "browser",
      isMutation: true,
      origin: "https://evil.example",
      csrfCookie: created.csrfToken,
      csrfHeader: created.csrfToken,
      now,
    })).rejects.toMatchObject({ code: "csrf_rejected" });
  });

  it("rate-limits failures without storing the submitted access key", async () => {
    const { service, repository } = fixture();
    await expect(service.authenticate("wrong-one", "192.0.2.1", "browser")).rejects.toBeInstanceOf(OwnerAuthenticationError);
    await expect(service.authenticate("wrong-two", "192.0.2.1", "browser")).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(service.authenticate("owner-access-key-that-is-at-least-32-characters-long", "192.0.2.1", "browser")).rejects.toMatchObject({ code: "rate_limited" });
    expect(JSON.stringify(repository.attempts)).not.toContain("wrong-one");
  });

  it("expires idle sessions and rotates on reauthentication", async () => {
    const { service } = fixture();
    const now = new Date("2026-08-26T00:00:00.000Z");
    const created = await service.authenticate("owner-access-key-that-is-at-least-32-characters-long", "127.0.0.1", "browser", now);
    await expect(service.validateSession({
      token: created.token,
      userAgent: "browser",
      isMutation: false,
      now: new Date(now.getTime() + 16 * 60_000),
    })).rejects.toMatchObject({ code: "invalid_session" });

    const fresh = await service.authenticate("owner-access-key-that-is-at-least-32-characters-long", "127.0.0.1", "browser", now);
    const previous = await service.validateSession({ token: fresh.token, userAgent: "browser", isMutation: false, now });
    const rotated = await service.reauthenticate({
      previous,
      previousToken: fresh.token,
      accessKey: "owner-access-key-that-is-at-least-32-characters-long",
      sourceIp: "127.0.0.1",
      userAgent: "browser",
      now: new Date(now.getTime() + 60_000),
    });
    expect(rotated.token).not.toBe(fresh.token);
    await expect(service.validateSession({ token: fresh.token, userAgent: "browser", isMutation: false, now })).rejects.toMatchObject({ code: "invalid_session" });
  });

  it("requires recent proof and supports revoke-all plus validated appearance", async () => {
    const { service } = fixture();
    const now = new Date("2026-08-26T00:00:00.000Z");
    const created = await service.authenticate("owner-access-key-that-is-at-least-32-characters-long", "127.0.0.1", "browser", now);
    await expect(service.validateSession({
      token: created.token,
      userAgent: "browser",
      isMutation: false,
      requireRecentReauthentication: true,
      now: new Date(now.getTime() + 6 * 60_000),
    })).rejects.toMatchObject({ code: "reauth_required" });
    await expect(service.updatePreferences({ darkColor: "#010101", lightColor: "#fefefe", accentColor: "#123abc" })).resolves.toMatchObject({ accentColor: "#123abc" });
    expect(await service.revokeAll()).toBe(1);
  });
});
