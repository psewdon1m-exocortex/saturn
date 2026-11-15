import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SaturnConfig } from "@saturn/config";
import { RuntimeStorageManager } from "./runtime-storage.manager.js";
import type { StorageAdapter } from "./types.js";
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-guard-profile-")); directories.push(directory);
  const passwordFile = path.join(directory, "credential.password"); await fs.writeFile(passwordFile, "synthetic-secret");
  const config: SaturnConfig["storage"] = { host: "localhost", port: 2222, username: "qa", root: "data", authMode: "password_file", passwordFile,
    hostFingerprint: "SHA256:" + "A".repeat(43), operationTimeoutMs: 1000, healthTimeoutMs: 1000, maxConnections: 1 };
  const adapter = { close: vi.fn(async () => undefined) } as unknown as StorageAdapter, factory = vi.fn(() => adapter);
  const manager = new RuntimeStorageManager(config, directory, factory); await manager.initialize(); return { directory, config, manager, factory };
}
it("installs a one-way guard and calls it before activation writes or adapter construction", async () => {
  const { manager, config, directory, factory } = await fixture(), guard = vi.fn(async () => undefined); await manager.installProfileGuard(guard);
  await expect(manager.installProfileGuard(guard)).rejects.toThrow("already installed"); guard.mockRejectedValue(Error("generation changed"));
  const before = await fs.readdir(directory);
  await expect(manager.activate({ profileId: "different", revision: 2, activatedAt: new Date().toISOString(), config })).rejects.toThrow("generation changed");
  expect(await fs.readdir(directory)).toEqual(before); expect(factory).toHaveBeenCalledTimes(1); expect(manager.current().profileId).toBe("bootstrap"); await manager.close();
});
it("checks a rollback before copying a credential or creating a rollback profile", async () => {
  const { manager, directory, factory } = await fixture(), guard = vi.fn(async () => undefined); await manager.installProfileGuard(guard); guard.mockRejectedValue(Error("closed"));
  const before = await fs.readdir(directory); await expect(manager.restore(manager.current())).rejects.toThrow("closed");
  expect(await fs.readdir(directory)).toEqual(before); expect(factory).toHaveBeenCalledTimes(1); await manager.close();
});
it("does not let unchanged profile UUID/revision bypass validation of changed configuration", async () => {
  const { manager, directory, config, factory } = await fixture();
  await manager.activate({ profileId: "original", revision: 2, activatedAt: new Date().toISOString(), config });
  const guard = vi.fn(async (profile: { config: SaturnConfig["storage"] }) => { if (profile.config.host !== "localhost") throw Error("host changed"); });
  await manager.installProfileGuard(guard);
  const file = path.join(directory, "active.json"), original = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  await fs.writeFile(file, JSON.stringify({ ...original, host: "other-host" })); await expect(manager.refresh()).rejects.toThrow("host changed");
  expect(factory).toHaveBeenCalledTimes(2); expect(manager.current().config.host).toBe("localhost"); await manager.close();
});
