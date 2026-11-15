import { describe, expect, it, vi } from "vitest";
import { FileController, parseRange } from "./file.controller.js";

describe("file preview byte ranges", () => {
  it("serves bounded and suffix ranges used by browser video players", () => {
    expect(parseRange("bytes=1024-2047", 4096)).toEqual({ offset: 1024, length: 1024, partial: true });
    expect(parseRange("bytes=-512", 4096)).toEqual({ offset: 3584, length: 512, partial: true });
    expect(parseRange(undefined, 4096)).toEqual({ offset: 0, partial: false });
  });

  it("rejects a range outside the stored object", () => {
    expect(() => parseRange("bytes=4096-4097", 4096)).toThrow(/Range is invalid/);
  });

  it.each(["download", "preview"] as const)("%s returns 416 without opening content for an unsatisfiable range", async (method) => {
    const files = { getResource: vi.fn().mockResolvedValue({ id: "file", storagePath: "fixture/file.txt", sizeBytes: 8, mimeType: "text/plain", name: "file.txt" }), openDownload: vi.fn() };
    const reply = { header: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    const controller = new FileController(files as never, {} as never, {} as never);
    await controller[method]("file", "bytes=9-", {} as never, reply as never);
    expect(reply.status).toHaveBeenCalledWith(416);
    expect(reply.header).toHaveBeenCalledWith("Content-Range", "bytes */8");
    expect(reply.send).toHaveBeenCalledWith({ code: "range_not_satisfiable" });
    expect(files.openDownload).not.toHaveBeenCalled();
  });
});
