import { deflateRawSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";
import type { Resource } from "@saturn/file-core";
import { packageArchiveReservation, PackageByteReservation } from "./package-reservation.js";

const entry = (name: string, size = 0, folder = false) => ({ path: name, resource: { type: folder ? "folder" : "file", sizeBytes: size } as Resource });
describe("package byte reservation", () => {
  it("covers actual incompressible ZIP64, UTF8 names and empty directories", async () => {
    const data = randomBytes(512 * 1024), entries = [entry("empty/", 0, true), entry("Каталог/雪.bin", data.length), entry("zero", 0)];
    const upper = packageArchiveReservation(entries), limit = new PackageByteReservation(upper), zip = new ZipFile();
    const received = (async () => { let bytes = 0; const hash = createHash("sha256"); for await (const chunk of zip.outputStream as Readable) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); limit.accept(data.length); bytes += data.length; hash.update(data); } return { bytes, sha256: hash.digest("hex") }; })();
    zip.addEmptyDirectory("empty/"); zip.addBuffer(data, "Каталог/雪.bin"); zip.addBuffer(Buffer.alloc(0), "zero"); zip.end({ forceZip64Format: true, comment: "" });
    const result = await received; expect(result.bytes).toBeGreaterThan(data.length); expect(result.bytes).toBeLessThanOrEqual(upper); expect(result.sha256).toHaveLength(64);
  });
  it("refuses a chunk before any byte crosses the physical reservation", () => {
    const limit = new PackageByteReservation(8); let delivered = 0;
    const write = (bytes: number) => { limit.accept(bytes); delivered += bytes; };
    write(5); expect(() => write(4)).toThrow("reservation"); expect(delivered).toBe(5); write(3); expect(delivered).toBe(8);
  });
  it.each(["../outside", "/absolute", "a/../b", "a\\b", "a\u0000b", "e\u0301.txt"])("refuses unsafe or noncanonical member %s", name => {
    expect(() => packageArchiveReservation([entry(name)])).toThrow();
  });
  it("refuses case collisions before opening any source", () => { expect(() => packageArchiveReservation([entry("File.txt"), entry("file.txt")])).toThrow("colliding"); });
  it("checks arithmetic before reserving archive bytes", () => { expect(() => packageArchiveReservation([entry("large", Number.MAX_SAFE_INTEGER)])).toThrow(); });
});

it("D-R17 valid4GiB ZIP64 corpus fits unchanged5GiB package custody", () => {
  const entries = [entry("данные-α.bin", 2 * 1024 ** 3), entry("雪-β.bin", 2 * 1024 ** 3 + 1), entry("long-" + "a".repeat(170) + ".bin", 1), entry("пустой_目录/", 0, true), entry("empty-second/", 0, true)];
  const upper = packageArchiveReservation(entries);
  expect(upper).toBeGreaterThan(4 * 1024 ** 3 + 2);
  expect(upper).toBeLessThanOrEqual(5 * 1024 ** 3);
});
it.each([[15,8,6],[15,1,9],[9,2,9],[15,9,1],[15,8,0]])("D-R17 physical raw deflate window%i/memory%i/level%i stays inside reservation", (windowBits, memLevel, level) => {
  const bytes = randomBytes(1024 * 1024 + 1), upper = packageArchiveReservation([entry("雪.bin", bytes.length)]), limit = new PackageByteReservation(upper);
  const actual = deflateRawSync(bytes, { windowBits: windowBits, memLevel, level });
  expect(actual.length).toBeLessThanOrEqual(upper); expect(() => limit.accept(actual.length)).not.toThrow();
});
