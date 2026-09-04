import type { Sql, TransactionSql } from "postgres";
import type { Database } from "@saturn/database";
import type { FileOperation, FileVersion, Resource, ResourceStatus, ResourceType, RetentionClass, SecurityClassification, UploadSession, UploadStatus } from "./models.js";
import type {
  CommitOverwriteRecord,
  CommitUploadRecord,
  CommitVersionRestoreRecord,
  CompleteUploadRecordResult,
  CopiedResourceRecord,
  CreateUploadRecord,
  FileRepository,
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

  listTree(storagePath: string): Promise<readonly Resource[]> {
    return this.#database.withSql(async (sql) => {
      const rows = await sql<ResourceRow[]>`
        SELECT * FROM resources
        WHERE storage_path = ${storagePath} OR storage_path LIKE ${`${storagePath}/%`}
        ORDER BY length(storage_path), storage_path
      `;
      return rows.map(resource);
    });
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

  createUpload(record: CreateUploadRecord): Promise<UploadSession> {
    return this.#database.transaction(async (sql) => {
      const rows = await sql<UploadRow[]>`
        INSERT INTO upload_sessions (
          id, idempotency_key, parent_id, filename, temp_path, target_path,
          expected_size, expected_sha256, status, expires_at, overwrite_resource_id,
          audit_actor_type, audit_actor_id
        ) VALUES (
          ${record.id}, ${record.idempotencyKey}, ${record.parentId}, ${record.filename},
          ${record.tempPath}, ${record.targetPath}, ${record.expectedSize},
          ${record.expectedSha256 ?? null}, 'created', ${record.expiresAt}, ${record.overwriteResourceId ?? null},
          ${record.auditActorType ?? "owner_bootstrap"}, ${record.auditActorId ?? "owner"}
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

  acquireLocks(operationId: string, lockKeys: readonly string[], expiresAt: Date): Promise<boolean> {
    const uniqueKeys = [...new Set(lockKeys)].sort();
    return this.#database.transaction(async (sql) => {
      await sql`DELETE FROM operation_locks WHERE expires_at <= now()`;
      let acquired = 0;
      for (const lockKey of uniqueKeys) {
        const rows = await sql<{ lock_key: string }[]>`
          INSERT INTO operation_locks (lock_key, operation_id, expires_at)
          VALUES (${lockKey}, ${operationId}, ${expiresAt})
          ON CONFLICT (lock_key) DO NOTHING
          RETURNING lock_key
        `;
        acquired += rows.length;
      }
      if (acquired === uniqueKeys.length) return true;
      await sql`DELETE FROM operation_locks WHERE operation_id = ${operationId}`;
      return false;
    });
  }

  releaseLocks(operationId: string): Promise<void> {
    return this.#database.withSql(async (sql) => {
      await sql`DELETE FROM operation_locks WHERE operation_id = ${operationId}`;
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
        WHERE storage_path = ${record.trashPath} OR storage_path LIKE ${`${record.trashPath}/%`}
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
        WHERE storage_path = ${record.restoredPath} OR storage_path LIKE ${`${record.restoredPath}/%`}
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

  purgeTrashFile(record: { readonly operationId: string; readonly resourceId: string }): Promise<Resource> {
    return this.#database.transaction(async (sql) => {
      const existing = await this.#resourceQuery(sql, record.resourceId);
      if (existing === undefined || existing.type !== "file" || existing.status !== "trashed" || existing.trashedFromParentId === undefined) {
        throw new Error("Trash file was not found");
      }
      await sql`UPDATE file_versions SET state = 'expired' WHERE resource_id = ${record.resourceId}`;
      const rows = await sql<ResourceRow[]>`
        UPDATE resources SET status = 'purged', purge_after = NULL, updated_at = now()
        WHERE id = ${record.resourceId} RETURNING *
      `;
      await sql`
        UPDATE operation_journal SET state = 'active', resource_id = ${record.resourceId}, updated_at = now()
        WHERE id = ${record.operationId}
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Purged trash file was not found");
      return resource(row);
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
        WHERE (storage_path = ${oldPath} OR storage_path LIKE ${`${oldPath}/%`})
          AND current_version_id IS NOT NULL
      ) AND (version.storage_path = ${oldPath} OR version.storage_path LIKE ${`${oldPath}/%`})
    `;
  }

  async #rewriteResourcePaths(sql: TransactionSql, oldPath: string, newPath: string): Promise<void> {
    await sql`
      UPDATE resources
      SET storage_path = CASE
        WHEN storage_path = ${oldPath} THEN ${newPath}
        ELSE ${newPath} || substring(storage_path FROM char_length(${oldPath}) + 1)
      END, updated_at = now()
      WHERE storage_path = ${oldPath} OR storage_path LIKE ${`${oldPath}/%`}
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
