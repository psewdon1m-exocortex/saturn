import type { FileOperation, FileVersion, Resource, SecurityClassification, UploadSession, UploadStatus } from "./models.js";
import type { ScopedSyncMetadata, ScopedSyncMetadataRequest } from "./sync-metadata.js";
import type { UploadPublicationAuthorization, UploadPublicationIntent, UploadPublicationReceipt } from "./upload-publication.js";
import type { PreparedCatalogUpload, VerifiedCatalogUpload } from "./catalog-commit.js";

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
  readonly expectedVersionId?: string;
  readonly requireAbsent?: boolean;
  readonly auditActorType?: string;
  readonly auditActorId?: string;
  readonly publicationIntent?: UploadPublicationIntent;
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
  readonly publicationAuthorization?: UploadPublicationAuthorization;
  /** Internal verified FileService evidence; never populated by the HTTP contract. */
  readonly catalogEvidence?: VerifiedCatalogUpload;
}

export interface AdoptExistingFileRecord {
  readonly resourceId: string;
  readonly versionId: string;
  readonly parentId: string;
  readonly filename: string;
  readonly storagePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mimeType: string;
}

export interface UploadLimits {
  readonly bufferMaxBytes: number;
  readonly maximumFileBytes: number;
}

export interface FileRepository {
  /** Optional for legacy adapters; never emulate this with per-node tree reads. */
  readScopedSyncMetadata?(request: ScopedSyncMetadataRequest): Promise<ScopedSyncMetadata>;
  getResource(id: string): Promise<Resource | undefined>;
  getResourceAtPath(storagePath: string): Promise<Resource | undefined>;
  getChild(parentId: string, name: string): Promise<Resource | undefined>;
  listChildren(parentId: string, offset: number, limit: number): Promise<readonly Resource[]>;
  listTrash(offset: number, limit: number): Promise<readonly Resource[]>;
  getTrashRetentionDays(): Promise<number>;
  getUploadLimits(): Promise<UploadLimits | undefined>;
  listTree(storagePath: string): Promise<readonly Resource[]>;
  createFolder(record: { readonly id: string; readonly parentId: string; readonly name: string; readonly storagePath: string }): Promise<Resource>;
  setSecurityClassification(id: string, classification: SecurityClassification): Promise<Resource>;
  getUpload(id: string): Promise<UploadSession | undefined>;
  getUploadByIdempotencyKey(key: string): Promise<UploadSession | undefined>;
  listRecoverableUploads?(limit: number): Promise<readonly UploadSession[]>;
  listAbandonedUploadsForCleanup?(limit: number): Promise<readonly UploadSession[]>;
  hasUploadRecoveryJournal?(id: string): Promise<boolean>;
  isBufferedDeliveryUpload?(id: string): Promise<boolean>;
  createUpload(record: CreateUploadRecord): Promise<UploadSession>;
  updateUploadProgress(id: string, expectedOffset: number, newOffset: number): Promise<UploadSession>;
  setUploadState(id: string, state: UploadStatus, fields?: { readonly actualSha256?: string; readonly errorCode?: string }): Promise<UploadSession>;
  retargetUpload?(id: string, targetPath: string): Promise<UploadSession>;
  prepareUploadCatalog?(id: string, backendIdentity: string | undefined, authorization?: UploadPublicationAuthorization): Promise<PreparedCatalogUpload | undefined>;
  commitUpload(record: CommitUploadRecord): Promise<CompleteUploadRecordResult>;
  adoptExistingFile(record: AdoptExistingFileRecord): Promise<Resource>;
  removeAdoptedFile(storagePath: string, expectedSha256: string): Promise<Resource | undefined>;
  commitOverwrite(record: CommitOverwriteRecord): Promise<CompleteUploadRecordResult>;
  getVersion(resourceId: string, versionId: string): Promise<FileVersion | undefined>;
  listVersions(resourceId: string, offset: number, limit: number): Promise<readonly FileVersion[]>;
  /** Atomically reject current/pinned/immutable versions before physical deletion.
   * Returns true for an identical expired row so interrupted deletion can resume. */
  expireVersion?(resourceId: string, version: Pick<FileVersion, "id" | "storagePath" | "sizeBytes" | "sha256">): Promise<boolean>;
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
  hasPendingPurge?(resourceId: string): Promise<boolean>;
  hasCommittingTarget?(parentId: string, filename: string, exceptUploadId: string): Promise<boolean>;
  hasCommittingTree?(storagePath: string): Promise<boolean>;
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
  purgeTrashTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
  }): Promise<Resource>;
  commitVersionRestore(record: CommitVersionRestoreRecord): Promise<Resource>;
}

export interface CommitOverwriteRecord extends CommitUploadRecord {
  // The repository anchors archive/deadline timestamps together at commit.
  readonly resourceId: string;
  readonly previousVersionId: string;
  readonly previousVersionArchivePath: string;
}

export interface CommitVersionRestoreRecord {
  // No client-clock deadline: use the persisted resource's retention policy.
  readonly operationId: string;
  readonly resourceId: string;
  readonly previousVersionId: string;
  readonly previousVersionArchivePath: string;
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
  readonly publicationReceipt?: UploadPublicationReceipt;
}
