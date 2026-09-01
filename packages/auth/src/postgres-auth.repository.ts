import type { Database } from "@saturn/database";
import type { OwnerAuthRepository, OwnerPreferences, OwnerSession } from "./types.js";

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
  dark_color: string;
  light_color: string;
  accent_color: string;
  updated_at: Date;
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
    darkColor: row.dark_color,
    lightColor: row.light_color,
    accentColor: row.accent_color,
    updatedAt: row.updated_at,
  };
}

export class PostgresOwnerAuthRepository implements OwnerAuthRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
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
          dark_color = ${input.darkColor}, light_color = ${input.lightColor},
          accent_color = ${input.accentColor}, updated_at = now()
        WHERE owner_id = 'owner'
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Owner preferences update failed");
      return preferences(row);
    });
  }
}
