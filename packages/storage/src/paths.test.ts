import { describe, expect, it } from "vitest";
import { joinStoragePath, normalizeStorageName, normalizeStoragePath } from "./paths.js";

describe("storage path policy", () => {
  it("normalizes separators, Unicode and dot segments", () => {
    expect(normalizeStoragePath("drive\\Photos/./Cafe\u0301")).toBe("drive/Photos/Café");
    expect(joinStoragePath("drop point", "photo.jpg")).toBe("drop point/photo.jpg");
  });

  it.each(["../escape", "/absolute", "C:\\absolute", "folder/../../escape"])(
    "rejects unsafe path %s",
    (candidate) => expect(() => normalizeStoragePath(candidate)).toThrow(),
  );

  it("rejects separators, controls and reserved names", () => {
    expect(() => normalizeStorageName("..")) .toThrow();
    expect(() => normalizeStorageName("a/b")).toThrow();
    expect(() => normalizeStorageName("bad\u0000name")).toThrow();
  });
});
