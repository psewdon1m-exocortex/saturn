import type { Database } from "@saturn/database";
import type { DropRepository, DropSession, DropUpload, TelegramIdentity } from "./types.js";

interface SessionRow {
  id: string;
  channel_id: string;
  token_hash: string;
  csrf_hash: string;
  user_agent_hash: string;
  telegram_user_id: string | null;
  telegram_chat_id: string | null;
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
  channel_id: string;
  client_key_hash: string;
  upload_id: string | null;
  resource_id: string | null;
  filename: string;
  expected_size: string;
  expected_sha256: string | null;
  state: DropUpload["state"];
  local_path: string | null;
  received_size: string;
  actual_sha256: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
  continuation_until: Date;
  transfer_started_at: Date | null;
  completed_at: Date | null;
}

interface ChannelRow {
  id: string;
  state: "active" | "revoked" | "expired";
  created_at: Date;
  activated_at: Date | null;
  expires_at: Date;
  max_files: number;
  max_bytes: string;
  reserved_files: number;
  reserved_bytes: string;
}

function session(row: SessionRow): DropSession {
  return {
    id: row.id,
    channelId: row.channel_id,
    tokenHash: row.token_hash,
    csrfHash: row.csrf_hash,
    userAgentHash: row.user_agent_hash,
    ...(row.telegram_user_id === null ? {} : { telegramUserId: row.telegram_user_id }),
    ...(row.telegram_chat_id === null ? {} : { telegramChatId: row.telegram_chat_id }),
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
    channelId: row.channel_id,
    clientKeyHash: row.client_key_hash,
    ...(row.upload_id === null ? {} : { uploadId: row.upload_id }),
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    filename: row.filename,
    expectedSize: Number(row.expected_size),
    ...(row.expected_sha256 === null ? {} : { expectedSha256: row.expected_sha256 }),
    state: row.state,
    ...(row.local_path === null ? {} : { localPath: row.local_path }),
    receivedSize: Number(row.received_size),
    ...(row.actual_sha256 === null ? {} : { actualSha256: row.actual_sha256 }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    continuationUntil: row.continuation_until,
    ...(row.transfer_started_at === null ? {} : { transferStartedAt: row.transfer_started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

export class PostgresDropRepository implements DropRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  createDropChallenge(input: { readonly id: string; readonly codeHash: string; readonly identity?: TelegramIdentity; readonly createdAt: Date; readonly expiresAt: Date; readonly maxFiles: number; readonly maxBytes: number }): Promise<boolean> {
    return this.#database.transaction(async (sql) => {
      await sql`UPDATE drop_challenges SET state = 'revoked' WHERE state = 'active'`;
      await sql`
        UPDATE drop_channels SET state = 'revoked'
        WHERE state = 'active' AND activated_at IS NULL
          AND id IN (SELECT channel_id FROM drop_challenges WHERE state = 'revoked')
      `;
      await sql`
        INSERT INTO drop_channels (id, state, created_at, expires_at, max_files, max_bytes)
        VALUES (${input.id}, 'active', ${input.createdAt}, ${input.expiresAt}, ${input.maxFiles}, ${input.maxBytes})
      `;
      await sql`
        INSERT INTO drop_challenges (id, channel_id, code_hash, telegram_user_id, telegram_chat_id, state, created_at, expires_at)
        VALUES (${input.id}, ${input.id}, ${input.codeHash}, ${input.identity?.userId ?? null}, ${input.identity?.chatId ?? null}, 'active', ${input.createdAt}, ${input.expiresAt})
      `;
      return true;
    });
  }

  redeemDropChallenge(input: { readonly codeHash: string; readonly tokenHash: string; readonly csrfHash: string; readonly userAgentHash: string; readonly sessionId: string; readonly now: Date; readonly expiresAt: Date; readonly maxFiles: number; readonly maxBytes: number }): Promise<DropSession | undefined> {
    return this.#database.transaction(async (sql) => {
      await sql`UPDATE drop_challenges SET state = 'expired' WHERE state = 'active' AND expires_at <= ${input.now}`;
      const challenges = await sql<{ channel_id: string; telegram_user_id: string | null; telegram_chat_id: string | null }[]>`
        SELECT channel_id, telegram_user_id, telegram_chat_id FROM drop_challenges
        WHERE code_hash = ${input.codeHash} AND state = 'active' AND expires_at > ${input.now}
        FOR UPDATE
      `;
      const challenge = challenges[0];
      if (challenge === undefined) return undefined;
      await sql`
        UPDATE drop_challenges SET consumed_at = COALESCE(consumed_at, ${input.now})
        WHERE channel_id = ${challenge.channel_id}
      `;
      const channels = await sql<ChannelRow[]>`
        UPDATE drop_channels SET
          activated_at = COALESCE(activated_at, ${input.now}),
          expires_at = CASE WHEN activated_at IS NULL THEN LEAST(expires_at, ${input.expiresAt}) ELSE expires_at END,
          max_files = CASE WHEN activated_at IS NULL THEN ${input.maxFiles} ELSE max_files END,
          max_bytes = CASE WHEN activated_at IS NULL THEN ${input.maxBytes} ELSE max_bytes END
        WHERE id = ${challenge.channel_id} AND state = 'active'
          AND (activated_at IS NULL OR expires_at > ${input.now})
        RETURNING *
      `;
      const channel = channels[0];
      if (channel === undefined) return undefined;
      const rows = await sql<SessionRow[]>`
        INSERT INTO drop_sessions (
          id, channel_id, token_hash, csrf_hash, user_agent_hash, telegram_user_id, telegram_chat_id,
          state, created_at, last_seen_at, expires_at, max_files, max_bytes, reserved_files, reserved_bytes
        ) VALUES (
          ${input.sessionId}, ${channel.id}, ${input.tokenHash}, ${input.csrfHash}, ${input.userAgentHash},
          ${challenge.telegram_user_id}, ${challenge.telegram_chat_id}, 'active', ${input.now},
          ${input.now}, ${channel.expires_at}, ${channel.max_files}, ${channel.max_bytes}, ${channel.reserved_files}, ${channel.reserved_bytes}
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
      await sql`UPDATE drop_channels SET state = 'expired' WHERE state = 'active' AND expires_at <= ${now}`;
      await sql`
        UPDATE drop_sessions AS session SET state = 'expired'
        FROM drop_channels AS channel
        WHERE session.channel_id = channel.id AND session.state = 'active'
          AND (channel.state = 'expired' OR session.expires_at <= ${now})
      `;
      const rows = await sql<SessionRow[]>`
        UPDATE drop_sessions SET last_seen_at = ${now}
        WHERE token_hash = ${tokenHash} AND user_agent_hash = ${userAgentHash}
          AND state = 'active' AND expires_at > ${now}
        RETURNING *
      `;
      return rows[0] === undefined ? undefined : session(rows[0]);
    });
  }

  getContinuationSession(tokenHash: string, userAgentHash: string, uploadId: string, now: Date): Promise<DropSession | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<SessionRow[]>`
        SELECT s.* FROM drop_sessions s
        JOIN drop_uploads u ON u.channel_id = s.channel_id
        WHERE s.token_hash = ${tokenHash} AND s.user_agent_hash = ${userAgentHash}
          AND s.state IN ('active', 'expired') AND u.id = ${uploadId}
          AND u.state = 'uploading' AND u.continuation_until > ${now}
        LIMIT 1
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
      const sessions = await sql`UPDATE drop_sessions SET state = 'revoked', revoked_at = ${now} WHERE state = 'active' AND telegram_user_id = ${identity.userId} AND telegram_chat_id = ${identity.chatId} RETURNING id`;
      const challenges = await sql`UPDATE drop_challenges SET state = 'revoked' WHERE state = 'active' AND telegram_user_id = ${identity.userId} AND telegram_chat_id = ${identity.chatId} RETURNING id`;
      return { sessions: sessions.length, challenges: challenges.length };
    });
  }

  reserveUpload(input: { readonly id: string; readonly sessionId: string; readonly channelId: string; readonly clientKeyHash: string; readonly filename: string; readonly expectedSize: number; readonly expectedSha256?: string; readonly now: Date; readonly continuationUntil?: Date; readonly globalMaxBytes?: number }): Promise<{ readonly value: DropUpload; readonly created: boolean }> {
    return this.#database.transaction(async (sql) => {
      if (input.globalMaxBytes !== undefined) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-drop-buffer-reservation', 0))`;
        const totals = await sql<{ bytes: string }[]>`SELECT COALESCE(sum(expected_size), 0)::text AS bytes FROM drop_uploads WHERE state IN ('reserved', 'uploading', 'buffered', 'transferring', 'verifying')`;
        if (Number(totals[0]?.bytes ?? 0) + input.expectedSize > input.globalMaxBytes) throw new Error("Drop global buffer quota is exhausted");
      }
      const sessions = await sql<SessionRow[]>`SELECT * FROM drop_sessions WHERE id = ${input.sessionId} FOR UPDATE`;
      const active = sessions[0];
      if (active === undefined || active.channel_id !== input.channelId || active.state !== "active" || active.expires_at <= input.now) throw new Error("Drop session is not active");
      const channels = await sql<ChannelRow[]>`SELECT * FROM drop_channels WHERE id = ${input.channelId} FOR UPDATE`;
      const channel = channels[0];
      if (channel === undefined || channel.state !== "active" || channel.expires_at <= input.now) throw new Error("Drop channel is not active");
      const existing = await sql<UploadRow[]>`
        SELECT * FROM drop_uploads WHERE channel_id = ${input.channelId} AND client_key_hash = ${input.clientKeyHash} LIMIT 1
      `;
      if (existing[0] !== undefined) {
        const value = upload(existing[0]);
        if (value.filename !== input.filename || value.expectedSize !== input.expectedSize || value.expectedSha256 !== input.expectedSha256) {
          throw new Error("Drop idempotency key was already used for different upload parameters");
        }
        return { value, created: false };
      }
      if (channel.reserved_files + 1 > channel.max_files || Number(channel.reserved_bytes) + input.expectedSize > Number(channel.max_bytes)) {
        throw new Error("Drop channel quota is exhausted");
      }
      const rows = await sql<UploadRow[]>`
        INSERT INTO drop_uploads (
          id, session_id, channel_id, client_key_hash, filename, expected_size, expected_sha256, state, created_at, updated_at, continuation_until
        ) VALUES (
          ${input.id}, ${input.sessionId}, ${input.channelId}, ${input.clientKeyHash}, ${input.filename}, ${input.expectedSize},
          ${input.expectedSha256 ?? null}, 'reserved', ${input.now}, ${input.now}, ${input.continuationUntil ?? new Date(input.now.getTime() + 24 * 60 * 60 * 1_000)}
        ) RETURNING *
      `;
      const updatedChannels = await sql<ChannelRow[]>`
        UPDATE drop_channels SET reserved_files = reserved_files + 1, reserved_bytes = reserved_bytes + ${input.expectedSize}
        WHERE id = ${input.channelId} RETURNING *
      `;
      const updatedChannel = updatedChannels[0];
      if (updatedChannel === undefined) throw new Error("Drop channel quota update failed");
      await sql`
        UPDATE drop_sessions SET reserved_files = ${updatedChannel.reserved_files}, reserved_bytes = ${updatedChannel.reserved_bytes}
        WHERE channel_id = ${input.channelId}
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop upload reservation returned no row");
      return { value: upload(row), created: true };
    });
  }

  attachUpload(channelId: string, id: string, uploadId: string): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE drop_uploads SET upload_id = ${uploadId}, state = 'uploading'
        WHERE id = ${id} AND channel_id = ${channelId} AND state IN ('reserved', 'uploading')
          AND (upload_id IS NULL OR upload_id = ${uploadId})
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop upload could not be attached");
      return upload(row);
    });
  }

  releaseUploadReservation(channelId: string, id: string): Promise<void> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<UploadRow[]>`
        DELETE FROM drop_uploads
        WHERE id = ${id} AND channel_id = ${channelId} AND state = 'reserved' AND upload_id IS NULL
        RETURNING *
      `;
      const removed = rows[0];
      if (removed !== undefined) {
        const channels = await sql<ChannelRow[]>`
          UPDATE drop_channels SET reserved_files = GREATEST(0, reserved_files - 1), reserved_bytes = GREATEST(0, reserved_bytes - ${removed.expected_size})
          WHERE id = ${channelId} RETURNING *
        `;
        const channel = channels[0];
        if (channel !== undefined) await sql`
          UPDATE drop_sessions SET reserved_files = ${channel.reserved_files}, reserved_bytes = ${channel.reserved_bytes}
          WHERE channel_id = ${channelId}
        `;
      }
    });
  }

  getDropUpload(channelId: string, id: string): Promise<DropUpload | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`SELECT * FROM drop_uploads WHERE id = ${id} AND channel_id = ${channelId} LIMIT 1`;
      return rows[0] === undefined ? undefined : upload(rows[0]);
    });
  }

  completeDropUpload(channelId: string, id: string, resourceId: string, completedAt: Date): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE drop_uploads SET resource_id = ${resourceId}, state = 'stored', completed_at = ${completedAt}, updated_at = ${completedAt}
        WHERE id = ${id} AND channel_id = ${channelId}
          AND (state IN ('uploading', 'verifying') OR (state = 'stored' AND resource_id = ${resourceId}))
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop upload could not be completed");
      return upload(row);
    });
  }

  initializeBufferedUpload(channelId: string, id: string, localPath: string, continuationUntil: Date, now: Date): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE drop_uploads SET local_path = ${localPath}, state = 'uploading', continuation_until = ${continuationUntil}, updated_at = ${now}
        WHERE id = ${id} AND channel_id = ${channelId} AND state IN ('reserved', 'uploading')
          AND (local_path IS NULL OR local_path = ${localPath})
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop buffer upload could not be initialized");
      return upload(row);
    });
  }

  advanceBufferedUpload(channelId: string, id: string, offset: number, bytes: number, now: Date): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE drop_uploads SET received_size = received_size + ${bytes}, updated_at = ${now}
        WHERE id = ${id} AND channel_id = ${channelId} AND state = 'uploading'
          AND continuation_until > ${now} AND received_size = ${offset} AND received_size + ${bytes} <= expected_size
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop buffer offset is no longer current");
      return upload(row);
    });
  }

  markUploadBuffered(channelId: string, id: string, sha256: string, now: Date): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE drop_uploads SET state = 'buffered', actual_sha256 = ${sha256}, updated_at = ${now}
        WHERE id = ${id} AND channel_id = ${channelId} AND state IN ('uploading', 'buffered')
          AND received_size = expected_size AND (actual_sha256 IS NULL OR actual_sha256 = ${sha256})
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop upload could not enter the buffer queue");
      return upload(row);
    });
  }

  listDropUploads(channelId: string): Promise<readonly DropUpload[]> {
    return this.#database.withSql(async (sql) => (await sql<UploadRow[]>`SELECT * FROM drop_uploads WHERE channel_id = ${channelId} ORDER BY created_at, id`).map(upload));
  }

  cancelDropUpload(channelId: string, id: string, now: Date): Promise<DropUpload> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE drop_uploads SET state = 'cancelled', updated_at = ${now}
        WHERE id = ${id} AND channel_id = ${channelId} AND state IN ('reserved', 'uploading', 'buffered')
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Drop upload cannot be cancelled after transfer starts");
      const channels = await sql<ChannelRow[]>`
        UPDATE drop_channels SET reserved_files = GREATEST(0, reserved_files - 1), reserved_bytes = GREATEST(0, reserved_bytes - ${row.expected_size})
        WHERE id = ${channelId} RETURNING *
      `;
      const channel = channels[0];
      if (channel !== undefined) await sql`
        UPDATE drop_sessions SET reserved_files = ${channel.reserved_files}, reserved_bytes = ${channel.reserved_bytes}
        WHERE channel_id = ${channelId}
      `;
      return upload(row);
    });
  }

  bufferReservedBytes(): Promise<number> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ bytes: string }[]>`SELECT COALESCE(sum(expected_size), 0)::text AS bytes FROM drop_uploads WHERE state IN ('reserved', 'uploading', 'buffered', 'transferring', 'verifying')`;
      return Number(rows[0]?.bytes ?? 0);
    });
  }

  claimBufferedUpload(now: Date): Promise<DropUpload | undefined> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<UploadRow[]>`
        WITH candidate AS (
          SELECT id FROM drop_uploads
          WHERE state = 'buffered' OR (state IN ('transferring', 'verifying') AND updated_at < ${new Date(now.getTime() - 30 * 60 * 1_000)})
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE drop_uploads SET state = 'transferring', transfer_started_at = ${now}, updated_at = ${now}
        WHERE id = (SELECT id FROM candidate)
        RETURNING *
      `;
      return rows[0] === undefined ? undefined : upload(rows[0]);
    });
  }

  markUploadVerifying(id: string, uploadId: string, now: Date): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`UPDATE drop_uploads SET upload_id = ${uploadId}, state = 'verifying', updated_at = ${now} WHERE id = ${id} AND state = 'transferring' RETURNING *`;
      const row = rows[0]; if (row === undefined) throw new Error("Drop upload could not enter verification"); return upload(row);
    });
  }

  markUploadStored(id: string, resourceId: string, sha256: string, now: Date): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`UPDATE drop_uploads SET resource_id = ${resourceId}, actual_sha256 = ${sha256}, state = 'stored', completed_at = ${now}, updated_at = ${now} WHERE id = ${id} AND state = 'verifying' RETURNING *`;
      const row = rows[0]; if (row === undefined) throw new Error("Drop upload could not be committed"); return upload(row);
    });
  }

  markUploadFailed(id: string, failureCode: string, now: Date): Promise<DropUpload> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`UPDATE drop_uploads SET state = 'failed', failure_code = ${failureCode.slice(0, 100)}, updated_at = ${now} WHERE id = ${id} AND state NOT IN ('stored', 'cancelled') RETURNING *`;
      const row = rows[0]; if (row === undefined) throw new Error("Drop upload could not be failed"); return upload(row);
    });
  }

}
