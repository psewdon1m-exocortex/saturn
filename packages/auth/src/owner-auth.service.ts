import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { AuditSink } from "@saturn/audit";
import { v7 as uuidv7 } from "uuid";
import type {
  NewOwnerSession,
  OwnerAuthOptions,
  OwnerAuthRepository,
  OwnerCredentialVerifier,
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

function scryptVerifier(value: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(value, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
    if (error === null) resolve(derived);
    else reject(error);
  }));
}

async function createCredentialVerifier(value: string): Promise<Omit<OwnerCredentialVerifier, "revision">> {
  const salt = randomBytes(16);
  return { algorithm: "scrypt-v1", saltHex: salt.toString("hex"), verifierHex: (await scryptVerifier(value, salt)).toString("hex") };
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
  #credentialVerifier: OwnerCredentialVerifier | undefined;

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

  async initialize(): Promise<void> {
    const existing = await this.#repository.getCredentialVerifier();
    this.#credentialVerifier = existing ?? await this.#repository.initializeCredentialVerifier(await createCredentialVerifier(this.#ownerAccessKey));
  }

  async verifyBootstrap(candidate: string): Promise<boolean> {
    const verifier = this.#credentialVerifier ?? await this.#repository.getCredentialVerifier();
    if (verifier === undefined) return secureEqual(candidate, this.#ownerAccessKey);
    this.#credentialVerifier = verifier;
    const derived = await scryptVerifier(candidate, Buffer.from(verifier.saltHex, "hex"));
    return timingSafeEqual(derived, Buffer.from(verifier.verifierHex, "hex"));
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
    if (!await this.verifyBootstrap(accessKey)) {
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
    if (!await this.verifyBootstrap(input.accessKey)) throw new OwnerAuthenticationError("invalid_credentials");
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

  async changeAccessKey(input: {
    readonly previous: OwnerSession;
    readonly previousToken: string;
    readonly currentAccessKey: string;
    readonly newAccessKey: string;
    readonly confirmation: string;
    readonly sourceIp: string;
    readonly userAgent: string;
    readonly now?: Date;
  }): Promise<NewOwnerSession & { readonly revokedSessions: number }> {
    if (!await this.verifyBootstrap(input.currentAccessKey)) throw new OwnerAuthenticationError("invalid_credentials");
    if (!secureEqual(input.newAccessKey, input.confirmation)
      || input.newAccessKey.length < 32
      || input.newAccessKey.length > 512
      || /[\r\n]/.test(input.newAccessKey)
      || secureEqual(input.currentAccessKey, input.newAccessKey)) {
      throw new OwnerAuthenticationError("invalid_credentials");
    }
    const verifier = this.#credentialVerifier;
    if (verifier === undefined) throw new Error("Owner credential verifier is not initialized");
    const now = input.now ?? new Date();
    const replacement = this.#newSession(input.sourceIp, input.userAgent, now, input.previous.expiresAt);
    const result = await this.#repository.replaceCredentialVerifier({
      expectedRevision: verifier.revision,
      verifier: await createCredentialVerifier(input.newAccessKey),
      previousTokenHash: sha256(input.previousToken),
      replacementSession: replacement.session,
      now,
    });
    this.#credentialVerifier = result.verifier;
    await this.#auditEvent("owner.access-key.changed", "success", `access-key:${replacement.session.id}`, {
      sessionId: replacement.session.id,
      revokedSessions: result.revokedSessions,
      credentialRevision: result.verifier.revision,
    });
    return { ...replacement, revokedSessions: result.revokedSessions };
  }

  getPreferences(): Promise<OwnerPreferences> {
    return this.#repository.getPreferences();
  }

  updatePreferences(input: Omit<OwnerPreferences, "updatedAt">): Promise<OwnerPreferences> {
    if (!/^#[0-9a-fA-F]{6}$/.test(input.accentColor)) throw new Error("Appearance color is invalid");
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
