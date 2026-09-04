export const ROOT_RESOURCE_ID = "00000000-0000-7000-8000-000000000001";
export const DROP_POINT_RESOURCE_ID = "00000000-0000-7000-8000-000000000002";
export const MASTERMIND_RESOURCE_ID = "00000000-0000-7000-8000-000000000003";
export const SYNC_RESOURCE_ID = "00000000-0000-7000-8000-000000000004";
export const VOLT_RESOURCE_ID = "00000000-0000-7000-8000-000000000005";
export const LABORATORY_RESOURCE_ID = "00000000-0000-7000-8000-000000000006";
export const BACKUPS_RESOURCE_ID = "00000000-0000-7000-8000-000000000007";

export type ResourceType = "file" | "folder";
export type ResourceStatus = "pending" | "active" | "trashed" | "missing" | "error" | "quarantined" | "purged";
export type UploadStatus =
  | "created"
  | "uploading"
  | "verifying"
  | "committing"
  | "active"
  | "failed_retryable"
  | "failed_final"
  | "abandoned";
export type RetentionClass = "general" | "mastermind_markdown" | "mastermind_attachment" | "keepass" | "laboratory_immutable";
export type SecurityClassification = "public" | "internal" | "confidential" | "secret";

export interface Resource {
  readonly id: string;
  readonly type: ResourceType;
  readonly parentId?: string;
  readonly name: string;
  readonly storagePath: string;
  readonly mimeType?: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly currentVersionId?: string;
  readonly status: ResourceStatus;
  readonly retentionClass?: RetentionClass;
  readonly securityClassification?: SecurityClassification;
  readonly trashedFromParentId?: string;
  readonly trashedFromName?: string;
  readonly purgeAfter?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FileOperation {
  readonly id: string;
  readonly operationType: "move" | "copy" | "trash" | "restore" | "purge" | "version_restore";
  readonly state: string;
  readonly idempotencyKey: string;
  readonly resourceId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly errorCode?: string;
}

export interface ResourceMutationInput {
  readonly idempotencyKey: string;
  readonly auditActor?: { readonly type: string; readonly id: string };
}

export interface MoveResourceInput extends ResourceMutationInput {
  readonly parentId: string;
  readonly name?: string;
}

export interface CopyResourceInput extends ResourceMutationInput {
  readonly parentId: string;
  readonly name?: string;
}

export interface UploadSession {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly parentId: string;
  readonly filename: string;
  readonly tempPath: string;
  readonly targetPath: string;
  readonly expectedSize: number;
  readonly receivedSize: number;
  readonly expectedSha256?: string;
  readonly actualSha256?: string;
  readonly status: UploadStatus;
  readonly resourceId?: string;
  readonly overwriteResourceId?: string;
  readonly auditActorType?: string;
  readonly auditActorId?: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateUploadInput {
  readonly parentId?: string;
  readonly filename: string;
  readonly expectedSize: number;
  readonly expectedSha256?: string;
  readonly idempotencyKey: string;
  readonly overwriteResourceId?: string;
  readonly auditActor?: { readonly type: string; readonly id: string };
}

export interface CompleteUploadResult {
  readonly upload: UploadSession;
  readonly resource: Resource;
}

export interface FileVersion {
  readonly id: string;
  readonly resourceId: string;
  readonly storagePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly reason: "initial" | "overwrite" | "sync-conflict" | "manual";
  readonly state: "active" | "expired" | "missing" | "error";
  readonly archivedAt?: Date;
  readonly purgeAfter?: Date;
  readonly createdAt: Date;
}
