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

export interface OwnerPreferences {
  readonly accentColor: string;
  readonly sidebarMode: "fixed" | "auto-hide";
  readonly navigationOrder: readonly ("dashboard" | "files" | "inbox" | "shared" | "synchronization" | "trash" | "settings")[];
  readonly dashboardOrder: readonly ("cpu" | "ram" | "disk" | "uptime" | "storage" | "drop" | "reachability" | "tasks")[];
  readonly settingsOrder: readonly ("appearance" | "security" | "backup" | "gryphon" | "updates" | "logs")[];
  readonly trashRetentionDays: number;
  readonly uploadBufferGiB: number;
  readonly maximumUploadFileGiB: number;
  readonly updatedAt: string;
}

export interface DropSessionInfo {
  readonly state: "upload_only";
  readonly channelId: string;
  readonly expiresAt: string;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxFileBytes?: number;
  readonly reservedFiles?: number;
  readonly reservedBytes?: number;
  readonly buffer?: { readonly state: "available" | "warning" | "critical" | "refusing"; readonly reservedBytes: number; readonly maxBytes: number; readonly freeBytes: number; readonly ratio: number };
}

export interface DropUploadStatus {
  readonly id: string;
  readonly state: "reserved" | "uploading" | "buffered" | "transferring" | "verifying" | "stored" | "completed" | "failed" | "cancelled";
  readonly expectedSize: number;
  readonly receivedSize: number;
  readonly expiresAt: string;
  readonly completed: boolean;
  readonly filename?: string;
  readonly failureCode?: string;
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
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ShareChild {
  readonly id: string;
  readonly parentId?: string;
  readonly type: "file" | "folder";
  readonly name: string;
  readonly sizeBytes: number;
  readonly mimeType?: string;
  readonly sha256?: string;
  readonly updatedAt: string;
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
  readonly namespaceSlug: string;
  readonly deploymentId: string;
  readonly mirrorRoot?: "volt" | "mastermind";
  readonly mirrorDeviceId?: string;
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

export interface OperatorOverview {
  readonly sampledAt: string;
  readonly cpu: { readonly state: "available"; readonly percent: number; readonly logicalCores: number } | { readonly state: "unavailable"; readonly reason?: string };
  readonly ram: { readonly state: "available"; readonly usedBytes: number; readonly totalBytes: number; readonly percent: number; readonly processBytes: number } | { readonly state: "unavailable"; readonly reason?: string };
  readonly disk: { readonly state: "available"; readonly usedBytes: number; readonly totalBytes: number; readonly percent: number } | { readonly state: "unavailable"; readonly reason?: string };
  readonly uptime: { readonly state: "available"; readonly seconds: number } | { readonly state: "unavailable"; readonly reason?: string };
  readonly storage: {
    readonly state: "available";
    readonly indexedBytes: number;
    readonly fileCount: number;
    readonly directoryCount: number;
    readonly capacity: { readonly state: "available"; readonly totalBytes: number; readonly availableBytes: number; readonly usedBytes: number } | { readonly state: "unavailable"; readonly reason: string };
  } | { readonly state: "unavailable"; readonly reason?: string };
  readonly transfers: {
    readonly uploadBytesPerSecond?: number;
    readonly downloadBytesPerSecond?: number;
    readonly activeCount: number;
    readonly queuedCount: number;
    readonly tasks: readonly TransferTaskInfo[];
  };
}

export interface TransferTaskInfo {
  readonly id: string;
  readonly direction: "upload" | "download" | "archive";
  readonly filename: string;
  readonly state: "queued" | "uploading" | "scanning" | "compressing" | "extracting" | "verifying" | "committing" | "waiting_retry" | "downloading" | "paused" | "cancelled" | "completed" | "failed";
  readonly transferredBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
  readonly bytesPerSecond?: number;
  readonly queuePosition?: number;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canCancel: boolean;
  readonly updatedAt: string;
}

export interface ArchiveJobInfo {
  readonly id: string;
  readonly kind: "compress_zip" | "extract";
  readonly format: "zip" | "rar";
  readonly state: "queued" | "scanning" | "compressing" | "extracting" | "verifying" | "committing" | "paused" | "completed" | "failed" | "cancelled";
  readonly requestedState: "running" | "paused" | "cancelled";
  readonly destinationParentId: string;
  readonly sourceResourceId?: string;
  readonly sourceResourceIds: readonly string[];
  readonly outputName: string;
  readonly totalBytes: number;
  readonly processedBytes: number;
  readonly currentItem?: string;
  readonly resultResourceId?: string;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface UpdateStatus {
  readonly installedVersion: string;
  readonly updater: { readonly state: "ready" | "unavailable" | "busy"; readonly version?: string; readonly reason?: string };
  readonly registry: { readonly state: "ready" | "unavailable"; readonly reason?: string };
  readonly discoveryEnabled: boolean;
}

export interface RecoveryStatus {
  readonly exportEnabled: boolean;
  readonly restoreEnabled: boolean;
  readonly busy: boolean;
  readonly maxArchiveBytes: number;
  readonly maxChunkBytes: number;
  readonly reason?: string;
}

export interface NeptuneStatus {
  readonly product: "neptune-linux";
  readonly version: string;
  readonly client_instance_id: string;
  readonly active: boolean;
  readonly last_success_at?: string;
  readonly latest_error?: string;
  readonly latest_run_state?: string;
  readonly project: {
    readonly enabled: boolean;
    readonly interval_hours: number;
    readonly next_run_at?: string;
    readonly mirror?: {
      readonly enabled: boolean;
      readonly interval_minutes: number;
      readonly next_run_at?: string;
      readonly root: "volt" | "mastermind";
      readonly mode: "single-file" | "zip-tree";
    } | null;
  };
  readonly mirror_active?: boolean;
  readonly mirror?: {
    readonly state: string;
    readonly lastAttemptAt?: string;
    readonly lastSuccessAt?: string;
    readonly uploadedFiles?: number;
    readonly deletedEntries?: number;
    readonly error?: string;
  };
}

export interface NeptuneAvailability {
  readonly installed: boolean;
  readonly linked: boolean;
  readonly state: "linked" | "unlinked" | "unavailable";
  readonly version?: string | null;
}

export interface GryphonChallenge {
  readonly code: string;
  readonly expiresAt: string;
  readonly command: string;
  readonly botUsername?: string;
}

export interface NeptuneReleaseCheck {
  readonly installed_version: string;
  readonly available_version?: string;
  readonly update_available: boolean;
}

export interface NeptuneAgentInfo {
  readonly serviceId: string;
  readonly desired: {
    readonly revision: number;
    readonly archiveEnabled: boolean;
    readonly archiveIntervalHours: number;
    readonly mirrorEnabled: boolean;
    readonly mirrorIntervalMinutes: number;
    readonly version?: string;
  };
  readonly observed: {
    readonly clientInstanceId?: string;
    readonly projectId?: string;
    readonly version?: string;
    readonly appliedRevision: number;
    readonly archive: Record<string, unknown>;
    readonly mirror: Record<string, unknown>;
    readonly latestError?: string;
    readonly lastSeenAt?: string;
  };
  readonly updatedAt: string;
}

export interface GryphonStatus {
  readonly version: string;
  readonly serviceId: "saturn";
  readonly state: string;
  readonly connected: boolean;
  readonly commandPrefix: string | null;
  readonly bot: { readonly id: string; readonly alias: string; readonly username?: string; readonly state: string } | null;
  readonly binding: { readonly linkedAt: string } | null;
}

export interface GryphonBot {
  readonly id: string;
  readonly alias: string;
  readonly username?: string;
  readonly state: string;
  readonly selected: boolean;
}

export interface RecoveryRestoreCandidate {
  readonly id: string;
  readonly filename: string;
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly schema: string;
  readonly backupId: string;
  readonly createdAt: string;
  readonly memberCount: number;
  readonly state: "ready";
}

export interface RecoveryRestoreResult {
  readonly backupId: string;
  readonly mode: "replace";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly measuredRpoMs: number;
  readonly measuredRtoMs: number;
  readonly verification: Readonly<Record<string, number>>;
  readonly snapshotPath?: string;
}

export interface AuditEventInfo {
  readonly sequence: number;
  readonly id: string;
  readonly occurredAt: string;
  readonly actorType: string;
  readonly actorId?: string;
  readonly action: string;
  readonly resourceId?: string;
  readonly outcome: "success" | "denied" | "failure";
  readonly correlationId: string;
}

export interface KernelStatus {
  readonly url?: string;
  readonly identity?: string;
  readonly revision: number;
  readonly configured: boolean;
  readonly reachability: "ready" | "unavailable";
}

export interface StorageConnectionStatus {
  readonly profileId: string;
  readonly revision: number;
  readonly activatedAt: string;
  readonly source: "bootstrap" | "runtime";
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly root: string;
  readonly hostFingerprint: string;
  readonly authMode: "password_file" | "private_key_file";
  readonly credentialConfigured: true;
  readonly reachability: "ready" | "unavailable";
  readonly capacity?: { readonly totalBytes: number; readonly availableBytes: number };
  readonly indexed?: { readonly files: number; readonly directories: number; readonly bytes: number };
  readonly revoked?: { readonly shares: number; readonly devices: number };
}

export interface StorageConnectionInput {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly root: string;
  readonly hostFingerprint: string;
  readonly authMode: "password_file" | "private_key_file";
  readonly credential: string;
}
