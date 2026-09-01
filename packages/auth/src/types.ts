export interface OwnerSession {
  readonly id: string;
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly state: "active" | "revoked" | "expired";
  readonly sourceIpHash: string;
  readonly userAgentHash: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly expiresAt: Date;
  readonly reauthenticatedAt: Date;
}

export interface NewOwnerSession {
  readonly session: OwnerSession;
  readonly token: string;
  readonly csrfToken: string;
}

export interface OwnerPreferences {
  readonly darkColor: string;
  readonly lightColor: string;
  readonly accentColor: string;
  readonly updatedAt: Date;
}

export interface OwnerAuthRepository {
  countRecentFailures(sourceIpHash: string, since: Date): Promise<number>;
  recordAttempt(sourceIpHash: string, outcome: "success" | "failure" | "rate_limited", occurredAt: Date): Promise<void>;
  createSession(session: OwnerSession): Promise<void>;
  touchSession(tokenHash: string, userAgentHash: string, now: Date, idleExpiresAt: Date): Promise<OwnerSession | undefined>;
  rotateSession(previousTokenHash: string, replacement: OwnerSession): Promise<void>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  revokeAllSessions(now: Date): Promise<number>;
  getPreferences(): Promise<OwnerPreferences>;
  updatePreferences(input: Omit<OwnerPreferences, "updatedAt">): Promise<OwnerPreferences>;
}

export interface SessionValidationInput {
  readonly token: string;
  readonly userAgent: string;
  readonly isMutation: boolean;
  readonly origin?: string;
  readonly csrfCookie?: string;
  readonly csrfHeader?: string;
  readonly requireRecentReauthentication?: boolean;
  readonly now?: Date;
}

export interface OwnerAuthOptions {
  readonly publicOrigin: string;
  readonly sessionIdleTtlMs: number;
  readonly sessionAbsoluteTtlMs: number;
  readonly reauthTtlMs: number;
  readonly failureLimit: number;
  readonly failureWindowMs: number;
}
