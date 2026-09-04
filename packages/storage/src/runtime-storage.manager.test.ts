import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { SaturnConfig } from "@saturn/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeStorageManager } from "./runtime-storage.manager.js";
import type { StorageAdapter } from "./types.js";

const temporaryDirectories: string[] = [];

function config(credentialFile: string, host = "bootstrap.example"): SaturnConfig["storage"] {
  return {
    host, port: 22, username: "saturn", root: ".", hostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    authMode: "password_file", passwordFile: credentialFile, operationTimeoutMs: 60_000, healthTimeoutMs: 3_000, maxConnections: 2,
  };
}

function adapter(label: string): StorageAdapter {
  return {
    stat: vi.fn(async (storagePath: string) => ({ path: storagePath, name: label, type: "directory" as const, size: 0, modifiedAt: new Date(0) })),
    list: vi.fn(async () => ({ entries: [] })), openRead: vi.fn(async () => Readable.from([])), write: vi.fn(async () => 0), truncate: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), copy: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
    exists: vi.fn(async () => true), statFs: vi.fn(async () => ({ totalBytes: 100, availableBytes: 60 })), close: vi.fn(async () => undefined),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("RuntimeStorageManager", () => {
  it("persists only a credential path and lets a second process converge on the active profile", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-storage-runtime-"));
    temporaryDirectories.push(directory);
    const bootstrapCredential = path.join(directory, "bootstrap-password");
    const runtimeCredential = path.join(directory, "runtime-password");
    await fs.writeFile(bootstrapCredential, "bootstrap-secret\n", { mode: 0o600 });
    await fs.writeFile(runtimeCredential, "runtime-secret\n", { mode: 0o600 });
    const created: string[] = [];
    const factory = (value: SaturnConfig["storage"]) => { created.push(value.host); return adapter(value.host); };
    const manager = new RuntimeStorageManager(config(bootstrapCredential), directory, factory);
    await manager.initialize();
    await manager.activate({ profileId: "11111111-1111-4111-8111-111111111111", revision: 2, activatedAt: "2026-09-04T00:00:00.000Z", config: config(runtimeCredential, "next.example") });
    const serialized = await fs.readFile(path.join(directory, "active.json"), "utf8");
    expect(serialized).not.toContain("runtime-secret");
    expect(serialized).toContain("runtime-password");

    const worker = new RuntimeStorageManager(config(bootstrapCredential), directory, factory);
    await worker.initialize();
    expect(worker.current()).toMatchObject({ profileId: "11111111-1111-4111-8111-111111111111", revision: 2, source: "runtime", config: { host: "next.example" } });
    expect((await worker.stat("")).name).toBe("next.example");
    expect(created).toContain("next.example");
    await Promise.all([manager.close(), worker.close()]);
  });

  it("rejects a runtime document that points a credential outside the protected directory", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-storage-runtime-"));
    temporaryDirectories.push(directory);
    const bootstrapCredential = path.join(directory, "bootstrap-password");
    await fs.writeFile(bootstrapCredential, "bootstrap-secret\n", { mode: 0o600 });
    await fs.writeFile(path.join(directory, "active.json"), JSON.stringify({ version: 1, profileId: "bad", revision: 2, activatedAt: new Date().toISOString(), host: "bad.example", port: 22, username: "saturn", root: ".", hostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", authMode: "password_file", credentialFile: path.join(os.tmpdir(), "escaped-secret"), operationTimeoutMs: 60_000, healthTimeoutMs: 3_000, maxConnections: 2 }));
    const manager = new RuntimeStorageManager(config(bootstrapCredential), directory, () => adapter("fake"));
    await expect(manager.initialize()).rejects.toThrow("escaped");
    await manager.close();
  });

  it("publishes a bootstrap rollback so another process leaves the failed candidate too", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-storage-runtime-"));
    temporaryDirectories.push(directory);
    const bootstrapCredential = path.join(directory, "bootstrap-password");
    const candidateCredential = path.join(directory, "credential-candidate.password");
    await fs.writeFile(bootstrapCredential, "bootstrap-secret\n", { mode: 0o600 });
    const factory = (value: SaturnConfig["storage"]) => adapter(value.host);
    const manager = new RuntimeStorageManager(config(bootstrapCredential), directory, factory);
    const bootstrap = manager.current();
    await manager.initialize();
    await fs.writeFile(candidateCredential, "candidate-secret\n", { mode: 0o600 });
    await manager.activate({ profileId: "22222222-2222-4222-8222-222222222222", revision: 2, activatedAt: "2026-09-04T00:00:00.000Z", config: config(candidateCredential, "candidate.example") });
    const worker = new RuntimeStorageManager(config(bootstrapCredential), directory, factory);
    await worker.initialize();
    expect(worker.current().config.host).toBe("candidate.example");

    await manager.restore(bootstrap);
    expect((await worker.stat("")).name).toBe("bootstrap.example");
    expect(worker.current()).toMatchObject({ source: "runtime", config: { host: "bootstrap.example" } });
    expect(await fs.readFile(path.join(directory, "active.json"), "utf8")).not.toContain("bootstrap-secret");
    await Promise.all([manager.close(), worker.close()]);
  });
});
