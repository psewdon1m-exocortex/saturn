import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuditSink } from "@saturn/audit";
import { v7 as uuidv7 } from "uuid";
import type {
  NewOwnerSession,
  OwnerAuthOptions,
  OwnerAuthRepository,
  OwnerPreferences,
  OwnerSession,
  SessionValidationInput,
} from "./types.js";

export class OwnerAuthenticationError extends Error {
  readonly code: "invalid_credentials" | "rate_limited" | "invalid_session" | "csrf_rejected" | "reauth_required";

  constructor(code: OwnerAuthenticationError["code"]) {
    super(code === "rate_limited" ? "Authentication is temporarily unavailable" : "Authentication failed");
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function validOpaqueToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export class OwnerAuthService {
  readonly #repository: OwnerAuthRepository;
  readonly #ownerAccessKey: string;
  readonly #pepper: Buffer;
  readonly #options: OwnerAuthOptions;
  readonly #audit: AuditSink | undefined;

  constructor(input: {
    readonly repository: OwnerAuthRepository;
    readonly ownerAccessKey: string;
    readonly pepper: string;
    readonly options: OwnerAuthOptions;
    readonly audit?: AuditSink;
  }) {
    if (input.ownerAccessKey.length < 32 || /[\r\n]/.test(input.ownerAccessKey)) throw new Error("Owner access key is invalid");
    if (input.pepper.length < 32 || /[\r\n]/.test(input.pepper)) throw new Error("Authentication pepper is invalid");
    this.#repository = input.repository;
    this.#ownerAccessKey = input.ownerAccessKey;
    this.#pepper = Buffer.from(input.pepper, "utf8");
    this.#options = input.options;
    this.#audit = input.audit;
  }

  verifyBootstrap(candidate: string): boolean {
    return secureEqual(candidate, this.#ownerAccessKey);
  }

  #fieldHash(label: string, value: string, maximumLength: number): string {
    return createHmac("sha256", this.#pepper)
      .update(label)
      .update("\0")
      .update(value.slice(0, maximumLength))
      .digest("hex");
  }

  #sourceHash(sourceIp: string): string {
    return this.#fieldHash("source-ip", sourceIp, 128);
  }

  #userAgentHash(userAgent: string): string {
    return this.#fieldHash("user-agent", userAgent, 1024);
  }

  #newSession(sourceIp: string, userAgent: string, now: Date, absoluteExpiry?: Date): NewOwnerSession {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = absoluteExpiry ?? new Date(now.getTime() + this.#options.sessionAbsoluteTtlMs);
    const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), now.getTime() + this.#options.sessionIdleTtlMs));
    return {
      token,
      csrfToken,
      session: {
        id: uuidv7(),
        tokenHash: sha256(token),
        csrfHash: sha256(csrfToken),
        state: "active",
        sourceIpHash: this.#sourceHash(sourceIp),
        userAgentHash: this.#userAgentHash(userAgent),
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        expiresAt,
        reauthenticatedAt: now,
      },
    };
  }

  async authenticate(accessKey: string, sourceIp: string, userAgent: string, now = new Date()): Promise<NewOwnerSession> {
    const sourceIpHash = this.#sourceHash(sourceIp);
    const failures = await this.#repository.countRecentFailures(
      sourceIpHash,
      new Date(now.getTime() - this.#options.failureWindowMs),
    );
    if (failures >= this.#options.failureLimit) {
      await this.#repository.recordAttempt(sourceIpHash, "rate_limited", now);
      await this.#auditEvent("owner.login", "denied", `login-rate:${uuidv7()}`, { reason: "rate_limited" });
      throw new OwnerAuthenticationError("rate_limited");
    }
    if (!this.verifyBootstrap(accessKey)) {
      await this.#repository.recordAttempt(sourceIpHash, "failure", now);
      await this.#auditEvent("owner.login", "denied", `login-failure:${uuidv7()}`, { reason: "invalid_credentials" });
      throw new OwnerAuthenticationError("invalid_credentials");
    }
    const created = this.#newSession(sourceIp, userAgent, now);
    await this.#repository.createSession(created.session);
    await this.#repository.recordAttempt(sourceIpHash, "success", now);
    await this.#auditEvent("owner.login", "success", `login:${created.session.id}`, { sessionId: created.session.id });
    return created;
  }

  async validateSession(input: SessionValidationInput): Promise<OwnerSession> {
    if (!validOpaqueToken(input.token)) throw new OwnerAuthenticationError("invalid_session");
    const now = input.now ?? new Date();
    const value = await this.#repository.touchSession(
      sha256(input.token),
      this.#userAgentHash(input.userAgent),
      now,
      new Date(now.getTime() + this.#options.sessionIdleTtlMs),
    );
    if (value === undefined) throw new OwnerAuthenticationError("invalid_session");
    if (input.isMutation) {
      let origin: string;
      try {
        origin = input.origin === undefined ? "" : new URL(input.origin).origin;
      } catch {
        throw new OwnerAuthenticationError("csrf_rejected");
      }
      if (origin !== new URL(this.#options.publicOrigin).origin
        || input.csrfCookie === undefined
        || input.csrfHeader === undefined
        || !validOpaqueToken(input.csrfCookie)
        || !secureEqual(input.csrfCookie, input.csrfHeader)
        || !secureEqual(sha256(input.csrfCookie), value.csrfHash)) {
        throw new OwnerAuthenticationError("csrf_rejected");
      }
    }
    if (input.requireRecentReauthentication === true
      && now.getTime() - value.reauthenticatedAt.getTime() > this.#options.reauthTtlMs) {
      throw new OwnerAuthenticationError("reauth_required");
    }
    return value;
  }

  async reauthenticate(input: {
    readonly previous: OwnerSession;
    readonly previousToken: string;
    readonly accessKey: string;
    readonly sourceIp: string;
    readonly userAgent: string;
    readonly now?: Date;
  }): Promise<NewOwnerSession> {
    if (!this.verifyBootstrap(input.accessKey)) throw new OwnerAuthenticationError("invalid_credentials");
    const now = input.now ?? new Date();
    const replacement = this.#newSession(input.sourceIp, input.userAgent, now, input.previous.expiresAt);
    await this.#repository.rotateSession(sha256(input.previousToken), replacement.session);
    await this.#auditEvent("owner.reauthenticated", "success", `reauth:${replacement.session.id}`, {
      previousSessionId: input.previous.id,
      sessionId: replacement.session.id,
    });
    return replacement;
  }

  async logout(token: string, now = new Date()): Promise<void> {
    if (validOpaqueToken(token)) await this.#repository.revokeSession(sha256(token), now);
    await this.#auditEvent("owner.logout", "success", `logout:${uuidv7()}`, {});
  }

  async revokeAll(now = new Date()): Promise<number> {
    const count = await this.#repository.revokeAllSessions(now);
    await this.#auditEvent("owner.sessions.revoked", "success", `revoke-sessions:${uuidv7()}`, { count });
    return count;
  }

  getPreferences(): Promise<OwnerPreferences> {
    return this.#repository.getPreferences();
  }

  updatePreferences(input: Omit<OwnerPreferences, "updatedAt">): Promise<OwnerPreferences> {
    for (const color of [input.darkColor, input.lightColor, input.accentColor]) {
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Appearance color is invalid");
    }
    return this.#repository.updatePreferences(input);
  }

  async #auditEvent(
    action: string,
    outcome: "success" | "denied" | "failure",
    correlationId: string,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.#audit?.write({ actorType: "owner", actorId: "owner", action, outcome, correlationId, details }).catch(() => undefined);
  }
}
