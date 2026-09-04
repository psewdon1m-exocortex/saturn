import type { FileOperation, FileVersion, Resource, SecurityClassification, UploadSession, UploadStatus } from "./models.js";

export interface CreateUploadRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly parentId: string;
  readonly filename: string;
  readonly tempPath: string;
  readonly targetPath: string;
  readonly expectedSize: number;
  readonly expectedSha256?: string;
  readonly expiresAt: Date;
  readonly overwriteResourceId?: string;
  readonly auditActorType?: string;
  readonly auditActorId?: string;
}

export interface CommitUploadRecord {
  readonly uploadId: string;
  readonly resourceId: string;
  readonly versionId: string;
  readonly parentId: string;
  readonly filename: string;
  readonly storagePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mimeType: string;
}

export interface FileRepository {
  getResource(id: string): Promise<Resource | undefined>;
  getChild(parentId: string, name: string): Promise<Resource | undefined>;
  listChildren(parentId: string, offset: number, limit: number): Promise<readonly Resource[]>;
  listTrash(offset: number, limit: number): Promise<readonly Resource[]>;
  listTree(storagePath: string): Promise<readonly Resource[]>;
  createFolder(record: { readonly id: string; readonly parentId: string; readonly name: string; readonly storagePath: string }): Promise<Resource>;
  setSecurityClassification(id: string, classification: SecurityClassification): Promise<Resource>;
  getUpload(id: string): Promise<UploadSession | undefined>;
  getUploadByIdempotencyKey(key: string): Promise<UploadSession | undefined>;
  createUpload(record: CreateUploadRecord): Promise<UploadSession>;
  updateUploadProgress(id: string, expectedOffset: number, newOffset: number): Promise<UploadSession>;
  setUploadState(id: string, state: UploadStatus, fields?: { readonly actualSha256?: string; readonly errorCode?: string }): Promise<UploadSession>;
  commitUpload(record: CommitUploadRecord): Promise<CompleteUploadRecordResult>;
  commitOverwrite(record: CommitOverwriteRecord): Promise<CompleteUploadRecordResult>;
  getVersion(resourceId: string, versionId: string): Promise<FileVersion | undefined>;
  listVersions(resourceId: string, offset: number, limit: number): Promise<readonly FileVersion[]>;
  getOperation(idempotencyKey: string): Promise<FileOperation | undefined>;
  createOperation(record: {
    readonly id: string;
    readonly operationType: FileOperation["operationType"];
    readonly idempotencyKey: string;
    readonly resourceId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<FileOperation>;
  setOperationState(id: string, state: string, fields?: { readonly resourceId?: string; readonly errorCode?: string }): Promise<void>;
  acquireLocks(operationId: string, lockKeys: readonly string[], expiresAt: Date): Promise<boolean>;
  releaseLocks(operationId: string): Promise<void>;
  moveTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
    readonly parentId: string;
    readonly name: string;
    readonly oldPath: string;
    readonly newPath: string;
  }): Promise<Resource>;
  createCopiedTree(record: {
    readonly operationId: string;
    readonly rootResourceId: string;
    readonly resources: readonly CopiedResourceRecord[];
  }): Promise<Resource>;
  trashTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
    readonly oldPath: string;
    readonly trashPath: string;
    readonly purgeAfter: Date;
  }): Promise<Resource>;
  restoreTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
    readonly oldPath: string;
    readonly restoredPath: string;
    readonly parentId: string;
    readonly name: string;
  }): Promise<Resource>;
  purgeTrashFile(record: {
    readonly operationId: string;
    readonly resourceId: string;
  }): Promise<Resource>;
  commitVersionRestore(record: CommitVersionRestoreRecord): Promise<Resource>;
}

export interface CommitOverwriteRecord extends CommitUploadRecord {
  readonly resourceId: string;
  readonly previousVersionId: string;
  readonly previousVersionArchivePath: string;
  readonly previousVersionPurgeAfter?: Date;
}

export interface CommitVersionRestoreRecord {
  readonly operationId: string;
  readonly resourceId: string;
  readonly previousVersionId: string;
  readonly previousVersionArchivePath: string;
  readonly previousVersionPurgeAfter?: Date;
  readonly newVersionId: string;
  readonly storagePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
}

export interface CopiedResourceRecord {
  readonly id: string;
  readonly versionId?: string;
  readonly type: Resource["type"];
  readonly parentId: string;
  readonly name: string;
  readonly storagePath: string;
  readonly mimeType?: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
}

export interface CompleteUploadRecordResult {
  readonly upload: UploadSession;
  readonly resource: Resource;
}
