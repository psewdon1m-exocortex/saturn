import { afterEach, expect, it, vi } from "vitest";
import { uploadDropFile, uploadFile } from "./api.js";
const durable = vi.hoisted(() => ({ list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(async () => undefined) }));
vi.mock("./upload-recovery-durable.js", () => ({ listDurableUploadRecovery: durable.list, saveDurableUploadRecovery: durable.save, removeDurableUploadRecovery: durable.remove, removeDurableUploadRecoveries: durable.remove, hydrateUploadRecovery: vi.fn(async () => undefined) }));
vi.mock("./upload-sha256.js", () => ({ uploadSourceHasher: { hash: vi.fn(async () => "a".repeat(64)) } }));
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it.each(["owner", "drop"])("does not send %s admission until the durable transaction completes", async channel => {
  let commit!: () => void;
  const committed = new Promise<void>(resolve => { commit = resolve; });
  durable.save.mockImplementationOnce(() => committed).mockResolvedValue(undefined);
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/uploads")) return Response.json({ id: "original", state: "uploading", expectedSize: 1, receivedSize: 0 });
    if (init.method === "HEAD") return new Response(null, { headers: { "Upload-Offset": "0", "Upload-Length": "1", "Upload-Status": "created" } });
    if (init.method === "PATCH") return new Response(null, { status: 204 });
    return Response.json(channel === "owner" ? { resource: { id: "result" } } : { upload: { id: "original", state: "stored", expectedSize: 1, receivedSize: 1 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const file = new File(["x"], "source.bin");
  const uploading = channel === "owner" ? uploadFile(file, "parent", undefined, vi.fn()) : uploadDropFile(file, vi.fn(), { channelId: "channel" });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock, "admission must wait for strict IndexedDB commit, not only an in-page storage write").not.toHaveBeenCalled();
    expect(durable.save).toHaveBeenCalledTimes(1);
  } finally { commit(); await uploading; }
  expect(fetchMock).toHaveBeenCalled();
});
it.each(["owner", "drop"])("does not send %s admission when strict commit fails", async channel => {
  durable.save.mockRejectedValueOnce(new DOMException("Durable storage is full", "QuotaExceededError"));
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const file = new File(["x"], "source.bin");
  const uploading = channel === "owner" ? uploadFile(file, "parent", undefined, vi.fn()) : uploadDropFile(file, vi.fn(), { channelId: "channel" });
  await expect(uploading).rejects.toThrow("Durable storage is full");
  expect(fetchMock).not.toHaveBeenCalled();
});
