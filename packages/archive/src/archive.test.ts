import { describe, expect, it } from "vitest";
import { archiveFormatForResource, archiveOutputFolderName, normalizeArchiveOutputName } from "./service.js";
import { validatePortableMemberPath, validateSevenZipListing } from "./runner.js";

describe("archive names", () => {
  it("normalizes ZIP output and extraction directory names", () => {
    expect(normalizeArchiveOutputName("release")).toBe("release.zip");
    expect(normalizeArchiveOutputName("release.ZIP")).toBe("release.ZIP");
    expect(archiveOutputFolderName("photos.rar")).toBe("photos");
  });

  it("recognizes ZIP and RAR without trusting only one signal", () => {
    const base = { type: "file" as const, mimeType: "application/octet-stream" };
    expect(archiveFormatForResource({ ...base, name: "a.zip" })).toBe("zip");
    expect(archiveFormatForResource({ ...base, name: "a.rar" })).toBe("rar");
    expect(archiveFormatForResource({ ...base, name: "a.exe" })).toBeUndefined();
  });
});

describe("portable archive paths", () => {
  it("accepts nested portable members", () => {
    expect(validatePortableMemberPath("photos/2026/image.jpg")).toBe("photos/2026/image.jpg");
  });

  it.each(["../secret", "/absolute", "C:/windows", "a\\b", "a//b", "./file", "bad\0name"])("rejects unsafe member %s", (member) => {
    expect(() => validatePortableMemberPath(member)).toThrow();
  });
});

describe("7-Zip RAR inventory", () => {
  const limits = { maxEntries: 10, maxMemberBytes: 1_000, maxExtractedBytes: 2_000, maxCompressionRatio: 100 };

  it("totals a safe listing before extraction", () => {
    const listing = "Path = photos\\one.jpg\nSize = 40\nPacked Size = 20\nAttributes = A\n\nPath = notes.md\nSize = 10\nPacked Size = 8\nAttributes = A";
    expect(validateSevenZipListing(listing, limits)).toBe(50);
  });

  it("rejects traversal, duplicate and linked members", () => {
    expect(() => validateSevenZipListing("Path = ..\\secret\nSize = 1\nPacked Size = 1", limits)).toThrow();
    expect(() => validateSevenZipListing("Path = same\nSize = 1\nPacked Size = 1\n\nPath = same\nSize = 1\nPacked Size = 1", limits)).toThrow(/duplicate/i);
    expect(() => validateSevenZipListing("Path = linked\nSize = 1\nPacked Size = 1\nSymbolic Link = target", limits)).toThrow(/unsafe/i);
  });
});
