import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "./local-storage.adapter.js";
import { migrateStorageLayout, SATURN_BUSINESS_ROOT_DIRECTORIES } from "./layout.js";

async function fixture(): Promise<{ readonly root: string; readonly storage: LocalStorageAdapter }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-layout-"));
  const storage = new LocalStorageAdapter(root);
  await storage.initialize();
  await storage.mkdir("drive");
  for (const directory of ["Inbox", "Laboratory", "mastermind", "Passwords", "Sync", "Archive", "Documents", "Photos", "Projects"]) {
    await storage.mkdir(`drive/${directory}`);
  }
  await storage.mkdir("backups");
  await storage.mkdir("_system");
  return { root, storage };
}

describe("Saturn root storage layout", () => {
  it("moves known legacy roots without changing bytes and is idempotent", async () => {
    const { root, storage } = await fixture();
    try {
      await storage.write("drive/mastermind/note.md", Readable.from("hello"), { offset: 0, create: true, exclusive: true });
      const first = await migrateStorageLayout(storage, "up");
      expect(first.actions).toContain("rename:drive/mastermind->mastermind");
      expect(await storage.exists("drive")).toBe(false);
      expect(await storage.exists("mastermind/note.md")).toBe(true);
      expect(await fs.readFile(path.join(root, "mastermind", "note.md"), "utf8")).toBe("hello");
      for (const directory of SATURN_BUSINESS_ROOT_DIRECTORIES) expect(await storage.exists(directory)).toBe(true);
      expect((await migrateStorageLayout(storage, "up")).actions).toEqual([]);
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("supports a controlled rollback to the legacy layout", async () => {
    const { root, storage } = await fixture();
    try {
      await migrateStorageLayout(storage, "up");
      await storage.write("volt/passwords.kdbx", Readable.from("encrypted"), { offset: 0, create: true, exclusive: true });
      await migrateStorageLayout(storage, "down");
      expect(await storage.exists("drive/Passwords/passwords.kdbx")).toBe(true);
      expect(await storage.exists("volt")).toBe(false);
      expect(await storage.exists("backups")).toBe(true);
      expect(await storage.exists("_system")).toBe(true);
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves arbitrary root folders and canonical renames on repeated checks", async () => {
    const { root, storage } = await fixture();
    try {
      await migrateStorageLayout(storage, "up");
      await storage.mkdir("personal");
      await storage.rename("sync", "device files");
      expect((await migrateStorageLayout(storage, "up")).actions).toEqual([]);
      expect(await storage.exists("personal")).toBe(true);
      expect(await storage.exists("device files")).toBe(true);
      expect(await storage.exists("sync")).toBe(false);
      await expect(migrateStorageLayout(storage, "down")).rejects.toThrow(/original canonical name: sync/);
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for direct root files, unclassified legacy data and non-empty target collisions", async () => {
    const first = await fixture();
    try {
      await first.storage.write("drive/unclassified.bin", Readable.from("data"), { offset: 0, create: true, exclusive: true });
      await expect(migrateStorageLayout(first.storage, "up")).rejects.toThrow(/Unclassified legacy root data/);
    } finally {
      await first.storage.close();
      await fs.rm(first.root, { recursive: true, force: true });
    }
    const rootEntry = await fixture();
    try {
      await rootEntry.storage.write("unknown-root.bin", Readable.from("data"), { offset: 0, create: true, exclusive: true });
      await expect(migrateStorageLayout(rootEntry.storage, "up")).rejects.toThrow(/Files are not allowed directly/);
    } finally {
      await rootEntry.storage.close();
      await fs.rm(rootEntry.root, { recursive: true, force: true });
    }
    const second = await fixture();
    try {
      await second.storage.write("drive/mastermind/old.md", Readable.from("old"), { offset: 0, create: true, exclusive: true });
      await second.storage.mkdir("mastermind");
      await second.storage.write("mastermind/new.md", Readable.from("new"), { offset: 0, create: true, exclusive: true });
      await expect(migrateStorageLayout(second.storage, "up")).rejects.toThrow(/collision/);
    } finally {
      await second.storage.close();
      await fs.rm(second.root, { recursive: true, force: true });
    }
  });
});
