import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secretDirectory = path.join(vaultRoot, ".secrets");
const temporaryDirectory = path.join(vaultRoot, ".tmp");
const postgresPasswordFile = path.join(secretDirectory, "dev-postgres-password");
const ownerTokenFile = path.join(secretDirectory, "dev-owner-bootstrap-token");
const authPepperFile = path.join(secretDirectory, "dev-auth-pepper");
const dropPepperFile = path.join(secretDirectory, "dev-drop-pepper");
const sharePepperFile = path.join(secretDirectory, "dev-share-pepper");
const devicePepperFile = path.join(secretDirectory, "dev-device-pepper");
const backupPepperFile = path.join(secretDirectory, "dev-backup-pepper");
const laboratoryPepperFile = path.join(secretDirectory, "dev-laboratory-pepper");
const gryphonServiceTokenFile = path.join(secretDirectory, "dev-gryphon-service-token");
const sshKeygenCommand = process.platform === "win32" ? "ssh-keygen.exe" : "ssh-keygen";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: vaultRoot,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result.stdout.trim();
}

async function ensureSecret(filePath) {
  try {
    const existing = (await fs.readFile(filePath, "utf8")).trim();
    if (existing) return existing;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const value = randomBytes(32).toString("base64url");
  await fs.writeFile(filePath, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return value;
}

function restrictWindowsAcl(filePath) {
  if (process.platform !== "win32") return;
  const identity = `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`;
  if (identity === "\\") return;
  run("icacls.exe", [
    filePath,
    "/inheritance:r",
    "/grant:r",
    `${identity}:(F)`,
    "NT AUTHORITY\\SYSTEM:(F)",
    "BUILTIN\\Administrators:(F)",
  ]);
}

function environmentLine(key, value) {
  if (/[\r\n]/.test(value)) throw new Error(`Environment value for ${key} contains a newline`);
  return `${key}=${value}`;
}

function developmentPort(value, fallback, name) {
  const port = value ?? fallback;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} is invalid`);
  return port;
}

export async function prepareDevelopmentEnvironment(options = {}) {
  const postgresPort = developmentPort(options.postgresPort, 55_432, "DEV PostgreSQL port");
  const sftpPort = developmentPort(options.sftpPort, 2_222, "DEV SFTP port");
  const runtimeNamespace = options.runtimeNamespace;
  if (runtimeNamespace !== undefined && !/^[a-z0-9][a-z0-9-]{0,80}$/.test(runtimeNamespace)) {
    throw new Error("DEV runtime namespace is invalid");
  }
  const scopedTemporaryDirectory = runtimeNamespace === undefined
    ? temporaryDirectory
    : path.join(temporaryDirectory, runtimeNamespace);
  const sftpDirectory = path.join(scopedTemporaryDirectory, "sftp");
  const sftpDataDirectory = runtimeNamespace === undefined
    ? path.join(vaultRoot, "data", "sftp")
    : path.join(scopedTemporaryDirectory, "sftp-data");
  const hostKeyFile = path.join(sftpDirectory, "ssh_host_ed25519_key");
  const clientKeyFile = path.join(sftpDirectory, "dev_client_ed25519");
  const usersFile = path.join(sftpDirectory, "users.conf");
  const runtimeEnvironmentFile = path.join(scopedTemporaryDirectory, "dev-runtime.env");
  await Promise.all([
    fs.mkdir(secretDirectory, { recursive: true }),
    fs.mkdir(sftpDirectory, { recursive: true }),
    fs.mkdir(sftpDataDirectory, { recursive: true }),
  ]);
  const postgresPassword = await ensureSecret(postgresPasswordFile);
  await ensureSecret(ownerTokenFile);
  await ensureSecret(authPepperFile);
  await ensureSecret(dropPepperFile);
  await ensureSecret(sharePepperFile);
  await ensureSecret(devicePepperFile);
  await ensureSecret(backupPepperFile);
  await ensureSecret(laboratoryPepperFile);
  await ensureSecret(gryphonServiceTokenFile);

  try {
    await fs.access(hostKeyFile);
  } catch {
    run(sshKeygenCommand, ["-q", "-t", "ed25519", "-N", "", "-C", "vault-dev-only", "-f", hostKeyFile]);
  }
  try {
    await fs.access(clientKeyFile);
  } catch {
    run(sshKeygenCommand, ["-q", "-t", "ed25519", "-N", "", "-C", "vault-dev-client", "-f", clientKeyFile]);
  }
  const fingerprintOutput = run(sshKeygenCommand, ["-l", "-E", "sha256", "-f", `${hostKeyFile}.pub`]);
  const hostFingerprint = fingerprintOutput.split(/\s+/)[1];
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(hostFingerprint ?? "")) {
    throw new Error("Could not derive the local SFTP host fingerprint");
  }

  await fs.writeFile(usersFile, "vault::1001:1001:gateway\n", { encoding: "utf8", mode: 0o600 });
  const databaseUrl = `postgres://vault:${encodeURIComponent(postgresPassword)}@127.0.0.1:${postgresPort}/vault`;
  const environment = {
    NODE_ENV: "development",
    PUBLIC_ORIGIN: "http://127.0.0.1:5173",
    API_HOST: "127.0.0.1",
    API_PORT: "3000",
    WORKER_HOST: "127.0.0.1",
    WORKER_PORT: "3001",
    DATABASE_URL: databaseUrl,
    DEV_POSTGRES_BIND_PORT: String(postgresPort),
    DEV_SFTP_BIND_PORT: String(sftpPort),
    DEV_SFTP_CONFIG_DIR: `./${path.relative(vaultRoot, sftpDirectory).replaceAll("\\", "/")}`,
    DEV_SFTP_DATA_DIR: `./${path.relative(vaultRoot, sftpDataDirectory).replaceAll("\\", "/")}`,
    OWNER_BOOTSTRAP_TOKEN_FILE: ownerTokenFile,
    AUTH_PEPPER_FILE: authPepperFile,
    AUTH_SESSION_IDLE_TTL_MS: "900000",
    AUTH_SESSION_ABSOLUTE_TTL_MS: "43200000",
    AUTH_REAUTH_TTL_MS: "300000",
    AUTH_FAILURE_LIMIT: "5",
    AUTH_FAILURE_WINDOW_MS: "900000",
    DROP_PEPPER_FILE: dropPepperFile,
    DROP_CODE_TTL_MS: "1800000",
    DROP_SESSION_TTL_MS: "1800000",
    DROP_MAX_FILES: "1000",
    DROP_MAX_BYTES: "107374182400",
    DROP_BUFFER_DIRECTORY: path.join(vaultRoot, "data", "drop-buffer"),
    DROP_BUFFER_MAX_BYTES: "118111600640",
    DROP_BUFFER_MIN_FREE_BYTES: "10737418240",
    DROP_BUFFER_WARNING_RATIO: "0.70",
    DROP_BUFFER_CRITICAL_RATIO: "0.85",
    DROP_BUFFER_REFUSAL_RATIO: "0.92",
    DROP_DRAIN_WORKERS: "2",
    DROP_DRAIN_INTERVAL_MS: "1000",
    DROP_CONTINUATION_TTL_MS: "86400000",
    DROP_FAILURE_LIMIT: "5",
    DROP_GLOBAL_FAILURE_LIMIT: "100",
    DROP_FAILURE_WINDOW_MS: "900000",
    SHARE_PEPPER_FILE: sharePepperFile,
    SHARE_ENABLED: "true",
    SHARE_DEFAULT_EXPIRY_MS: "604800000",
    SHARE_MAX_EXPIRY_MS: "31536000000",
    SHARE_SESSION_TTL_MS: "1800000",
    SHARE_PASSWORD_FAILURE_LIMIT: "5",
    SHARE_PASSWORD_FAILURE_WINDOW_MS: "900000",
    SHARE_PACKAGE_MAX_FILES: "5000",
    SHARE_PACKAGE_MAX_BYTES: "5368709120",
    SHARE_PACKAGE_MAX_DURATION_MS: "600000",
    SHARE_STREAM_REVALIDATE_BYTES: "1048576",
    DEVICE_PEPPER_FILE: devicePepperFile,
    WEBDAV_ENABLED: "true",
    WEBDAV_PROPFIND_MAX_ITEMS: "1000",
    DEVICE_DELETE_MAX_ITEMS: "1000",
    DEVICE_DELETE_WINDOW_MS: "900000",
    BACKUP_PEPPER_FILE: backupPepperFile,
    LABORATORY_PEPPER_FILE: laboratoryPepperFile,
    BACKUP_INGEST_ENABLED: "true",
    BACKUP_TRUST_CLIENT_CERT_HEADER: "false",
    BACKUP_TOKEN_ROTATION_GRACE_MS: "3600000",
    BACKUP_REQUIRE_ENCRYPTION: "true",
    BACKUP_MAX_RUN_BYTES: "21474836480",
    BACKUP_DAILY_QUOTA_BYTES: "42949672960",
    BACKUP_STORED_QUOTA_BYTES: "536870912000",
    BACKUP_MAX_CONCURRENT_RUNS: "1",
    BACKUP_FRESHNESS_SLA_MS: "86400000",
    BACKUP_RETENTION_DAILY: "7",
    BACKUP_RETENTION_WEEKLY: "4",
    BACKUP_RETENTION_MONTHLY: "12",
    BACKUP_RETENTION_YEARLY: "3",
    LABORATORY_ENABLED: "true",
    LABORATORY_PUBLIC_ENABLED: "false",
    LABORATORY_TOKEN_ROTATION_GRACE_MS: "3600000",
    LABORATORY_MAX_CONCURRENT_PUBLIC_STREAMS: "16",
    GRYPHON_ENABLED: "false",
    GRYPHON_SERVICE_TOKEN_FILE: gryphonServiceTokenFile,
    GRYPHON_SOCKET_PATH: "/run/gryphon/client.sock",
    GRYPHON_TIMEOUT_MS: "10000",
    STORAGE_HOST: "127.0.0.1",
    STORAGE_PORT: String(sftpPort),
    STORAGE_USER: "vault",
    STORAGE_ROOT: "gateway",
    STORAGE_HOST_FINGERPRINT: hostFingerprint,
    STORAGE_AUTH_MODE: "private_key_file",
    STORAGE_PASSWORD_FILE: "",
    STORAGE_PRIVATE_KEY_FILE: clientKeyFile,
    STORAGE_RUNTIME_CONFIG_DIR: path.join(vaultRoot, "data", "storage-runtime"),
    STORAGE_OPERATION_TIMEOUT_MS: "60000",
    STORAGE_MAX_CONNECTIONS: "8",
    UPLOAD_MAX_BYTES: "21474836480",
    UPLOAD_CHUNK_MAX_BYTES: "8388608",
    UPLOAD_INCOMPLETE_TTL_MS: "86400000",
    TRASH_RETENTION_MS: "2592000000",
    PURGE_ENABLED: "true",
    READINESS_REQUIRE_STORAGE: "true",
    LOG_LEVEL: "info",
    WORKER_HEARTBEAT_INTERVAL_MS: "5000",
    WORKER_STALE_AFTER_MS: "20000",
    RECONCILIATION_INTERVAL_MS: "21600000",
    RECOVERY_SPOOL_DIR: path.join(vaultRoot, "spool", "recovery"),
    RECOVERY_ARCHIVE_DIR: path.join(vaultRoot, "data", "recovery"),
    RECOVERY_MAX_ARCHIVE_BYTES: "10737418240",
    RECOVERY_MAX_MEMBER_BYTES: "8589934592",
    RECOVERY_MAX_EXTRACTED_BYTES: "12884901888",
    RECOVERY_MAX_ENTRIES: "512",
    RECOVERY_MAX_COMPRESSION_RATIO: "200",
    RECOVERY_MAX_MANIFEST_BYTES: "1048576",
    RECOVERY_BACKUP_INTERVAL_MS: "21600000",
    ARCHIVE_SPOOL_DIR: path.join(vaultRoot, "spool", "archives"),
    ARCHIVE_7Z_BIN: process.platform === "win32" ? "7z.exe" : "7zz",
    ARCHIVE_MAX_ARCHIVE_BYTES: "21474836480",
    ARCHIVE_MAX_MEMBER_BYTES: "21474836480",
    ARCHIVE_MAX_EXTRACTED_BYTES: "107374182400",
    ARCHIVE_MAX_ENTRIES: "10000",
    ARCHIVE_MAX_COMPRESSION_RATIO: "200",
    ARCHIVE_JOB_LEASE_MS: "300000",
    PG_DUMP_BIN: process.platform === "win32" ? "docker.exe" : "docker",
    PG_RESTORE_BIN: process.platform === "win32" ? "docker.exe" : "docker",
    PG_DUMP_PREFIX_ARGS: JSON.stringify(["compose", "--project-directory", vaultRoot, "-p", "vault-dev", "exec", "-T", "postgres", "pg_dump"]),
    PG_RESTORE_PREFIX_ARGS: JSON.stringify(["compose", "--project-directory", vaultRoot, "-p", "vault-dev", "exec", "-T", "postgres", "pg_restore"]),
    PG_COMMAND_CONNECTION_ARGS: JSON.stringify(["--username", "vault", "--dbname", "vault"]),
  };
  await fs.writeFile(
    runtimeEnvironmentFile,
    `${Object.entries(environment).map(([key, value]) => environmentLine(key, value)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  for (const filePath of [postgresPasswordFile, ownerTokenFile, authPepperFile, dropPepperFile, sharePepperFile, devicePepperFile, backupPepperFile, laboratoryPepperFile, gryphonServiceTokenFile, hostKeyFile, clientKeyFile, usersFile, runtimeEnvironmentFile]) {
    restrictWindowsAcl(filePath);
  }
  return { environment, hostFingerprint, runtimeEnvironmentFile };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const prepared = await prepareDevelopmentEnvironment();
  process.stdout.write(`${JSON.stringify({
    result: "ready",
    runtimeEnvironmentFile: path.relative(vaultRoot, prepared.runtimeEnvironmentFile),
    hostFingerprint: prepared.hostFingerprint,
    secrets: "generated-and-protected",
  })}\n`);
}
