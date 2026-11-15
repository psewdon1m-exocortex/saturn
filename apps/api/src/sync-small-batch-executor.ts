import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import type { SmallBatchItem } from "../../../packages/contracts/src/sync-small-batch.js";
import type { CatalogFolderAuthority } from "../../../packages/file-core/src/catalog-folder-authority.js";
import type { CatalogUploadStatus } from "../../../packages/file-core/src/catalog-upload-intent.js";
import type { FileService } from "../../../packages/file-core/src/file.service.js";
import { SmallBatchPlanError } from "../../../packages/file-core/src/small-batch-plan.js";
import type { SmallBatchRegistration, SmallBatchRegistry } from "../../../packages/file-core/src/small-batch-registry.js";
import { receiveSmallBatch } from "./sync-small-batch-stream.js";
import { SmallBatchPublicationBudget } from "./small-batch-publication-budget.js";

export interface SmallBatchItemOutcome {
  readonly operation_id: string;
  readonly source_generation: string;
  readonly source_identity: string;
  readonly state: "MISSING" | "PENDING" | "PUBLISHED" | "NOT_PUBLISHED" | "CONFLICT" | "UNRESOLVED";
  readonly status?: CatalogUploadStatus;
  readonly code?: string;
}
export interface SmallBatchOutcome extends SyncRootBinding {
  readonly schema: "saturn.small-file-batch-result.v1";
  readonly batch_id: string;
  readonly items: readonly SmallBatchItemOutcome[];
}
type SmallBatchFiles = Pick<FileService, "prepareCatalogUpload" | "appendCatalogUpload" | "completeCatalogUpload">
  & Partial<Pick<FileService, "prepareSmallCatalogUpload" | "completeSmallCatalogUpload" | "supportsReplayableCatalogTransfers">>;
const fatal = new Set(["authority_invalid", "authorization_changed", "unauthorized", "forbidden", "binding_invalid", "binding_mismatch"]);
const publicErrors = new Set(["operation_reused", "membership_changed", "precondition_failed", "reconciliation_required", "admission_full", "transfer_unresolved", "verification_failed", "upload_too_large", "counter_exhausted"]);
function identity(item: SmallBatchItem) {
  return { operation_id: item.operation_id, source_generation: item.source_generation, source_identity: item.source_identity };
}
export function outcome(item: SmallBatchItem, status: CatalogUploadStatus): SmallBatchItemOutcome {
  return { ...identity(item), state: status.result?.status ?? (status.session.phase === "reconciliation_required" || status.session.phase === "physical_pending" ? "UNRESOLVED" : "PENDING"), status };
}
export function failed(item: SmallBatchItem, error: unknown, signal?: AbortSignal): SmallBatchItemOutcome {
  signal?.throwIfAborted();
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "sync_internal_error";
  if (fatal.has(code)) throw error;
  return { ...identity(item), state: ["operation_reused", "membership_changed", "precondition_failed"].includes(code) ? "CONFLICT" : "UNRESOLVED", code: publicErrors.has(code) ? code : "sync_internal_error" };
}

/** Request-local executor; the HTTP adapter bounds concurrent requests. At most
 * four small files (1 MiB) are buffered per request. No physical file/session is created for
 * an incomplete, incorrectly hashed or incorrectly delimited part. Publication
 * uses the existing independently verified guarded upload lifecycle verbatim. */
export class SmallBatchExecutor {
  constructor(private readonly registry: SmallBatchRegistry, private readonly files: SmallBatchFiles,
    private readonly binding: SyncRootBinding, private readonly proof: CatalogFolderAuthority,
    private readonly publications:Pick<SmallBatchPublicationBudget,'run'> = new SmallBatchPublicationBudget()) {}
  #response(batchId: string, items: readonly SmallBatchItemOutcome[]): SmallBatchOutcome {
    return { ...this.binding, schema: "saturn.small-file-batch-result.v1", batch_id: batchId, items };
  }
  async status(record: SmallBatchRegistration, signal?: AbortSignal): Promise<SmallBatchOutcome> {
    const results: SmallBatchItemOutcome[] = [];
    for (const [index, item] of record.plan.manifest.items.entries()) {
      signal?.throwIfAborted();
      const stored = record.items[index], input = record.plan.inputs[index];
      if (!stored || !input) throw new SmallBatchPlanError("projection_mismatch");
      if (!stored.admitted) results.push({ ...identity(item), state: "CONFLICT", code: "operation_reused" });
      else if (stored.uploadId === null) results.push({ ...identity(item), state: "MISSING" });
      else {
        try { results.push(outcome(item, (await this.files.prepareCatalogUpload(input, this.proof, stored.uploadId)).status)); }
        catch (error) { results.push(failed(item, error, signal)); }
      }
    }
    return this.#response(record.plan.manifest.batch_id, results);
  }
  async receive(body: AsyncIterable<Uint8Array>, contentType: string, signal?: AbortSignal): Promise<SmallBatchOutcome> {
    let record: SmallBatchRegistration | undefined;
    const results = new Map<string, SmallBatchItemOutcome>();
    const pending = new Set<Promise<void>>();
    let failure: Error | undefined;
    const throwIfFailed = () => { if (failure) throw failure; };
    try {
    const manifest = await receiveSmallBatch(body, contentType, this.binding, {
      manifest: async value => {
        record = await this.registry.status(value.batch_id, this.binding, this.proof);
        if (!record) throw new SmallBatchPlanError("batch_missing");
        if (JSON.stringify(record.plan.manifest) !== JSON.stringify(value)) throw new SmallBatchPlanError("operation_reused");
      },
      part: async item => {
        if (!record) throw new SmallBatchPlanError("projection_mismatch");
        const index = record.plan.manifest.items.findIndex(entry => entry.operation_id === item.operation_id);
        const original = record.plan.inputs[index], registered = record.items[index];
        if (!original || !registered) throw new SmallBatchPlanError("projection_mismatch");
        let preliminary: SmallBatchItemOutcome | undefined;
        if (!registered.admitted) preliminary = { ...identity(item), state: "CONFLICT", code: "operation_reused" };
        else if (registered.uploadId !== null) {
          try {
            const current = await this.files.prepareCatalogUpload(original, this.proof, registered.uploadId);
            if (current.status.result) preliminary = outcome(item, current.status);
          } catch (error) { preliminary = failed(item, error, signal); }
        }
        // A completed duplicate still passes transport length/hash validation,
        // but cannot write its body to storage a second time.
        let bytes: Buffer | undefined = preliminary ? undefined : Buffer.alloc(Number(item.size_bytes)), offset = 0;
        return {
          write: chunk => {
            signal?.throwIfAborted();
            if (offset + chunk.length > Number(item.size_bytes)) throw new SmallBatchPlanError("projection_mismatch");
            bytes?.set(chunk, offset); offset += chunk.length; return Promise.resolve();
          },
          interrupted: () => { bytes = undefined; return Promise.resolve(); },
          received: async () => {
            signal?.throwIfAborted();
            throwIfFailed();
            if (offset !== Number(item.size_bytes)) throw new SmallBatchPlanError("projection_mismatch");
            if (preliminary) { results.set(item.operation_id, preliminary); return; }
            if (!bytes) throw new SmallBatchPlanError("projection_mismatch");
            const sealed = bytes; bytes = undefined;
            const publication = this.publications.run(async () => {
            try {
              let current = await (this.files.prepareSmallCatalogUpload?.(original, this.proof, registered.uploadId ?? undefined)
                ?? this.files.prepareCatalogUpload(original, this.proof, registered.uploadId ?? undefined));
              if (!current.status.result) {
                const session = current.status.session;
                if (session.transferPending && !await this.files.supportsReplayableCatalogTransfers?.()) throw new SmallBatchPlanError("transfer_unresolved");
                if (session.phase !== "transport" && session.phase !== "verified") throw new SmallBatchPlanError("reconciliation_required");
                const received = BigInt(session.receivedSizeBytes);
                if (received > BigInt(sealed.length)) throw new SmallBatchPlanError("projection_mismatch");
                signal?.throwIfAborted();
                if(this.files.completeSmallCatalogUpload)current=await this.files.completeSmallCatalogUpload(current,this.proof,sealed);
                else {
                  if (received < BigInt(sealed.length)) current = await this.files.appendCatalogUpload(current, this.proof, session.receivedSizeBytes, sealed.subarray(Number(received)));
                  signal?.throwIfAborted();
                  current = await this.files.completeCatalogUpload(current, this.proof);
                }
              }
              results.set(item.operation_id, outcome(item, current.status));
            } catch (error) { results.set(item.operation_id, failed(item, error, signal)); }
            }, signal).catch((error: unknown) => { failure ??= error instanceof Error ? error : new Error("Batch publication failed", { cause: error }); }).finally(() => { pending.delete(publication); });
            pending.add(publication);
            if (pending.size >= 4) await Promise.race(pending);
            throwIfFailed();
          },
        };
      },
    }, signal);
    await Promise.all(pending);
    throwIfFailed();
    const ordered = manifest.items.map(item => {
      const result = results.get(item.operation_id); if (!result) throw new SmallBatchPlanError("projection_mismatch"); return result;
    });
    return this.#response(manifest.batch_id, ordered);
    } finally {
      // Even a malformed trailing part cannot outlive its HTTP admission slot.
      await Promise.all(pending);
    }
  }
}
