import { requiredValue } from "./test-value.js";
import { describe, expect, it, vi } from "vitest";
import { enumerateUploadTree, validateUploadTreeName, type UploadTreeSource } from "./upload-source-tree.js";

const directory = (name: string, children: readonly UploadTreeSource[] = []): UploadTreeSource => ({ name, kind: "directory", children: async function* () { yield* children; } });
describe("real upload source tree enumeration", () => {
  it("preserves 1024 empty siblings and parent identities without reading file contents", async () => {
    const getFile = vi.fn(async () => new File(["bytes"], "данные.bin"));
    const items = await enumerateUploadTree([directory("root", [...Array.from({ length: 1024 }, (_, index) => directory(`empty-${String(index)}`)), { kind: "file", name: "данные.bin", getFile }])]);
    expect(items).toHaveLength(1026);
    expect(items.filter(item => item.kind === "directory")).toHaveLength(1025);
    expect(items.slice(1).every(item => item.parentItemId === requiredValue(items[0]).itemId)).toBe(true);
    expect(new Set(items.map(item => item.itemId)).size).toBe(items.length);
    expect(getFile).not.toHaveBeenCalled();
    expect((await requiredValue(requiredValue(items.at(-1)).getFile)()).name).toBe("данные.bin");
  });
  it.each(["..", "/absolute", "C:drive", "a\\b", "a/b", "a\0b", "trailing ", "trailing.", "CON", "NUL.txt"])("rejects unsafe or silently normalized name %j", name => { expect(() => validateUploadTreeName(name)).toThrow(); });
  it("rejects a late duplicate, directory bound, and cancelled traversal before any file read", async () => {
    await expect(enumerateUploadTree([directory("root", [directory("Case"), directory("case")])])).rejects.toThrow("case-colliding");
    await expect(enumerateUploadTree([directory("root", [directory("empty")])], { maxDirectories: 1 })).rejects.toThrow("directory limit");
    const controller = new AbortController();
    await expect(enumerateUploadTree([directory("root", [directory("empty")])], { signal: controller.signal, onEnumerated: () => controller.abort() })).rejects.toMatchObject({ name: "AbortError" });
  });
});
