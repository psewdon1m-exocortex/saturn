import type { Sql, TransactionSql } from "postgres";
import type { Database } from "@saturn/database";
import type { FileOperation, FileVersion, Resource, ResourceStatus, ResourceType, RetentionClass, SecurityClassification, UploadSession, UploadStatus } from "./models.js";
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
  };
}

export class PostgresFileRepository implements FileRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  #resourceQuery(sql: Sql | TransactionSql, id: string): Promise<Resource | undefined> {
    return Promise.resolve(sql<ResourceRow[]>`
      SELECT * FROM resources WHERE id = ${id} LIMIT 1
    `).then((rows) => rows[0] === undefined ? undefined : resource(rows[0]));
  }

  #uploadQuery(sql: Sql | TransactionSql, id: string): Promise<UploadSession | undefined> {
    return Promise.resolve(sql<UploadRow[]>`
      SELECT * FROM upload_sessions WHERE id = ${id} LIMIT 1
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
    return this.#database.transaction(async (sql) => {
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
      const rows = await sql<UploadRow[]>`SELECT * FROM upload_sessions WHERE idempotency_key = ${key} LIMIT 1`;
      return rows[0] === undefined ? undefined : upload(rows[0]);
    });
  }

  listAbandonedUploadsForCleanup(limit: number): Promise<readonly UploadSession[]> {
    return this.#database.withSql(async sql => (await sql<UploadRow[]>`
      SELECT u.* FROM upload_sessions u WHERE ((u.status='abandoned'
        AND EXISTS(SELECT 1 FROM operation_journal j WHERE j.upload_id=u.id AND j.error_code='cleanup_pending'))
        OR (u.status='failed_retryable' AND u.received_size=0 AND u.audit_actor_type='device_token'
          AND u.idempotency_key LIKE 'dav-upload-%' AND u.updated_at < now()-interval '2 minutes')
        OR (u.status IN ('created','uploading','failed_retryable','failed_final') AND u.expires_at <= now()
          AND NOT EXISTS(SELECT 1 FROM drop_uploads d WHERE u.audit_actor_type='drop_worker' AND u.parent_id='00000000-0000-7000-8000-000000000002' AND d.local_path IS NOT NULL AND d.received_size=d.expected_size
            AND d.state IN ('buffered','transferring','verifying') AND (d.upload_id=u.id OR u.idempotency_key='drop-drain:'||d.id::text))
          AND NOT EXISTS(SELECT 1 FROM operation_journal j WHERE j.upload_id=u.id AND j.error_code IN ('verification_interrupted','reconciliation_required'))))
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
        INSERT INTO operation_journal (id, operation_type, state, idempotency_key, upload_id, payload)
        VALUES (${record.id}, 'upload', 'created', ${`upload:${record.idempotencyKey}`}, ${record.id},
          ${sql.json({ tempPath: record.tempPath, targetPath: record.targetPath })})
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Upload insert returned no row");
      return upload(row);
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

  commitUpload(record: CommitUploadRecord): Promise<CompleteUploadRecordResult> {
    return this.#database.transaction(async (sql) => {
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
      return { upload: upload(uploadRows[0]), resource: committedResource };
    });
  }

  adoptExistingFile(record: AdoptExistingFileRecord): Promise<Resource> {
    return this.#database.transaction(async (sql) => {
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
    return this.#database.transaction(async (sql) => {
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
    return this.#database.transaction(async (sql) => {
      const existing = await this.#resourceQuery(sql, record.resourceId);
      if (existing === undefined || existing.parentId === undefined || existing.type !== "file") throw new Error("Overwrite resource was not found");
      await sql`
        UPDATE file_versions
        SET storage_path = ${record.previousVersionArchivePath}, archived_at = now(),
          purge_after = ${record.previousVersionPurgeAfter ?? null}
        WHERE id = ${record.previousVersionId} AND resource_id = ${record.resourceId}
      `;
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
      await this.#adjustAncestorSizes(sql, existing.parentId, record.sizeBytes - existing.sizeBytes);
      return { resource: resource(resourceRow), upload: upload(uploadRow) };
    });
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

  expireVersion(resourceId: string, versionId: string): Promise<void> {
    return this.#database.withSql(async sql => {
      await sql`UPDATE file_versions SET state='expired' WHERE resource_id=${resourceId} AND id=${versionId} AND id <> (SELECT current_version_id FROM resources WHERE id=${resourceId})`;
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
    return this.#database.transaction(async (sql) => {
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
    return this.#database.transaction(async (sql) => {
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
    return this.#database.transaction(async (sql) => {
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
    return this.#database.transaction(async (sql) => {
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
    return this.#database.transaction(async (sql) => {
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
    return this.#database.transaction(async (sql) => {
      const existing = await this.#resourceQuery(sql, record.resourceId);
      if (existing === undefined || existing.parentId === undefined || existing.type !== "file") throw new Error("Version-restored resource was not found");
      await sql`
        UPDATE file_versions SET storage_path = ${record.previousVersionArchivePath},
          archived_at = now(), purge_after = ${record.previousVersionPurgeAfter ?? null}
        WHERE id = ${record.previousVersionId} AND resource_id = ${record.resourceId}
      `;
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

  async #adjustAncestorSizes(sql: TransactionSql, folderId: string, deltaBytes: number): Promise<void> {
    await sql`
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id
        FROM resources
        WHERE id = ${folderId} AND type = 'folder' AND status = 'active'
        UNION ALL
        SELECT parent.id, parent.parent_id
        FROM resources AS parent
        INNER JOIN ancestors AS child ON parent.id = child.parent_id
        WHERE parent.type = 'folder' AND parent.status = 'active'
      )
      UPDATE resources
      SET size_bytes = size_bytes + ${deltaBytes}, updated_at = now()
      WHERE id IN (SELECT id FROM ancestors)
    `;
  }
}
