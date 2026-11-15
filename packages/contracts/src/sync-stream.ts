/** K2 r2. The v2 intent fields remain unchanged except sha256:null before seal. */
export interface SyncStreamPrepare {
  readonly schema: "saturn.stream-upload.v1" | "saturn.stream-upload.v2";
  readonly operationId: string;
  readonly source: { readonly generation: string; readonly witnessSha256: string };
  readonly chunkBytes: 4194304;
  readonly prepare: { readonly epoch: string; readonly bindingVersion: string; readonly backendIdentity: string;
    readonly intent: Readonly<Record<string, unknown>> & { readonly schema: "saturn.upload-intent.v2"; readonly sha256: null;
      readonly rootId: string; readonly deviceId: string; readonly deviceKind: "windows_sync" | "pluto"; readonly idempotencyKey: string; readonly sizeBytes: string } };
}
export interface SyncStreamChunk { readonly index: number; readonly offset: string; readonly length: string; readonly sha256: string }
export interface SyncStreamSeal { readonly sha256: string; readonly sourceGeneration: string; readonly sourceWitnessSha256: string }
export interface SyncStreamStatus {
  readonly schema: "saturn.stream-upload-status.v1" | "saturn.stream-upload-status.v2";
  readonly operationId: string;
  readonly state: "RECEIVING" | "SEALED" | "PUBLISHING" | "UNKNOWN" | "PUBLISHED";
  readonly receivedSizeBytes: string;
  readonly chunks: readonly SyncStreamChunk[];
  readonly pendingChunk?: SyncStreamChunk | null;
  readonly pendingChunks?: readonly SyncStreamChunk[];
  readonly afterIndex?: number;
  readonly nextIndex?: number | null;
  readonly finalSha256: string | null;
  /** Existing catalog upload result/status, with the same operation/upload ID. */
  readonly publication: unknown;
}
