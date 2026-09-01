import type { Database } from "@saturn/database";
import type { DropRepository, DropSession, DropUpload, TelegramBinding, TelegramIdentity } from "./types.js";

interface BindingRow {
  telegram_user_id: string;
  telegram_chat_id: string;
  display_name: string | null;
  bound_at: Date;
  updated_at: Date;
}

interface SessionRow {
  id: string;
  token_hash: string;
  csrf_hash: string;
  user_agent_hash: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  state: DropSession["state"];
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  max_files: number;
  max_bytes: string;
  reserved_files: number;
  reserved_bytes: string;
}

interface UploadRow {
  id: string;
  session_id: string;
  client_key_hash: string;
  upload_id: string | null;
  resource_id: string | null;
  filename: string;
  expected_size: string;
  expected_sha256: string | null;
  state: DropUpload["state"];
  created_at: Date;
  completed_at: Date | null;
}

function binding(row: BindingRow): TelegramBinding {
  return {
    userId: row.telegram_user_id,
    chatId: row.telegram_chat_id,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    boundAt: row.bound_at,
    updatedAt: row.updated_at,
  };
}

function session(row: SessionRow): DropSession {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    userAgentHash: row.user_agent_hash,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    state: row.state,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    maxFiles: row.max_files,
    maxBytes: Number(row.max_bytes),
    reservedFiles: row.reserved_files,
    reservedBytes: Number(row.reserved_bytes),
  };
}

function upload(row: UploadRow): DropUpload {
  return {
    id: row.id,
    sessionId: row.session_id,
    clientKeyHash: row.client_key_hash,
    ...(row.upload_id === null ? {} : { uploadId: row.upload_id }),
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    filename: row.filename,
    expectedSize: Number(row.expected_size),
    ...(row.expected_sha256 === null ? {} : { expectedSha256: row.expected_sha256 }),
    state: row.state,
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

export class PostgresDropRepository implements DropRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  createLinkChallenge(input: { readonly id: string; readonly codeHash: string; readonly createdAt: Date; readonly expiresAt: Date }): Promise<void> {
    return this.#database.transaction(async (sql) => {
      await sql`UPDATE telegram_link_challenges SET state = 'revoked' WHERE state = 'active'`;
      await sql`
        INSERT INTO telegram_link_challenges (id, code_hash, state, created_at, expires_at)
        VALUES (${input.id}, ${input.codeHash}, 'active', ${input.createdAt}, ${input.expiresAt})
      `;
    });
  }

  consumeLinkChallenge(codeHash: string, identity: TelegramIdentity, now: Date): Promise<TelegramBinding | undefined> {
    return this.#database.transaction(async (sql) => {
      await sql`UPDATE telegram_link_challenges SET state = 'expired' WHERE state = 'active' AND expires_at <= ${now}`;
      const consumed = await sql`
        UPDATE telegram_link_challenges SET state = 'consumed', consumed_at = ${now}
        WHERE code_hash = ${codeHash} AND state = 'active' AND expires_at > ${now}
        RETURNING id
      `;
      if (consumed.length !== 1) return undefined;
      await sql`UPDATE drop_challenges SET state = 'revoked' WHERE state = 'active'`;
      await sql`UPDATE drop_sessions SET state = 'revoked', revoked_at = ${now} WHERE state = 'active'`;
      const rows = await sql<BindingRow[]>`
        INSERT INTO telegram_binding (owner_id, telegram_user_id, telegram_chat_id, display_name, bound_at, updated_at)
        VALUES ('owner', ${identity.userId}, ${identity.chatId}, ${identity.displayName ?? null}, ${now}, ${now})
        ON CONFLICT (owner_id) DO UPDATE SET
          telegram_user_id = EXCLUDED.telegram_user_id,
          telegram_chat_id = EXCLUDED.telegram_chat_id,
          display_name = EXCLUDED.display_name,
          bound_at = EXCLUDED.bound_at,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Telegram binding returned no row");
      return binding(row);
    });
  }

  getBinding(): Promise<TelegramBinding | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<BindingRow[]>`SELECT * FROM telegram_binding WHERE owner_id = 'owner' LIMIT 1`;
      return rows[0] === undefined ? undefined : binding(rows[0]);
    });
  }

  unlink(now: Date): Promise<{ readonly sessions: number; readonly challenges: number }> {
    return this.#database.transaction(async (sql) => {
      const sessions = await sql`UPDATE drop_sessions SET state = 'revoked', revoked_at = ${now} WHERE state = 'active' RETURNING id`;
      const challenges = await sql`UPDATE drop_challenges SET state = 'revoked' WHERE state = 'active' RETURNING id`;
      await sql`UPDATE telegram_link_challenges SET state = 'revoked' WHERE state = 'active'`;
      await sql`DELETE FROM telegram_binding WHERE owner_id = 'owner'`;
      return { sessions: sessions.length, challenges: challenges.length };
    });
  }

  createDropChallenge(input: { readonly id: string; readonly codeHash: string; readonly identity: TelegramIdentity; readonly createdAt: Date; readonly expiresAt: Date }): Promise<boolean> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<BindingRow[]>`SELECT * FROM telegram_binding WHERE owner_id = 'owner' FOR UPDATE`;
      const current = rows[0];
      if (current === undefined || current.telegram_user_id !== input.identity.userId || current.telegram_chat_id !== input.identity.chatId) return false;
      await sql`UPDATE drop_challenges SET state = 'revoked' WHERE state = 'active'`;
      await sql`
        INSERT INTO drop_challenges (id, code_hash, telegram_user_id, telegram_chat_id, state, created_at, expires_at)
        VALUES (${input.id}, ${input.codeHash}, ${input.identity.userId}, ${input.identity.chatId}, 'active', ${input.createdAt}, ${input.expiresAt})
      `;
      return true;
    });
  }

  redeemDropChallenge(input: { readonly codeHash: string; readonly tokenHash: string; readonly csrfHash: string; readonly userAgentHash: string; readonly sessionId: string; readonly now: Date; readonly expiresAt: Date; readonly maxFiles: number; readonly maxBytes: number }): Promise<DropSession | undefined> {
    return this.#database.transaction(async (sql) => {
      await sql`UPDATE drop_challenges SET state = 'expired' WHERE state = 'active' AND expires_at <= ${input.now}`;
      const challenges = await sql<{ telegram_user_id: string; telegram_chat_id: string }[]>`
        UPDATE drop_challenges SET state = 'consumed', consumed_at = ${input.now}
        WHERE code_hash = ${input.codeHash} AND state = 'active' AND expires_at > ${input.now}
        RETURNING telegram_user_id, telegram_chat_id
      `;
      const challenge = challenges[0];
      if (challenge === undefined) return undefined;
      const rows = await sql<SessionRow[]>`
        INSERT INTO drop_sessions (
          id, token_hash, csrf_hash, user_agent_hash, telegram_user_id, telegram_chat_id,
          state, created_at, last_seen_at, expires_at, max_files, max_bytes
        ) VALUES (
          ${input.sessionId}, ${input.tokenHash}, ${input.csrfHash}, ${input.userAgentHash},
          ${challenge.telegram_user_id}, ${challenge.telegram_chat_id}, 'active', ${input.now},
          ${input.now}, ${input.expiresAt}, ${input.maxFiles}, ${input.maxBytes}
        ) RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop session returned no row");
      return session(row);
    });
  }

  beginDropAttempt(input: { readonly sourceIpHash: string; readonly since: Date; readonly sourceLimit: number; readonly globalLimit: number; readonly occurredAt: Date }): Promise<string | undefined> {
    return this.#database.transaction(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('vault-drop-rate-limit', 0))`;
      const rows = await sql<{ source_count: string; global_count: string }[]>`
        SELECT
          count(*) FILTER (WHERE source_ip_hash = ${input.sourceIpHash})::text AS source_count,
          count(*)::text AS global_count
        FROM drop_attempts
        WHERE outcome IN ('pending', 'failure') AND occurred_at >= ${input.since}
      `;
      const source = Number(rows[0]?.source_count ?? 0);
      const global = Number(rows[0]?.global_count ?? 0);
      if (source >= input.sourceLimit || global >= input.globalLimit) {
        await sql`INSERT INTO drop_attempts (source_ip_hash, outcome, occurred_at) VALUES (${input.sourceIpHash}, 'rate_limited', ${input.occurredAt})`;
        return undefined;
      }
      const inserted = await sql<{ sequence: string }[]>`
        INSERT INTO drop_attempts (source_ip_hash, outcome, occurred_at)
        VALUES (${input.sourceIpHash}, 'pending', ${input.occurredAt})
        RETURNING sequence::text AS sequence
      `;
      const sequence = inserted[0]?.sequence;
      if (sequence === undefined) throw new Error("Drop attempt reservation returned no row");
      return sequence;
    });
  }

  finishDropAttempt(sequence: string, outcome: "success" | "failure", occurredAt: Date): Promise<void> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ sequence: string }[]>`
        UPDATE drop_attempts SET outcome = ${outcome}, occurred_at = ${occurredAt}
        WHERE sequence = ${sequence} AND outcome = 'pending'
        RETURNING sequence::text AS sequence
      `;
      if (rows.length !== 1) throw new Error("Drop attempt reservation is not active");
    });
  }

  touchDropSession(tokenHash: string, userAgentHash: string, now: Date): Promise<DropSession | undefined> {
    return this.#database.transaction(async (sql) => {
      await sql`UPDATE drop_sessions SET state = 'expired' WHERE token_hash = ${tokenHash} AND state = 'active' AND expires_at <= ${now}`;
      const rows = await sql<SessionRow[]>`
        UPDATE drop_sessions SET last_seen_at = ${now}
        WHERE token_hash = ${tokenHash} AND user_agent_hash = ${userAgentHash}
          AND state = 'active' AND expires_at > ${now}
        RETURNING *
      `;
      return rows[0] === undefined ? undefined : session(rows[0]);
    });
  }

  revokeDropSession(tokenHash: string, now: Date): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`UPDATE drop_sessions SET state = 'revoked', revoked_at = ${now} WHERE token_hash = ${tokenHash} AND state = 'active'`;
    });
  }

  revokeDropAccess(identity: TelegramIdentity, now: Date): Promise<{ readonly sessions: number; readonly challenges: number }> {
    return this.#database.transaction(async (sql) => {
      const bound = await sql<BindingRow[]>`SELECT * FROM telegram_binding WHERE owner_id = 'owner' FOR UPDATE`;
      const current = bound.at(0);
      if (current?.telegram_user_id !== identity.userId || current.telegram_chat_id !== identity.chatId) {
        throw new Error("Telegram identity is not bound");
      }
      const sessions = await sql`UPDATE drop_sessions SET state = 'revoked', revoked_at = ${now} WHERE state = 'active' RETURNING id`;
      const challenges = await sql`UPDATE drop_challenges SET state = 'revoked' WHERE state = 'active' RETURNING id`;
      return { sessions: sessions.length, challenges: challenges.length };
    });
  }

  reserveUpload(input: { readonly id: string; readonly sessionId: string; readonly clientKeyHash: string; readonly filename: string; readonly expectedSize: number; readonly expectedSha256?: string; readonly now: Date }): Promise<{ readonly value: DropUpload; readonly created: boolean }> {
    return this.#database.transaction(async (sql) => {
      const sessions = await sql<SessionRow[]>`SELECT * FROM drop_sessions WHERE id = ${input.sessionId} FOR UPDATE`;
      const active = sessions[0];
      if (active === undefined || active.state !== "active" || active.expires_at <= input.now) throw new Error("Drop session is not active");
      const existing = await sql<UploadRow[]>`
        SELECT * FROM drop_uploads WHERE session_id = ${input.sessionId} AND client_key_hash = ${input.clientKeyHash} LIMIT 1
      `;
      if (existing[0] !== undefined) {
        const value = upload(existing[0]);
        if (value.filename !== input.filename || value.expectedSize !== input.expectedSize || value.expectedSha256 !== input.expectedSha256) {
          throw new Error("Drop idempotency key was already used for different upload parameters");
        }
        return { value, created: false };
      }
      if (active.reserved_files + 1 > active.max_files || Number(active.reserved_bytes) + input.expectedSize > Number(active.max_bytes)) {
        throw new Error("Drop session quota is exhausted");
      }
      const rows = await sql<UploadRow[]>`
        INSERT INTO drop_uploads (
          id, session_id, client_key_hash, filename, expected_size, expected_sha256, state, created_at
        ) VALUES (
          ${input.id}, ${input.sessionId}, ${input.clientKeyHash}, ${input.filename}, ${input.expectedSize},
          ${input.expectedSha256 ?? null}, 'reserved', ${input.now}
        ) RETURNING *
      `;
      await sql`
        UPDATE drop_sessions SET reserved_files = reserved_files + 1, reserved_bytes = reserved_bytes + ${input.expectedSize}
        WHERE id = ${input.sessionId}
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop upload reservation returned no row");
      return { value: upload(row), created: true };
    });
  }

  attachUpload(sessionId: string, id: string, uploadId: string): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE drop_uploads SET upload_id = ${uploadId}, state = 'uploading'
        WHERE id = ${id} AND session_id = ${sessionId} AND state IN ('reserved', 'uploading')
          AND (upload_id IS NULL OR upload_id = ${uploadId})
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop upload could not be attached");
      return upload(row);
    });
  }

  releaseUploadReservation(sessionId: string, id: string): Promise<void> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<UploadRow[]>`
        DELETE FROM drop_uploads
        WHERE id = ${id} AND session_id = ${sessionId} AND state = 'reserved' AND upload_id IS NULL
        RETURNING *
      `;
      const removed = rows[0];
      if (removed !== undefined) {
        await sql`
          UPDATE drop_sessions SET reserved_files = reserved_files - 1, reserved_bytes = reserved_bytes - ${removed.expected_size}
          WHERE id = ${sessionId}
        `;
      }
    });
  }

  getDropUpload(sessionId: string, id: string): Promise<DropUpload | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`SELECT * FROM drop_uploads WHERE id = ${id} AND session_id = ${sessionId} LIMIT 1`;
      return rows[0] === undefined ? undefined : upload(rows[0]);
    });
  }

  completeDropUpload(sessionId: string, id: string, resourceId: string, completedAt: Date): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE drop_uploads SET resource_id = ${resourceId}, state = 'completed', completed_at = ${completedAt}
        WHERE id = ${id} AND session_id = ${sessionId}
          AND (state = 'uploading' OR (state = 'completed' AND resource_id = ${resourceId}))
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop upload could not be completed");
      return upload(row);
    });
  }

  claimTelegramUpdate(updateId: string, telegramUserId: string | undefined, now: Date): Promise<"claimed" | "retry" | "duplicate" | "busy"> {
    return this.#database.transaction(async (sql) => {
      const inserted = await sql`
        INSERT INTO telegram_updates (update_id, state, telegram_user_id, received_at)
        VALUES (${updateId}, 'processing', ${telegramUserId ?? null}, ${now})
        ON CONFLICT (update_id) DO NOTHING
        RETURNING update_id
      `;
      if (inserted.length === 1) return "claimed";
      const rows = await sql<{ state: "processing" | "completed" | "failed" }[]>`
        SELECT state FROM telegram_updates WHERE update_id = ${updateId} FOR UPDATE
      `;
      if (rows[0]?.state === "completed") return "duplicate";
      if (rows[0]?.state === "processing") return "busy";
      const retried = await sql`
        UPDATE telegram_updates SET state = 'processing', attempt_count = attempt_count + 1,
          failed_at = NULL, failure_code = NULL
        WHERE update_id = ${updateId} AND state = 'failed'
        RETURNING update_id
      `;
      return retried.length === 1 ? "retry" : "busy";
    });
  }

  completeTelegramUpdate(updateId: string, now: Date): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`UPDATE telegram_updates SET state = 'completed', completed_at = ${now} WHERE update_id = ${updateId} AND state = 'processing'`;
    });
  }

  failTelegramUpdate(updateId: string, failureCode: string, now: Date): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`
        UPDATE telegram_updates SET state = 'failed', failed_at = ${now}, failure_code = ${failureCode}
        WHERE update_id = ${updateId} AND state = 'processing'
      `;
    });
  }
}
