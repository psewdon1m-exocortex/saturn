import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironment, publicConfig, validateRecoveredConfiguration } from "./index.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function environment() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "saturn-local-config-")); directories.push(directory);
  const password = path.join(directory, "database-password"); fs.writeFileSync(password, "synthetic-db-secret-0123456789012345");
  return {
    NODE_ENV: "production", PUBLIC_ORIGIN: "https://saturn.internal", DATABASE_URL: "postgres://runtime@localhost/saturn", DATABASE_PASSWORD_FILE: password,
    OWNER_BOOTSTRAP_TOKEN_FILE: path.join(directory, "owner"), AUTH_PEPPER_FILE: path.join(directory, "auth"),
    DROP_PEPPER_FILE: path.join(directory, "drop"), SHARE_PEPPER_FILE: path.join(directory, "share"), DEVICE_PEPPER_FILE: path.join(directory, "device"),
    BACKUP_PEPPER_FILE: path.join(directory, "backup"), LABORATORY_PEPPER_FILE: path.join(directory, "laboratory"),
    STORAGE_BACKEND: "local", STORAGE_LOCAL_ROOT: path.join(directory, "backend"), STORAGE_LOCAL_CUSTODY_FILE: path.join(directory, "custody.json"),
    STORAGE_RUNTIME_CONFIG_DIR: path.join(directory, "runtime"),
  };
}
describe("explicit production local storage selection", () => {
  it("needs no dummy SFTP credential and excludes custody file from public recovery data", () => {
    const env = environment(), config = loadEnvironment(env);
    expect(config.storage).toMatchObject({ backend: "local", root: env.STORAGE_LOCAL_ROOT, custodyFile: env.STORAGE_LOCAL_CUSTODY_FILE, requireFsync: true });
    expect(config.storage).not.toHaveProperty("authMode");
    expect(publicConfig(config).storage).toMatchObject({ backend: "local", root: env.STORAGE_LOCAL_ROOT });
    expect(publicConfig(config).storage).not.toHaveProperty("custodyFile");
    expect(validateRecoveredConfiguration(publicConfig(config), config, env).storage).toEqual(config.storage);
  });
  it("rejects unknown, implicit or mixed backend selection and insecure local paths", () => {
    const env = environment();
    for (const patch of [{ STORAGE_BACKEND: "unknown" }, { STORAGE_BACKEND: undefined }, { STORAGE_HOST: "remote" },
      { STORAGE_LOCAL_ROOT: "relative" }, { STORAGE_LOCAL_ROOT: path.parse(env.STORAGE_LOCAL_ROOT).root },
      { STORAGE_LOCAL_CUSTODY_FILE: path.join(env.STORAGE_LOCAL_ROOT, "custody") }, { STORAGE_REQUIRE_FSYNC: "false" }]) {
      expect(() => loadEnvironment({ ...env, ...patch })).toThrow("Invalid Saturn configuration");
    }
  });
  it("refuses recovery redirection of the local root or backend kind", () => {
    const env = environment(), config = loadEnvironment(env), value = publicConfig(config);
    const storage = value.storage as Record<string, unknown>;
    expect(() => validateRecoveredConfiguration({ ...value, storage: { ...storage, root: path.join(env.STORAGE_LOCAL_ROOT, "replacement") } }, config, env)).toThrow("operator-pinned");
    expect(() => validateRecoveredConfiguration({ ...value, storage: { ...storage, backend: "sftp" } }, config, env)).toThrow("operator-selected");
  });
});
