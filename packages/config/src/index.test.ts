import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvironment, publicConfig } from "./index.js";

const valid = {
  NODE_ENV: "test",
  PUBLIC_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgres://vault:test@localhost/vault",
  OWNER_BOOTSTRAP_TOKEN_FILE: ".secrets/owner-token",
  AUTH_PEPPER_FILE: ".secrets/auth-pepper",
  DROP_PEPPER_FILE: ".secrets/drop-pepper",
  SHARE_PEPPER_FILE: ".secrets/share-pepper",
  DEVICE_PEPPER_FILE: ".secrets/device-pepper",
  BACKUP_PEPPER_FILE: ".secrets/backup-pepper",
  LABORATORY_PEPPER_FILE: ".secrets/laboratory-pepper",
  STORAGE_HOST: "localhost",
  STORAGE_USER: "vault",
  STORAGE_ROOT: "gateway",
  STORAGE_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`,
  STORAGE_AUTH_MODE: "password_file",
  STORAGE_PASSWORD_FILE: ".secrets/test-password",
};

describe("loadEnvironment", () => {
  it("loads a validated development configuration with absolute secret references", () => {
    const config = loadEnvironment(valid, "C:/vault");
    expect(config.storage.passwordFile).toMatch(/vault[\\/].secrets[\\/]test-password$/);
    expect(config.ownerBootstrapTokenFile).toMatch(/vault[\\/].secrets[\\/]owner-token$/);
    expect(config.auth.pepperFile).toMatch(/vault[\\/].secrets[\\/]auth-pepper$/);
    expect(config.drop.pepperFile).toMatch(/vault[\\/].secrets[\\/]drop-pepper$/);
    expect(config.share.pepperFile).toMatch(/vault[\\/].secrets[\\/]share-pepper$/);
    expect(config.device.pepperFile).toMatch(/vault[\\/].secrets[\\/]device-pepper$/);
    expect(config.backupIngest.pepperFile).toMatch(/vault[\\/].secrets[\\/]backup-pepper$/);
    expect(config.laboratory.pepperFile).toMatch(/vault[\\/].secrets[\\/]laboratory-pepper$/);
    expect(config.storage.maxConnections).toBe(8);
    expect(config.storage.healthTimeoutMs).toBe(3_000);
    expect(config.readinessTimeoutMs).toBe(3_000);
    expect(config.drop.codeTtlMs).toBe(30 * 60 * 1_000);
    expect(config.drop.sessionTtlMs).toBe(30 * 60 * 1_000);
    expect(config.recovery.pgDumpPrefixArgs).toEqual([]);
    expect(config.recovery.pgRestorePrefixArgs).toEqual([]);
    expect(config.recovery.pgCommandConnectionArgs).toEqual([]);
    expect(config.limits).toEqual({
      uploadMaxBytes: 20 * 1024 * 1024 * 1024,
      uploadChunkMaxBytes: 8 * 1024 * 1024,
      uploadIncompleteTtlMs: 24 * 60 * 60 * 1_000,
      trashRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    });
    expect(config.protection.purgeEnabled).toBe(true);
  });

  it("loads bounded PostgreSQL command prefixes without exposing them publicly", () => {
    const config = loadEnvironment({
      ...valid,
      PG_DUMP_BIN: "docker",
      PG_RESTORE_BIN: "docker",
      PG_DUMP_PREFIX_ARGS: '["compose","exec","-T","postgres","pg_dump"]',
      PG_RESTORE_PREFIX_ARGS: '["compose","exec","-T","postgres","pg_restore"]',
      PG_COMMAND_CONNECTION_ARGS: '["--username","vault","--dbname","vault"]',
    });
    expect(config.recovery.pgDumpPrefixArgs.at(-1)).toBe("pg_dump");
    expect(config.recovery.pgRestorePrefixArgs.at(-1)).toBe("pg_restore");
    expect(config.recovery.pgCommandConnectionArgs).toEqual(["--username", "vault", "--dbname", "vault"]);
    expect(JSON.stringify(publicConfig(config))).not.toContain("pg_dump");
    expect(() => loadEnvironment({ ...valid, PG_DUMP_PREFIX_ARGS: '["ok",""]' })).toThrow(/JSON array/);
  });

  it("rejects traversal in the storage root", () => {
    expect(() => loadEnvironment({ ...valid, STORAGE_ROOT: "../escape" })).toThrow(/safe relative path/);
  });

  it("refuses production password authentication and placeholder values", () => {
    expect(() => loadEnvironment({
      ...valid,
      NODE_ENV: "production",
      PUBLIC_ORIGIN: "https://example.invalid",
      DATABASE_URL: "postgres://vault:change-me@db/vault",
    })).toThrow(/Production Storage Box access requires a private key file/);
  });

  it("injects a production database password from a secret file without changing the public contract", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vault-config-"));
    try {
      const databasePasswordFile = path.join(directory, "database-password");
      fs.writeFileSync(databasePasswordFile, "stage13-database-password-value", { mode: 0o600 });
      const config = loadEnvironment({
        ...valid,
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://drive.acme.test",
        DATABASE_URL: "postgres://vault@postgres/vault",
        DATABASE_PASSWORD_FILE: databasePasswordFile,
        STORAGE_AUTH_MODE: "private_key_file",
        STORAGE_PASSWORD_FILE: "",
        STORAGE_PRIVATE_KEY_FILE: path.join(directory, "storage-key"),
      });
      expect(new URL(config.databaseUrl).password).toBe("stage13-database-password-value");
      expect(config.databasePasswordFile).toBe(databasePasswordFile);
      expect(JSON.stringify(publicConfig(config))).not.toContain("database-password");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never exposes secret-file paths in public configuration", () => {
    const safe = JSON.stringify(publicConfig(loadEnvironment(valid)));
    expect(safe).not.toContain("test-password");
    expect(safe).not.toContain("passwordFile");
    expect(safe).not.toContain("owner-token");
    expect(safe).not.toContain("auth-pepper");
    expect(safe).not.toContain("drop-pepper");
    expect(safe).not.toContain("share-pepper");
    expect(safe).not.toContain("device-pepper");
    expect(safe).not.toContain("backup-pepper");
    expect(safe).not.toContain("laboratory-pepper");
    expect(safe).not.toContain("pepperFile");
  });
});
