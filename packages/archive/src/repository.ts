import type { ArchiveJob, ArchiveJobState, ArchiveRequestedState } from "./types.js";

export interface ArchiveJobRepository {
  create(job: ArchiveJob): Promise<ArchiveJob>;
  get(id: string): Promise<ArchiveJob | undefined>;
  list(destinationParentId: string | undefined, limit: number): Promise<readonly ArchiveJob[]>;
  claimNext(workerId: string, leaseMs: number, now: Date): Promise<ArchiveJob | undefined>;
  setState(id: string, state: ArchiveJobState, fields?: {
    readonly processedBytes?: number;
    readonly totalBytes?: number;
    readonly currentItem?: string | null;
    readonly resultResourceId?: string;
    readonly failureCode?: string | null;
    readonly completedAt?: Date;
  }): Promise<ArchiveJob>;
  setRequestedState(id: string, state: ArchiveRequestedState): Promise<ArchiveJob>;
  renewLease(id: string, workerId: string, leaseMs: number, now: Date): Promise<void>;
}
