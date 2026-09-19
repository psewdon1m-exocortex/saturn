import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { backupReceipt, savedBackup, readUpdateBytes } from "./update-backup.js";

describe("saved-copy update protocol", () => {
  const archive = Buffer.from("PK\x03\x04synthetic-builder-output");
  const token = "synthetic-control-token-only-for-tests";
  it("returns the same bytes and binds them to head, version and signature", () => {
    const signed = backupReceipt(archive, "saturn.zip", "saturn", "saturn", "0.1.17", token);
    const request = savedBackup(archive, signed, token, "saturn", "saturn");
    expect(request.version).toBe("0.1.17");
    expect(Buffer.from(request.backup.data_base64, "base64")).toEqual(archive);
    expect(request.operator_saved).toBe(true);
    expect(() => savedBackup(archive, signed, "wrong", "saturn", "saturn")).toThrow("signature");
    expect(() => savedBackup(archive, signed, token, "kernel", "saturn")).toThrow("match");
    expect(() => savedBackup(Buffer.from("changed"), signed, token, "saturn", "saturn")).toThrow("match");
  });
  it("bounds stream uploads and rejects JSON masquerading as ZIP bytes", async () => {
    expect(await readUpdateBytes(Readable.from([archive]))).toEqual(archive);
    await expect(readUpdateBytes({ data: "not raw bytes" })).rejects.toThrow("application/octet-stream");
    expect(() => backupReceipt(Buffer.from("json"), "bad.zip", "saturn", "saturn", "0.1.17", token)).toThrow("standard ZIP");
  });
});
