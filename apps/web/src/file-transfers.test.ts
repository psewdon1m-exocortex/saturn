import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadUrl, folderDownloadUrl, publicShareApi, resumeOwnerUpload, uploadDropFile } from "./api.js";

afterEach(() => { window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const status = { id: "test-upload", state: "uploading", expectedSize: 6, receivedSize: 0, completed: false, expiresAt: new Date(Date.now() + 60_000).toISOString() };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
describe("Drop browser transfer recovery", () => {
  it("starts an explicit download with a new identity while preserving preview URLs", () => {
    const first = new URL(downloadUrl("valuable-file"), "https://saturn.test");
    const retry = new URL(downloadUrl("valuable-file"), "https://saturn.test");
    expect(first.searchParams.get("transferId")).toMatch(/^[a-f0-9-]{36}$/);
    expect(retry.searchParams.get("transferId")).not.toBe(first.searchParams.get("transferId"));
    expect(new URL(folderDownloadUrl("folder"), "https://saturn.test").searchParams.get("transferId")).toBeTruthy();
    expect(downloadUrl("valuable-file", true)).toBe("/api/v1/files/valuable-file/preview");
    expect(publicShareApi.contentUrl("share", "file")).toBe("/api/v1/public/shares/share/content/file");
    expect(new URL(publicShareApi.contentUrl("share", "file", true), "https://saturn.test").searchParams.get("transferId")).toBeTruthy();
    expect(new URL(publicShareApi.packageUrl("share"), "https://saturn.test").searchParams.get("transferId")).toBeTruthy();
  });
  it("validates a detached source before unpausing the server task", async () => {
    window.sessionStorage.setItem("saturnOwnerUploadsV1", JSON.stringify([{ id: "paused-source", filename: "original.bin", expectedSize: 6, lastModified: 123, parentId: "folder" }]));
    const resume = vi.fn();
    await expect(resumeOwnerUpload("paused-source", new File(["saturn"], "wrong.bin", { lastModified: 123 }), vi.fn(), resume)).rejects.toThrow("Select the original");
    expect(resume).not.toHaveBeenCalled();
  });
  it("reports the server identity before streaming and aborts without retrying a cancelled body", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return json(status);
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const created = vi.fn();
    await expect(uploadDropFile(new File(["saturn"], "value.bin"), vi.fn(), { signal: controller.signal, onCreated: created })).rejects.toMatchObject({ name: "AbortError" });
    expect(created).toHaveBeenCalledWith(status);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("uses the authoritative buffered result when the completion acknowledgement is lost", async () => {
    let completed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/complete")) { completed = true; throw new TypeError("connection lost"); }
      if (url.endsWith("/status")) return json({ ...status, state: "stored", receivedSize: 6, completed });
      if (init?.method === "PATCH") return new Response(null, { status: 204 });
      return json(status);
    }));
    await expect(uploadDropFile(new File(["saturn"], "value.bin"), vi.fn())).resolves.toMatchObject({ state: "stored", receivedSize: 6 });
  });
});
