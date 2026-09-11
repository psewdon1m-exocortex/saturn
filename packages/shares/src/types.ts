import type { Readable } from "node:stream";
import type { Resource, SecurityClassification } from "@saturn/file-core";

export type ShareMode = "view" | "download" | "browse" | "download_folder";
export type ShareState = "active" | "revoked" | "expired" | "exhausted";

export interface ShareRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly resourceId: string;
  readonly resourceType: "file" | "folder";
  readonly mode: ShareMode;
  readonly state: ShareState;
  readonly passwordHash?: string;
  readonly expiresAt?: Date;
  readonly maxDownloads?: number;
  readonly downloadCount: number;
  readonly allowedCidr?: string;
  readonly classificationCeiling: "public" | "internal";
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revokedAt?: Date;
}

export interface PublicShare {
  readonly id: string;
  readonly resourceId: string;
  readonly resourceType: "file" | "folder";
  readonly resourceName: string;
  readonly resourceSize: number;
  readonly resourceMimeType?: string;
  readonly mode: ShareMode;
  readonly state: ShareState;
  readonly locked: boolean;
  readonly expiresAt?: Date;
  readonly maxDownloads?: number;
  readonly downloadCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ShareSession {
  readonly id: string;
  readonly shareId: string;
  readonly tokenHash: string;
  readonly sourceIpHash: string;
  readonly userAgentHash: string;
  readonly state: "active" | "revoked" | "expired";
  readonly downloadClaimed: boolean;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

export interface SharePackage {
  readonly id: string;
  readonly shareId: string;
  readonly state: "preparing" | "ready" | "failed" | "expired";
  readonly storagePath: string;
  readonly fileCount: number;
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly createdAt: Date;
  readonly readyAt?: Date;
  readonly expiresAt: Date;
  readonly errorCode?: string;
}

export interface ShareOptions {
  readonly enabled: boolean;
  readonly publicOrigin: string;
  readonly resolvePublicOrigin?: () => Promise<string>;
  readonly defaultExpiryMs: number;
  readonly maxExpiryMs: number;
  readonly sessionTtlMs: number;
  readonly passwordFailureLimit: number;
  readonly passwordFailureWindowMs: number;
  readonly passwordFailureDelayMs?: number;
  readonly packageMaxFiles: number;
  readonly packageMaxBytes: number;
  readonly packageMaxDurationMs: number;
  readonly streamRevalidateBytes: number;
}

export interface ShareRepository {
  createShare(input: Omit<ShareRecord, "downloadCount" | "state" | "updatedAt">): Promise<ShareRecord>;
  getShareById(id: string): Promise<ShareRecord | undefined>;
  getShareByTokenHash(tokenHash: string): Promise<ShareRecord | undefined>;
  listShares(offset: number, limit: number): Promise<readonly ShareRecord[]>;
  updateShare(id: string, input: { readonly mode?: ShareMode; readonly expiresAt?: Date | null; readonly passwordHash?: string | null; readonly maxDownloads?: number | null; readonly allowedCidr?: string | null }, now: Date): Promise<ShareRecord>;
  revokeShare(id: string, now: Date): Promise<ShareRecord>;
  sourceAllowed(sourceIp: string, cidr: string): Promise<boolean>;
  isDescendant(rootId: string, candidateId: string): Promise<boolean>;
  createSession(input: Omit<ShareSession, "state" | "downloadClaimed" | "lastSeenAt">): Promise<ShareSession>;
  touchSession(input: { readonly shareId: string; readonly tokenHash: string; readonly sourceIpHash: string; readonly userAgentHash: string; readonly now: Date }): Promise<ShareSession | undefined>;
  claimDownload(shareId: string, sessionId: string, now: Date): Promise<{ readonly share: ShareRecord; readonly session: ShareSession }>;
  validateActive(shareId: string, now: Date): Promise<boolean>;
  beginPasswordAttempt(input: { readonly sourceIpHash: string; readonly since: Date; readonly limit: number; readonly occurredAt: Date }): Promise<string | undefined>;
  finishPasswordAttempt(sequence: string, outcome: "success" | "failure", occurredAt: Date): Promise<void>;
  writeAccessEvent(input: { readonly id: string; readonly shareId?: string; readonly sourceIpHash: string; readonly action: "metadata" | "unlock" | "browse" | "content" | "package_create" | "package_content"; readonly outcome: "success" | "denied" | "failure"; readonly statusCode: number; readonly rangeStart?: number; readonly rangeLength?: number; readonly occurredAt: Date; readonly details?: Readonly<Record<string, unknown>> }): Promise<void>;
  createPackage(input: Omit<SharePackage, "state" | "fileCount" | "sizeBytes">): Promise<{ readonly value: SharePackage; readonly created: boolean }>;
  getCurrentPackage(shareId: string): Promise<SharePackage | undefined>;
  setPackageReady(id: string, input: { readonly fileCount: number; readonly sizeBytes: number; readonly sha256: string; readonly readyAt: Date }): Promise<SharePackage>;
  setPackageFailed(id: string, errorCode: string): Promise<void>;
  claimExpiredPackages(now: Date, limit: number): Promise<readonly SharePackage[]>;
  markPackageExpired(id: string): Promise<void>;
}

export interface ShareFileGateway {
  getResource(id: string): Promise<Resource>;
  listChildren(parentId: string, offset?: number, limit?: number): Promise<readonly Resource[]>;
  openDownload(id: string, offset?: number, length?: number): Promise<{ readonly resource: Resource; readonly stream: Readable }>;
  setSecurityClassification(id: string, classification: SecurityClassification): Promise<Resource>;
}

export interface ShareStorageGateway {
  mkdir(storagePath: string): Promise<void>;
  exists(storagePath: string): Promise<boolean>;
  write(storagePath: string, source: Readable, options: { readonly offset: number; readonly create: boolean; readonly exclusive?: boolean; readonly truncate?: boolean }): Promise<number>;
  openRead(storagePath: string, options?: { readonly offset?: number; readonly length?: number }): Promise<Readable>;
  stat(storagePath: string): Promise<{ readonly size: number }>;
  delete(storagePath: string): Promise<void>;
}
