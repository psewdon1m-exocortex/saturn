import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, uploadFile } from "./api.js";

afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe("ApiError", () => {
  it("shows the bounded server explanation to the authenticated operator", () => {
    const error = new ApiError(400, { code: "invalid_request", message: "Release is no longer the current update candidate" });
    expect(error.message).toBe("Release is no longer the current update candidate (HTTP 400)");
    expect(error.code).toBe("invalid_request");
  });

  it("falls back to the status when the response has no safe explanation", () => {
    expect(new ApiError(502, { message: ["not", "a", "string"] }).message).toBe("Gateway request failed with status 502");
  });

  it("uploads a file larger than 400 MiB through bounded resumable chunks", async () => {
    const size = 401 * 1024 * 1024;
    const file = {
      name: "large-backup.bin",
      size,
      lastModified: 1,
      slice: (start: number, end: number) => ({ size: end - start }) as Blob,
    } as File;
    let offset = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/uploads") && init?.method === "POST") return Response.json({ id: "upload-large", receivedSize: 0 }, { status: 201 });
      if (url.endsWith("/uploads/upload-large") && init?.method === "HEAD") return new Response(null, { status: 200, headers: { "Upload-Offset": String(offset), "Upload-Length": String(size), "Upload-Status": offset === 0 ? "created" : "uploading" } });
      if (url.endsWith("/uploads/upload-large") && init?.method === "PATCH") {
        offset += (init.body as Blob).size;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/uploads/upload-large/complete") && init?.method === "POST") return Response.json({ resource: { id: "resource-large", name: file.name, sizeBytes: size } });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const progress: number[] = [];
    const resource = await uploadFile(file, "00000000-0000-0000-0000-000000000000", undefined, (value) => progress.push(value));

    expect(resource).toMatchObject({ id: "resource-large", sizeBytes: size });
    expect(offset).toBe(size);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(51);
    expect(progress.at(-1)).toBe(1);
  });
});
