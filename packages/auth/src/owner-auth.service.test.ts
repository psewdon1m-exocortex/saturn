import { describe, expect, it } from "vitest";
import { OwnerAuthenticationError, OwnerAuthService } from "./owner-auth.service.js";
import type { OwnerAuthRepository, OwnerCredentialVerifier, OwnerPreferences, OwnerSession } from "./types.js";

class MemoryRepository implements OwnerAuthRepository {
  sessions = new Map<string, OwnerSession>();
  credentialVerifier: OwnerCredentialVerifier | undefined;
  attempts: Array<{ source: string; outcome: "success" | "failure" | "rate_limited"; at: Date }> = [];
  preferences: OwnerPreferences = {
    accentColor: "#00a8ff",
    sidebarMode: "fixed",
    navigationOrder: ["dashboard", "files", "inbox", "shared", "synchronization", "trash", "settings"],
    dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"],
    settingsOrder: ["appearance", "security", "backup", "gryphon", "updates", "logs"],
    trashRetentionDays: 30,
    uploadBufferGiB: 110,
    maximumUploadFileGiB: 20,
    updatedAt: new Date(0),
  };

  getCredentialVerifier(): Promise<OwnerCredentialVerifier | undefined> {
    return Promise.resolve(this.credentialVerifier);
  }

  initializeCredentialVerifier(verifier: Omit<OwnerCredentialVerifier, "revision">): Promise<OwnerCredentialVerifier> {
    this.credentialVerifier ??= { ...verifier, revision: 1 };
    return Promise.resolve(this.credentialVerifier);
  }

  replaceCredentialVerifier(input: {
    readonly expectedRevision: number;
    readonly verifier: Omit<OwnerCredentialVerifier, "revision">;
    readonly previousTokenHash: string;
    readonly replacementSession: OwnerSession;
    readonly now: Date;
  }): Promise<{ readonly verifier: OwnerCredentialVerifier; readonly revokedSessions: number }> {
    if (this.credentialVerifier?.revision !== input.expectedRevision || this.sessions.get(input.previousTokenHash)?.state !== "active") return Promise.reject(new Error("concurrent"));
    let revoked = 0;
    for (const [key, value] of this.sessions) if (value.state === "active") { this.sessions.set(key, { ...value, state: "revoked" }); revoked += 1; }
    this.sessions.set(input.replacementSession.tokenHash, input.replacementSession);
    this.credentialVerifier = { ...input.verifier, revision: input.expectedRevision + 1 };
    return Promise.resolve({ verifier: this.credentialVerifier, revokedSessions: Math.max(0, revoked - 1) });
  }

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
    const { repository, service } = fixture();
    const now = new Date("2026-08-26T00:00:00.000Z");
    const created = await service.authenticate("owner-access-key-that-is-at-least-32-characters-long", "127.0.0.1", "browser", now);
    await expect(service.validateSession({
      token: created.token,
      userAgent: "browser",
      isMutation: false,
      requireRecentReauthentication: true,
      now: new Date(now.getTime() + 6 * 60_000),
    })).rejects.toMatchObject({ code: "reauth_required" });
    await expect(service.updatePreferences({
      accentColor: "#22bbff",
      sidebarMode: "auto-hide",
      navigationOrder: ["dashboard", "inbox", "files", "shared", "synchronization", "trash", "settings"],
      dashboardOrder: ["ram", "cpu", "disk", "uptime", "storage", "drop", "reachability", "tasks"],
      settingsOrder: ["security", "appearance", "backup", "gryphon", "updates", "logs"],
      trashRetentionDays: 45,
      uploadBufferGiB: 220,
      maximumUploadFileGiB: 40,
    })).resolves.toMatchObject({ accentColor: "#22bbff", sidebarMode: "auto-hide", trashRetentionDays: 45 });
    await expect(service.updatePreferences({
      accentColor: "#111111",
      sidebarMode: "fixed",
      navigationOrder: ["dashboard", "files", "inbox", "shared", "synchronization", "trash", "settings"],
      dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"],
      settingsOrder: ["appearance", "security", "backup", "gryphon", "updates", "logs"],
      trashRetentionDays: 30,
      uploadBufferGiB: 110,
      maximumUploadFileGiB: 20,
    })).resolves.toMatchObject({ accentColor: "#111111" });
    expect(() => service.updatePreferences({
      accentColor: "#11111",
      sidebarMode: "fixed",
      navigationOrder: ["dashboard", "files", "inbox", "shared", "synchronization", "trash", "settings"],
      dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"],
      settingsOrder: ["appearance", "security", "backup", "gryphon", "updates", "logs"],
      trashRetentionDays: 30,
      uploadBufferGiB: 110,
      maximumUploadFileGiB: 20,
    })).toThrow(/invalid/);
    expect(() => service.updatePreferences({
      ...repository.preferences,
      uploadBufferGiB: 10,
      maximumUploadFileGiB: 10,
    })).toThrow(/Upload limits/);
    expect(await service.revokeAll()).toBe(1);
  });

  it("atomically rotates the Access Key and revokes every other session", async () => {
    const { service } = fixture();
    await service.initialize();
    const current = await service.authenticate("owner-access-key-that-is-at-least-32-characters-long", "127.0.0.1", "browser-a");
    const other = await service.authenticate("owner-access-key-that-is-at-least-32-characters-long", "127.0.0.2", "browser-b");
    const previous = await service.validateSession({ token: current.token, userAgent: "browser-a", isMutation: false });
    const replacementKey = "replacement-owner-access-key-with-more-than-32-characters";
    const changed = await service.changeAccessKey({
      previous,
      previousToken: current.token,
      currentAccessKey: "owner-access-key-that-is-at-least-32-characters-long",
      newAccessKey: replacementKey,
      confirmation: replacementKey,
      sourceIp: "127.0.0.1",
      userAgent: "browser-a",
    });
    expect(changed.revokedSessions).toBe(1);
    await expect(service.validateSession({ token: other.token, userAgent: "browser-b", isMutation: false })).rejects.toMatchObject({ code: "invalid_session" });
    await expect(service.validateSession({ token: changed.token, userAgent: "browser-a", isMutation: false })).resolves.toMatchObject({ id: changed.session.id });
    expect(await service.verifyBootstrap(replacementKey)).toBe(true);
    expect(await service.verifyBootstrap("owner-access-key-that-is-at-least-32-characters-long")).toBe(false);
  });
});
