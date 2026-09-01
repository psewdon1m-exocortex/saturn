import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, publicConfig } from "../src/config.mjs";

async function fixture(overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-storage-config-"));
  const configPath = path.join(dir, "storage.json");
  const passwordFile = path.join(dir, "password.txt");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      environment: "DEV",
      host: "u123-sub1.your-storagebox.de",
      port: 22,
      username: "u123-sub1",
      root: ".",
      hostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      safeConnectionPool: 8,
      operationTimeoutMs: 60_000,
      qualificationBytes: 1024 * 1024,
      downloadSegmentBytes: 64 * 1024 * 1024,
      chunkBytes: 64 * 1024,
      requestBytes: 32 * 1024,
      requestConcurrency: 8,
      transferLanes: 4,
      laneRequestConcurrency: 4,
      ...overrides,
    }),
  );
  await fs.writeFile(passwordFile, "test-only-secret\n");
  return { dir, configPath, passwordFile };
}

test("loads a DEV sub-account config and strips the trailing newline", async (t) => {
  const files = await fixture();
  t.after(() => fs.rm(files.dir, { recursive: true, force: true }));
  const config = await loadConfig(files);
  assert.equal(config.password, "test-only-secret");
  assert.equal(config.port, 22);
});

test("public config never returns the password or its file path", async (t) => {
  const files = await fixture();
  t.after(() => fs.rm(files.dir, { recursive: true, force: true }));
  const safe = publicConfig(await loadConfig(files));
  assert.equal("password" in safe, false);
  assert.equal("passwordFile" in safe, false);
});

test("refuses a non-DEV environment", async (t) => {
  const files = await fixture({ environment: "PROD" });
  t.after(() => fs.rm(files.dir, { recursive: true, force: true }));
  await assert.rejects(() => loadConfig(files), /refuses every environment except DEV/);
});

test("refuses a main account instead of a sub-account", async (t) => {
  const files = await fixture({ host: "u123.your-storagebox.de", username: "u123" });
  t.after(() => fs.rm(files.dir, { recursive: true, force: true }));
  await assert.rejects(() => loadConfig(files), /sub-account/);
});
