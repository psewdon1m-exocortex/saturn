import type { Readable } from "node:stream";
import type { FileVersion, Resource } from "@saturn/file-core";

export type LaboratoryAssetMode = "private" | "public_immutable" | "public_alias";
export type LaboratoryAssetState = "active" | "disabled";

export interface LaboratoryClient {
  readonly id: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly previousTokenHash?: string;
  readonly previousTokenExpiresAt?: Date;
  readonly state: "active" | "revoked";
  readonly lastUsedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly revokedAt?: Date;
}

export type PublicLaboratoryClient = Omit<LaboratoryClient, "tokenHash" | "previousTokenHash" | "previousTokenExpiresAt">;

export interface LaboratoryAsset {
  readonly id: string;
  readonly resourceId: string;
  readonly mode: LaboratoryAssetMode;
  readonly pinnedVersionId?: string;
  readonly sourceShareId?: string;
  readonly publicFilename: string;
  readonly label: string;
  readonly disposition: "inline" | "attachment";
  readonly state: LaboratoryAssetState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly disabledAt?: Date;
}

export interface LaboratoryRepository {
  createClient(value: LaboratoryClient): Promise<void>;
  listClients(offset: number, limit: number): Promise<readonly LaboratoryClient[]>;
  rotateClientToken(id: string, tokenHash: string, previousTokenExpiresAt: Date, now: Date): Promise<LaboratoryClient>;
  revokeClient(id: string, now: Date): Promise<LaboratoryClient>;
  authenticateClient(tokenHash: string, now: Date): Promise<{ readonly client: LaboratoryClient; readonly usedPreviousToken: boolean } | undefined>;
  createAsset(value: LaboratoryAsset): Promise<LaboratoryAsset>;
  findActiveSharedAsset(resourceId: string, versionId: string, sourceShareId: string): Promise<LaboratoryAsset | undefined>;
  getAsset(id: string): Promise<LaboratoryAsset | undefined>;
  listAssets(offset: number, limit: number): Promise<readonly LaboratoryAsset[]>;
  updateAsset(id: string, input: { readonly mode?: LaboratoryAssetMode; readonly pinnedVersionId?: string | null; readonly label?: string; readonly disposition?: "inline" | "attachment" }, now: Date): Promise<LaboratoryAsset>;
  disableAsset(id: string, now: Date): Promise<LaboratoryAsset>;
}

export interface LaboratoryFileGateway {
  getResource(id: string): Promise<Resource>;
  getVersion(resourceId: string, versionId: string): Promise<FileVersion>;
  openDownload(resourceId: string, offset?: number, length?: number, actor?: { readonly type: string; readonly id: string }): Promise<{ readonly resource: Resource; readonly stream: Readable }>;
  openVersionDownload(resourceId: string, versionId: string, offset?: number, length?: number, actor?: { readonly type: string; readonly id: string }): Promise<{ readonly resource: Resource; readonly version: FileVersion; readonly stream: Readable }>;
}

export interface LaboratoryOptions {
  readonly enabled: boolean;
  readonly publicEnabled: boolean;
  readonly publicOrigin: string;
  readonly resolvePublicOrigin?: () => Promise<string>;
  readonly tokenRotationGraceMs: number;
  readonly maxConcurrentPublicStreams: number;
}

export interface LaboratoryDelivery {
  readonly asset: LaboratoryAsset;
  readonly resource: Resource;
  readonly versionId: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mimeType: string;
  readonly etag: string;
  readonly lastModified: Date;
  readonly cacheControl: string;
  readonly offset: number;
  readonly length: number;
  readonly partial: boolean;
  readonly notModified: boolean;
  readonly stream?: Readable;
  readonly release: () => void;
}
