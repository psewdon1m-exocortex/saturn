import type { TransactionSql } from "postgres";
import type { Database } from "@saturn/database";
import { assertBrowserNamespaceCatalogPermit } from "./browser-upload-namespace-context.js";
import type { FileOperation, FileVersion, Resource, ResourceStatus, ResourceType, RetentionClass, SecurityClassification, UploadSession, UploadStatus } from "./models.js";
import { ROOT_RESOURCE_ID } from "./models.js";
import { VERSION_RETENTION } from "./retention.js";
import { SYNC_METADATA_MAX_ANCESTOR_HOPS, validSyncMetadataIds, type ScopedSyncMetadata, type ScopedSyncMetadataRequest } from "./sync-metadata.js";
import { uploadIntentHash, uploadPublicationIntentSchema, uploadPublicationReceiptSchema, type UploadPublicationIntent } from "./upload-publication.js";
import type { UploadPublicationAuthorization } from "./upload-publication.js";
import type { CatalogCommitCoordinator, CatalogCommitContext, CatalogCommitSql, PreparedCatalogUpload } from "./catalog-commit.js";
import type {
  AdoptExistingFileRecord,
  CommitOverwriteRecord,
  CommitUploadRecord,
  CommitVersionRestoreRecord,
  CompleteUploadRecordResult,
  CopiedResourceRecord,
  CreateUploadRecord,
  FileRepository,
  UploadLimits,
} from "./repository.js";

interface ResourceRow {
  id: string;
  type: ResourceType;
  parent_id: string | null;
  name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: string;
  sha256: string | null;
  current_version_id: string | null;
  status: ResourceStatus;
  retention_class: RetentionClass;
  security_classification: SecurityClassification;
  trashed_from_parent_id: string | null;
  trashed_from_name: string | null;
  purge_after: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface OperationRow {
  id: string;
  operation_type: FileOperation["operationType"];
  state: string;
  idempotency_key: string;
  resource_id: string | null;
  payload: Record<string, unknown>;
  error_code: string | null;
}

interface VersionRow {
  id: string;
  resource_id: string;
  storage_path: string;
  sha256: string;
  size_bytes: string;
  mime_type: string;
  reason: FileVersion["reason"];
  state: FileVersion["state"];
  archived_at: Date | null;
  purge_after: Date | null;
  created_at: Date;
}

interface UploadRow {
  id: string;
  idempotency_key: string;
  parent_id: string;
  filename: string;
  temp_path: string;
  target_path: string;
  expected_size: string;
  received_size: string;
  expected_sha256: string | null;
  actual_sha256: string | null;
  status: UploadStatus;
  resource_id: string | null;
  overwrite_resource_id: string | null;
  expected_version_id: string | null;
  require_absent: boolean;
  audit_actor_type: string;
  audit_actor_id: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  upload_intent?: unknown;
  upload_intent_hash?: string | null;
  upload_receipt?: unknown;
}

function resource(row: ResourceRow): Resource {
  return {
    id: row.id,
    type: row.type,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    name: row.name,
    storagePath: row.storage_path,
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    sizeBytes: Number(row.size_bytes),
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    ...(row.current_version_id === null ? {} : { currentVersionId: row.current_version_id }),
    status: row.status,
    retentionClass: row.retention_class,
    securityClassification: row.security_classification,
    ...(row.trashed_from_parent_id === null ? {} : { trashedFromParentId: row.trashed_from_parent_id }),
    ...(row.trashed_from_name === null ? {} : { trashedFromName: row.trashed_from_name }),
    ...(row.purge_after === null ? {} : { purgeAfter: row.purge_after }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function operation(row: OperationRow): FileOperation {
  return {
    id: row.id,
    operationType: row.operation_type,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    payload: row.payload,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}

function version(row: VersionRow): FileVersion {
  return {
    id: row.id,
    resourceId: row.resource_id,
    storagePath: row.storage_path,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    reason: row.reason,
    state: row.state,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    ...(row.purge_after === null ? {} : { purgeAfter: row.purge_after }),
    createdAt: row.created_at,
  };
}

function upload(row: UploadRow): UploadSession {
  const intent = row.upload_intent == null ? undefined : uploadPublicationIntentSchema.parse(row.upload_intent);
  const receipt = row.upload_receipt == null ? undefined : uploadPublicationReceiptSchema.parse(row.upload_receipt);
  if (intent !== undefined && (row.upload_intent_hash !== uploadIntentHash(intent)
    || intent.idempotencyKey !== row.idempotency_key || intent.parentId !== row.parent_id || intent.name !== row.filename
    || intent.sizeBytes !== row.expected_size || intent.sha256 !== row.expected_sha256
    || intent.deviceId !== row.audit_actor_id || row.audit_actor_type !== "device_token"
    || intent.targetId !== row.overwrite_resource_id || intent.expectedVersionId !== row.expected_version_id || intent.requireAbsent !== row.require_absent
    || (receipt !== undefined && (receipt.uploadId !== row.id || receipt.intentHash !== row.upload_intent_hash || receipt.rootId !== intent.rootId
      || receipt.parentId !== intent.parentId || receipt.name !== intent.name || receipt.sha256 !== intent.sha256 || receipt.sizeBytes !== intent.sizeBytes
      || receipt.resourceId !== row.resource_id || row.status !== "active" || row.actual_sha256 !== receipt.sha256)))) {
    throw new Error("Stored upload publication identity is inconsistent");
  }
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    parentId: row.parent_id,
    filename: row.filename,
    tempPath: row.temp_path,
    targetPath: row.target_path,
    expectedSize: Number(row.expected_size),
    receivedSize: Number(row.received_size),
    ...(row.expected_sha256 === null ? {} : { expectedSha256: row.expected_sha256 }),
    ...(row.actual_sha256 === null ? {} : { actualSha256: row.actual_sha256 }),
    status: row.status,
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    ...(row.overwrite_resource_id === null ? {} : { overwriteResourceId: row.overwrite_resource_id }),
    ...(row.expected_version_id === null ? {} : { expectedVersionId: row.expected_version_id }),
    requireAbsent: row.require_absent,
    auditActorType: row.audit_actor_type,
    auditActorId: row.audit_actor_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(intent === undefined ? {} : { publicationIntent: intent, intentHash: uploadIntentHash(intent) }),
    ...(receipt === undefined ? {} : { publicationReceipt: receipt }),
  };
}

export class PostgresFileRepository implements FileRepository {
  readonly #database: Database;
  readonly #catalogCommit: CatalogCommitCoordinator | undefined;

  constructor(database: Database, options: { readonly catalogCommitCoordinator?: CatalogCommitCoordinator } = {}) {
    this.#database = database;
    this.#catalogCommit = options.catalogCommitCoordinator;
  }

  #resourceQuery(sql: CatalogCommitSql, id: string): Promise<Resource | undefined> {
    return Promise.resolve(sql<ResourceRow[]>`
      SELECT * FROM resources WHERE id = ${id} LIMIT 1
    `).then((rows) => rows[0] === undefined ? undefined : resource(rows[0]));
  }

  #uploadQuery(sql: CatalogCommitSql, id: string): Promise<UploadSession | undefined> {
    return Promise.resolve(sql<UploadRow[]>`
      SELECT u.*,j.upload_intent,j.upload_intent_hash,j.upload_receipt FROM upload_sessions u
      LEFT JOIN operation_journal j ON j.id=u.id AND j.upload_id=u.id WHERE u.id = ${id} LIMIT 1
    `).then((rows) => rows[0] === undefined ? undefined : upload(rows[0]));
  }

  getResourceAtPath(storagePath: string): Promise<Resource | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ResourceRow[]>`SELECT * FROM resources WHERE storage_path = ${storagePath} LIMIT 1`;
      return rows[0] === undefined ? undefined : resource(rows[0]);
    });
  }

  getResource(id: string): Promise<Resource | undefined> {
    return this.#database.withSql((sql) => this.#resourceQuery(sql, id));
  }

  readScopedSyncMetadata(request: ScopedSyncMetadataRequest): Promise<ScopedSyncMetadata> {
    if (!validSyncMetadataIds(request.nodeIds) || !validSyncMetadataIds([request.rootId, request.rootParentId])) {
      throw new Error("Sync metadata IDs are invalid");
    }
    return this.#database.withSql(async sql => {
      // One MVCC statement proves every active folder ancestor. Inaccessible
      // origins simply have no root witness. No storage/ACL/backend reads.
      const rows = await sql<{
        id: string; parent_id: string | null; name: string | null; type: "file" | "folder";
        size_bytes: string; sha256: string | null; updated_at: Date;
      }[]>`
        WITH RECURSIVE allowed_root AS (
          SELECT id FROM resources WHERE id = ${request.rootId}::uuid
            AND parent_id = ${request.rootParentId}::uuid AND type = 'folder' AND status = 'active'
        ), requested AS (
          SELECT DISTINCT unnest(${sql.array([...new Set(request.nodeIds)], 2950)}::uuid[]) AS id
          UNION SELECT id FROM allowed_root
        ), ancestry(origin_id, id, parent_id, depth, visited) AS (
          SELECT r.id, r.id, r.parent_id, 0, ARRAY[r.id]
          FROM requested i JOIN resources r ON r.id = i.id
          WHERE r.status = 'active' AND EXISTS (SELECT 1 FROM allowed_root)
          UNION ALL
          SELECT a.origin_id, p.id, p.parent_id, a.depth + 1, a.visited || p.id
          FROM ancestry a
          JOIN LATERAL (
            SELECT id, parent_id FROM resources WHERE id = a.parent_id
              AND status = 'active' AND type = 'folder' LIMIT 1
          ) p ON true
          WHERE a.id <> ${request.rootId}::uuid AND a.depth < ${SYNC_METADATA_MAX_ANCESTOR_HOPS}
            AND NOT p.id = ANY(a.visited)
        ), scoped AS (
          SELECT DISTINCT origin_id FROM ancestry WHERE id = ${request.rootId}::uuid
        )
        SELECT r.id, CASE WHEN r.id = ${request.rootId}::uuid THEN NULL ELSE r.parent_id END AS parent_id,
          CASE WHEN octet_length(r.name) <= 1020 THEN r.name ELSE NULL END AS name,
          r.type, r.size_bytes::text, r.sha256, r.updated_at
        FROM scoped s JOIN resources r ON r.id = s.origin_id
      `;
      // Corrupt/unsupported oversized names must fail the whole read, never
      // masquerade as absence or allocate an unbounded metadata response.
      if (rows.some(row => row.name === null)) throw new Error("limit");
      return {
        rootActive: rows.some(row => row.id === request.rootId.toLowerCase()),
        nodes: rows.map(row => ({ nodeId: row.id, parentId: row.parent_id, name: row.name as string, type: row.type,
          sizeBytes: row.size_bytes, sha256: row.type === "file" ? row.sha256 : null,
          legacyETag: row.type === "file" && row.sha256 !== null
            ? `"sha256-${row.sha256}"` : `"resource-${row.id}-${String(row.updated_at.getTime())}"`,
        })),
      };
    });
  }

  getChild(parentId: string, name: string): Promise<Resource | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ResourceRow[]>`
        SELECT * FROM resources
        WHERE parent_id = ${parentId} AND lower(name) = lower(${name}) AND status = 'active'
        LIMIT 1
      `;
      return rows[0] === undefined ? undefined : resource(rows[0]);
    });
  }

  listChildren(parentId: string, offset: number, limit: number): Promise<readonly Resource[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ResourceRow[]>`
        SELECT * FROM resources
        WHERE parent_id = ${parentId} AND status = 'active'
        ORDER BY type DESC, lower(name), id
        OFFSET ${offset} LIMIT ${limit}
      `;
      return rows.map(resource);
    });
  }

  listTrash(offset: number, limit: number): Promise<readonly Resource[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ResourceRow[]>`
        SELECT * FROM resources
        WHERE status = 'trashed' AND trashed_from_parent_id IS NOT NULL
        ORDER BY updated_at DESC, id
        OFFSET ${offset} LIMIT ${limit}
      `;
      return rows.map(resource);
    });
  }

  getTrashRetentionDays(): Promise<number> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ trash_retention_days: number }[]>`
        SELECT trash_retention_days FROM owner_preferences WHERE owner_id = 'owner'
      `;
      const days = rows[0]?.trash_retention_days;
      if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("Trash retention setting is invalid");
      return days;
    });
  }

  getUploadLimits(): Promise<UploadLimits | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<{ upload_buffer_gib: number; maximum_upload_file_gib: number }[]>`
        SELECT upload_buffer_gib, maximum_upload_file_gib FROM owner_preferences WHERE owner_id = 'owner'
      `;
      const row = rows[0];
      if (row === undefined) return undefined;
      if (!Number.isSafeInteger(row.upload_buffer_gib) || row.upload_buffer_gib < 1
        || !Number.isSafeInteger(row.maximum_upload_file_gib) || row.maximum_upload_file_gib < 1) {
        throw new Error("Upload limit settings are invalid");
      }
      return {
        bufferMaxBytes: row.upload_buffer_gib * 1024 ** 3,
        maximumFileBytes: row.maximum_upload_file_gib * 1024 ** 3,
      };
    });
  }

  listTree(storagePath: string): Promise<readonly Resource[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ResourceRow[]>`
        SELECT * FROM resources
        WHERE storage_path = ${storagePath} OR starts_with(storage_path, ${`${storagePath}/`})
        ORDER BY length(storage_path), storage_path
      `;
      return rows.map(resource);
    });
  }

  hasCommittingTarget(parentId: string, filename: string, exceptUploadId: string): Promise<boolean> {
    return this.#database.withSql(async sql => (await sql<{ pending: boolean }[]>`SELECT EXISTS(SELECT 1 FROM upload_sessions WHERE parent_id=${parentId} AND lower(filename)=lower(${filename}) AND status='committing' AND id<>${exceptUploadId}) AS pending`)[0]?.pending ?? false);
  }

  hasCommittingTree(storagePath: string): Promise<boolean> {
    return this.#database.withSql(async sql => (await sql<{ pending: boolean }[]>`SELECT EXISTS(SELECT 1 FROM upload_sessions WHERE status='committing' AND (target_path=${storagePath} OR starts_with(target_path, ${`${storagePath}/`}))) AS pending`)[0]?.pending ?? false);
  }

  createFolder(record: { readonly id: string; readonly parentId: string; readonly name: string; readonly storagePath: string }): Promise<Resource> {
    return this.#accountingTransaction(async (sql) => {
      await assertBrowserNamespaceCatalogPermit(sql);
      const rows = await sql<ResourceRow[]>`
        INSERT INTO resources (id, type, parent_id, name, storage_path, status)
        VALUES (${record.id}, 'folder', ${record.parentId}, ${record.name}, ${record.storagePath}, 'active')
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Folder insert returned no row");
      await this.#adjustAncestorSizes(sql, record.parentId, 0);
      return resource(row);
    });
  }

  setSecurityClassification(id: string, classification: SecurityClassification): Promise<Resource> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ResourceRow[]>`
        UPDATE resources SET security_classification = ${classification}, updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Resource not found");
      return resource(row);
    });
  }

  getUpload(id: string): Promise<UploadSession | undefined> {
    return this.#database.withSql((sql) => this.#uploadQuery(sql, id));
  }

  getUploadByIdempotencyKey(key: string): Promise<UploadSession | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<UploadRow[]>`SELECT u.*,j.upload_intent,j.upload_intent_hash,j.upload_receipt FROM upload_sessions u
        LEFT JOIN operation_journal j ON j.id=u.id AND j.upload_id=u.id WHERE u.idempotency_key = ${key} LIMIT 1`;
      return rows[0] === undefined ? undefined : upload(rows[0]);
    });
  }

  listAbandonedUploadsForCleanup(limit: number): Promise<readonly UploadSession[]> {
    return this.#database.withSql(async sql => (await sql<UploadRow[]>`
      SELECT u.* FROM upload_sessions u WHERE ((u.status='abandoned'
        AND EXISTS(SELECT 1 FROM operation_journal j WHERE j.upload_id=u.id AND j.error_code='cleanup_pending'))
        OR ((u.status='failed_final' OR (u.status='failed_retryable' AND u.received_size=0)) AND u.audit_actor_type='device_token'
          AND u.idempotency_key LIKE 'dav-upload-%' AND u.updated_at < now()-interval '2 minutes'
          AND NOT EXISTS(SELECT 1 FROM operation_journal j WHERE j.upload_id=u.id AND j.error_code IN ('verification_interrupted','reconciliation_required')))
        OR (u.status IN ('created','uploading','failed_retryable','failed_final') AND u.expires_at <= now()
          AND NOT EXISTS(SELECT 1 FROM drop_uploads d WHERE u.audit_actor_type='drop_worker' AND u.parent_id='00000000-0000-7000-8000-000000000002' AND d.local_path IS NOT NULL AND d.received_size=d.expected_size
            AND d.state IN ('buffered','transferring','verifying') AND (d.upload_id=u.id OR u.idempotency_key='drop-drain:'||d.id::text))
          AND NOT EXISTS(SELECT 1 FROM operation_journal j WHERE j.upload_id=u.id AND j.error_code IN ('verification_interrupted','reconciliation_required'))))
        -- Catalog uploads retain their own fixed lifecycle and recovery authority.
        -- Ignore the field on schemas before 0054, without treating a stored JSON null as SQL NULL.
        AND NOT EXISTS(SELECT 1 FROM operation_journal j WHERE j.upload_id=u.id
          AND j IS DISTINCT FROM jsonb_populate_record(j, '{"upload_execution":null}'::jsonb))
        AND NOT EXISTS(SELECT 1 FROM operation_locks l WHERE l.lock_key='upload:'||u.id::text AND l.expires_at>now())
      ORDER BY u.updated_at LIMIT ${limit}
    `).map(upload));
  }

  hasUploadRecoveryJournal(id: string): Promise<boolean> {
    return this.#database.withSql(async sql => (await sql`
      SELECT 1 FROM operation_journal WHERE upload_id=${id}
        AND error_code IN ('verification_interrupted','reconciliation_required') LIMIT 1
    `).length > 0);
  }

  isBufferedDeliveryUpload(id: string): Promise<boolean> {
    return this.#database.withSql(async sql => (await sql<{pending:boolean}[]>`
      SELECT EXISTS(SELECT 1 FROM upload_sessions u JOIN drop_uploads d
        ON d.upload_id=u.id OR u.idempotency_key='drop-drain:'||d.id::text
        WHERE u.id=${id} AND u.audit_actor_type='drop_worker' AND u.parent_id='00000000-0000-7000-8000-000000000002' AND d.local_path IS NOT NULL AND d.received_size=d.expected_size
        AND d.state IN ('buffered','transferring','verifying')) AS pending
    `)[0]?.pending ?? false);
  }

  listRecoverableUploads(limit: number): Promise<readonly UploadSession[]> {
    return this.#database.withSql(async sql => (await sql<UploadRow[]>`
      SELECT u.* FROM upload_sessions u WHERE u.updated_at < now()-interval '2 minutes'
        AND (u.status IN ('committing','verifying') OR (u.status='failed_retryable' AND EXISTS(SELECT 1 FROM operation_journal j WHERE j.upload_id=u.id AND j.error_code='verification_interrupted')))
        AND NOT EXISTS(SELECT 1 FROM operation_journal j WHERE j.upload_id=u.id
          AND j IS DISTINCT FROM jsonb_populate_record(j, '{"upload_execution":null}'::jsonb))
        AND u.received_size=u.expected_size ORDER BY u.updated_at LIMIT ${limit}
    `).map(upload));
  }

  createUpload(record: CreateUploadRecord): Promise<UploadSession> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<UploadRow[]>`
        INSERT INTO upload_sessions (
          id, idempotency_key, parent_id, filename, temp_path, target_path,
          expected_size, expected_sha256, status, expires_at, overwrite_resource_id,
          audit_actor_type, audit_actor_id, expected_version_id, require_absent
        ) VALUES (
          ${record.id}, ${record.idempotencyKey}, ${record.parentId}, ${record.filename},
          ${record.tempPath}, ${record.targetPath}, ${record.expectedSize},
          ${record.expectedSha256 ?? null}, 'created', ${record.expiresAt}, ${record.overwriteResourceId ?? null},
          ${record.auditActorType ?? "owner_bootstrap"}, ${record.auditActorId ?? "owner"}, ${record.expectedVersionId ?? null}, ${record.requireAbsent ?? false}
        ) RETURNING *
      `;
      await sql`
        INSERT INTO operation_journal (id, operation_type, state, idempotency_key, upload_id, payload,upload_intent,upload_intent_hash)
        VALUES (${record.id}, 'upload', 'created', ${`upload:${record.idempotencyKey}`}, ${record.id},
          ${sql.json({ tempPath: record.tempPath, targetPath: record.targetPath })},
          ${record.publicationIntent === undefined ? null : sql.json({...record.publicationIntent})},
          ${record.publicationIntent === undefined ? null : uploadIntentHash(record.publicationIntent)})
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Upload insert returned no row");
      const created = await this.#uploadQuery(sql,record.id);
      if(created === undefined)throw new Error("Upload creation did not return state");
      return created;
    }).catch(async (error:unknown) => {
      if(typeof error !== "object" || error === null || !("code" in error) || error.code !== "23505")throw error;
      const existing = await this.getUploadByIdempotencyKey(record.idempotencyKey);
      if(existing === undefined || existing.parentId !== record.parentId || existing.filename !== record.filename
        || existing.expectedSize !== record.expectedSize || existing.expectedSha256 !== record.expectedSha256
        || (existing.overwriteResourceId ?? null) !== (record.overwriteResourceId ?? null)
        || (existing.expectedVersionId ?? null) !== (record.expectedVersionId ?? null)
        || (existing.requireAbsent ?? false) !== (record.requireAbsent ?? false)
        || existing.auditActorType !== (record.auditActorType ?? "owner_bootstrap") || existing.auditActorId !== (record.auditActorId ?? "owner")
        || (record.publicationIntent === undefined ? existing.publicationIntent !== undefined : existing.intentHash !== uploadIntentHash(record.publicationIntent))) {
        throw new Error("Idempotency key was already used for different upload publication intent",{cause:error});
      }
      return existing;
    });
  }

  updateUploadProgress(id: string, expectedOffset: number, newOffset: number): Promise<UploadSession> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE upload_sessions
        SET received_size = ${newOffset}, status = 'uploading', updated_at = now()
        WHERE id = ${id} AND received_size = ${expectedOffset}
          AND status IN ('created', 'uploading', 'failed_retryable')
        RETURNING *
      `;
      if (rows[0] === undefined) throw new Error("Upload offset changed concurrently");
      await sql`UPDATE operation_journal SET state = 'uploading', updated_at = now() WHERE upload_id = ${id}`;
      return upload(rows[0]);
    });
  }

  setUploadState(id: string, state: UploadStatus, fields: { readonly actualSha256?: string; readonly errorCode?: string } = {}): Promise<UploadSession> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<UploadRow[]>`
        UPDATE upload_sessions
        SET status = ${state}, actual_sha256 = COALESCE(${fields.actualSha256 ?? null}, actual_sha256), updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      if (rows[0] === undefined) throw new Error("Upload session not found");
      await sql`
        UPDATE operation_journal
        SET state = ${state}, error_code = ${fields.errorCode ?? null}, updated_at = now()
        WHERE upload_id = ${id}
      `;
      return upload(rows[0]);
    });
  }

  retargetUpload(id: string, targetPath: string): Promise<UploadSession> {
    return this.#database.transaction(async sql => {
      const rows = await sql<UploadRow[]>`UPDATE upload_sessions SET target_path = ${targetPath}, updated_at = now()
        WHERE id = ${id} AND status IN ('created', 'uploading', 'verifying', 'failed_retryable') RETURNING *`;
      if (rows[0] === undefined) throw new Error("Upload destination cannot change during commit");
      await sql`UPDATE operation_journal SET payload = payload || ${sql.json({ targetPath })}, updated_at = now() WHERE upload_id = ${id}`;
      return upload(rows[0]);
    });
  }

  async prepareUploadCatalog(id: string, backendIdentity: string | undefined, authorization?: UploadPublicationAuthorization): Promise<PreparedCatalogUpload | undefined> {
    if (this.#catalogCommit !== undefined) return this.#catalogCommit.prepareUpload(id,backendIdentity ?? "",authorization);
    // An old/unqualified composition must not silently publish a previously
    // bound operation. Reject before verification/final backend publication.
    const bound = await this.#database.withSql(sql => sql`SELECT id FROM operation_journal WHERE id=${id} AND sync_root_id IS NOT NULL`);
    if (bound.length !== 0) throw new Error("Bound upload requires its catalog commit coordinator");
    return undefined;
  }

  async #lockUploadPublication(sql: CatalogCommitSql, record: CommitUploadRecord, qualified = false): Promise<{intent?:UploadPublicationIntent;replay?:CompleteUploadRecordResult}> {
    const candidate=await this.#uploadQuery(sql,record.uploadId);
    if (!qualified) {
      const bound = await sql`SELECT id FROM operation_journal WHERE id=${record.uploadId} AND sync_root_id IS NOT NULL`;
      if (bound.length !== 0 || (candidate?.publicationIntent !== undefined && this.#catalogCommit?.isRootAdmitted(candidate.publicationIntent.rootId))) throw new Error("Bound upload requires prepared catalog evidence");
    }
    if(candidate?.publicationIntent !== undefined && !qualified)await sql.unsafe("SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='10s'");
    await sql`SELECT id FROM upload_sessions WHERE id=${record.uploadId} FOR UPDATE`;
    await sql`SELECT id FROM operation_journal WHERE id=${record.uploadId} AND upload_id=${record.uploadId} FOR UPDATE`;
    const selected = await this.#uploadQuery(sql,record.uploadId);
    if(selected === undefined)throw new Error("Upload session not found");
    const intent = selected.publicationIntent;
    if(intent !== undefined && (intent.parentId !== record.parentId || intent.name !== record.filename
      || intent.sizeBytes !== String(record.sizeBytes) || intent.sha256 !== record.sha256
      || (intent.targetId !== null && intent.targetId !== record.resourceId))) {
      throw new Error("Upload commit differs from sealed publication intent");
    }
    if(selected.status === "active" && selected.resourceId !== undefined) {
      const current = await this.#resourceQuery(sql,selected.resourceId);
      if(current === undefined)throw new Error("Published upload resource is unavailable");
      return {replay:{upload:selected,resource:current,
        ...(selected.publicationReceipt === undefined ? {} : {publicationReceipt:selected.publicationReceipt})}};
    }
    if(intent !== undefined) {
      // Lock only SQL identity rows during the metadata commit. Credential
      // rotation is checked for HTTP calls; workers have no persisted token.
      const credential=record.publicationAuthorization;
      if(credential !== undefined && (credential.deviceId !== intent.deviceId || credential.rootId !== intent.rootId)) {
        throw new Error("Upload publication authorization changed");
      }
      await sql`SELECT id FROM devices WHERE id=${intent.deviceId} FOR SHARE`;
      const chain=await sql<{id:string}[]>`WITH RECURSIVE ancestors AS (
        SELECT id,parent_id,ARRAY[id] AS visited,0 AS hops FROM resources WHERE id=${intent.parentId}
        UNION ALL SELECT r.id,r.parent_id,a.visited||r.id,a.hops+1 FROM resources r JOIN ancestors a ON r.id=a.parent_id
          WHERE a.id<>${intent.rootId} AND a.hops<128 AND NOT r.id=ANY(a.visited)
      ) SELECT id FROM ancestors ORDER BY id`;
      const ids=chain.map(row=>row.id);
      // Size accounting writes these folders later in this same transaction.
      // Taking SHARE then upgrading would deadlock two independent parents.
      // Acquire the write-compatible mode in a fixed UUID order immediately;
      // it serializes only the short SQL commit, never the backend verification.
      await sql`SELECT id FROM resources WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
      // A row may have changed while lock acquisition waited. Rewalk and require
      // the exact locked chain, all active folders and a real assigned root.
      const authorized = await sql<{allowed:boolean}[]>`WITH RECURSIVE ancestors AS (
        SELECT id,parent_id,type,status,ARRAY[id] AS visited,0 AS hops FROM resources WHERE id=${intent.parentId}
        UNION ALL SELECT r.id,r.parent_id,r.type,r.status,a.visited||r.id,a.hops+1 FROM resources r JOIN ancestors a ON r.id=a.parent_id
          WHERE a.id<>${intent.rootId} AND a.hops<128 AND NOT r.id=ANY(a.visited)
      ) SELECT EXISTS(SELECT 1 FROM devices d JOIN resources r ON r.id=d.sync_root_id
        WHERE d.id=${intent.deviceId} AND d.state='active' AND d.device_kind='windows_sync' AND d.can_write
          AND d.sync_root_id=${intent.rootId} AND d.scope_ids=ARRAY[${intent.rootId}::uuid]
          AND (${credential?.tokenHash ?? null}::text IS NULL OR d.token_hash=${credential?.tokenHash ?? null})
          AND (d.expires_at IS NULL OR d.expires_at>now()) AND r.type='folder' AND r.status='active'
          AND r.parent_id=${"00000000-0000-7000-8000-000000000004"})
        AND (SELECT array_agg(id ORDER BY id) FROM ancestors)=${ids}::uuid[]
        AND EXISTS(SELECT 1 FROM ancestors WHERE id=${intent.rootId})
        AND NOT EXISTS(SELECT 1 FROM ancestors WHERE status<>'active' OR type<>'folder') AS allowed`;
      if(!authorized[0]?.allowed)throw new Error("Upload publication authorization changed");
      if(intent.targetId !== null) {
        const target = await sql<{current_version_id:string;parent_id:string;name:string;status:string}[]>`
          SELECT current_version_id,parent_id,name,status FROM resources WHERE id=${intent.targetId} FOR NO KEY UPDATE`;
        const previous=target[0];
        if(previous === undefined || previous.current_version_id !== intent.expectedVersionId || previous.parent_id !== intent.parentId
          || previous.name !== intent.name || previous.status !== "active")throw new Error("Upload publication precondition changed");
      }
    }
    return intent === undefined ? {} : {intent};
  }

  async #recordUploadPublication(sql: CatalogCommitSql, record: CommitUploadRecord, intent: UploadPublicationIntent|undefined): Promise<void> {
    if(intent === undefined)return;
    const version = (await sql<{created_at:Date}[]>`SELECT created_at FROM file_versions WHERE id=${record.versionId} AND resource_id=${record.resourceId}`)[0];
    if(version === undefined)throw new Error("Published upload version is unavailable");
    const receipt = uploadPublicationReceiptSchema.parse({schema:"saturn.upload-publication.v1",uploadId:record.uploadId,
      operationId:record.uploadId,intentHash:uploadIntentHash(intent),rootId:intent.rootId,resourceId:record.resourceId,
      versionId:record.versionId,parentId:record.parentId,name:record.filename,sizeBytes:String(record.sizeBytes),sha256:record.sha256,
      etag:`"sha256-${record.sha256}"`,publishedAt:version.created_at.toISOString()});
    const rows = await sql`UPDATE operation_journal SET upload_receipt=${sql.json({...receipt})},upload_published_version_id=${record.versionId}
      WHERE id=${record.uploadId} AND upload_intent_hash=${receipt.intentHash} AND upload_receipt IS NULL RETURNING id`;
    if(rows.length !== 1)throw new Error("Upload receipt could not be atomically published");
  }

  commitUpload(record: CommitUploadRecord): Promise<CompleteUploadRecordResult> {
    record = structuredClone(record);
    if (record.catalogEvidence !== undefined) {
      if (this.#catalogCommit === undefined) throw new Error("Catalog upload coordinator is unavailable");
      return this.#catalogCommit.commitUpload(record,(sql,context) => this.#commitUpload(sql,record,context));
    }
    return this.#accountingTransaction(sql => this.#commitUpload(sql,record));
  }

  async #commitUpload(sql: CatalogCommitSql, record: CommitUploadRecord, context?: CatalogCommitContext): Promise<CompleteUploadRecordResult> {
      const publication = await this.#lockUploadPublication(sql,record,context !== undefined);
      if(publication.replay !== undefined)return publication.replay;
      await sql`
        INSERT INTO resources (
          id, type, parent_id, name, storage_path, mime_type, size_bytes, sha256, status
        ) VALUES (
          ${record.resourceId}, 'file', ${record.parentId}, ${record.filename}, ${record.storagePath},
          ${record.mimeType}, ${record.sizeBytes}, ${record.sha256}, 'active'
        )
      `;
      await sql`
        INSERT INTO file_versions (id, resource_id, storage_path, sha256, size_bytes, mime_type, reason)
        VALUES (${record.versionId}, ${record.resourceId}, ${record.storagePath}, ${record.sha256},
          ${record.sizeBytes}, ${record.mimeType}, 'initial')
      `;
      await sql`UPDATE resources SET current_version_id = ${record.versionId}, updated_at = now() WHERE id = ${record.resourceId}`;
      await this.#adjustAncestorSizes(sql, record.parentId, record.sizeBytes,context?.accountingAncestorIds);
      const uploadRows = await sql<UploadRow[]>`
        UPDATE upload_sessions
        SET status = 'active', resource_id = ${record.resourceId}, actual_sha256 = ${record.sha256}, updated_at = now()
        WHERE id = ${record.uploadId}
        RETURNING *
      `;
      await sql`
        UPDATE operation_journal
        SET state = 'active', resource_id = ${record.resourceId}, updated_at = now()
        WHERE upload_id = ${record.uploadId}
      `;
      const committedResource = await this.#resourceQuery(sql, record.resourceId);
      if (uploadRows[0] === undefined || committedResource === undefined) throw new Error("Upload commit did not return state");
      await this.#recordUploadPublication(sql,record,publication.intent);
      const completedUpload = await this.#uploadQuery(sql,record.uploadId);
      if(completedUpload === undefined)throw new Error("Upload publication did not return state");
      return { upload: completedUpload, resource: committedResource,
        ...(completedUpload.publicationReceipt === undefined ? {} : {publicationReceipt:completedUpload.publicationReceipt}) };
  }

  adoptExistingFile(record: AdoptExistingFileRecord): Promise<Resource> {
    return this.#accountingTransaction(async (sql) => {
      const existingRows = await sql<ResourceRow[]>`SELECT * FROM resources WHERE storage_path = ${record.storagePath} LIMIT 1 FOR UPDATE`;
      const existing = existingRows[0];
      if (existing !== undefined) {
        if (existing.type !== "file" || existing.status !== "active" || Number(existing.size_bytes) !== record.sizeBytes
          || existing.sha256 !== record.sha256 || existing.parent_id !== record.parentId) {
          throw new Error("Existing catalog resource differs from the backup artifact");
        }
        return resource(existing);
      }
      await sql`
        INSERT INTO resources (
          id, type, parent_id, name, storage_path, mime_type, size_bytes, sha256, status
        ) VALUES (
          ${record.resourceId}, 'file', ${record.parentId}, ${record.filename}, ${record.storagePath},
          ${record.mimeType}, ${record.sizeBytes}, ${record.sha256}, 'active'
        )
      `;
      await sql`
        INSERT INTO file_versions (id, resource_id, storage_path, sha256, size_bytes, mime_type, reason)
        VALUES (${record.versionId}, ${record.resourceId}, ${record.storagePath}, ${record.sha256},
          ${record.sizeBytes}, ${record.mimeType}, 'initial')
      `;
      await sql`UPDATE resources SET current_version_id = ${record.versionId}, updated_at = now() WHERE id = ${record.resourceId}`;
      await this.#adjustAncestorSizes(sql, record.parentId, record.sizeBytes);
      const committed = await this.#resourceQuery(sql, record.resourceId);
      if (committed === undefined) throw new Error("Adopted backup resource was not found after commit");
      return committed;
    });
  }

  removeAdoptedFile(storagePath: string, expectedSha256: string): Promise<Resource | undefined> {
    return this.#accountingTransaction(async (sql) => {
      const rows = await sql<ResourceRow[]>`SELECT * FROM resources WHERE storage_path = ${storagePath} LIMIT 1 FOR UPDATE`;
      const selected = rows[0];
      if (selected === undefined) return undefined;
      if (selected.status === "purged" && selected.type === "file" && selected.sha256 === expectedSha256) return undefined;
      if (selected.type !== "file" || selected.status !== "active" || selected.sha256 !== expectedSha256 || selected.parent_id === null) {
        throw new Error("Catalog resource is not the expected backup artifact");
      }
      // Audit events and other historical records retain foreign keys to this
      // artifact. Preserve its identity after retention removes the bytes.
      await sql`UPDATE file_versions SET state = 'expired' WHERE resource_id = ${selected.id}`;
      await sql`UPDATE resources SET status = 'purged', purge_after = NULL, updated_at = now() WHERE id = ${selected.id}`;
      await this.#adjustAncestorSizes(sql, selected.parent_id, -Number(selected.size_bytes));
      return resource(selected);
    });
  }

  commitOverwrite(record: CommitOverwriteRecord): Promise<CompleteUploadRecordResult> {
    record = structuredClone(record);
    if (record.catalogEvidence !== undefined) {
      if (this.#catalogCommit === undefined) throw new Error("Catalog upload coordinator is unavailable");
      return this.#catalogCommit.commitUpload(record,(sql,context) => this.#commitOverwrite(sql,record,context));
    }
    return this.#accountingTransaction(sql => this.#commitOverwrite(sql,record));
  }

  async #commitOverwrite(sql: CatalogCommitSql, record: CommitOverwriteRecord, context?: CatalogCommitContext): Promise<CompleteUploadRecordResult> {
      const publication = await this.#lockUploadPublication(sql,record,context !== undefined);
      if(publication.replay !== undefined)return publication.replay;
      const existing = await this.#resourceQuery(sql, record.resourceId);
      if (existing === undefined || existing.parentId === undefined || existing.type !== "file") throw new Error("Overwrite resource was not found");
      await this.#archivePreviousVersion(sql, record, existing.retentionClass ?? "general");
      await sql`
        INSERT INTO file_versions (id, resource_id, storage_path, sha256, size_bytes, mime_type, reason)
        VALUES (${record.versionId}, ${record.resourceId}, ${record.storagePath}, ${record.sha256},
          ${record.sizeBytes}, ${record.mimeType}, 'overwrite')
      `;
      const resourceRows = await sql<ResourceRow[]>`
        UPDATE resources SET mime_type = ${record.mimeType}, size_bytes = ${record.sizeBytes},
          sha256 = ${record.sha256}, current_version_id = ${record.versionId}, status = 'active', updated_at = now()
        WHERE id = ${record.resourceId} AND type = 'file'
        RETURNING *
      `;
      const uploadRows = await sql<UploadRow[]>`
        UPDATE upload_sessions
        SET status = 'active', resource_id = ${record.resourceId}, actual_sha256 = ${record.sha256}, updated_at = now()
        WHERE id = ${record.uploadId}
        RETURNING *
      `;
      await sql`
        UPDATE operation_journal
        SET state = 'active', resource_id = ${record.resourceId}, updated_at = now()
        WHERE upload_id = ${record.uploadId}
      `;
      const resourceRow = resourceRows[0];
      const uploadRow = uploadRows[0];
      if (resourceRow === undefined || uploadRow === undefined) throw new Error("Overwrite commit did not return state");
      await this.#adjustAncestorSizes(sql, existing.parentId, record.sizeBytes - existing.sizeBytes,context?.accountingAncestorIds);
      await this.#recordUploadPublication(sql,record,publication.intent);
      const completedUpload = await this.#uploadQuery(sql,record.uploadId);
      if(completedUpload === undefined)throw new Error("Upload publication did not return state");
      return { resource: resource(resourceRow), upload: completedUpload,
        ...(completedUpload.publicationReceipt === undefined ? {} : {publicationReceipt:completedUpload.publicationReceipt}) };
  }

  getVersion(resourceId: string, versionId: string): Promise<FileVersion | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<VersionRow[]>`
        SELECT * FROM file_versions WHERE id = ${versionId} AND resource_id = ${resourceId} LIMIT 1
      `;
      return rows[0] === undefined ? undefined : version(rows[0]);
    });
  }

  listVersions(resourceId: string, offset: number, limit: number): Promise<readonly FileVersion[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<VersionRow[]>`
        SELECT * FROM file_versions WHERE resource_id = ${resourceId}
        ORDER BY created_at DESC, id DESC OFFSET ${offset} LIMIT ${limit}
      `;
      return rows.map(version);
    });
  }

  getOperation(idempotencyKey: string): Promise<FileOperation | undefined> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<OperationRow[]>`
        SELECT * FROM operation_journal WHERE idempotency_key = ${idempotencyKey} LIMIT 1
      `;
      return rows[0] === undefined ? undefined : operation(rows[0]);
    });
  }

  expireVersion(resourceId: string, selected: Pick<FileVersion, "id" | "storagePath" | "sizeBytes" | "sha256">): Promise<boolean> {
    return this.#database.transaction(async sql => {
      const resources = await sql<ResourceRow[]>`SELECT * FROM resources WHERE id=${resourceId} FOR UPDATE`;
      const current = resources[0];
      if (current === undefined || current.type !== "file" || current.status !== "active"
        || current.current_version_id === selected.id || !VERSION_RETENTION[current.retention_class].automaticPurge) return false;
      // The pin trigger takes FOR SHARE on this same row. Check pins in a new
      // statement after obtaining the lock, including any pin that just committed.
      const rows = await sql<VersionRow[]>`SELECT * FROM file_versions WHERE resource_id=${resourceId} AND id=${selected.id} FOR UPDATE`;
      const candidate = rows[0];
      if (candidate === undefined || candidate.storage_path !== selected.storagePath || candidate.sha256 !== selected.sha256
        || Number(candidate.size_bytes) !== selected.sizeBytes || !["active", "expired"].includes(candidate.state)) return false;
      const pins = await sql<{ pinned: boolean }[]>`SELECT EXISTS(SELECT 1 FROM laboratory_assets WHERE pinned_version_id=${selected.id}) AS pinned`;
      if (pins[0]?.pinned !== false) return false;
      await sql`UPDATE file_versions SET state='expired' WHERE resource_id=${resourceId} AND id=${selected.id} AND state='active'`;
      return true;
    });
  }

  createOperation(record: {
    readonly id: string;
    readonly operationType: FileOperation["operationType"];
    readonly idempotencyKey: string;
    readonly resourceId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<FileOperation> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<OperationRow[]>`
        INSERT INTO operation_journal (id, operation_type, state, idempotency_key, resource_id, payload)
        VALUES (${record.id}, ${record.operationType}, 'created', ${record.idempotencyKey},
          ${record.resourceId}, ${sql.json(record.payload as never)})
        RETURNING *
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Operation journal insert returned no row");
      return operation(row);
    });
  }

  setOperationState(id: string, state: string, fields: { readonly resourceId?: string; readonly errorCode?: string } = {}): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`
        UPDATE operation_journal
        SET state = ${state}, resource_id = COALESCE(${fields.resourceId ?? null}, resource_id),
          error_code = ${fields.errorCode ?? null}, updated_at = now()
        WHERE id = ${id}
      `;
    });
  }

  async acquireLocks(operationId: string, lockKeys: readonly string[], expiresAt: Date): Promise<boolean> {
    const uniqueKeys = [...new Set(lockKeys)].sort();
    const contention = new Error("File lease is held by another operation");
    try { return await this.#database.transaction(async (sql) => {
      await sql`DELETE FROM operation_locks WHERE expires_at <= now()`;
      for (const lockKey of uniqueKeys) {
        const rows = await sql<{ lock_key: string }[]>`
          INSERT INTO operation_locks (lock_key, operation_id, expires_at)
          VALUES (${lockKey}, ${operationId}, ${expiresAt})
          ON CONFLICT (lock_key) DO UPDATE SET expires_at=EXCLUDED.expires_at
            WHERE operation_locks.operation_id=EXCLUDED.operation_id
          RETURNING lock_key
        `;
        if (rows.length === 0) throw contention;
      }
      return true;
    }); } catch (error) { if (error === contention) return false; throw error; }
  }

  releaseLocks(operationId: string): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`DELETE FROM operation_locks WHERE operation_id = ${operationId}`;
    });
  }

  hasPendingPurge(resourceId: string): Promise<boolean> {
    return this.#database.withSql(async sql => {
      const rows = await sql<{ pending: boolean }[]>`SELECT EXISTS (SELECT 1 FROM operation_journal
        WHERE resource_id = ${resourceId} AND operation_type = 'purge' AND state = 'storage_committing'
          AND idempotency_key LIKE 'scheduled-purge:%' AND payload->>'kind' = 'trash') AS pending`;
      return rows[0]?.pending ?? false;
    });
  }

  moveTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
    readonly parentId: string;
    readonly name: string;
    readonly oldPath: string;
    readonly newPath: string;
  }): Promise<Resource> {
    return this.#accountingTransaction(async (sql) => {
      const original = await this.#resourceQuery(sql, record.resourceId);
      if (original === undefined || original.parentId === undefined) throw new Error("Moved resource was not found");
      await this.#rewriteCurrentVersionPaths(sql, record.oldPath, record.newPath);
      await this.#rewriteResourcePaths(sql, record.oldPath, record.newPath);
      const rows = await sql<ResourceRow[]>`
        UPDATE resources SET parent_id = ${record.parentId}, name = ${record.name}, updated_at = now()
        WHERE id = ${record.resourceId} RETURNING *
      `;
      if (original.parentId === record.parentId) {
        await this.#adjustAncestorSizes(sql, record.parentId, 0);
      } else {
        await this.#adjustAncestorSizes(sql, original.parentId, -original.sizeBytes);
        await this.#adjustAncestorSizes(sql, record.parentId, original.sizeBytes);
      }
      await sql`UPDATE operation_journal SET state = 'active', updated_at = now() WHERE id = ${record.operationId}`;
      const row = rows[0];
      if (row === undefined) throw new Error("Moved resource was not found");
      return resource(row);
    });
  }

  createCopiedTree(record: {
    readonly operationId: string;
    readonly rootResourceId: string;
    readonly resources: readonly CopiedResourceRecord[];
  }): Promise<Resource> {
    return this.#accountingTransaction(async (sql) => {
      for (const item of record.resources) {
        await sql`
          INSERT INTO resources (id, type, parent_id, name, storage_path, mime_type, size_bytes, sha256, status)
          VALUES (${item.id}, ${item.type}, ${item.parentId}, ${item.name}, ${item.storagePath},
            ${item.mimeType ?? null}, ${item.sizeBytes}, ${item.sha256 ?? null}, 'active')
        `;
        if (item.type === "file") {
          if (item.versionId === undefined || item.sha256 === undefined || item.mimeType === undefined) {
            throw new Error("Copied file metadata is incomplete");
          }
          await sql`
            INSERT INTO file_versions (id, resource_id, storage_path, sha256, size_bytes, mime_type, reason)
            VALUES (${item.versionId}, ${item.id}, ${item.storagePath}, ${item.sha256},
              ${item.sizeBytes}, ${item.mimeType}, 'manual')
          `;
          await sql`UPDATE resources SET current_version_id = ${item.versionId} WHERE id = ${item.id}`;
        }
      }
      const copiedRoot = record.resources.find((item) => item.id === record.rootResourceId);
      if (copiedRoot === undefined) throw new Error("Copied root metadata is missing");
      await this.#adjustAncestorSizes(sql, copiedRoot.parentId, copiedRoot.sizeBytes);
      await sql`
        UPDATE operation_journal SET state = 'active', resource_id = ${record.rootResourceId}, updated_at = now()
        WHERE id = ${record.operationId}
      `;
      const result = await this.#resourceQuery(sql, record.rootResourceId);
      if (result === undefined) throw new Error("Copied resource was not found");
      return result;
    });
  }

  trashTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
    readonly oldPath: string;
    readonly trashPath: string;
    readonly purgeAfter: Date;
  }): Promise<Resource> {
    return this.#accountingTransaction(async (sql) => {
      const original = await this.#resourceQuery(sql, record.resourceId);
      if (original === undefined || original.parentId === undefined) throw new Error("Trash resource was not found");
      await this.#rewriteCurrentVersionPaths(sql, record.oldPath, record.trashPath);
      await this.#rewriteResourcePaths(sql, record.oldPath, record.trashPath);
      await sql`
        UPDATE resources SET status = 'trashed', updated_at = now()
        WHERE storage_path = ${record.trashPath} OR starts_with(storage_path, ${`${record.trashPath}/`})
      `;
      const rows = await sql<ResourceRow[]>`
        UPDATE resources SET trashed_from_parent_id = ${original.parentId}, trashed_from_name = ${original.name},
          purge_after = ${record.purgeAfter}, updated_at = now()
        WHERE id = ${record.resourceId} RETURNING *
      `;
      await this.#adjustAncestorSizes(sql, original.parentId, -original.sizeBytes);
      await sql`UPDATE operation_journal SET state = 'active', updated_at = now() WHERE id = ${record.operationId}`;
      const row = rows[0];
      if (row === undefined) throw new Error("Trashed resource was not found");
      return resource(row);
    });
  }

  restoreTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
    readonly oldPath: string;
    readonly restoredPath: string;
    readonly parentId: string;
    readonly name: string;
  }): Promise<Resource> {
    return this.#accountingTransaction(async (sql) => {
      const original = await this.#resourceQuery(sql, record.resourceId);
      if (original === undefined) throw new Error("Restore resource was not found");
      await this.#rewriteCurrentVersionPaths(sql, record.oldPath, record.restoredPath);
      await this.#rewriteResourcePaths(sql, record.oldPath, record.restoredPath);
      await sql`
        UPDATE resources SET status = 'active', purge_after = NULL, updated_at = now()
        WHERE storage_path = ${record.restoredPath} OR starts_with(storage_path, ${`${record.restoredPath}/`})
      `;
      const rows = await sql<ResourceRow[]>`
        UPDATE resources SET parent_id = ${record.parentId}, name = ${record.name},
          trashed_from_parent_id = NULL, trashed_from_name = NULL, updated_at = now()
        WHERE id = ${record.resourceId} RETURNING *
      `;
      await this.#adjustAncestorSizes(sql, record.parentId, original.sizeBytes);
      await sql`UPDATE operation_journal SET state = 'active', updated_at = now() WHERE id = ${record.operationId}`;
      const row = rows[0];
      if (row === undefined) throw new Error("Restored resource was not found");
      return resource(row);
    });
  }

  purgeTrashTree(record: { readonly operationId: string; readonly resourceId: string }): Promise<Resource> {
    return this.#accountingTransaction(async (sql) => {
      const existing = await this.#resourceQuery(sql, record.resourceId);
      if (existing === undefined || existing.status !== "trashed" || existing.trashedFromParentId === undefined) {
        throw new Error("Trash resource was not found");
      }
      await sql`
        UPDATE file_versions SET state = 'expired'
        WHERE resource_id IN (
          SELECT id FROM resources
          WHERE storage_path = ${existing.storagePath} OR starts_with(storage_path, ${`${existing.storagePath}/`})
        )
      `;
      await sql`
        UPDATE resources SET status = 'purged', purge_after = NULL, updated_at = now()
        WHERE storage_path = ${existing.storagePath} OR starts_with(storage_path, ${`${existing.storagePath}/`})
      `;
      await sql`
        UPDATE operation_journal SET state = 'active', resource_id = ${record.resourceId}, updated_at = now()
        WHERE id = ${record.operationId}
      `;
      const row = await this.#resourceQuery(sql, record.resourceId);
      if (row === undefined) throw new Error("Purged trash resource was not found");
      return row;
    });
  }

  commitVersionRestore(record: CommitVersionRestoreRecord): Promise<Resource> {
    return this.#accountingTransaction(async (sql) => {
      const existing = await this.#resourceQuery(sql, record.resourceId);
      if (existing === undefined || existing.parentId === undefined || existing.type !== "file") throw new Error("Version-restored resource was not found");
      await this.#archivePreviousVersion(sql, record, existing.retentionClass ?? "general");
      await sql`
        INSERT INTO file_versions (id, resource_id, storage_path, sha256, size_bytes, mime_type, reason)
        VALUES (${record.newVersionId}, ${record.resourceId}, ${record.storagePath}, ${record.sha256},
          ${record.sizeBytes}, ${record.mimeType}, 'manual')
      `;
      const rows = await sql<ResourceRow[]>`
        UPDATE resources SET current_version_id = ${record.newVersionId}, sha256 = ${record.sha256},
          size_bytes = ${record.sizeBytes}, mime_type = ${record.mimeType}, status = 'active', updated_at = now()
        WHERE id = ${record.resourceId} RETURNING *
      `;
      await this.#adjustAncestorSizes(sql, existing.parentId, record.sizeBytes - existing.sizeBytes);
      await sql`UPDATE operation_journal SET state = 'active', updated_at = now() WHERE id = ${record.operationId}`;
      const row = rows[0];
      if (row === undefined) throw new Error("Version-restored resource was not found");
      return resource(row);
    });
  }

  async #archivePreviousVersion(
    sql: CatalogCommitSql,
    record: Pick<CommitOverwriteRecord, "resourceId" | "previousVersionId" | "previousVersionArchivePath">,
    retentionClass: RetentionClass,
  ): Promise<void> {
    const policy = VERSION_RETENTION[retentionClass];
    const minimumAgeMs = policy.automaticPurge ? policy.minimumAgeMs : null;
    // One DB instant after publication locks anchors both fields. An app clock
    // offset must never shorten the archived version's minimum retention age.
    await sql`
      WITH archive_clock AS MATERIALIZED (SELECT clock_timestamp() AS archived_at)
      UPDATE file_versions AS previous
      SET storage_path = ${record.previousVersionArchivePath}, archived_at = archive_clock.archived_at,
        purge_after = archive_clock.archived_at + ${minimumAgeMs}::bigint * interval '1 millisecond'
      FROM archive_clock
      WHERE previous.id = ${record.previousVersionId} AND previous.resource_id = ${record.resourceId}
    `;
  }

  async #rewriteCurrentVersionPaths(sql: TransactionSql, oldPath: string, newPath: string): Promise<void> {
    await sql`
      UPDATE file_versions AS version
      SET storage_path = CASE
        WHEN version.storage_path = ${oldPath} THEN ${newPath}
        ELSE ${newPath} || substring(version.storage_path FROM char_length(${oldPath}) + 1)
      END
      WHERE version.id IN (
        SELECT current_version_id FROM resources
        WHERE (storage_path = ${oldPath} OR starts_with(storage_path, ${`${oldPath}/`}))
          AND current_version_id IS NOT NULL
      ) AND (version.storage_path = ${oldPath} OR starts_with(version.storage_path, ${`${oldPath}/`}))
    `;
  }

  async #rewriteResourcePaths(sql: TransactionSql, oldPath: string, newPath: string): Promise<void> {
    await sql`
      UPDATE resources
      SET storage_path = CASE
        WHEN storage_path = ${oldPath} THEN ${newPath}
        ELSE ${newPath} || substring(storage_path FROM char_length(${oldPath}) + 1)
      END, updated_at = now()
      WHERE storage_path = ${oldPath} OR starts_with(storage_path, ${`${oldPath}/`})
    `;
  }

  #accountingTransaction<T>(action: (sql: TransactionSql) => Promise<T>): Promise<T> {
    return this.#database.transaction(async sql => {
      // All ordinary topology/accounting writers pin the canonical common
      // ancestor BEFORE reading membership or modifying any descendant row.
      // Otherwise a move could change a discovered chain while its locks wait,
      // or hold a child row while the publisher holding its parent waits on it.
      // This is the root row every such transaction already increments, not a
      // new physical/network admission limit. No filesystem I/O runs here.
      // Qualified CJ commits use their existing clock/ancestor lock protocol.
      await sql`SELECT id FROM resources WHERE id=${ROOT_RESOURCE_ID} FOR NO KEY UPDATE`;
      return action(sql);
    });
  }

  async #adjustAncestorSizes(sql: CatalogCommitSql, folderId: string, deltaBytes: number, lockedAncestorIds?: readonly string[]): Promise<void> {
    if (lockedAncestorIds !== undefined) {
      if (!lockedAncestorIds.includes(folderId) || lockedAncestorIds.length > 131) throw new Error("Catalog accounting ancestor witness is invalid");
      await sql`UPDATE resources SET size_bytes=size_bytes+${deltaBytes},updated_at=now() WHERE id=ANY(${lockedAncestorIds}::uuid[])`;
      return;
    }
    const ids = await this.#lockAccountingAncestors(sql, [folderId]);
    await sql`UPDATE resources SET size_bytes=size_bytes+${deltaBytes},updated_at=now() WHERE id=ANY(${ids}::uuid[])`;
  }

  async #lockAccountingAncestors(sql: CatalogCommitSql, folderIds: readonly string[]): Promise<string[]> {
    // Discover membership separately from locking/updating the target rows.
    // Recursive UPDATE membership can be re-evaluated by EPQ after a wait;
    // its executor order also differs between branch shapes. Neither is a
    // suitable lock order for concurrent ancestor accounting.
    const chain = await sql<{id: string; cycle: boolean}[]>`
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, ARRAY[id] AS visited, false AS cycle
        FROM resources
        WHERE id = ANY(${folderIds}::uuid[]) AND type = 'folder' AND status = 'active'
        UNION ALL
        SELECT parent.id, parent.parent_id, child.visited || parent.id, parent.id = ANY(child.visited)
        FROM resources AS parent
        INNER JOIN ancestors AS child ON parent.id = child.parent_id
        WHERE parent.type = 'folder' AND parent.status = 'active' AND NOT child.cycle
      )
      SELECT DISTINCT id, cycle FROM ancestors
    `;
    if (chain.some(row => row.cycle)) throw new Error("Catalog accounting ancestry contains a cycle");
    const ids = [...new Set(chain.map(row => row.id))].sort();
    // NO KEY UPDATE is compatible with the FK key-share locks taken when
    // another publication inserts a child. FOR UPDATE would cause an upgrade
    // deadlock even with sorted ancestors. The following statement receives
    // a fresh READ COMMITTED snapshot and increments the locked current rows.
    await sql`SELECT id FROM resources WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
    return ids;
  }
}
