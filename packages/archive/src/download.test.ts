import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createDownloadArchive, type DownloadArchiveEntry } from "./download.js";

const content = Buffer.from("download bytes");
function entry(name = "file.bin"): DownloadArchiveEntry {
  return { path: `tree/${name}`, resource: { id: name, parentId: "tree", type: "file", status: "active", name,
    storagePath: `tree/${name}`, sizeBytes: content.length, sha256: createHash("sha256").update(content).digest("hex"),
    createdAt: new Date(), updatedAt: new Date() } };
}

describe("download archive failure boundaries", () => {
  it("fails before the central directory when source bytes differ from the selected version", async () => {
    const validate = vi.fn(async () => undefined);
    const zip = createDownloadArchive({ entries: [entry()], emptyRoot: "tree/", open: async () => Readable.from([Buffer.alloc(content.length)]), validate });
    await expect(zip.toArray()).rejects.toThrow("source content changed");
    expect(validate).not.toHaveBeenCalled();
  });

  it("refuses a tree changed after the last member was read", async () => {
    const zip = createDownloadArchive({ entries: [entry()], emptyRoot: "tree/", open: async () => Readable.from([content]),
      validate: async () => { throw new Error("tree version changed"); } });
    await expect(zip.toArray()).rejects.toThrow("tree version changed");
  });

  it("propagates a forbidden last member instead of producing a valid partial archive", async () => {
    const open = vi.fn(async (item: DownloadArchiveEntry) => { if (item.resource.id === "forbidden") throw new Error("forbidden member"); return Readable.from([content]); });
    const zip = createDownloadArchive({ entries: [entry(), entry("forbidden")], emptyRoot: "tree/", open, validate: async () => undefined });
    await expect(zip.toArray()).rejects.toThrow("forbidden member");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("keeps later readers unopened and closes the active source on cancellation", async () => {
    const sources: PassThrough[] = [];
    const open = vi.fn(async () => { const source = new PassThrough(); sources.push(source); return source; });
    const zip = createDownloadArchive({ entries: [entry(), entry("next"), entry("later")], emptyRoot: "tree/", open, validate: async () => undefined });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(open).toHaveBeenCalledTimes(1);
    zip.destroy(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(sources.every(source => source.destroyed)).toBe(true); expect(open).toHaveBeenCalledTimes(1);
  });

  it("closes a pending open that resolves after cancellation", async () => {
    const source = new PassThrough(); let resolveOpen!: (source: Readable) => void;
    const zip = createDownloadArchive({ entries: [entry()], emptyRoot: "tree/", open: () => new Promise<Readable>(resolve => { resolveOpen = resolve; }), validate: async () => undefined });
    zip.destroy(); resolveOpen(source); await new Promise<void>(resolve => setImmediate(resolve));
    expect(source.destroyed).toBe(true);
  });

  it.each(["../escape", "/absolute", "folder/../../escape", "C:/drive", "folder\\escape"])("rejects unsafe member %s before opening bytes", name => {
    const open = vi.fn();
    expect(() => createDownloadArchive({ entries: [{ ...entry(), path: name }], emptyRoot: "tree/", open, validate: async () => undefined })).toThrow("unsafe");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects file/folder or case collisions before opening bytes", () => {
    expect(() => createDownloadArchive({ entries: [entry("File"), entry("file")], emptyRoot: "tree/", open: vi.fn(), validate: async () => undefined })).toThrow("colliding");
  });
});

it("D-R17 progressing first archive member must not expire an unused later reader", async () => {
  const first = new PassThrough();
  const later = () => { const source = Readable.from([content]); const timer = setTimeout(() => source.destroy(new Error("physical reader idle before its member was consumed")), 100); source.once("close", () => clearTimeout(timer)); source.once("end", () => clearTimeout(timer)); return source; };
  const zip = createDownloadArchive({ entries: [entry(), entry("next.bin")], emptyRoot: "tree/", open: async item => item.resource.id === "file.bin" ? first : later(), validate: async () => undefined });
  const pump = (async () => { for (const byte of content) { await new Promise<void>(resolve => setTimeout(resolve, 30)); if (first.destroyed) break; first.write(Buffer.from([byte])); } if (!first.destroyed) first.end(); })();
  try { const bytes = Buffer.concat(await zip.toArray()); expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50); }
  finally { first.destroy(); zip.destroy(); await pump; }
});

it("D-R17 folder-output backpressure must not expire a reader between file members", async () => {
  const folders = Array.from({ length: 12000 }, (_, index): DownloadArchiveEntry => { const name = `dir-${String(index)}-${"a".repeat(180)}`; const value = entry(name); const { sha256, ...folder } = value.resource; expect(sha256).toHaveLength(64); return { path: `tree/${name}/`, resource: { ...folder, type: "folder", sizeBytes: 0 } }; });
  const zip = createDownloadArchive({ entries: [entry(), ...folders, entry("next.bin")], emptyRoot: "tree/", open: async () => { const source = Readable.from([content]); const timer = setTimeout(() => source.destroy(new Error("physical reader idle between file members")), 100); source.once("close", () => clearTimeout(timer)); source.once("end", () => clearTimeout(timer)); return source; }, validate: async () => undefined });
  try { await new Promise<void>(resolve => setTimeout(resolve, 200)); const bytes = Buffer.concat(await zip.toArray()); expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50); expect(bytes.readUInt16LE(bytes.length - 12)).toBe(12002); }
  finally { zip.destroy(); }
});
