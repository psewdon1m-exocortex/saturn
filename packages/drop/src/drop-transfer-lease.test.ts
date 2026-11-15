import { requireTestValue } from "../../contracts/src/test-support.js";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropDrainService } from "./drop-drain.service.js";
import type { DropBufferStore } from "./buffer-store.js";
import type { DropFileGateway, DropRepository, DropUpload } from "./types.js";
import { DROP_TRANSFER_LEASE_MS } from "./transfer-lease.js";

function fixture() {
  let item: DropUpload = { id: "original-drop", channelId: "channel", sessionId: "session", clientKeyHash: "key",
    filename: "original.bin", expectedSize: 4, actualSha256: "expected-sha", state: "transferring", localPath: "original.part",
    createdAt: new Date(), transferLeaseToken: "owner-a", transferLeaseUntil: new Date(Date.now() + DROP_TRANSFER_LEASE_MS) };
  let claimed = false, revoked = false, renewals = 0, receivedSize = 2, publications = 0;
  const stored = vi.fn(async (_id: string, _resource: string, _sha: string, _now: Date, token: string) => {
    expect(token).toBe(item.transferLeaseToken); item = { ...item, state: "stored" }; return item;
  });
  const retry = vi.fn(async () => undefined), fail = vi.fn(async () => item), cleanup = vi.fn(async () => undefined);
  const repository = {
    claimBufferedUpload: async () => { if (claimed) return undefined; claimed = true; return item; },
    getDropUpload: async () => item,
    renewTransferLease: async (_id: string, token: string) => {
      renewals++;
      if (revoked || token !== item.transferLeaseToken || Date.now() >= requireTestValue(item.transferLeaseUntil).getTime()) return false;
      item = { ...item, transferLeaseUntil: new Date(Date.now() + DROP_TRANSFER_LEASE_MS) }; return true;
    },
    markUploadVerifying: async (_id: string, _upload: string, _now: Date, token: string) => {
      expect(token).toBe(item.transferLeaseToken); item = { ...item, state: "verifying" }; return item;
    },
    markUploadStored: stored, retryUpload: retry, markUploadFailed: fail,
  } as unknown as DropRepository;
  const append = vi.fn(async (_id: string, offset: number, length: number, source: Readable) => {
    expect(offset).toBe(receivedSize); let bytes = 0;
    for await (const chunk of source) bytes += Buffer.byteLength(chunk as Uint8Array);
    expect(bytes).toBe(length); receivedSize += bytes; return { receivedSize };
  });
  const complete = vi.fn(async () => {
    publications++; return { resource: { id: "same-resource", name: item.filename, sizeBytes: 4, sha256: "expected-sha" },
      upload: { receivedSize: 4, expectedSize: 4, status: "active", expiresAt: new Date() } };
  });
  const create = vi.fn(async (input: { idempotencyKey: string }) => {
    expect(input.idempotencyKey).toBe("drop-drain:original-drop"); return { id: "same-core-upload" };
  });
  const files = { createUpload: create, getUpload: async () => ({ receivedSize }), appendUpload: append, completeUpload: complete } as unknown as DropFileGateway;
  const buffer = { openRead: () => Readable.from([Buffer.from("abcd")]), delete: cleanup } as unknown as DropBufferStore;
  return { drain: new DropDrainService({ repository, files, buffer, workers: 1, chunkBytes: 4 }), repository, append, complete, create,
    stored, retry, fail, cleanup, revoke: () => { revoked = true; }, item: () => item, renewals: () => renewals, publications: () => publications };
}

describe("Drop transfer lease and original recovery", () => {
  afterEach(() => vi.useRealTimers());
  it("resumes only unconfirmed bytes with the same core key and preserves checksum verification", async () => {
    const f = fixture(); expect(await f.drain.drain()).toBe(1);
    expect(f.append).toHaveBeenCalledExactlyOnceWith("same-core-upload", 2, 2, expect.any(Readable));
    expect(f.stored).toHaveBeenCalledOnce(); expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.publications()).toBe(1);
  });
  it("renews during an append lasting longer than the lease, without starting a second drain", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const f = fixture(); let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const original = requireTestValue(f.append.getMockImplementation());
    f.append.mockImplementation(async (...args) => { await blocked; return original(...args); });
    const run = f.drain.drain();
    await vi.waitFor(() => expect(f.append).toHaveBeenCalledOnce());
    const overlap = f.drain.drain(); expect(overlap).toBe(run);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.renewals()).toBeGreaterThanOrEqual(9); expect(requireTestValue(f.item().transferLeaseUntil).getTime()).toBeGreaterThan(Date.now());
    release(); expect(await run).toBe(1); expect(f.stored).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not publish, retry or delete bytes after ownership is lost during append", async () => {
    const f = fixture(), original = requireTestValue(f.append.getMockImplementation());
    f.append.mockImplementation(async (...args) => { const result = await original(...args); f.revoke(); return result; });
    expect(await f.drain.drain()).toBe(1);
    expect(f.complete).not.toHaveBeenCalled(); expect(f.stored).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled(); expect(f.fail).not.toHaveBeenCalled(); expect(f.cleanup).not.toHaveBeenCalled();
  });
  it("leaves the original recoverable if completion succeeds after ownership is lost", async () => {
    const f = fixture(), original = requireTestValue(f.complete.getMockImplementation());
    f.complete.mockImplementation(async () => { const result = await original(); f.revoke(); return result; });
    await f.drain.drain(); expect(f.publications()).toBe(1); expect(f.stored).not.toHaveBeenCalled();
    expect(f.retry).not.toHaveBeenCalled(); expect(f.cleanup).not.toHaveBeenCalled();
  });
  it("fails closed when the lease renewal database call fails", async () => {
    const f = fixture(); f.repository.renewTransferLease = async () => { throw new Error("database unavailable"); };
    await f.drain.drain(); expect(f.create).not.toHaveBeenCalled(); expect(f.retry).not.toHaveBeenCalled(); expect(f.cleanup).not.toHaveBeenCalled();
  });
  it("retains the buffer on checksum mismatch and fences the failure transition", async () => {
    const f = fixture(), original = requireTestValue(f.complete.getMockImplementation());
    f.complete.mockImplementation(async () => { const result = await original(); return { ...result, resource: { ...result.resource, sha256: "wrong" } }; });
    await f.drain.drain(); expect(f.fail).toHaveBeenCalledWith("original-drop", "remote_checksum_mismatch", expect.any(Date), "owner-a");
    expect(f.stored).not.toHaveBeenCalled(); expect(f.cleanup).not.toHaveBeenCalled();
  });
  it("keeps a stored receipt final when only local cleanup fails", async () => {
    const f = fixture(); f.cleanup.mockRejectedValue(new Error("sharing violation"));
    await f.drain.drain(); expect(f.stored).toHaveBeenCalledOnce(); expect(f.retry).not.toHaveBeenCalled(); expect(f.fail).not.toHaveBeenCalled();
  });
});
