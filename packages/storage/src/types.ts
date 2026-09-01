import type { Readable } from "node:stream";

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
}

export interface StorageWriteOptions {
  readonly offset: number;
  readonly create: boolean;
  readonly exclusive?: boolean;
  readonly truncate?: boolean;
}

export interface StorageAdapter {
  stat(storagePath: string): Promise<StorageFileInfo>;
  list(storagePath: string, cursor: string | undefined, limit: number): Promise<StorageListResult>;
  openRead(storagePath: string, options?: StorageReadOptions): Promise<Readable>;
  write(storagePath: string, source: Readable, options: StorageWriteOptions): Promise<number>;
  truncate(storagePath: string, size: number): Promise<void>;
  mkdir(storagePath: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  delete(storagePath: string): Promise<void>;
  exists(storagePath: string): Promise<boolean>;
  statFs(): Promise<StorageCapacity>;
  close(): Promise<void>;
}
