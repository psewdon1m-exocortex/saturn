import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "./local-storage.adapter.js";

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("LocalStorageAdapter contract", () => {
  it("supports create, offset resume, range, list, copy, rename and delete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-local-storage-"));
    const adapter = new LocalStorageAdapter(root);
    try {
      await adapter.initialize();
      await adapter.mkdir("drive");
      await adapter.write("drive/file.bin", Readable.from(Buffer.from("hello")), {
        offset: 0,
        create: true,
        exclusive: true,
      });
      await adapter.write("drive/file.bin", Readable.from(Buffer.from(" world")), {
        offset: 5,
        create: false,
      });
      expect((await adapter.stat("drive/file.bin")).size).toBe(11);
      await adapter.truncate("drive/file.bin", 11);
      expect((await adapter.stat("drive/file.bin")).size).toBe(11);
      expect((await collect(await adapter.openRead("drive/file.bin", { offset: 6, length: 5 }))).toString()).toBe("world");
      const digest = createHash("sha256").update(await collect(await adapter.openRead("drive/file.bin"))).digest("hex");
      expect(digest).toBe(createHash("sha256").update("hello world").digest("hex"));
      await adapter.copy("drive/file.bin", "drive/copy.bin");
      await adapter.rename("drive/copy.bin", "drive/renamed.bin");
      expect((await adapter.list("drive", undefined, 1)).nextCursor).toBeTruthy();
      expect(await adapter.exists("drive/renamed.bin")).toBe(true);
      await adapter.delete("drive/renamed.bin");
      expect(await adapter.exists("drive/renamed.bin")).toBe(false);
      expect((await adapter.statFs()).availableBytes).toBeGreaterThan(0);
    } finally {
      await adapter.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses symbolic links instead of following them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-local-symlink-"));
    const adapter = new LocalStorageAdapter(root);
    try {
      await adapter.initialize();
      await fs.writeFile(path.join(root, "target"), "data");
      try {
        await fs.symlink(path.join(root, "target"), path.join(root, "link"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      await expect(adapter.stat("link")).rejects.toThrow(/Symbolic links/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
