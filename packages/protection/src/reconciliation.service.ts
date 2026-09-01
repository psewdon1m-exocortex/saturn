import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { AuditSink } from "@saturn/audit";
import type { StorageAdapter } from "@saturn/storage";
import { joinStoragePath } from "@saturn/storage";
import { v7 as uuidv7 } from "uuid";
import type {
  ReconciliationIssue,
  ReconciliationIssueType,
  ReconciliationMode,
  ReconciliationRepository,
  ReconciliationRun,
} from "./types.js";

async function hash(stream: Readable): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    digest.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: digest.digest("hex"), bytes };
}

export class ReconciliationService {
  readonly #repository: ReconciliationRepository;
  readonly #storage: StorageAdapter;
  readonly #audit: AuditSink | undefined;

  constructor(repository: ReconciliationRepository, storage: StorageAdapter, audit?: AuditSink) {
    this.#repository = repository;
    this.#storage = storage;
    this.#audit = audit;
  }

  async run(mode: ReconciliationMode): Promise<ReconciliationRun> {
    const runId = uuidv7();
    await this.#repository.startRun(runId, mode);
    let scannedResources = 0;
    let scannedStorageEntries = 0;
    let issueCount = 0;
    const addIssue = async (
      issueType: ReconciliationIssueType,
      storagePath: string,
      resolution: string,
      expected: Readonly<Record<string, unknown>>,
      actual: Readonly<Record<string, unknown>>,
      resourceId?: string,
    ): Promise<void> => {
      const issue: ReconciliationIssue = {
        id: uuidv7(),
        runId,
        issueType,
        ...(resourceId === undefined ? {} : { resourceId }),
        storagePath,
        expected,
        actual,
        resolution,
      };
      await this.#repository.addIssue(issue);
      issueCount += 1;
    };

    try {
      let afterId: string | undefined;
      let resourcePageSize: number;
      do {
        const page = await this.#repository.listActiveFiles(afterId, 100);
        resourcePageSize = page.length;
        for (const tracked of page) {
          scannedResources += 1;
          if (!(await this.#storage.exists(tracked.storagePath))) {
            await this.#repository.setResourceStatus(tracked.id, "missing");
            await addIssue("missing", tracked.storagePath, "resource_marked_missing", { sizeBytes: tracked.sizeBytes, sha256: tracked.sha256 }, {}, tracked.id);
            continue;
          }
          const attributes = await this.#storage.stat(tracked.storagePath);
          if (attributes.type !== "file" || attributes.size !== tracked.sizeBytes) {
            await this.#repository.setResourceStatus(tracked.id, "error");
            await addIssue("size_mismatch", tracked.storagePath, "resource_marked_error", { sizeBytes: tracked.sizeBytes }, {
              type: attributes.type,
              sizeBytes: attributes.size,
            }, tracked.id);
            continue;
          }
          if (mode === "full_hash" && tracked.sha256 !== undefined) {
            const actual = await hash(await this.#storage.openRead(tracked.storagePath));
            if (actual.bytes !== tracked.sizeBytes || actual.sha256 !== tracked.sha256) {
              await this.#repository.setResourceStatus(tracked.id, "quarantined");
              await addIssue("checksum_mismatch", tracked.storagePath, "resource_quarantined", {
                sizeBytes: tracked.sizeBytes,
                sha256: tracked.sha256,
              }, actual, tracked.id);
            }
          }
        }
        afterId = page.at(-1)?.id;
      } while (resourcePageSize === 100);

      const queue: string[] = [...await this.#repository.listManagedRootPaths()];
      while (queue.length > 0) {
        const directory = queue.shift();
        if (directory === undefined) break;
        let cursor: string | undefined;
        do {
          const page = await this.#storage.list(directory, cursor, 500);
          cursor = page.nextCursor;
          for (const entry of page.entries) {
            scannedStorageEntries += 1;
            if (entry.type === "directory") {
              queue.push(entry.path);
              continue;
            }
            if (await this.#repository.hasResourceAtPath(entry.path)) continue;
            const orphanPath = joinStoragePath(`_system/orphaned/${runId}`, entry.path);
            await this.#ensureParent(orphanPath);
            await this.#storage.rename(entry.path, orphanPath);
            await addIssue("orphaned", entry.path, "moved_to_orphan_namespace", {}, { orphanPath, sizeBytes: entry.size });
          }
        } while (cursor !== undefined);
      }

      for (const interrupted of await this.#repository.listInterruptedOperations()) {
        await addIssue(
          "operation_interrupted",
          interrupted.storagePath,
          "manual_or_operation_specific_reconciliation_required",
          { state: "active" },
          { state: interrupted.state, operationId: interrupted.id },
          interrupted.resourceId,
        );
      }

      const completed = await this.#repository.finishRun(runId, {
        state: "complete",
        scannedResources,
        scannedStorageEntries,
        issueCount,
      });
      await this.#audit?.write({
        actorType: "system",
        actorId: "reconciliation",
        action: "reconciliation.completed",
        outcome: "success",
        correlationId: `reconciliation:${runId}`,
        details: { mode, scannedResources, scannedStorageEntries, issueCount },
      }).catch(() => undefined);
      return completed;
    } catch (error) {
      await this.#repository.finishRun(runId, {
        state: "failed",
        scannedResources,
        scannedStorageEntries,
        issueCount,
        errorCode: "reconciliation_failed",
      }).catch(() => undefined);
      await this.#audit?.write({
        actorType: "system",
        actorId: "reconciliation",
        action: "reconciliation.failed",
        outcome: "failure",
        correlationId: `reconciliation:${runId}`,
        details: { mode, error: error instanceof Error ? error.message : "unknown" },
      }).catch(() => undefined);
      throw error;
    }
  }

  listRuns(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Reconciliation run limit is invalid");
    return this.#repository.listRuns(limit);
  }

  listIssues(runId: string, limit = 500) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Reconciliation issue limit is invalid");
    return this.#repository.listIssues(runId, limit);
  }

  async #ensureParent(storagePath: string): Promise<void> {
    const parts = storagePath.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.#storage.exists(current))) await this.#storage.mkdir(current);
    }
  }
}
