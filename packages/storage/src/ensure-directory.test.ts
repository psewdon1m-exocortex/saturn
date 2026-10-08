import { describe, expect, it } from "vitest";
import { ensureStorageDirectory } from "./ensure-directory.js";

describe("shared storage directory creation", () => {
  it("accepts a concurrent creator even when SFTP reports a generic failure", async () => {
    let created = false, checks = 0, release!: () => void;
    const checked = new Promise<void>(resolve => { release = resolve; });
    const storage = {
      exists: async () => { checks++; if (checks === 2) release(); await checked; return false; },
      mkdir: async () => { if (created) throw new Error("Failure"); created = true; },
      stat: async () => ({ type: "directory" as const, size: 0 }),
    };
    await expect(Promise.all([ensureStorageDirectory(storage, "shared"), ensureStorageDirectory(storage, "shared")])).resolves.toHaveLength(2);
    expect(created).toBe(true);
  });
  it.each(["missing", "file"])("preserves the error when the parent is %s", async kind => {
    const failure = new Error("Failure");
    const storage = { exists: async () => false, mkdir: async () => { throw failure; },
      stat: async () => { if (kind === "missing") throw new Error("Missing"); return { type: "file" as const, size: 1 }; } };
    await expect(ensureStorageDirectory(storage, "shared")).rejects.toBe(failure);
  });
});
