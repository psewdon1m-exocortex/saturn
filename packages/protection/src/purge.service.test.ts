import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "@saturn/storage";
import { PurgeService, type PurgeCandidate, type PurgeRepository } from "./purge.service.js";

class MemoryPurgeRepository implements PurgeRepository {
  readonly candidates: PurgeCandidate[] = [];
  readonly purged: PurgeCandidate[] = [];
  async listCandidates(_now: Date, limit: number) { return this.candidates.slice(0, limit); }
  async markPurged(candidate: PurgeCandidate) { this.purged.push(candidate); }
}

describe("PurgeService", () => {
  it("is fail-closed while disabled", async () => {
    const repository = new MemoryPurgeRepository();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-purge-disabled-"));
    const storage = new LocalStorageAdapter(root);
    try {
      expect(await new PurgeService(repository, storage, false).run()).toEqual({ state: "disabled", purged: 0 });
      expect(repository.purged).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("deletes only repository-selected version and trash trees when enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-purge-enabled-"));
    const storage = new LocalStorageAdapter(root);
    const repository = new MemoryPurgeRepository();
    try {
      await storage.initialize();
      await storage.mkdir("versions");
      await storage.write("versions/old.bin", Readable.from("old"), { offset: 0, create: true, exclusive: true });
      await storage.mkdir("trash");
      await storage.mkdir("trash/resource");
      await storage.write("trash/resource/file.bin", Readable.from("trash"), { offset: 0, create: true, exclusive: true });
      repository.candidates.push(
        { kind: "version", id: "version", resourceId: "resource", storagePath: "versions/old.bin" },
        { kind: "trash", id: "resource", resourceId: "resource", storagePath: "trash/resource" },
      );
      expect(await new PurgeService(repository, storage, true).run()).toEqual({ state: "complete", purged: 2 });
      expect(await storage.exists("versions/old.bin")).toBe(false);
      expect(await storage.exists("trash/resource")).toBe(false);
      expect(repository.purged).toHaveLength(2);
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
