import type { ResourceStatus } from "@saturn/file-core";

export type ReconciliationMode = "metadata" | "full_hash";
export type ReconciliationIssueType = "missing" | "orphaned" | "size_mismatch" | "checksum_mismatch" | "operation_interrupted";

export interface TrackedFile {
  readonly id: string;
  readonly storagePath: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
  readonly status: ResourceStatus;
}

export interface InterruptedOperation {
  readonly id: string;
  readonly resourceId?: string;
  readonly storagePath: string;
  readonly state: string;
}

export interface ReconciliationRun {
  readonly id: string;
  readonly mode: ReconciliationMode;
  readonly state: "running" | "complete" | "failed";
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly scannedResources: number;
  readonly scannedStorageEntries: number;
  readonly issueCount: number;
  readonly errorCode?: string;
}

export interface ReconciliationIssue {
  readonly id: string;
  readonly runId: string;
  readonly issueType: ReconciliationIssueType;
  readonly resourceId?: string;
  readonly storagePath: string;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly actual: Readonly<Record<string, unknown>>;
  readonly resolution: string;
}

export interface ReconciliationRepository {
  startRun(id: string, mode: ReconciliationMode): Promise<ReconciliationRun>;
  finishRun(id: string, result: { readonly state: "complete" | "failed"; readonly scannedResources: number; readonly scannedStorageEntries: number; readonly issueCount: number; readonly errorCode?: string }): Promise<ReconciliationRun>;
  listActiveFiles(afterId: string | undefined, limit: number): Promise<readonly TrackedFile[]>;
  listManagedRootPaths(): Promise<readonly string[]>;
  hasResourceAtPath(storagePath: string): Promise<boolean>;
  setResourceStatus(id: string, status: ResourceStatus): Promise<void>;
  listInterruptedOperations(): Promise<readonly InterruptedOperation[]>;
  addIssue(issue: ReconciliationIssue): Promise<void>;
  listRuns(limit: number): Promise<readonly ReconciliationRun[]>;
  listIssues(runId: string, limit: number): Promise<readonly ReconciliationIssue[]>;
}
