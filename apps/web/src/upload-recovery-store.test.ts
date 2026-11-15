import { afterEach, expect, it, vi } from "vitest";
import { listUploadRecovery, saveUploadRecovery, removeUploadRecovery, withUploadSourceLock, type UploadRecoveryRecord } from "./upload-recovery-store.js";
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
const record = (): UploadRecoveryRecord => {
  const operationId = crypto.randomUUID();
  return { schema: 2, channel: "owner", parentId: "parent", operationId, idempotencyKey: `web-upload-${operationId}`, filename: "a.bin", expectedSize: 1, lastModified: 1, sha256: "a".repeat(64), createdAt: Date.now() };
};
it("persists original identity before the server ID, then binds the ID immutably", () => {
  const value = record(); saveUploadRecovery(value);
  expect(listUploadRecovery()).toEqual([value]);
  saveUploadRecovery({ ...value, id: "server-id" });
  expect(() => saveUploadRecovery({ ...value, id: "other-id" })).toThrow(/cannot change/);
  expect(() => saveUploadRecovery({ ...value, id: "server-id", sha256: "b".repeat(64) })).toThrow(/cannot change/);
  removeUploadRecovery(value.operationId); expect(listUploadRecovery()).toEqual([]);
});
it("retains unknown records at capacity, refuses corrupt/blocked persistence", () => {
  for (let count = 0; count < 128; count++) saveUploadRecovery(record());
  expect(() => saveUploadRecovery(record())).toThrow(/Too many/);
  expect(listUploadRecovery()).toHaveLength(128);
  localStorage.clear();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
  expect(() => saveUploadRecovery(record())).toThrow(/Full/);
});
it("holds the source lock until physical promises settle", async () => {
  let release!: () => void;
  const first = withUploadSourceLock("source", () => new Promise<void>(resolve => { release = resolve; }));
  await expect(withUploadSourceLock("source", async () => undefined)).rejects.toThrow(/already active/);
  release(); await first;
  await expect(withUploadSourceLock("source", async () => "next")).resolves.toBe("next");
});
