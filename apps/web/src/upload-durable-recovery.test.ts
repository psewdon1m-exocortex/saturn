import { requiredValue } from "./test-value.js";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { listUploadRecovery, saveUploadRecovery, type UploadRecoveryRecord } from "./upload-recovery-store.js";
import { dropApi, resumeOwnerUpload, uploadDropFile, uploadFile } from "./api.js";
import { uploadSourceHasher } from "./upload-sha256.js";

vi.mock("./upload-sha256.js", () => ({ uploadSourceHasher: { hash: async (file: Blob) => {
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(file); });
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
} } }));
afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const fingerprint = createHash("sha256").update("original").digest("hex");
function pausedRecord(): UploadRecoveryRecord {
  const operationId = crypto.randomUUID();
  return { schema: 2, channel: "owner", parentId: "parent", operationId, idempotencyKey: `web-upload-${operationId}`, id: "paused-original", filename: "same.bin", expectedSize: 8, lastModified: 123, sha256: fingerprint, createdAt: Date.now() };
}
it.each(["owner", "drop"])("preserves %s admission identity after every create reply is lost and module reload", async channel => {
  const admissions: RequestInit[] = [];
  let lost = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/uploads") && init.method === "POST") {
      admissions.push(init);
      // Server can commit before the first response, so recovery must already exist.
      expect(listUploadRecovery()).toHaveLength(1);
      expect(listUploadRecovery()[0]?.idempotencyKey).toBe(new Headers(init.headers).get("Idempotency-Key"));
      if (lost) throw new TypeError("committed; response lost");
      return Response.json({ id: "original-server-id", state: "uploading", expectedSize: 8, receivedSize: 0 });
    }
    if (init.method === "HEAD") return new Response(null, { headers: { "Upload-Offset": "0", "Upload-Length": "8", "Upload-Status": "created" } });
    if (init.method === "PATCH") return new Response(null, { status: 204 });
    if (url.endsWith("/complete")) return Response.json(channel === "owner" ? { resource: { id: "resource" } } : { upload: { id: "original-server-id", state: "stored", expectedSize: 8, receivedSize: 8 } });
    throw new Error(`Unexpected request ${url}`);
  }));
  const file = new File(["original"], "same.bin", { lastModified: 123 });
  const invoke = (module: { uploadFile: typeof uploadFile; uploadDropFile: typeof uploadDropFile }) => channel === "owner"
    ? module.uploadFile(file, "parent", undefined, vi.fn()) : module.uploadDropFile(file, vi.fn(), { channelId: "drop-channel" });
  await expect(invoke({ uploadFile, uploadDropFile })).rejects.toThrow(/response lost/);
  expect(admissions).toHaveLength(3);
  lost = false;
  vi.resetModules();
  const reloaded = await import("./api.js");
  await invoke(reloaded);
  expect(admissions).toHaveLength(4);
  expect(new Set(admissions.map(init => new Headers(init.headers).get("Idempotency-Key"))).size).toBe(1);
  expect(new Set(admissions.map(init => init.body)).size).toBe(1);
  const body:unknown=JSON.parse(requiredValue(admissions[0]).body as string);expect(body).toMatchObject({expectedSha256:fingerprint});
  expect(listUploadRecovery()).toHaveLength(0);
});
it("rejects changed bytes with identical name/size/mtime before unpausing or sending any request", async () => {
  saveUploadRecovery(pausedRecord());
  const fetchMock = vi.fn(), unpause = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(resumeOwnerUpload("paused-original", new File(["modified"], "same.bin", { lastModified: 123 }), vi.fn(), unpause)).rejects.toThrow(/SHA-256/);
  expect(unpause).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  expect(listUploadRecovery()).toHaveLength(1);
});
it("does not admit when durable recovery metadata cannot be saved", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Storage unavailable", "QuotaExceededError"); });
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(uploadFile(new File(["original"], "same.bin"), "parent", undefined, vi.fn())).rejects.toThrow(/Storage unavailable/);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("fails closed for legacy records whose same-name source never had a full fingerprint", async () => {
  sessionStorage.setItem("saturnOwnerUploadsV1", JSON.stringify([{ id: "old", filename: "same.bin", expectedSize: 8, lastModified: 123, parentId: "parent" }]));
  const unpause = vi.fn(), fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  await expect(resumeOwnerUpload("old", new File(["modified"], "same.bin", { lastModified: 123 }), vi.fn(), unpause)).rejects.toThrow(/no saved SHA-256/);
  expect(unpause).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
});
it("recovers the original completed upload after all completion acknowledgements were lost", async () => {
  saveUploadRecovery(pausedRecord());
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push(`${String(init.method)} ${url}`);
    if (init.method === "HEAD") return new Response(null, { headers: { "Upload-Offset": "8", "Upload-Length": "8", "Upload-Status": "active" } });
    if (url.endsWith("/paused-original/complete")) return Response.json({ resource: { id: "existing-resource", currentVersionId: "existing-version" } });
    throw new Error("Must not create/append to the original completed upload");
  }));
  await expect(resumeOwnerUpload("paused-original", new File(["original"], "same.bin", { lastModified: 123 }), vi.fn())).resolves.toMatchObject({ id: "existing-resource", currentVersionId: "existing-version" });
  expect(requests).toHaveLength(2); expect(listUploadRecovery()).toHaveLength(0);
});
it("only retires a Drop recovery identity after matching authoritative channel/id/size confirmation", async () => {
  const operationId = crypto.randomUUID();
  saveUploadRecovery({ schema: 2, channel: "drop", channelId: "original-channel", operationId, idempotencyKey: `drop-web-${operationId}`, id: "original-upload", filename: "x", expectedSize: 8, lastModified: 1, sha256: fingerprint, createdAt: Date.now() });
  let expectedSize = 9;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "original-upload", state: "stored", expectedSize })));
  await dropApi.status("original-upload", undefined, "original-channel"); expect(listUploadRecovery()).toHaveLength(1);
  expectedSize = 8;
  await dropApi.status("original-upload", undefined, "other-channel"); expect(listUploadRecovery()).toHaveLength(1);
  await dropApi.status("original-upload", undefined, "original-channel"); expect(listUploadRecovery()).toHaveLength(0);
});
it("reconciles a full Drop backlog before reading a new source and keeps four spare durable slots", async () => {
  const statuses: Array<{ id: string; state: string; expectedSize: number; receivedSize: number }> = [];
  for (let i = 0; i < 124; i++) {
    const operationId = crypto.randomUUID(), id = `buffered-${String(i)}`;
    saveUploadRecovery({ schema: 2, channel: "drop", channelId: "channel", operationId, idempotencyKey: `drop-web-${operationId}`, id, filename: `old-${String(i)}`, expectedSize: 8, lastModified: 1, sha256: fingerprint, createdAt: Date.now() });
    statuses.push({ id, state: "stored", expectedSize: 8, receivedSize: 8 });
  }
  vi.spyOn(uploadSourceHasher, "hash").mockImplementation(async () => { expect(listUploadRecovery()).toHaveLength(0); return fingerprint; });
  const order: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    order.push(init.method ?? "GET");
    if (url.endsWith("/uploads") && init.method === undefined) return Response.json(statuses);
    if (url.endsWith("/uploads") && init.method === "POST") return Response.json({ id: "new", state: "uploading", expectedSize: 8, receivedSize: 0 });
    if (init.method === "PATCH") return new Response(null, { status: 204 });
    if (url.endsWith("/complete")) return Response.json({ upload: { id: "new", state: "stored", expectedSize: 8, receivedSize: 8 } });
    throw Error("Unexpected request");
  }));
  await uploadDropFile(new File(["original"], "new", { lastModified: 1 }), vi.fn(), { channelId: "channel" });
  expect(order).toEqual(["GET", "POST", "PATCH", "POST"]); expect(listUploadRecovery()).toHaveLength(0);
});
vi.mock("./upload-recovery-durable.js", async () => (await import("./upload-recovery-test-backend.js")).recoveryUnitBackend());
