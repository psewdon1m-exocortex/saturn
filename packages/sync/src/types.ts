import type { Readable } from "node:stream";
import type { Resource } from "@saturn/file-core";

export const MASTERMIND_RESOURCE_ID = "00000000-0000-7000-8000-000000000003";
export const SYNC_RESOURCE_ID = "00000000-0000-7000-8000-000000000004";
export const VOLT_RESOURCE_ID = "00000000-0000-7000-8000-000000000005";

export interface DeviceRights {
  readonly read: boolean;
  readonly write: boolean;
  readonly move: boolean;
  readonly delete: boolean;
}

export interface DeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly deviceKind: "generic" | "mirror" | "windows_sync" | "pluto";
  readonly plutoStatus?: PlutoStatus;
  readonly syncRootId?: string;
  readonly tokenHash: string;
  readonly state: "active" | "revoked" | "expired";
  readonly scopeIds: readonly string[];
  readonly rights: DeviceRights;
  readonly expiresAt?: Date;
  readonly lastUsedAt?: Date;
  readonly lastSeenAt?: Date;
  readonly clientPlatform?: "windows" | "linux";
  readonly clientVersion?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revokedAt?: Date;
}

export interface DeviceEnrollmentRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly codeHash: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly consumedAt?: Date;
}

export type PublicDevice = Omit<DeviceRecord, "tokenHash"> & { readonly syncFolderName?: string };

export interface SyncConflict {
  readonly id: string;
  readonly deviceId: string;
  readonly resourceId: string;
  readonly conflictResourceId: string;
  readonly baseEtag: string;
  readonly currentEtag: string;
  readonly state: "open" | "resolved";
  readonly createdAt: Date;
}

export interface DeviceRepository {
  create(input: Omit<DeviceRecord, "state" | "updatedAt" | "lastUsedAt">): Promise<DeviceRecord>;
  getById(id: string): Promise<DeviceRecord | undefined>;
  authenticate(tokenHash: string, now: Date): Promise<DeviceRecord | undefined>;
  list(offset: number, limit: number): Promise<readonly DeviceRecord[]>;
  update(id: string, input: { readonly name?: string; readonly scopeIds?: readonly string[]; readonly rights?: DeviceRights; readonly expiresAt?: Date | null; readonly syncRootId?: string; readonly tokenHash?: string }, now: Date): Promise<DeviceRecord>;
  revoke(id: string, now: Date): Promise<DeviceRecord>;
  createEnrollment(value: DeviceEnrollmentRecord): Promise<void>;
  redeemEnrollment(codeHash: string, tokenHash: string, now: Date, kind?: "windows_sync" | "pluto"): Promise<DeviceRecord | undefined>;
  recordPresence(id: string, platform: "windows" | "linux", version: string, now: Date, plutoStatus?: PlutoStatus): Promise<DeviceRecord>;
  reserveDelete(input: { readonly deviceId: string; readonly itemCount: number; readonly since: Date; readonly limit: number; readonly occurredAt: Date }): Promise<boolean>;
  recordConflict(input: SyncConflict): Promise<void>;
}

export interface PlutoStatus {
  readonly enabled: boolean;
  readonly intervalSeconds: number;
  readonly lastAttemptAt?: string;
  readonly lastSuccessAt?: string;
  readonly nextRunAt?: string;
  readonly uploadedFiles: number;
  readonly error?: string;
}

export interface DeviceOptions {
  readonly enabled: boolean;
  readonly publicOrigin: string;
  readonly uploadChunkMaxBytes: number;
  readonly propfindMaxItems: number;
  readonly deleteMaxItems: number;
  readonly deleteWindowMs: number;
}

export interface DeviceContext { readonly device: DeviceRecord }

export interface DavEntry { readonly path: string; readonly resource: Resource }

export interface DavRead {
  readonly resource: Resource;
  readonly stream: Readable;
  readonly offset: number;
  readonly length: number;
  readonly partial: boolean;
}
