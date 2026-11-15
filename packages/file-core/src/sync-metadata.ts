/** Read-only metadata: legacy ETags are observations, not new CAS versions. */
export const SYNC_METADATA_MAX_ITEMS = 500;
export const SYNC_METADATA_MAX_BYTES = 4 * 1024 * 1024;
export const SYNC_METADATA_MAX_ANCESTOR_HOPS = 128;

export interface SyncMetadataNode {
  readonly nodeId: string;
  /** The assigned root has no parent in this scoped view. */
  readonly parentId: string | null;
  readonly name: string;
  readonly type: "file" | "folder";
  readonly sizeBytes: string;
  readonly sha256: string | null;
  readonly legacyETag: string;
}

export interface ScopedSyncMetadata {
  readonly rootActive: boolean;
  readonly nodes: readonly SyncMetadataNode[];
}

export interface ScopedSyncMetadataRequest {
  readonly rootId: string;
  readonly rootParentId: string;
  readonly nodeIds: readonly string[];
}

export function validSyncMetadataIds(ids: readonly string[]): boolean {
  return ids.length >= 1 && ids.length <= SYNC_METADATA_MAX_ITEMS
    && ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
}
