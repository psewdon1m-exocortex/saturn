import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadDropFile, uploadFile } from "./api.js";
vi.mock("./upload-sha256.js", () => ({ uploadSourceHasher: { hash: vi.fn(async () => "a".repeat(64)) } }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); window.sessionStorage.clear(); window.localStorage.clear(); window.history.replaceState({}, "", "/"); });
const dropStatus = { id: "stable-drop", state: "uploading", expectedSize: 1, receivedSize: 0, completed: false };

describe("upload admission recovery", () => {
  it("does not reserve a Drop upload after cancellation before admission", async () => {
    const controller = new AbortController(); controller.abort();
    const fetchMock = vi.fn(async () => Response.json(dropStatus));
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadDropFile(new File(["x"], "x"), vi.fn(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["owner", "drop"])("replays a lost %s create reply with the original key and body", async channel => {
    const creates: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/uploads") && init.method === "POST") {
        creates.push(init);
        if (creates.length === 1) throw new TypeError("create committed; response lost");
        return Response.json(channel === "owner" ? { id: "stable-owner", receivedSize: 0 } : dropStatus);
      }
      if (init.method === "HEAD") return new Response(null, { headers: { "Upload-Offset": "0", "Upload-Length": "1", "Upload-Status": "created" } });
      if (init.method === "PATCH") return new Response(null, { status: 204 });
      if (url.endsWith("/complete")) return Response.json(channel === "owner" ? { resource: { id: "resource" } } : { upload: { ...dropStatus, state: "buffered" } });
      throw new Error(`Unexpected request ${url}`);
    }));
    const file = new File(["x"], "x");
    if (channel === "owner") await uploadFile(file, "parent", undefined, vi.fn());
    else await uploadDropFile(file, vi.fn(), { channelId: "test-channel" });
    expect(creates).toHaveLength(2);
    expect(new Headers(creates[0]?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(new Headers(creates[1]?.headers).get("Idempotency-Key")).toBe(new Headers(creates[0]?.headers).get("Idempotency-Key"));
    expect(creates[1]?.body).toBe(creates[0]?.body);
  });

  it("passes cancellation to Drop admission and performs no follow-up mutation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit = {}) => {
      expect(init.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadDropFile(new File(["x"], "x"), vi.fn(), { signal: controller.signal, channelId: "test-channel" })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an authorization refusal as a network failure", async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: "revoked" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadDropFile(new File(["x"], "x"), vi.fn(), { channelId: "test-channel" })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
vi.mock("./upload-recovery-durable.js", async () => (await import("./upload-recovery-test-backend.js")).recoveryUnitBackend());
