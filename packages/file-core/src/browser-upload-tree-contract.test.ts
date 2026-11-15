import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateBrowserTreeJob, validateBrowserTreePath } from "./browser-upload-tree-contract.js";
const directory = () => ({ kind: "directory", itemId: randomUUID(), parentItemId: null, relativePath: "root" });
const envelope = (items: unknown[]) => ({ schema: "saturn.browser-tree-job.v1", jobId: randomUUID(), items });
describe("bounded browser tree contract", () => {
  it("includes empty directories and binds immutable content/parent/representation", () => {
    const parent = directory(), bytes = Buffer.from("content");
    const input = envelope([parent, { kind: "file", itemId: randomUUID(), parentItemId: parent.itemId, relativePath: "root/data.bin", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: bytes.toString("base64") }]);
    const checked = validateBrowserTreeJob(input);
    expect(checked).toMatchObject({ files: 1, directories: 1, payloadBytes: 7 });
    expect(validateBrowserTreeJob(JSON.parse(JSON.stringify(input))).intentSha256).toBe(checked.intentSha256);
    expect(Object.isFrozen(checked.value.items[1])).toBe(true);
  });
  it.each(["../x", "/absolute", "C:/x", "\\\\server\\share", "root/%2e%2e", "root//x", "root/a\\b", "root/a ", "root/NUL", "root/a\0b"])("rejects path %j", path => { expect(() => validateBrowserTreePath(path)).toThrow(); });
  it("rejects an invalid last item, duplicate/case paths, file parent and over-bound jobs", () => {
    const root = directory();
    expect(() => validateBrowserTreeJob(envelope([root, { ...directory(), relativePath: "ROOT" }]))).toThrow(/Duplicate/);
    expect(() => validateBrowserTreeJob(envelope([root, { kind: "file", itemId: randomUUID(), parentItemId: root.itemId, relativePath: "root/bad", sizeBytes: 1, sha256: "a".repeat(64), contentBase64: "eA==" }]))).toThrow(/mismatch/);
    expect(() => validateBrowserTreeJob(envelope(Array.from({ length: 17 }, directory)))).toThrow(/bounded/);
    expect(() => validateBrowserTreeJob({ ...envelope([root]), authority: "owner" })).toThrow(/field/);
    const parentFile = { kind: "file", itemId: randomUUID(), parentItemId: null, relativePath: "file", sizeBytes: 0, sha256: createHash("sha256").digest("hex"), contentBase64: "" };
    expect(() => validateBrowserTreeJob(envelope([parentFile, { ...directory(), parentItemId: parentFile.itemId, relativePath: "file/child" }]))).toThrow(/directory/);
    expect(() => validateBrowserTreeJob(envelope([root, { ...directory(), parentItemId: root.itemId, relativePath: "other/child" }]))).toThrow(/directory/);
  });
});
