export const ROOT_RESOURCE_ID = "00000000-0000-7000-8000-000000000001";
export const DROP_POINT_RESOURCE_ID = "00000000-0000-7000-8000-000000000002";
export const MASTERMIND_RESOURCE_ID = "00000000-0000-7000-8000-000000000003";
export const SYNC_RESOURCE_ID = "00000000-0000-7000-8000-000000000004";
export const VOLT_RESOURCE_ID = "00000000-0000-7000-8000-000000000005";
export const LABORATORY_RESOURCE_ID = "00000000-0000-7000-8000-000000000006";
export const BACKUPS_RESOURCE_ID = "00000000-0000-7000-8000-000000000007";

export interface Resource {
  readonly id: string;
  readonly type: "file" | "folder";
  readonly parentId?: string;
  readonly name: string;
  readonly storagePath: string;
  readonly mimeType?: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly status: "pending" | "active" | "trashed" | "missing" | "error" | "quarantined" | "purged";
  readonly securityClassification?: "public" | "internal" | "confidential" | "secret";
  readonly purgeAfter?: string;
  readonly trashedFromParentId?: string;
  readonly trashedFromName?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FileVersion {
  readonly id: string;
  readonly resourceId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly reason: string;
  readonly state: string;
  readonly createdAt: string;
}

export interface AuditEvent {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: "success" | "denied" | "failure";
  readonly resourceId?: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface OwnerPreferences {
  readonly darkColor: string;
  readonly lightColor: string;
  readonly accentColor: string;
  readonly updatedAt: string;
}

export interface DropSessionInfo {
  readonly state: "upload_only";
  readonly expiresAt: string;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly reservedFiles?: number;
  readonly reservedBytes?: number;
}

export interface DropUploadStatus {
  readonly id: string;
  readonly state: "reserved" | "uploading" | "completed" | "failed";
  readonly expectedSize: number;
  readonly receivedSize: number;
  readonly expiresAt: string;
  readonly completed: boolean;
}

export interface TelegramStatus {
  readonly provider: { readonly state: "disabled" | "starting" | "ready" | "degraded"; readonly bot?: { readonly id: string; readonly username?: string } };
  readonly binding?: { readonly userId: string; readonly chatId: string; readonly displayName?: string; readonly boundAt: string; readonly updatedAt: string };
}

export interface ShareInfo {
  readonly id: string;
  readonly resourceId: string;
  readonly resourceType: "file" | "folder";
  readonly resourceName: string;
  readonly resourceSize: number;
  readonly resourceMimeType?: string;
  readonly mode: "view" | "download" | "browse" | "download_folder";
  readonly state: "active" | "revoked" | "expired" | "exhausted";
  readonly locked: boolean;
  readonly expiresAt?: string;
  readonly maxDownloads?: number;
  readonly downloadCount: number;
}

export interface ShareChild {
  readonly id: string;
  readonly parentId?: string;
  readonly type: "file" | "folder";
  readonly name: string;
  readonly sizeBytes: number;
  readonly mimeType?: string;
}

export interface DeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly state: "active" | "revoked" | "expired";
  readonly scopeIds: readonly string[];
  readonly rights: { readonly read: boolean; readonly write: boolean; readonly move: boolean; readonly delete: boolean };
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BackupServiceInfo {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly state: "active" | "revoked";
  readonly requireEncryption: boolean;
  readonly maxBackupBytes: number;
  readonly dailyQuotaBytes: number;
  readonly storedQuotaBytes: number;
  readonly maxConcurrentRuns: number;
  readonly freshnessSlaMs: number;
  readonly retention: { readonly daily: number; readonly weekly: number; readonly monthly: number; readonly yearly: number };
  readonly usage: { readonly storedBytes: number; readonly activeReservedBytes: number; readonly dailyReservedBytes: number; readonly activeRuns: number; readonly lastCompletedAt?: string; readonly failedRuns: number };
  readonly lastRestoreTest?: { readonly outcome: "success" | "failure"; readonly method: string; readonly completedAt: string };
  readonly fresh: boolean;
  readonly lastUsedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LaboratoryClientInfo { readonly id: string; readonly name: string; readonly state: "active" | "revoked"; readonly lastUsedAt?: string; readonly createdAt: string; readonly updatedAt: string; readonly revokedAt?: string }
export interface LaboratoryAssetInfo { readonly id: string; readonly resourceId: string; readonly mode: "private" | "public_immutable" | "public_alias"; readonly pinnedVersionId?: string; readonly publicFilename: string; readonly label: string; readonly disposition: "inline" | "attachment"; readonly state: "active" | "disabled"; readonly createdAt: string; readonly updatedAt: string; readonly disabledAt?: string }
