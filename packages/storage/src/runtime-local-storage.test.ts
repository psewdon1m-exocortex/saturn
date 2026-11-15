import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalStorageConfig } from "@saturn/config";
import { RuntimeStorageManager } from "./runtime-storage.manager.js";
import { inspectLocalCustody } from "./local-custody.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-runtime-local-")); directories.push(directory);
  const root = path.join(directory, "backend"), custodyFile = path.join(directory, "custody.json"), runtime = path.join(directory, "runtime");
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(custodyFile, JSON.stringify(await inspectLocalCustody(root, randomUUID(), randomUUID())), { mode: 0o600 });
  const config: LocalStorageConfig = { backend: "local", root, custodyFile, requireFsync: true, maxConnections: 4, operationTimeoutMs: 60_000, healthTimeoutMs: 3000 };
  const manager = new RuntimeStorageManager(config, runtime); await manager.initialize();
  return { manager, runtime, root, config };
}
describe("runtime local storage composition", () => {
  it("selects the real local adapter in the default production factory", async () => {
    const f = await fixture();
    await f.manager.write("file", Readable.from(["local"]), { offset: 0, create: true });
    expect(await fs.readFile(path.join(f.root, "file"), "utf8")).toBe("local");
    expect((await f.manager.localCustody()).receipt.root).toBe(f.root);
    await f.manager.restore(f.manager.current());
    await f.manager.close();
  });
  it("refuses both API profile changes and a disk profile replacement", async () => {
    const f = await fixture();
    await expect(f.manager.activate({ ...f.manager.current(), profileId: "replacement" })).rejects.toThrow("requalification");
    await fs.writeFile(path.join(f.runtime, "active.json"), "{}");
    await expect(f.manager.stat("")).rejects.toThrow("SFTP runtime profile");
    await f.manager.close();
  });
  it("detects root replacement even without an ACTIVE guarded manifest", async () => {
    const f = await fixture();
    await fs.rename(f.root, f.root + "-previous"); await fs.mkdir(f.root);
    await expect(f.manager.stat("")).rejects.toThrow("custody_invalid");
    await f.manager.close();
  });
});
