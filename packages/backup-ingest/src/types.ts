import type { Readable } from "node:stream";

export type BackupServiceState = "active" | "revoked";
export type BackupRunState = "pending" | "uploading" | "appending" | "verifying" | "complete" | "failed";

export interface BackupRetentionPolicy {
  readonly daily: number;
  readonly weekly: number;
  readonly monthly: number;
  readonly yearly: number;
}

export interface BackupServiceRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly previousTokenHash?: string;
  readonly previousTokenExpiresAt?: Date;
  readonly state: BackupServiceState;
  readonly requireEncryption: boolean;
  readonly mtlsCertFingerprint?: string;
  readonly maxBackupBytes: number;
  readonly dailyQuotaBytes: number;
  readonly storedQuotaBytes: number;
  readonly maxConcurrentRuns: number;
  readonly freshnessSlaMs: number;
  readonly retention: BackupRetentionPolicy;
  readonly lastUsedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revokedAt?: Date;
}

export interface BackupReceipt {
  readonly schema: "vault.service-backup-receipt.v1";
  readonly runId: string;
  readonly serviceId: string;
  readonly serviceSlug: string;
  readonly logicalPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly committedAt: string;
}

export interface BackupRunRecord {
  readonly id: string;
  readonly serviceId: string;
  readonly clientKeyHash: string;
  readonly filename: string;
  readonly sourceCreatedAt: Date;
  readonly backupType: string;
  readonly expectedSize: number;
  readonly expectedSha256: string;
  readonly sourceVersion: string;
  readonly encrypted: boolean;
  readonly state: BackupRunState;
  readonly receivedSize: number;
  readonly tempPath: string;
  readonly finalPath: string;
  readonly receipt?: BackupReceipt;
  readonly failureCode?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly committedAt?: Date;
}

export interface BackupRestoreTestRecord {
  readonly id: string;
  readonly serviceId: string;
  readonly runId: string;
  readonly method: "integrity_check" | "isolated_restore";
  readonly outcome: "success" | "failure";
  readonly notes?: string;
  readonly artifactSha256?: string;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

export interface BackupUsage {
  readonly storedBytes: number;
  readonly activeReservedBytes: number;
  readonly dailyReservedBytes: number;
  readonly activeRuns: number;
  readonly lastCompletedAt?: Date;
  readonly failedRuns: number;
}

export interface PublicBackupService extends Omit<BackupServiceRecord, "tokenHash" | "previousTokenHash"> {
  readonly usage: BackupUsage;
  readonly lastRestoreTest?: BackupRestoreTestRecord;
  readonly fresh: boolean;
}

export interface BackupContext {
  readonly service: BackupServiceRecord;
  readonly usedPreviousToken: boolean;
}

export interface BackupOptions {
  readonly enabled: boolean;
  readonly trustClientCertificateHeader: boolean;
  readonly tokenRotationGraceMs: number;
  readonly uploadChunkMaxBytes: number;
  readonly incompleteTtlMs: number;
  readonly defaults: {
    readonly requireEncryption: boolean;
    readonly maxBackupBytes: number;
    readonly dailyQuotaBytes: number;
    readonly storedQuotaBytes: number;
    readonly maxConcurrentRuns: number;
    readonly freshnessSlaMs: number;
    readonly retention: BackupRetentionPolicy;
  };
}

export interface BackupServiceCreateInput {
  readonly slug: string;
  readonly name: string;
  readonly requireEncryption?: boolean;
  readonly mtlsCertFingerprint?: string;
  readonly maxBackupBytes?: number;
  readonly dailyQuotaBytes?: number;
  readonly storedQuotaBytes?: number;
  readonly maxConcurrentRuns?: number;
  readonly freshnessSlaMs?: number;
  readonly retention?: Partial<BackupRetentionPolicy>;
}

export interface BackupRunCreateInput {
  readonly filename: string;
  readonly createdAt: Date;
  readonly backupType: string;
  readonly expectedSize: number;
  readonly sha256: string;
  readonly sourceVersion: string;
  readonly encrypted: boolean;
  readonly idempotencyKey: string;
}

export interface BackupRepository {
  createService(value: BackupServiceRecord): Promise<void>;
  getService(id: string): Promise<BackupServiceRecord | undefined>;
  listServices(offset: number, limit: number): Promise<readonly BackupServiceRecord[]>;
  updateService(id: string, input: Partial<Pick<BackupServiceRecord, "name" | "requireEncryption" | "mtlsCertFingerprint" | "maxBackupBytes" | "dailyQuotaBytes" | "storedQuotaBytes" | "maxConcurrentRuns" | "freshnessSlaMs" | "retention">>, now: Date): Promise<BackupServiceRecord>;
  rotateToken(id: string, tokenHash: string, previousTokenExpiresAt: Date, now: Date): Promise<BackupServiceRecord>;
  revokeService(id: string, now: Date): Promise<BackupServiceRecord>;
  authenticate(tokenHash: string, now: Date): Promise<{ readonly service: BackupServiceRecord; readonly usedPreviousToken: boolean } | undefined>;
  reserveRun(input: BackupRunRecord, now: Date): Promise<{ readonly run: BackupRunRecord; readonly created: boolean }>;
  getRun(serviceId: string, runId: string): Promise<BackupRunRecord | undefined>;
  getRunForOwner(runId: string): Promise<BackupRunRecord | undefined>;
  listRuns(serviceId: string, offset: number, limit: number): Promise<readonly BackupRunRecord[]>;
  claimAppend(serviceId: string, runId: string, offset: number, length: number, now: Date): Promise<BackupRunRecord>;
  finishAppend(serviceId: string, runId: string, receivedSize: number, now: Date): Promise<BackupRunRecord>;
  releaseAppend(serviceId: string, runId: string, failureCode: string, terminal: boolean, now: Date): Promise<void>;
  claimComplete(serviceId: string, runId: string, now: Date): Promise<BackupRunRecord>;
  completeRun(serviceId: string, runId: string, receipt: BackupReceipt, now: Date): Promise<BackupRunRecord>;
  failRun(serviceId: string, runId: string, failureCode: string, now: Date): Promise<void>;
  usage(serviceId: string, since: Date): Promise<BackupUsage>;
  recordRestoreTest(value: BackupRestoreTestRecord): Promise<void>;
  latestRestoreTest(serviceId: string): Promise<BackupRestoreTestRecord | undefined>;
}

export interface BackupStorage {
  stat(path: string): Promise<{ readonly size: number; readonly type: "file" | "directory" }>;
  openRead(path: string): Promise<Readable>;
  write(path: string, source: Readable, options: { readonly offset: number; readonly create: boolean; readonly exclusive?: boolean; readonly truncate?: boolean }): Promise<number>;
  truncate(path: string, size: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

