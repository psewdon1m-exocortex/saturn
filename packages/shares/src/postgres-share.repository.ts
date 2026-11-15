import type { Database } from "@saturn/database";
import type { Resource } from "@saturn/file-core";
import type { SharePackage, SharePackageEntry, ShareRecord, ShareRepository, ShareSession } from "./types.js";
import { PostgresPackageLifecycle } from "./package-lifecycle.js";

interface PackageTreeRow {
  id: string; type: Resource["type"]; parent_id: string | null; name: string; storage_path: string;
  mime_type: string | null; size_bytes: string; sha256: string | null; current_version_id: string | null;
  status: Resource["status"]; security_classification: Resource["securityClassification"];
  created_at: Date; updated_at: Date; member_path: string;
}

interface ShareRow {
  id: string;
  token_hash: string;
  token_ciphertext: string | null;
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
  generation_id?: string | null;
  source_fingerprint: string | null;
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
    ...(row.token_ciphertext === null ? {} : { tokenCiphertext: row.token_ciphertext }),
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
    ...(row.generation_id == null ? {} : { generationId: row.generation_id }),
    ...(row.source_fingerprint == null ? {} : { sourceFingerprint: row.source_fingerprint }),
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

  readonly packageLifecycle: PostgresPackageLifecycle;
  constructor(database: Database) { this.#database = database; this.packageLifecycle = new PostgresPackageLifecycle(database); }

  createShare(input: Omit<ShareRecord, "downloadCount" | "state" | "updatedAt">): Promise<ShareRecord> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ShareRow[]>`
        INSERT INTO shares (
          id, token_hash, token_ciphertext, resource_id, resource_type, mode, state, password_hash,
          expires_at, max_downloads, allowed_cidr, classification_ceiling, created_at, updated_at
        ) VALUES (
          ${input.id}, ${input.tokenHash}, ${input.tokenCiphertext ?? null}, ${input.resourceId}, ${input.resourceType}, ${input.mode}, 'active',
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

  rotateShareCapability(id: string, input: { readonly tokenHash: string; readonly tokenCiphertext: string }, now: Date): Promise<{ readonly share: ShareRecord; readonly rotated: boolean }> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<ShareRow[]>`
        UPDATE shares SET token_hash = ${input.tokenHash}, token_ciphertext = ${input.tokenCiphertext}, updated_at = ${now}
        WHERE id = ${id} AND state = 'active' AND token_ciphertext IS NULL RETURNING *
      `;
      const row = rows[0];
      if (row !== undefined) {
        await sql`UPDATE share_sessions SET state = 'revoked' WHERE share_id = ${id} AND state = 'active'`;
        return { share: share(row), rotated: true };
      }
      const current = (await sql<ShareRow[]>`SELECT * FROM shares WHERE id = ${id} AND state = 'active' LIMIT 1`)[0];
      if (current === undefined) throw new Error("Active share not found");
      return { share: share(current), rotated: false };
    });
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
      if (input.mode !== undefined && input.mode !== "download_folder") await sql`UPDATE share_packages SET state = 'expired' WHERE share_id = ${id} AND state IN ('preparing', 'ready', 'failed')`;
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
      await sql`UPDATE share_packages SET state = 'expired' WHERE share_id = ${id} AND state IN ('preparing', 'ready', 'failed')`;
      return share(rows[0]);
    });
  }

  sourceAllowed(sourceIp: string, cidr: string): Promise<boolean> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ allowed: boolean }[]>`SELECT ${sourceIp}::inet <<= ${cidr}::cidr AS allowed`;
      return rows[0]?.allowed ?? false;
    });
  }

  isDescendant(rootId: string, candidateId: string, ceiling: ShareRecord["classificationCeiling"] = "internal"): Promise<boolean> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ allowed: boolean }[]>`
        WITH RECURSIVE ancestry AS (
          SELECT id, parent_id, ARRAY[id] AS visited FROM resources WHERE id = ${candidateId} AND status = 'active'
            AND CASE security_classification WHEN 'public' THEN 0 WHEN 'internal' THEN 1 ELSE 2 END <= ${ceiling === "public" ? 0 : 1}
          UNION ALL
          SELECT parent.id, parent.parent_id, child.visited || parent.id FROM resources parent JOIN ancestry child ON child.parent_id = parent.id
          WHERE child.id <> ${rootId} AND parent.status = 'active' AND parent.type = 'folder' AND NOT parent.id = ANY(child.visited)
            AND CASE parent.security_classification WHEN 'public' THEN 0 WHEN 'internal' THEN 1 ELSE 2 END <= ${ceiling === "public" ? 0 : 1}
        )
        SELECT EXISTS(SELECT 1 FROM ancestry WHERE id = ${rootId}) AS allowed
      `;
      return rows[0]?.allowed ?? false;
    });
  }

  readPackageTree(rootId: string, ceiling: ShareRecord["classificationCeiling"], maxEntries: number): Promise<readonly SharePackageEntry[]> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) throw new Error("Share package entry limit is invalid");
    return this.#database.withSql(async sql => {
      // LIMIT consumes the recursive CTE on demand; no outer sort/aggregate materializes an unbounded tree.
      // The root and every traversed ancestor must be active and inside the current classification ceiling.
      const rows = await sql<PackageTreeRow[]>`
        WITH RECURSIVE tree AS (
          SELECT r.*, ''::text AS member_path, ARRAY[r.id] AS visited FROM resources r
          WHERE r.id = ${rootId} AND r.type = 'folder' AND r.status = 'active'
            AND CASE r.security_classification WHEN 'public' THEN 0 WHEN 'internal' THEN 1 ELSE 2 END <= ${ceiling === "public" ? 0 : 1}
          UNION ALL
          SELECT r.*, CASE WHEN parent.member_path = '' THEN r.name ELSE parent.member_path || '/' || r.name END,
            parent.visited || r.id
          FROM resources r JOIN tree parent ON r.parent_id = parent.id
          WHERE parent.type = 'folder' AND r.status = 'active' AND NOT r.id = ANY(parent.visited)
            AND CASE r.security_classification WHEN 'public' THEN 0 WHEN 'internal' THEN 1 ELSE 2 END <= ${ceiling === "public" ? 0 : 1}
        )
        SELECT id, type, parent_id, name, storage_path, mime_type, size_bytes, sha256, current_version_id,
          status, security_classification, created_at, updated_at, member_path FROM tree LIMIT ${maxEntries + 2}
      `;
      if (!rows.some(row => row.id === rootId && row.member_path === "")) throw new Error("Share package root is unavailable");
      if (rows.length > maxEntries + 1) throw new Error("Share package entry limit exceeded");
      return rows.filter(row => row.id !== rootId).map(row => ({
        path: row.member_path + (row.type === "folder" ? "/" : ""),
        resource: {
          id: row.id, type: row.type, name: row.name, storagePath: row.storage_path, sizeBytes: Number(row.size_bytes),
          status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
          ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
          ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
          ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
          ...(row.current_version_id === null ? {} : { currentVersionId: row.current_version_id }),
          ...(row.security_classification === undefined ? {} : { securityClassification: row.security_classification }),
        },
      }));
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

  claimDownload(shareId: string, sessionId: string, now: Date, transfer?: Parameters<ShareRepository["claimDownload"]>[3]): Promise<{ readonly share: ShareRecord; readonly session: ShareSession }> {
    return this.#database.transaction(async (sql) => {
      const shares = await sql<ShareRow[]>`SELECT * FROM shares WHERE id = ${shareId} FOR UPDATE`;
      const sessions = await sql<SessionRow[]>`SELECT * FROM share_sessions WHERE id = ${sessionId} AND share_id = ${shareId} FOR UPDATE`;
      const currentShare = shares[0];
      const currentSession = sessions[0];
      if (currentShare === undefined || currentSession === undefined || !["active", "exhausted"].includes(currentShare.state)
        || currentShare.expires_at !== null && currentShare.expires_at <= now || currentSession.state !== "active" || currentSession.expires_at <= now) {
        throw new Error("Share access is not active");
      }
      let claimed = currentSession.download_claimed;
      if (transfer !== undefined) {
        const existing = await sql<{ resource_id: string; kind: string }[]>`SELECT resource_id, kind FROM share_download_claims
          WHERE session_id = ${sessionId} AND transfer_id = ${transfer.id}`;
        if (existing[0] !== undefined && (existing[0].resource_id !== transfer.resourceId || existing[0].kind !== transfer.kind)) throw new Error("Download identity target changed");
        claimed = existing.length !== 0;
      }
      if (!claimed) {
        if (currentShare.state !== "active" || currentShare.max_downloads !== null && currentShare.download_count >= currentShare.max_downloads) {
          throw new Error("Share download limit is exhausted");
        }
        if (transfer !== undefined) await sql`INSERT INTO share_download_claims (session_id, transfer_id, resource_id, kind, created_at, expires_at)
          VALUES (${sessionId}, ${transfer.id}, ${transfer.resourceId}, ${transfer.kind}, ${now}, ${currentSession.expires_at})`;
        const nextSessions = await sql<SessionRow[]>`UPDATE share_sessions SET download_claimed = true WHERE id = ${sessionId} RETURNING *`;
        const nextShares = await sql<ShareRow[]>`
          UPDATE shares SET download_count = download_count + 1,
            state = CASE WHEN max_downloads IS NOT NULL AND download_count + 1 >= max_downloads THEN 'exhausted' ELSE state END,
            updated_at = ${now}
          WHERE id = ${shareId} RETURNING *
        `;
        return { share: share(nextShares[0] ?? currentShare), session: session(nextSessions[0] ?? currentSession) };
      }
      return { share: share(currentShare), session: session(currentSession) };
    });
  }

  cleanupExpiredDownloadClaims(now: Date, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid download cleanup limit");
    return this.#database.withSql(async sql => {
      const rows = await sql`WITH expired AS (
        SELECT session_id, transfer_id FROM share_download_claims WHERE expires_at <= ${now}
        ORDER BY expires_at, session_id, transfer_id LIMIT ${limit} FOR UPDATE SKIP LOCKED
      ) DELETE FROM share_download_claims c USING expired e
        WHERE c.session_id = e.session_id AND c.transfer_id = e.transfer_id RETURNING c.transfer_id`;
      return rows.length;
    });
  }

  validateActive(shareId: string, now: Date, sessionId?: string): Promise<boolean> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ active: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM shares s JOIN resources r ON r.id = s.resource_id
          WHERE s.id = ${shareId} AND s.state IN ('active', 'exhausted')
            AND (s.expires_at IS NULL OR s.expires_at > ${now})
            AND (${sessionId ?? null}::uuid IS NULL OR EXISTS(
              SELECT 1 FROM share_sessions session WHERE session.id = ${sessionId ?? null}::uuid
                AND session.share_id = s.id AND session.state = 'active' AND session.expires_at > ${now}
            ))
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
      await sql`SELECT pg_advisory_xact_lock(1399677207)`;
      await sql`UPDATE share_packages SET state='expired' WHERE share_id=${input.shareId} AND state IN ('preparing','ready') AND expires_at<=${input.createdAt}`;
      const existing = await sql<PackageRow[]>`SELECT * FROM share_packages WHERE share_id = ${input.shareId} AND state IN ('preparing', 'ready') LIMIT 1`;
      if (existing[0] !== undefined) return { value: packageValue(existing[0]), created: false };
      const queued = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM share_packages WHERE state='preparing'`;
      if ((queued[0]?.count ?? 32) >= 32) throw new Error("Share package queue is full");
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

  claimPendingPackage(now: Date): Promise<SharePackage | undefined> {
    return this.#database.transaction(async sql => {
      const rows = await sql<PackageRow[]>`
        WITH candidate AS (SELECT id FROM share_packages WHERE state='preparing' AND expires_at>${now}
          AND (claimed_at IS NULL OR claimed_at<${new Date(now.getTime()-30*60_000)}
            OR claimed_at<${new Date(now.getTime()-30_000)} AND EXISTS(SELECT 1 FROM share_package_generations g WHERE g.id=share_packages.generation_id AND g.writer_expires_at<=${now} AND g.state='writing')) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE share_packages SET claimed_at=${now} WHERE id=(SELECT id FROM candidate) RETURNING *
      `;
      return rows[0] === undefined ? undefined : packageValue(rows[0]);
    });
  }

  getCurrentPackage(shareId: string): Promise<SharePackage | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<PackageRow[]>`SELECT * FROM share_packages WHERE share_id = ${shareId} AND state IN ('preparing', 'ready') ORDER BY created_at DESC LIMIT 1`;
      return rows[0] === undefined ? undefined : packageValue(rows[0]);
    });
  }

  setPackageReady(id: string, input: { readonly fileCount: number; readonly sizeBytes: number; readonly sha256: string; readonly readyAt: Date; readonly sourceFingerprint?: string }): Promise<SharePackage> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<PackageRow[]>`
        UPDATE share_packages SET state = 'ready', file_count = ${input.fileCount}, size_bytes = ${input.sizeBytes},
          sha256 = ${input.sha256}, ready_at = ${input.readyAt}, source_fingerprint=${input.sourceFingerprint ?? null}
        WHERE id = ${id} AND state = 'preparing' AND generation_id IS NULL RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Share package is not preparing");
      return packageValue(row);
    });
  }

  setPackageFailed(id: string, errorCode: string, expectedGenerationId?: string): Promise<void> {
    // Reject an unallocated job or the exact expired generation observed by the
    // claimant, never a replacement admitted by another worker in the meantime.
    return this.#database.withSql(async (sql) => { await sql`UPDATE share_packages SET state = 'failed', error_code = ${errorCode} WHERE id = ${id} AND state = 'preparing'
      AND (generation_id IS NULL AND ${expectedGenerationId ?? null}::uuid IS NULL OR generation_id=${expectedGenerationId ?? null}::uuid
        AND EXISTS(SELECT 1 FROM share_package_generations g WHERE g.id=share_packages.generation_id AND g.writer_expires_at<=clock_timestamp()))`; });
  }

  claimExpiredPackages(now: Date, limit: number): Promise<readonly SharePackage[]> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<PackageRow[]>`
        SELECT * FROM share_packages WHERE state IN ('failed', 'expired') OR state = 'ready' AND expires_at <= ${now}
        ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT ${limit}
      `;
      return rows.map(packageValue);
    });
  }

  markPackageExpired(id: string): Promise<void> {
    return this.#database.withSql(async (sql) => { await sql`UPDATE share_packages SET state = 'expired' WHERE id = ${id} AND state IN ('ready', 'failed')`; });
  }

  deleteExpiredPackage(id: string): Promise<void> {
    return this.#database.withSql(async sql => { await sql`DELETE FROM share_packages WHERE id = ${id} AND state = 'expired'`; });
  }
}
