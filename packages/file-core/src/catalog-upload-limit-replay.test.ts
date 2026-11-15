import { describe, expect, it, vi } from "vitest";
import type { StorageAdapter } from "@saturn/storage";
import type { CatalogFolderAuthority } from "./catalog-folder-authority.js";
import type { CatalogUploadDatabaseCoordinator, PreparedCatalogUpload } from "./catalog-upload-database.js";
import { CatalogUploadTransferExecutor } from "./catalog-upload-transfer.js";

describe("historical publication versus current physical size limit", () => {
  it("returns the qualified original published result after the configured maximum shrinks, with no backend calls", async () => {
    const original = { input: { intent: { sizeBytes: "1073741824" } }, status: { session: { uploadId: "original", phase: "published" }, result: { status: "PUBLISHED", intentHash: "original sealed" } } } as unknown as PreparedCatalogUpload;
    const status = vi.fn(async () => original), storage = new Proxy({}, { get: () => { throw new Error("No physical adapter access on historical replay"); } }) as StorageAdapter;
    const executor = new CatalogUploadTransferExecutor({ status } as unknown as CatalogUploadDatabaseCoordinator, storage, 1);
    expect(await executor.complete(original, {} as CatalogFolderAuthority)).toBe(original); expect(status).toHaveBeenCalledOnce();
  });
  it("still refuses an unfinished oversized operation without reading or writing backend bytes", async () => {
    const original = { input: { intent: { sizeBytes: "2" } }, status: { session: { uploadId: "original", phase: "transport" } } } as unknown as PreparedCatalogUpload;
    const status = vi.fn(async () => original), storage = new Proxy({}, { get: () => { throw new Error("Oversize must stop before backend access"); } }) as StorageAdapter;
    const executor = new CatalogUploadTransferExecutor({ status } as unknown as CatalogUploadDatabaseCoordinator, storage, 1);
    await expect(executor.complete(original, {} as CatalogFolderAuthority)).rejects.toMatchObject({ code: "upload_too_large" }); expect(status).toHaveBeenCalledOnce();
  });
  it("admits same-ID completion before status lookup, so a retry storm cannot consume the catalog command budget", async () => {
    const original = { input: { intent: { sizeBytes: "2" } }, status: { session: { uploadId: "original", phase: "published" }, result: { status: "PUBLISHED" } } } as unknown as PreparedCatalogUpload;
    let release: (value: PreparedCatalogUpload) => void = () => undefined;
    const pending = new Promise<PreparedCatalogUpload>(resolve => { release = resolve; });
    const status = vi.fn(() => pending), storage = new Proxy({}, { get: () => { throw new Error("Historical replay has no backend access"); } }) as StorageAdapter;
    const executor = new CatalogUploadTransferExecutor({ status } as unknown as CatalogUploadDatabaseCoordinator, storage, 1);
    const admitted = executor.complete(original, {} as CatalogFolderAuthority);
    const rejected = await Promise.all(Array.from({ length: 100 }, () => executor.complete(original, {} as CatalogFolderAuthority).catch((error: unknown) => error)));
    expect(rejected).toHaveLength(100); expect(rejected.every(error => error instanceof Error && "code" in error && error.code === "admission_full")).toBe(true);
    expect(status).toHaveBeenCalledOnce(); release(original); expect(await admitted).toBe(original);
    expect(await executor.complete(original, {} as CatalogFolderAuthority)).toBe(original); expect(status).toHaveBeenCalledTimes(2);
  });
});
