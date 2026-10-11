import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "./local-storage.adapter.js";
import { migrateStorageLayout, SATURN_BUSINESS_ROOT_DIRECTORIES } from "./layout.js";

async function legacyFixture(): Promise<{ readonly root: string; readonly storage: LocalStorageAdapter }> {
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

async function v2Fixture(): Promise<{ readonly root: string; readonly storage: LocalStorageAdapter }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-layout-v2-"));
  const storage = new LocalStorageAdapter(root);
  await storage.initialize();
  for (const directory of ["drop point", "laboratory", "backups", "mastermind", "volt", "sync", "_system"]) await storage.mkdir(directory);
  return { root, storage };
}

describe("Saturn root storage layout", () => {
  it("migrates legacy and v2 roots to v3 without changing bytes", async () => {
    const { root, storage } = await legacyFixture();
    try {
      await storage.write("drive/mastermind/note.md", Readable.from("hello"), { offset: 0, create: true, exclusive: true });
      await storage.mkdir("backups/pluto");
      await storage.mkdir("backups/pluto/Outdoor server");
      await storage.write("backups/pluto/Outdoor server/config.ini", Readable.from("safe"), { offset: 0, create: true, exclusive: true });
      const first = await migrateStorageLayout(storage, "up");
      expect(first.version).toBe(3);
      expect(first.actions).toContain("rename:mastermind-># mastermind");
      expect(await storage.exists("drive")).toBe(false);
      expect(await fs.readFile(path.join(root, "# mastermind", "note.md"), "utf8")).toBe("hello");
      expect(await fs.readFile(path.join(root, "# sync outdoor connections", "Outdoor server", "config.ini"), "utf8")).toBe("safe");
      expect(await storage.exists("# sync inner services/pluto")).toBe(false);
      for (const directory of SATURN_BUSINESS_ROOT_DIRECTORIES) expect(await storage.exists(directory)).toBe(true);
      expect((await migrateStorageLayout(storage, "up")).actions).toEqual([]);
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rolls v3 back to v2 while preserving direct Pluto connections", async () => {
    const { root, storage } = await v2Fixture();
    try {
      await storage.mkdir("backups/pluto");
      await storage.mkdir("backups/pluto/Remote");
      await storage.write("backups/pluto/Remote/data.bin", Readable.from("payload"), { offset: 0, create: true, exclusive: true });
      await storage.write("volt/passwords.kdbx", Readable.from("encrypted"), { offset: 0, create: true, exclusive: true });
      await migrateStorageLayout(storage, "up");
      const result = await migrateStorageLayout(storage, "down");
      expect(result.version).toBe(2);
      expect(await storage.exists("backups/pluto/Remote/data.bin")).toBe(true);
      expect(await storage.exists("volt/passwords.kdbx")).toBe(true);
      expect(await storage.exists("# sync outdoor connections")).toBe(false);
      expect(await storage.exists("# references")).toBe(false);
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for collisions and non-empty references rollback", async () => {
    const first = await v2Fixture();
    try {
      await first.storage.write("mastermind/old.md", Readable.from("old"), { offset: 0, create: true, exclusive: true });
      await first.storage.mkdir("# mastermind");
      await first.storage.write("# mastermind/new.md", Readable.from("new"), { offset: 0, create: true, exclusive: true });
      await expect(migrateStorageLayout(first.storage, "up")).rejects.toThrow(/collision/);
    } finally {
      await first.storage.close();
      await fs.rm(first.root, { recursive: true, force: true });
    }
    const second = await v2Fixture();
    try {
      await migrateStorageLayout(second.storage, "up");
      await second.storage.write("# references/keep.txt", Readable.from("keep"), { offset: 0, create: true, exclusive: true });
      await expect(migrateStorageLayout(second.storage, "down")).rejects.toThrow(/# references to be empty/);
    } finally {
      await second.storage.close();
      await fs.rm(second.root, { recursive: true, force: true });
    }
  });

  it("fails closed for direct root files and unclassified legacy data", async () => {
    const first = await legacyFixture();
    try {
      await first.storage.write("drive/unclassified.bin", Readable.from("data"), { offset: 0, create: true, exclusive: true });
      await expect(migrateStorageLayout(first.storage, "up")).rejects.toThrow(/Unclassified legacy root data/);
    } finally {
      await first.storage.close();
      await fs.rm(first.root, { recursive: true, force: true });
    }
    const second = await v2Fixture();
    try {
      await second.storage.write("unknown-root.bin", Readable.from("data"), { offset: 0, create: true, exclusive: true });
      await expect(migrateStorageLayout(second.storage, "up")).rejects.toThrow(/Files are not allowed directly/);
    } finally {
      await second.storage.close();
      await fs.rm(second.root, { recursive: true, force: true });
    }
  });
});
