import { describe, expect, it } from "vitest";
import { browserNamespaceScopesConflict as conflict, canonicalBrowserNamespaceScopes as canonical, type BrowserNamespaceScope } from "./browser-upload-namespace-scopes.js";
const create = (name: string) => canonical([{ mode: "parent", path: "" }, { mode: "parent", path: "parent" }, { mode: "entry", path: `parent/${name}` }], true);
const subtree = (path: string) => canonical([{ mode: "subtree", path }], true);
describe("browser namespace conflict algebra (not a held coordinator)", () => {
  it("allows independent sibling creations while excluding parent move/trash/adoption", () => {
    const a = create("a.bin"), b = create("b.bin");
    expect(conflict(a, b)).toBe(false);
    expect(conflict(a, subtree("parent"))).toBe(true);
    expect(conflict(a, subtree(""))).toBe(true);
    expect(conflict(a, subtree("unrelated"))).toBe(false);
    expect(conflict(a, subtree("parent/a.bin"))).toBe(true);
  });
  it("locks both move destinations and source subtrees without prefix false positives", () => {
    const move = canonical([{ mode: "subtree", path: "parent/a" }, { mode: "subtree", path: "other/a" }], true);
    for (const path of ["parent/a/file", "other/a/file"]) expect(conflict(move, canonical([{ mode: "parent", path }], true))).toBe(true);
    expect(conflict(move, subtree("parent/ab"))).toBe(false);
    expect(conflict(move, subtree("other/ab"))).toBe(false);
  });
  it("uses one fixed case policy and keeps Unicode normalized without locale ordering", () => {
    const upper = canonical([{ mode: "entry", path: "P/É" }], false), lower = canonical([{ mode: "entry", path: "p/é" }], false);
    expect(conflict(upper, lower)).toBe(true);
    expect(upper).toEqual([{ mode: "subtree", path: "p" }]);
    expect(conflict(canonical([{ mode: "entry", path: "p/İ/file" }], false), canonical([{ mode: "entry", path: "p/i/file" }], false))).toBe(true);
    expect(conflict(canonical([{ mode: "entry", path: "P/É" }], true), canonical([{ mode: "entry", path: "p/é" }], true))).toBe(false);
    expect(() => canonical([{ mode: "entry", path: "p/e\u0301" }], true)).toThrow(/invalid/);
  });
  it("is symmetric for every mode pair and representative ancestor relationships", () => {
    const modes = ["parent", "entry", "subtree"] as const;
    for (const a of modes) for (const b of modes) for (const x of ["", "p", "p/a", "p/ab", "q"]) for (const y of ["", "p", "p/a", "p/ab", "q"]) {
      const left = canonical([{ mode: a, path: x }], true), right = canonical([{ mode: b, path: y }], true);
      expect(conflict(left, right)).toBe(conflict(right, left));
    }
  });
  it("sorts and deduplicates whole bounded sets before acquisition", () => {
    const scopes: BrowserNamespaceScope[] = [{ mode: "entry", path: "z" }, { mode: "parent", path: "" }, { mode: "entry", path: "z" }, { mode: "entry", path: "a" }];
    expect(canonical(scopes, true)).toEqual(canonical([...scopes].reverse(), true));
    expect(canonical(scopes, true)).toHaveLength(3);
    expect(Object.isFrozen(canonical(scopes, true))).toBe(true);
  });
  it("never URL-decodes internal catalog paths into aliases or ancestors", () => {
    expect(conflict(subtree("p/%2e%2e"), subtree("other"))).toBe(false);
    expect(conflict(subtree("p/%2f"), subtree("p/child"))).toBe(false);
  });
  it.each(["/absolute", "a//b", "a/../b", "a\\b", "C:/a", "a/ b", "a/\u0000", "a/", "x".repeat(4097)])("rejects noncanonical scope %s", path => {
    expect(() => canonical([{ mode: "entry", path }], true)).toThrow(/invalid/);
  });
  it("rejects unbounded/empty scope sets and excessive depth", () => {
    expect(() => canonical([], true)).toThrow(/invalid/);
    expect(() => canonical(Array.from({ length: 257 }, () => ({ mode: "entry", path: "a" })), true)).toThrow(/invalid/);
    expect(() => canonical([{ mode: "entry", path: Array(129).fill("a").join("/") }], true)).toThrow(/invalid/);
  });
});
