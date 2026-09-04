import { DROP_POINT_RESOURCE_ID } from "@saturn/file-core";
import { Readable } from "node:stream";
import type { DropBufferStore } from "./buffer-store.js";
import type { DropFileGateway, DropRepository, DropUpload } from "./types.js";

export class DropDrainService {
  readonly #repository: DropRepository;
  readonly #buffer: DropBufferStore;
  readonly #files: DropFileGateway;
  readonly #workers: number;

  constructor(input: { readonly repository: DropRepository; readonly buffer: DropBufferStore; readonly files: DropFileGateway; readonly workers: number }) {
    if (!Number.isSafeInteger(input.workers) || input.workers < 1 || input.workers > 4) throw new Error("Drop drain worker count is invalid");
    this.#repository = input.repository;
    this.#buffer = input.buffer;
    this.#files = input.files;
    this.#workers = input.workers;
  }

  async drain(): Promise<number> {
    if (this.#repository.claimBufferedUpload === undefined) return 0;
    const results = await Promise.all(Array.from({ length: this.#workers }, async () => {
      const item = await this.#repository.claimBufferedUpload?.(new Date());
      if (item === undefined) return 0;
      await this.#transfer(item);
      return 1;
    }));
    return results.reduce<number>((sum, value) => sum + value, 0);
  }

  async #transfer(item: DropUpload): Promise<void> {
    if (item.localPath === undefined || this.#repository.markUploadVerifying === undefined || this.#repository.markUploadStored === undefined) {
      await this.#repository.markUploadFailed?.(item.id, "buffer_metadata_missing", new Date());
      return;
    }
    try {
      const filename = await this.#availableName(item.filename, item.id);
      const core = await this.#files.createUpload({
        parentId: DROP_POINT_RESOURCE_ID,
        filename,
        expectedSize: item.expectedSize,
        ...(item.actualSha256 === undefined ? {} : { expectedSha256: item.actualSha256 }),
        idempotencyKey: `drop-drain:${item.id}`,
        auditActor: { type: "drop_worker", id: item.id },
      });
      const current = await this.#files.getUpload(core.id);
      let offset = current.receivedSize;
      if (offset > item.expectedSize) throw new Error("Remote upload offset exceeds buffered file size");
      let sourceOffset = 0;
      for await (const chunk of this.#buffer.openRead(item.localPath)) {
        const value = Buffer.from(chunk as Uint8Array);
        const end = sourceOffset + value.length;
        if (end <= offset) { sourceOffset = end; continue; }
        const start = Math.max(0, offset - sourceOffset);
        const remaining = value.subarray(start);
        await this.#files.appendUpload(core.id, offset, remaining.length, Readable.from([remaining]));
        offset += remaining.length;
        sourceOffset = end;
      }
      if (offset !== item.expectedSize) throw new Error("Buffered file ended before expected size");
      await this.#repository.markUploadVerifying(item.id, core.id, new Date());
      const completed = await this.#files.completeUpload(core.id);
      const checksum = completed.resource.sha256 ?? "";
      if (item.actualSha256 !== undefined && checksum !== item.actualSha256) throw new Error("Remote checksum does not match local buffer");
      await this.#repository.markUploadStored(item.id, completed.resource.id, checksum, new Date());
      await this.#buffer.delete(item.localPath);
    } catch (error) {
      const code = error instanceof Error && /checksum/i.test(error.message) ? "remote_checksum_mismatch" : "transfer_failed";
      await this.#repository.markUploadFailed?.(item.id, code, new Date()).catch(() => undefined);
    }
  }

  async #availableName(filename: string, uploadId: string): Promise<string> {
    const existing: string[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.#files.listChildren(DROP_POINT_RESOURCE_ID, offset, 500);
      existing.push(...page.map((item) => item.name.toLocaleLowerCase()));
      if (page.length < 500) break;
    }
    if (!existing.includes(filename.toLocaleLowerCase())) return filename;
    const dot = filename.lastIndexOf(".");
    const suffix = uploadId.slice(0, 8);
    return dot > 0 ? `${filename.slice(0, dot)}-${suffix}${filename.slice(dot)}` : `${filename}-${suffix}`;
  }
}
