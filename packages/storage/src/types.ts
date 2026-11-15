import type { Readable } from "node:stream";
import type { StorageVerifyRequest, StorageVerifyResult } from "../../contracts/src/storage-verifier.js";

export type StorageEntryType = "file" | "directory";

export interface StorageFileInfo {
  readonly path: string;
  readonly name: string;
  readonly type: StorageEntryType;
  readonly size: number;
  readonly modifiedAt: Date;
}

export interface StorageListResult {
  readonly entries: readonly StorageFileInfo[];
  readonly nextCursor?: string;
}

export interface StorageCapacity {
  readonly totalBytes: number;
  readonly availableBytes: number;
}

export interface StorageReadOptions {
  readonly offset?: number;
  readonly length?: number;
  readonly priority?: "foreground" | "scrub";
  readonly signal?: AbortSignal;
}

export type StorageReadStream = Readable & {
  /** Exact backend handle closure proof, independent of wrapper close/end.
   * Missing or rejected proof means UNKNOWN; consumers must retain custody. */
  readonly storageClosed?: Promise<void>;
};

export interface StorageWriteOptions {
  readonly offset: number;
  readonly create: boolean;
  readonly exclusive?: boolean;
  readonly truncate?: boolean;
}

export interface StorageRenameGroupMember {
  readonly operationId: string;
  readonly source: string;
  readonly destination: string;
}

export interface StorageWrittenVerification {
  readonly sizeBytes: string;
  readonly sha256: string;
  /** From an independent physical read, never from the submitted buffer. */
  readonly prefix: Buffer;
}

export interface StorageAdapter {
  /** Qualified write-owner liveness. A readable root alone is not readiness.
   * This probe never transfers ownership or changes queued operation outcomes. */
  assertReady?(): Promise<void>;
  /** Startup-only opt-in for a qualified v3 runtime. */
  enableExactPaths?():void;
  /** Optional qualified storage-local proof; absence requires ordinary readback. */
  verify?(request: StorageVerifyRequest, signal?: AbortSignal): Promise<StorageVerifyResult>;
  /** Capability hint only; false still requires full ordinary SHA readback. */
  supportsVerify?(): Promise<boolean>;
  stat(storagePath: string): Promise<StorageFileInfo>;
  list(storagePath: string, cursor: string | undefined, limit: number): Promise<StorageListResult>;
  openRead(storagePath: string, options?: StorageReadOptions): Promise<StorageReadStream>;
  write(storagePath: string, source: Readable, options: StorageWriteOptions): Promise<number>;
  /** Qualified durable executor only: replay the exact transfer task, never the
   * raw filesystem effect. Unsupported adapters must use the ordinary protocol. */
  writeOnce?(taskId: string, storagePath: string, bytes: Buffer, options: StorageWriteOptions): Promise<number>;
  supportsWriteOnce?(): Promise<boolean>;
  /** Full exclusive small create and independent readback in one physical slot.
   * Terminal replay must freshly verify current bytes. */
  writeVerifiedOnce?(taskId: string, storagePath: string, bytes: Buffer): Promise<StorageWrittenVerification>;
  supportsWriteVerifiedOnce?(): Promise<boolean>;
  /** One immutable queue task for up to four disjoint, already verified creates.
   * Partial physical completion stays UNKNOWN; callers retain every original. */
  renameGroupOnce?(taskId: string, members: readonly StorageRenameGroupMember[]): Promise<void>;
  supportsRenameGroupOnce?(): Promise<boolean>;
  truncate(storagePath: string, size: number): Promise<void>;
  mkdir(storagePath: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  delete(storagePath: string): Promise<void>;
  exists(storagePath: string): Promise<boolean>;
  statFs(): Promise<StorageCapacity>;
  close(): Promise<void>;
}
