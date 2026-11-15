import { describe, expect, it, vi } from "vitest";
import { FileService, SYNC_RESOURCE_ID, type FileRepository, type ScopedSyncMetadata, type SyncMetadataNode } from "@saturn/file-core";
import type { StorageAdapter } from "@saturn/storage";
import { DeviceService } from "./device.service.js";
import type { DeviceRecord, DeviceRepository } from "./types.js";

const root = "11111111-1111-4111-8111-111111111111";
const child = "11111111-1111-4111-8111-111111111112";
const missing = "11111111-1111-4111-8111-111111111113";
const node: SyncMetadataNode = { nodeId: child, parentId: root, name: "file.bin", type: "file",
  sizeBytes: "9007199254740993", sha256: "a".repeat(64), legacyETag: '"sha256-' + "a".repeat(64) + '"' };

function fixture() {
  const initial: DeviceRecord = { id: missing, name: "test", deviceKind: "windows_sync", syncRootId: root, state: "active",
    tokenHash: "test-hash", scopeIds: [root], rights: { read: true, write: true, move: true, delete: true },
    createdAt: new Date(), updatedAt: new Date() };
  let current: DeviceRecord = initial;
  const read = vi.fn(async (): Promise<ScopedSyncMetadata> => ({ rootActive: true, nodes: [node] }));
  const repository = { readScopedSyncMetadata: read } as unknown as FileRepository;
  const storage = { stat: vi.fn(), list: vi.fn() };
  const files = new FileService(repository, storage as unknown as StorageAdapter);
  const devices = new DeviceService({ files, repository: { getById: async () => current } as unknown as DeviceRepository,
    pepper: "test-metadata-pepper-with-at-least-32-characters", options: { enabled: true, publicOrigin: "https://test.invalid",
      uploadChunkMaxBytes: 1024, propfindMaxItems: 100, deleteMaxItems: 100, deleteWindowMs: 1000 } });
  return { devices, files, read, initial, storage, setCurrent(value: DeviceRecord) { current = value; } };
}

describe("read-only sync metadata", () => {
  it("advertises only implemented read-only features and bounded traversal", async () => {
    const f = fixture();
    const caps = await f.devices.syncMetadataCapabilities({ device: f.initial }, root);
    expect(caps).toMatchObject({ protocol: "saturn-sync-metadata/1", nameCodec: "legacy", rootId: root,
      features: { metadataBatch: true, stableNodeIds: true, snapshot: false, deltaFeed: false, batchResolve: false,
        batchDirectories: false, smallFileBatches: false, conditionalVersions: false, newSyncEngine: false, compressedMetadata: false },
      limits: { metadataItems: 500, metadataUncompressedBytes: "4194304", maxAncestorHops: 128, concurrentMetadataBatchesPerProcess: 4 } });
    for (const unsupported of ["serverEpoch", "version", "cursor"]) expect(caps).not.toHaveProperty(unsupported);
    expect(f.read).toHaveBeenCalledOnce();
  });

  it("keeps duplicate request order, decimal sizes and indistinguishable absence", async () => {
    const f = fixture();
    const response = await f.devices.syncMetadataBatch({ device: f.initial }, root, [child.toUpperCase(), missing, child]);
    expect(response.results).toEqual([{ nodeId: child.toUpperCase(), status: "found", metadata: node },
      { nodeId: missing, status: "not_found" }, { nodeId: child, status: "found", metadata: node }]);
    expect(f.read).toHaveBeenCalledExactlyOnceWith({ rootId: root, rootParentId: SYNC_RESOURCE_ID, nodeIds: [child.toUpperCase(), missing, child] });
    expect(f.storage.stat).not.toHaveBeenCalled();
    expect(f.storage.list).not.toHaveBeenCalled();
  });

  it("rechecks revocation, expiry and token rotation before using a captured context", async () => {
    const f = fixture(), context = { device: f.initial };
    for (const change of [{ state: "revoked" as const }, { expiresAt: new Date(0) }, { tokenHash: "rotated" }]) {
      f.setCurrent({ ...f.initial, ...change });
      await expect(f.devices.syncMetadataBatch(context, root, [child])).rejects.toMatchObject({ code: "unauthorized" });
    }
    expect(f.read).not.toHaveBeenCalled();
  });

  it("rejects peer roots, broad scopes, generic kinds and unreadable devices before lookup", async () => {
    const f = fixture(), context = { device: f.initial };
    await expect(f.devices.syncMetadataBatch(context, child, [root])).rejects.toMatchObject({ code: "not_found" });
    f.setCurrent({ ...f.initial, scopeIds: [root, child] });
    await expect(f.devices.syncMetadataBatch(context, root, [child])).rejects.toMatchObject({ code: "not_found" });
    f.setCurrent({ ...f.initial, deviceKind: "generic" });
    await expect(f.devices.syncMetadataBatch(context, root, [child])).rejects.toMatchObject({ code: "forbidden" });
    f.setCurrent({ ...f.initial, rights: { ...f.initial.rights, read: false } });
    await expect(f.devices.syncMetadataBatch(context, root, [child])).rejects.toMatchObject({ code: "forbidden" });
    expect(f.read).not.toHaveBeenCalled();
  });

  it("does not translate a missing root witness to an empty successful batch", async () => {
    const f = fixture(); f.read.mockResolvedValue({ rootActive: false, nodes: [] });
    await expect(f.devices.syncMetadataBatch({ device: f.initial }, root, [child])).rejects.toMatchObject({ code: "not_found" });
    await expect(f.devices.syncMetadataCapabilities({ device: f.initial }, root)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects invalid or excess IDs without metadata IO", async () => {
    const f = fixture();
    for (const ids of [[], ["bad"], Array<string>(501).fill(child)]) {
      await expect(f.devices.syncMetadataBatch({ device: f.initial }, root, ids)).rejects.toMatchObject({ code: "invalid_body" });
    }
    await expect(f.files.readScopedSyncMetadata({ rootId: "bad", rootParentId: SYNC_RESOURCE_ID, nodeIds: [child] })).rejects.toThrow("IDs are invalid");
    expect(f.read).not.toHaveBeenCalled();
  });

  it("bounds in-process query concurrency, rejects excess immediately, and releases slots after failure", async () => {
    const f = fixture();
    let release = () => {};
    const wait = new Promise<void>(resolve => { release = resolve; });
    f.read.mockImplementation(async () => { await wait; throw new Error("fixture query failure"); });
    const jobs = Array.from({ length: 4 }, () => f.devices.syncMetadataBatch({ device: f.initial }, root, [child]));
    // getById is asynchronous; let all four acquire the fixed read slots.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await expect(f.devices.syncMetadataBatch({ device: f.initial }, root, [child])).rejects.toMatchObject({ code: "rate_limited" });
    expect(f.read).toHaveBeenCalledTimes(4);
    release(); await Promise.allSettled(jobs);
    f.read.mockResolvedValue({ rootActive: true, nodes: [node] });
    await expect(f.devices.syncMetadataBatch({ device: f.initial }, root, [child])).resolves.toMatchObject({ results: [{ status: "found" }] });
  });
});
