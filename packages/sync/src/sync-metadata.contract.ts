import type { SyncMetadataNode } from "@saturn/file-core";

/** not_found is an unavailable scoped observation, never proof of ABSENT. */
export type SyncMetadataResult = {
  readonly nodeId: string;
  readonly status: "found";
  readonly metadata: SyncMetadataNode;
} | { readonly nodeId: string; readonly status: "not_found" };

export interface SyncMetadataBatchResponse {
  readonly rootId: string;
  readonly results: readonly SyncMetadataResult[];
}
