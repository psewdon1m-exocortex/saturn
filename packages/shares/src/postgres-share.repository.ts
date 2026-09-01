import type { Database } from "@saturn/database";
import type { SharePackage, ShareRecord, ShareRepository, ShareSession } from "./types.js";

interface ShareRow {
  id: string;
  token_hash: string;
  resource_id: string;
  resource_type: "file" | "folder";
  mode: ShareRecord["mode"];
  state: ShareRecord["state"];
  password_hash: string | null;
  expires_at: Date | null;
  max_downloads: number | null;
  download_count: number;
  allowed_cidr: string | null;
  classification_ceiling: "public" | "internal";
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

interface SessionRow {
  id: string;
  share_id: string;
  token_hash: string;
  source_ip_hash: string;
  user_agent_hash: string;
  state: ShareSession["state"];
  download_claimed: boolean;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

interface PackageRow {
  id: string;
  share_id: string;
  state: SharePackage["state"];
  storage_path: string;
  file_count: number;
  size_bytes: string;
  sha256: string | null;
  created_at: Date;
  ready_at: Date | null;
  expires_at: Date;
  error_code: string | null;
}

function share(row: ShareRow): ShareRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    resourceId: row.resource_id,
    resourceType: row.resource_type,
    mode: row.mode,
    state: row.state,
    ...(row.password_hash === null ? {} : { passwordHash: row.password_hash }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.max_downloads === null ? {} : { maxDownloads: row.max_downloads }),
    downloadCount: row.download_count,
    ...(row.allowed_cidr === null ? {} : { allowedCidr: row.allowed_cidr }),
    classificationCeiling: row.classification_ceiling,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

function session(row: SessionRow): ShareSession {
  return {
    id: row.id,
    shareId: row.share_id,
    tokenHash: row.token_hash,
    sourceIpHash: row.source_ip_hash,
    userAgentHash: row.user_agent_hash,
    state: row.state,
    downloadClaimed: row.download_claimed,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

function packageValue(row: PackageRow): SharePackage {
  return {
    id: row.id,
    shareId: row.share_id,
    state: row.state,
    storagePath: row.storage_path,
    fileCount: row.file_count,
    sizeBytes: Number(row.size_bytes),
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    createdAt: row.created_at,
    ...(row.ready_at === null ? {} : { readyAt: row.ready_at }),
    expiresAt: row.expires_at,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}

export class PostgresShareRepository implements ShareRepository {
  readonly #database: Database;

  constructor(database: Database) { this.#database = database; }

  createShare(input: Omit<ShareRecord, "downloadCount" | "state" | "updatedAt">): Promise<ShareRecord> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ShareRow[]>`
        INSERT INTO shares (
          id, token_hash, resource_id, resource_type, mode, state, password_hash,
          expires_at, max_downloads, allowed_cidr, classification_ceiling, created_at, updated_at
        ) VALUES (
          ${input.id}, ${input.tokenHash}, ${input.resourceId}, ${input.resourceType}, ${input.mode}, 'active',
          ${input.passwordHash ?? null}, ${input.expiresAt ?? null}, ${input.maxDownloads ?? null},
          ${input.allowedCidr ?? null}, ${input.classificationCeiling}, ${input.createdAt}, ${input.createdAt}
        ) RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Share creation returned no row");
      return share(row);
    });
  }

  getShareById(id: string): Promise<ShareRecord | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ShareRow[]>`SELECT * FROM shares WHERE id = ${id} LIMIT 1`;
      return rows[0] === undefined ? undefined : share(rows[0]);
    });
  }

  getShareByTokenHash(tokenHash: string): Promise<ShareRecord | undefined> {
    return this.#database.transaction(async (sql) => {
      await sql`UPDATE shares SET state = 'expired', updated_at = now() WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= now()`;
      await sql`UPDATE shares SET state = 'exhausted', updated_at = now() WHERE state = 'active' AND max_downloads IS NOT NULL AND download_count >= max_downloads`;
      const rows = await sql<ShareRow[]>`SELECT * FROM shares WHERE token_hash = ${tokenHash} LIMIT 1`;
      return rows[0] === undefined ? undefined : share(rows[0]);
    });
  }

  listShares(offset: number, limit: number): Promise<readonly ShareRecord[]> {
    return this.#database.withSql(async (sql) => (await sql<ShareRow[]>`
      SELECT * FROM shares ORDER BY created_at DESC, id DESC OFFSET ${offset} LIMIT ${limit}
    `).map(share));
  }

  updateShare(id: string, input: { readonly mode?: ShareRecord["mode"]; readonly expiresAt?: Date | null; readonly passwordHash?: string | null; readonly maxDownloads?: number | null; readonly allowedCidr?: string | null }, now: Date): Promise<ShareRecord> {
    return this.#database.transaction(async (sql) => {
      const currentRows = await sql<ShareRow[]>`SELECT * FROM shares WHERE id = ${id} FOR UPDATE`;
      const current = currentRows[0];
      if (current === undefined) throw new Error("Share not found");
      const rows = await sql<ShareRow[]>`
        UPDATE shares SET
          mode = ${input.mode ?? current.mode},
          expires_at = ${input.expiresAt === undefined ? current.expires_at : input.expiresAt},
          password_hash = ${input.passwordHash === undefined ? current.password_hash : input.passwordHash},
          max_downloads = ${input.maxDownloads === undefined ? current.max_downloads : input.maxDownloads},
          allowed_cidr = ${input.allowedCidr === undefined ? current.allowed_cidr : input.allowedCidr},
          updated_at = ${now},
          state = CASE WHEN state IN ('expired', 'exhausted') THEN 'active' ELSE state END
        WHERE id = ${id}
        RETURNING *
      `;
      await sql`UPDATE share_sessions SET state = 'revoked' WHERE share_id = ${id} AND state = 'active'`;
      const row = rows[0];
      if (row === undefined) throw new Error("Share update returned no row");
      return share(row);
    });
  }

  revokeShare(id: string, now: Date): Promise<ShareRecord> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<ShareRow[]>`
        UPDATE shares SET state = 'revoked', revoked_at = ${now}, updated_at = ${now}
        WHERE id = ${id} RETURNING *
      `;
      if (rows[0] === undefined) throw new Error("Share not found");
      await sql`UPDATE share_sessions SET state = 'revoked' WHERE share_id = ${id} AND state = 'active'`;
      return share(rows[0]);
    });
  }

  sourceAllowed(sourceIp: string, cidr: string): Promise<boolean> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ allowed: boolean }[]>`SELECT ${sourceIp}::inet <<= ${cidr}::cidr AS allowed`;
      return rows[0]?.allowed ?? false;
    });
  }

  isDescendant(rootId: string, candidateId: string): Promise<boolean> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ allowed: boolean }[]>`
        WITH RECURSIVE descendants AS (
          SELECT id FROM resources WHERE id = ${rootId}
          UNION ALL
          SELECT child.id FROM resources child JOIN descendants parent ON child.parent_id = parent.id
        )
        SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ${candidateId}) AS allowed
      `;
      return rows[0]?.allowed ?? false;
    });
  }

  createSession(input: Omit<ShareSession, "state" | "downloadClaimed" | "lastSeenAt">): Promise<ShareSession> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<SessionRow[]>`
        INSERT INTO share_sessions (
          id, share_id, token_hash, source_ip_hash, user_agent_hash, state,
          download_claimed, created_at, last_seen_at, expires_at
        ) VALUES (
          ${input.id}, ${input.shareId}, ${input.tokenHash}, ${input.sourceIpHash}, ${input.userAgentHash},
          'active', false, ${input.createdAt}, ${input.createdAt}, ${input.expiresAt}
        ) RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Share session returned no row");
      return session(row);
    });
  }

  touchSession(input: { readonly shareId: string; readonly tokenHash: string; readonly sourceIpHash: string; readonly userAgentHash: string; readonly now: Date }): Promise<ShareSession | undefined> {
    return this.#database.transaction(async (sql) => {
      await sql`UPDATE share_sessions SET state = 'expired' WHERE token_hash = ${input.tokenHash} AND state = 'active' AND expires_at <= ${input.now}`;
      const rows = await sql<SessionRow[]>`
        UPDATE share_sessions SET last_seen_at = ${input.now}
        WHERE share_id = ${input.shareId} AND token_hash = ${input.tokenHash}
          AND source_ip_hash = ${input.sourceIpHash} AND user_agent_hash = ${input.userAgentHash}
          AND state = 'active' AND expires_at > ${input.now}
        RETURNING *
      `;
      return rows[0] === undefined ? undefined : session(rows[0]);
    });
  }

  claimDownload(shareId: string, sessionId: string, now: Date): Promise<{ readonly share: ShareRecord; readonly session: ShareSession }> {
    return this.#database.transaction(async (sql) => {
      const shares = await sql<ShareRow[]>`SELECT * FROM shares WHERE id = ${shareId} FOR UPDATE`;
      const sessions = await sql<SessionRow[]>`SELECT * FROM share_sessions WHERE id = ${sessionId} AND share_id = ${shareId} FOR UPDATE`;
      const currentShare = shares[0];
      const currentSession = sessions[0];
      if (currentShare === undefined || currentSession === undefined || currentShare.state !== "active" || currentSession.state !== "active" || currentSession.expires_at <= now) {
        throw new Error("Share access is not active");
      }
      if (!currentSession.download_claimed) {
        if (currentShare.max_downloads !== null && currentShare.download_count >= currentShare.max_downloads) {
          await sql`UPDATE shares SET state = 'exhausted', updated_at = ${now} WHERE id = ${shareId}`;
          throw new Error("Share download limit is exhausted");
        }
        await sql`UPDATE share_sessions SET download_claimed = true WHERE id = ${sessionId}`;
        await sql`
          UPDATE shares SET download_count = download_count + 1,
            state = CASE WHEN max_downloads IS NOT NULL AND download_count + 1 >= max_downloads THEN 'exhausted' ELSE state END,
            updated_at = ${now}
          WHERE id = ${shareId}
        `;
      }
      const nextShares = await sql<ShareRow[]>`SELECT * FROM shares WHERE id = ${shareId}`;
      const nextSessions = await sql<SessionRow[]>`SELECT * FROM share_sessions WHERE id = ${sessionId}`;
      return { share: share(nextShares[0] ?? currentShare), session: session(nextSessions[0] ?? currentSession) };
    });
  }

  validateActive(shareId: string, now: Date): Promise<boolean> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ active: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM shares s JOIN resources r ON r.id = s.resource_id
          WHERE s.id = ${shareId} AND s.state IN ('active', 'exhausted')
            AND (s.expires_at IS NULL OR s.expires_at > ${now})
            AND r.status = 'active'
            AND CASE r.security_classification
              WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 ELSE 3 END
              <= CASE s.classification_ceiling WHEN 'public' THEN 0 ELSE 1 END
        ) AS active
      `;
      return rows[0]?.active ?? false;
    });
  }

  beginPasswordAttempt(input: { readonly sourceIpHash: string; readonly since: Date; readonly limit: number; readonly occurredAt: Date }): Promise<string | undefined> {
    return this.#database.transaction(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('vault-share-password-rate', 0))`;
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM share_password_attempts
        WHERE source_ip_hash = ${input.sourceIpHash} AND outcome IN ('pending', 'failure') AND occurred_at >= ${input.since}
      `;
      if (Number(rows[0]?.count ?? 0) >= input.limit) {
        await sql`INSERT INTO share_password_attempts (source_ip_hash, outcome, occurred_at) VALUES (${input.sourceIpHash}, 'rate_limited', ${input.occurredAt})`;
        return undefined;
      }
      const inserted = await sql<{ sequence: string }[]>`
        INSERT INTO share_password_attempts (source_ip_hash, outcome, occurred_at)
        VALUES (${input.sourceIpHash}, 'pending', ${input.occurredAt}) RETURNING sequence::text AS sequence
      `;
      return inserted[0]?.sequence;
    });
  }

  finishPasswordAttempt(sequence: string, outcome: "success" | "failure", occurredAt: Date): Promise<void> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql`
        UPDATE share_password_attempts SET outcome = ${outcome}, occurred_at = ${occurredAt}
        WHERE sequence = ${sequence} AND outcome = 'pending' RETURNING sequence
      `;
      if (rows.length !== 1) throw new Error("Share password attempt is not active");
    });
  }

  writeAccessEvent(input: Parameters<ShareRepository["writeAccessEvent"]>[0]): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`
        INSERT INTO share_access_events (
          id, share_id, source_ip_hash, action, outcome, status_code,
          range_start, range_length, occurred_at, details
        ) VALUES (
          ${input.id}, ${input.shareId ?? null}, ${input.sourceIpHash}, ${input.action}, ${input.outcome},
          ${input.statusCode}, ${input.rangeStart ?? null}, ${input.rangeLength ?? null}, ${input.occurredAt}, ${sql.json((input.details ?? {}) as never)}
        )
      `;
    });
  }

  createPackage(input: Omit<SharePackage, "state" | "fileCount" | "sizeBytes">): Promise<{ readonly value: SharePackage; readonly created: boolean }> {
    return this.#database.transaction(async (sql) => {
      const existing = await sql<PackageRow[]>`SELECT * FROM share_packages WHERE share_id = ${input.shareId} AND state IN ('preparing', 'ready') LIMIT 1`;
      if (existing[0] !== undefined) return { value: packageValue(existing[0]), created: false };
      const rows = await sql<PackageRow[]>`
        INSERT INTO share_packages (id, share_id, state, storage_path, created_at, expires_at)
        VALUES (${input.id}, ${input.shareId}, 'preparing', ${input.storagePath}, ${input.createdAt}, ${input.expiresAt})
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Share package returned no row");
      return { value: packageValue(row), created: true };
    });
  }

  getCurrentPackage(shareId: string): Promise<SharePackage | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<PackageRow[]>`SELECT * FROM share_packages WHERE share_id = ${shareId} AND state IN ('preparing', 'ready') ORDER BY created_at DESC LIMIT 1`;
      return rows[0] === undefined ? undefined : packageValue(rows[0]);
    });
  }

  setPackageReady(id: string, input: { readonly fileCount: number; readonly sizeBytes: number; readonly sha256: string; readonly readyAt: Date }): Promise<SharePackage> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<PackageRow[]>`
        UPDATE share_packages SET state = 'ready', file_count = ${input.fileCount}, size_bytes = ${input.sizeBytes},
          sha256 = ${input.sha256}, ready_at = ${input.readyAt}
        WHERE id = ${id} AND state = 'preparing' RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Share package is not preparing");
      return packageValue(row);
    });
  }

  setPackageFailed(id: string, errorCode: string): Promise<void> {
    return this.#database.withSql(async (sql) => { await sql`UPDATE share_packages SET state = 'failed', error_code = ${errorCode} WHERE id = ${id} AND state = 'preparing'`; });
  }

  claimExpiredPackages(now: Date, limit: number): Promise<readonly SharePackage[]> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<PackageRow[]>`
        SELECT * FROM share_packages WHERE state IN ('ready', 'failed') AND expires_at <= ${now}
        ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT ${limit}
      `;
      return rows.map(packageValue);
    });
  }

  markPackageExpired(id: string): Promise<void> {
    return this.#database.withSql(async (sql) => { await sql`UPDATE share_packages SET state = 'expired' WHERE id = ${id} AND state IN ('ready', 'failed')`; });
  }
}
