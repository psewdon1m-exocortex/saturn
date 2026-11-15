import { DROP_POINT_RESOURCE_ID } from "@saturn/file-core";
import { Readable } from "node:stream";
import type { DropBufferStore } from "./buffer-store.js";
import type { DropFileGateway, DropRepository, DropUpload } from "./types.js";
import { DROP_TRANSFER_HEARTBEAT_MS } from "./transfer-lease.js";

class TransferLeaseLost extends Error {}

export class DropDrainService {
  readonly #repository: DropRepository;
  readonly #buffer: DropBufferStore;
  readonly #files: DropFileGateway;
  readonly #workers: number;
  readonly #chunkBytes: number;
  #running: Promise<number> | undefined;

  constructor(input: { readonly repository: DropRepository; readonly buffer: DropBufferStore; readonly files: DropFileGateway; readonly workers: number; readonly chunkBytes: number }) {
    if (!Number.isSafeInteger(input.workers) || input.workers < 1 || input.workers > 4) throw new Error("Drop drain worker count is invalid");
    if (!Number.isSafeInteger(input.chunkBytes) || input.chunkBytes < 1) throw new Error("Drop drain chunk size is invalid");
    this.#repository = input.repository;
    this.#buffer = input.buffer;
    this.#files = input.files;
    this.#workers = input.workers;
    this.#chunkBytes = input.chunkBytes;
  }

  drain(): Promise<number> {
    // A second caller must not create a second set of physical workers.
    this.#running ??= this.#drain().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #drain(): Promise<number> {
    for (const item of await this.#repository.listBufferCleanup?.(100) ?? []) {
      if (item.localPath === undefined) continue;
      try { await this.#buffer.delete(item.localPath); await this.#repository.releaseBuffer?.(item.id); }
      catch { /* Keep the bytes accounted for until cleanup succeeds. */ }
    }
    if (this.#repository.claimBufferedUpload === undefined) return 0;
    // Consume ready work without an idle scheduler tick between every wave.
    // Bound both admission count and time so archive/maintenance jobs still run.
    const deadline = performance.now() + 1_000;
    let admissions = 0;
    const results = await Promise.allSettled(Array.from({ length: this.#workers }, async () => {
      let processed = 0;
      while (admissions < 256 && performance.now() < deadline) {
        admissions += 1;
        const item = await this.#repository.claimBufferedUpload?.(new Date());
        if (item === undefined) break;
        const succeeded = this.#repository.withUploadLock === undefined
          ? await this.#transfer(item)
          : await this.#repository.withUploadLock(item.id, () => this.#transfer(item));
        processed += 1;
        // An unavailable backend should not be hammered by a tight retry loop.
        if (!succeeded) break;
      }
      return processed;
    }));
    // Keep ownership until every lane has settled, including on claim/lock errors.
    let processed = 0;
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      processed += result.value;
    }
    return processed;
  }

  async #transfer(item: DropUpload): Promise<boolean> {
    // A stale claim may have waited behind another worker that finished it.
    const fresh = await this.#repository.getDropUpload(item.channelId, item.id);
    if (fresh === undefined || fresh.state === "stored" || fresh.state === "cancelled") return true;
    if (item.transferLeaseToken !== fresh.transferLeaseToken) return false;
    item = fresh;
    const token = item.transferLeaseToken;
    let lost = false;
    let renewal = Promise.resolve(true);
    const renew = (): Promise<boolean> => {
      // Serialize heartbeats; a database error ends ownership instead of letting
      // a delayed callback revive an expired or replaced lease.
      renewal = renewal.then(async () => {
        if (lost) return false;
        if (token === undefined) return true; // Repositories without durable leases.
        try { lost = await this.#repository.renewTransferLease?.(item.id, token, new Date()) !== true; }
        catch { lost = true; }
        return !lost;
      });
      return renewal;
    };
    const assertOwned = async (): Promise<void> => {
      if (!await renew()) throw new TransferLeaseLost("Drop transfer lease lost");
    };
    const timer = token === undefined ? undefined : setInterval(() => { void renew(); }, DROP_TRANSFER_HEARTBEAT_MS);
    timer?.unref();
    try { return await this.#transferOwned(item, assertOwned); }
    finally { if (timer !== undefined) clearInterval(timer); await renewal; }
  }

  async #transferOwned(item: DropUpload, assertOwned: () => Promise<void>): Promise<boolean> {
    if (item.localPath === undefined || this.#repository.markUploadVerifying === undefined || this.#repository.markUploadStored === undefined) {
      await this.#repository.markUploadFailed?.(item.id, "buffer_metadata_missing", new Date(), item.transferLeaseToken);
      return false;
    }
    let stage = "create";
    try {
      await assertOwned();
      const core = await this.#files.createUpload({
        parentId: DROP_POINT_RESOURCE_ID,
        filename: item.filename,
        expectedSize: item.expectedSize,
        ...(item.actualSha256 === undefined ? {} : { expectedSha256: item.actualSha256 }),
        idempotencyKey: `drop-drain:${item.id}`,
        auditActor: { type: "drop_worker", id: item.id },
      });
      stage = "resume";
      await assertOwned();
      const current = await this.#files.getUpload(core.id);
      let offset = current.receivedSize;
      if (offset > item.expectedSize) throw new Error("Remote upload offset exceeds buffered file size");
      let sourceOffset = 0;
      stage = "read";
      for await (const chunk of this.#buffer.openRead(item.localPath, this.#chunkBytes)) {
        const value = Buffer.from(chunk as Uint8Array);
        const end = sourceOffset + value.length;
        if (end <= offset) { sourceOffset = end; continue; }
        const start = Math.max(0, offset - sourceOffset);
        const remaining = value.subarray(start);
        stage = "append";
        await assertOwned();
        await this.#files.appendUpload(core.id, offset, remaining.length, Readable.from([remaining]));
        offset += remaining.length;
        sourceOffset = end;
        stage = "read";
      }
      if (offset !== item.expectedSize) throw new Error("Buffered file ended before expected size");
      stage = "verify";
      await assertOwned();
      await this.#repository.markUploadVerifying(item.id, core.id, new Date(), item.transferLeaseToken);
      stage = "complete";
      await assertOwned();
      const completed = await this.#files.completeUpload(core.id);
      const checksum = completed.resource.sha256 ?? "";
      if (item.actualSha256 !== undefined && checksum !== item.actualSha256) throw new Error("Remote checksum does not match local buffer");
      stage = "commit";
      await assertOwned();
      await this.#repository.markUploadStored(item.id, completed.resource.id, checksum, new Date(), item.transferLeaseToken);
    } catch (error) {
      if (error instanceof TransferLeaseLost) return false;
      try { await assertOwned(); } catch { return false; }
      const code = error instanceof Error && /checksum/i.test(error.message) ? "remote_checksum_mismatch" : `transfer_${stage}_failed`;
      if (code !== "remote_checksum_mismatch" && this.#repository.retryUpload !== undefined) await this.#repository.retryUpload(item.id, code, new Date(), item.transferLeaseToken);
      else await this.#repository.markUploadFailed?.(item.id, code, new Date(), item.transferLeaseToken).catch(() => undefined);
      return false;
    }
    // Publication is final. A cleanup failure must not turn it into a new
    // transfer; the persisted stored row retains buffer accounting for retry.
    try { await this.#buffer.delete(item.localPath); await this.#repository.releaseBuffer?.(item.id); }
    catch { /* listBufferCleanup retries only the local cleanup. */ }
    return true;
  }
}
