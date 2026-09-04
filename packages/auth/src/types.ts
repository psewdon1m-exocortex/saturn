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
  readonly accentColor: string;
  readonly sidebarMode: "fixed" | "auto-hide";
  readonly navigationOrder: readonly ("dashboard" | "files" | "inbox" | "shared" | "trash" | "settings")[];
  readonly dashboardOrder: readonly ("cpu" | "ram" | "disk" | "uptime" | "storage" | "drop" | "reachability" | "tasks")[];
  readonly settingsOrder: readonly ("appearance" | "security" | "telegram" | "backup" | "updates" | "logs")[];
  readonly updatedAt: Date;
}

export interface OwnerCredentialVerifier {
  readonly algorithm: "scrypt-v1";
  readonly saltHex: string;
  readonly verifierHex: string;
  readonly revision: number;
}

export interface OwnerAuthRepository {
  getCredentialVerifier(): Promise<OwnerCredentialVerifier | undefined>;
  initializeCredentialVerifier(verifier: Omit<OwnerCredentialVerifier, "revision">): Promise<OwnerCredentialVerifier>;
  replaceCredentialVerifier(input: {
    readonly expectedRevision: number;
    readonly verifier: Omit<OwnerCredentialVerifier, "revision">;
    readonly previousTokenHash: string;
    readonly replacementSession: OwnerSession;
    readonly now: Date;
  }): Promise<{ readonly verifier: OwnerCredentialVerifier; readonly revokedSessions: number }>;
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
