import type { Database } from "@saturn/database";
import type { OwnerAuthRepository, OwnerCredentialVerifier, OwnerPreferences, OwnerSession } from "./types.js";

interface SessionRow {
  id: string;
  token_hash: string;
  csrf_hash: string;
  state: OwnerSession["state"];
  source_ip_hash: string;
  user_agent_hash: string;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  expires_at: Date;
  reauthenticated_at: Date;
}

interface PreferencesRow {
  accent_color: string;
  sidebar_mode: OwnerPreferences["sidebarMode"];
  navigation_order: OwnerPreferences["navigationOrder"];
  dashboard_order: OwnerPreferences["dashboardOrder"];
  settings_order: OwnerPreferences["settingsOrder"];
  updated_at: Date;
}

interface CredentialRow {
  algorithm: "scrypt-v1";
  salt_hex: string;
  verifier_hex: string;
  revision: string;
}

function credential(row: CredentialRow): OwnerCredentialVerifier {
  return { algorithm: row.algorithm, saltHex: row.salt_hex, verifierHex: row.verifier_hex, revision: Number(row.revision) };
}

function session(row: SessionRow): OwnerSession {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    state: row.state,
    sourceIpHash: row.source_ip_hash,
    userAgentHash: row.user_agent_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    idleExpiresAt: row.idle_expires_at,
    expiresAt: row.expires_at,
    reauthenticatedAt: row.reauthenticated_at,
  };
}

function preferences(row: PreferencesRow): OwnerPreferences {
  return {
    accentColor: row.accent_color,
    sidebarMode: row.sidebar_mode,
    navigationOrder: row.navigation_order,
    dashboardOrder: row.dashboard_order,
    settingsOrder: row.settings_order,
    updatedAt: row.updated_at,
  };
}

export class PostgresOwnerAuthRepository implements OwnerAuthRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  getCredentialVerifier(): Promise<OwnerCredentialVerifier | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<CredentialRow[]>`SELECT algorithm, salt_hex, verifier_hex, revision::text FROM owner_credentials WHERE owner_id = 'owner'`;
      return rows[0] === undefined ? undefined : credential(rows[0]);
    });
  }

  initializeCredentialVerifier(verifier: Omit<OwnerCredentialVerifier, "revision">): Promise<OwnerCredentialVerifier> {
    return this.#database.transaction(async (sql) => {
      await sql`
        INSERT INTO owner_credentials (owner_id, algorithm, salt_hex, verifier_hex)
        VALUES ('owner', ${verifier.algorithm}, ${verifier.saltHex}, ${verifier.verifierHex})
        ON CONFLICT (owner_id) DO NOTHING
      `;
      const rows = await sql<CredentialRow[]>`SELECT algorithm, salt_hex, verifier_hex, revision::text FROM owner_credentials WHERE owner_id = 'owner' FOR UPDATE`;
      const row = rows[0];
      if (row === undefined) throw new Error("Owner credential initialization failed");
      return credential(row);
    });
  }

  replaceCredentialVerifier(input: {
    readonly expectedRevision: number;
    readonly verifier: Omit<OwnerCredentialVerifier, "revision">;
    readonly previousTokenHash: string;
    readonly replacementSession: OwnerSession;
    readonly now: Date;
  }): Promise<{ readonly verifier: OwnerCredentialVerifier; readonly revokedSessions: number }> {
    return this.#database.transaction(async (sql) => {
      const current = await sql`SELECT id FROM web_sessions WHERE token_hash = ${input.previousTokenHash} AND state = 'active' FOR UPDATE`;
      if (current.length !== 1) throw new Error("Owner session is no longer active");
      const rows = await sql<CredentialRow[]>`
        UPDATE owner_credentials SET
          algorithm = ${input.verifier.algorithm}, salt_hex = ${input.verifier.saltHex},
          verifier_hex = ${input.verifier.verifierHex}, revision = revision + 1, updated_at = ${input.now}
        WHERE owner_id = 'owner' AND revision = ${input.expectedRevision}
        RETURNING algorithm, salt_hex, verifier_hex, revision::text
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Owner credential changed concurrently");
      const revoked = await sql`
        UPDATE web_sessions SET state = 'revoked', revoked_at = ${input.now}
        WHERE state = 'active'
        RETURNING id
      `;
      await sql`
        INSERT INTO web_sessions (
          id, token_hash, csrf_hash, state, source_ip_hash, user_agent_hash,
          created_at, last_seen_at, idle_expires_at, expires_at, reauthenticated_at
        ) VALUES (
          ${input.replacementSession.id}, ${input.replacementSession.tokenHash}, ${input.replacementSession.csrfHash}, 'active',
          ${input.replacementSession.sourceIpHash}, ${input.replacementSession.userAgentHash}, ${input.replacementSession.createdAt},
          ${input.replacementSession.lastSeenAt}, ${input.replacementSession.idleExpiresAt}, ${input.replacementSession.expiresAt},
          ${input.replacementSession.reauthenticatedAt}
        )
      `;
      return { verifier: credential(row), revokedSessions: Math.max(0, revoked.length - 1) };
    });
  }

  countRecentFailures(sourceIpHash: string, since: Date): Promise<number> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM auth_attempts
        WHERE source_ip_hash = ${sourceIpHash} AND outcome = 'failure' AND occurred_at >= ${since}
      `;
      return Number(rows[0]?.count ?? 0);
    });
  }

  recordAttempt(sourceIpHash: string, outcome: "success" | "failure" | "rate_limited", occurredAt: Date): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`INSERT INTO auth_attempts (source_ip_hash, outcome, occurred_at) VALUES (${sourceIpHash}, ${outcome}, ${occurredAt})`;
    });
  }

  createSession(value: OwnerSession): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`
        INSERT INTO web_sessions (
          id, token_hash, csrf_hash, state, source_ip_hash, user_agent_hash,
          created_at, last_seen_at, idle_expires_at, expires_at, reauthenticated_at
        ) VALUES (
          ${value.id}, ${value.tokenHash}, ${value.csrfHash}, ${value.state},
          ${value.sourceIpHash}, ${value.userAgentHash}, ${value.createdAt}, ${value.lastSeenAt},
          ${value.idleExpiresAt}, ${value.expiresAt}, ${value.reauthenticatedAt}
        )
      `;
    });
  }

  touchSession(tokenHash: string, userAgentHash: string, now: Date, idleExpiresAt: Date): Promise<OwnerSession | undefined> {
    return this.#database.transaction(async (sql) => {
      await sql`
        UPDATE web_sessions SET state = 'expired'
        WHERE token_hash = ${tokenHash} AND state = 'active'
          AND (idle_expires_at <= ${now} OR expires_at <= ${now})
      `;
      const rows = await sql<SessionRow[]>`
        UPDATE web_sessions SET
          last_seen_at = ${now},
          idle_expires_at = LEAST(expires_at, ${idleExpiresAt})
        WHERE token_hash = ${tokenHash} AND user_agent_hash = ${userAgentHash}
          AND state = 'active' AND idle_expires_at > ${now} AND expires_at > ${now}
        RETURNING *
      `;
      return rows[0] === undefined ? undefined : session(rows[0]);
    });
  }

  rotateSession(previousTokenHash: string, replacement: OwnerSession): Promise<void> {
    return this.#database.transaction(async (sql) => {
      const revoked = await sql`
        UPDATE web_sessions SET state = 'revoked', revoked_at = ${replacement.createdAt}
        WHERE token_hash = ${previousTokenHash} AND state = 'active'
        RETURNING id
      `;
      if (revoked.length !== 1) throw new Error("Owner session is no longer active");
      await sql`
        INSERT INTO web_sessions (
          id, token_hash, csrf_hash, state, source_ip_hash, user_agent_hash,
          created_at, last_seen_at, idle_expires_at, expires_at, reauthenticated_at
        ) VALUES (
          ${replacement.id}, ${replacement.tokenHash}, ${replacement.csrfHash}, 'active',
          ${replacement.sourceIpHash}, ${replacement.userAgentHash}, ${replacement.createdAt},
          ${replacement.lastSeenAt}, ${replacement.idleExpiresAt}, ${replacement.expiresAt},
          ${replacement.reauthenticatedAt}
        )
      `;
    });
  }

  revokeSession(tokenHash: string, now: Date): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`UPDATE web_sessions SET state = 'revoked', revoked_at = ${now} WHERE token_hash = ${tokenHash} AND state = 'active'`;
    });
  }

  revokeAllSessions(now: Date): Promise<number> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql`UPDATE web_sessions SET state = 'revoked', revoked_at = ${now} WHERE state = 'active' RETURNING id`;
      return rows.length;
    });
  }

  getPreferences(): Promise<OwnerPreferences> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<PreferencesRow[]>`SELECT * FROM owner_preferences WHERE owner_id = 'owner'`;
      const row = rows[0];
      if (row === undefined) throw new Error("Owner preferences are missing");
      return preferences(row);
    });
  }

  updatePreferences(input: Omit<OwnerPreferences, "updatedAt">): Promise<OwnerPreferences> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<PreferencesRow[]>`
        UPDATE owner_preferences SET
          dark_color = '#000000', light_color = '#ffffff',
          accent_color = ${input.accentColor}, sidebar_mode = ${input.sidebarMode},
          navigation_order = ${sql.json(input.navigationOrder)},
          dashboard_order = ${sql.json(input.dashboardOrder)},
          settings_order = ${sql.json(input.settingsOrder)}, updated_at = now()
        WHERE owner_id = 'owner'
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Owner preferences update failed");
      return preferences(row);
    });
  }
}
