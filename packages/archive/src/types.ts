export type ArchiveFormat = "zip" | "rar";
export type ArchiveJobKind = "compress_zip" | "extract";
export type ArchiveJobState =
  | "queued"
  | "scanning"
  | "compressing"
  | "extracting"
  | "verifying"
  | "committing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type ArchiveRequestedState = "running" | "paused" | "cancelled";

export interface ArchiveJob {
  readonly id: string;
  readonly kind: ArchiveJobKind;
  readonly format: ArchiveFormat;
  readonly state: ArchiveJobState;
  readonly requestedState: ArchiveRequestedState;
  readonly destinationParentId: string;
  readonly sourceResourceId?: string;
  readonly sourceResourceIds: readonly string[];
  readonly outputName: string;
  readonly totalBytes: number;
  readonly processedBytes: number;
  readonly currentItem?: string;
  readonly resultResourceId?: string;
  readonly failureCode?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt?: Date;
}

export interface ArchiveLimits {
  readonly maxArchiveBytes: number;
  readonly maxMemberBytes: number;
  readonly maxExtractedBytes: number;
  readonly maxEntries: number;
  readonly maxCompressionRatio: number;
  readonly uploadChunkBytes: number;
  readonly leaseMs: number;
}

export interface ArchiveRuntimeOptions {
  readonly spoolDirectory: string;
  readonly sevenZipExecutable: string;
  readonly limits: ArchiveLimits;
}

export interface CreateArchiveJobInput {
  readonly destinationParentId: string;
  readonly sourceResourceIds: readonly string[];
  readonly outputName: string;
}

export interface ExtractArchiveJobInput {
  readonly sourceResourceId: string;
}
