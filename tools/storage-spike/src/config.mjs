import fs from "node:fs/promises";
import path from "node:path";

const REQUIRED_FIELDS = [
  "environment",
  "host",
  "port",
  "username",
  "root",
  "hostFingerprint",
  "safeConnectionPool",
  "operationTimeoutMs",
  "qualificationBytes",
  "downloadSegmentBytes",
  "chunkBytes",
  "requestBytes",
  "requestConcurrency",
  "transferLanes",
  "laneRequestConcurrency",
];

export async function loadConfig({ configPath, passwordFile }) {
  if (!configPath) throw new Error("VAULT_STORAGE_CONFIG is required");
  if (!passwordFile) throw new Error("VAULT_STORAGE_PASSWORD_FILE is required");

  const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  for (const field of REQUIRED_FIELDS) {
    if (parsed[field] === undefined || parsed[field] === null || parsed[field] === "") {
      throw new Error(`Missing storage configuration field: ${field}`);
    }
  }

  if (parsed.environment !== "DEV") {
    throw new Error("Live qualification refuses every environment except DEV");
  }
  if (!/-sub\d+\.your-storagebox\.de$/i.test(parsed.host)) {
    throw new Error("Live qualification requires a Hetzner sub-account hostname");
  }
  if (!/-sub\d+$/i.test(parsed.username)) {
    throw new Error("Live qualification requires a Hetzner sub-account username");
  }
  if (Number(parsed.port) !== 22) {
    throw new Error("Stage 1 qualification permits SFTP port 22 only");
  }
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(parsed.hostFingerprint)) {
    throw new Error("Host fingerprint must use the SHA256:base64 format");
  }
  if (parsed.safeConnectionPool < 1 || parsed.safeConnectionPool > 8) {
    throw new Error("Safe connection pool must stay between 1 and 8");
  }
  if (parsed.operationTimeoutMs < 1_000 || parsed.operationTimeoutMs > 120_000) {
    throw new Error("Operation timeout must stay between 1 and 120 seconds");
  }
  if (parsed.chunkBytes < 64 * 1024 || parsed.chunkBytes > 8 * 1024 * 1024) {
    throw new Error("Chunk size must stay between 64 KiB and 8 MiB");
  }
  if (parsed.qualificationBytes < parsed.chunkBytes) {
    throw new Error("Qualification size must be at least one chunk");
  }
  if (parsed.downloadSegmentBytes < 64 * 1024 * 1024
      || parsed.downloadSegmentBytes > 4 * 1024 * 1024 * 1024) {
    throw new Error("Download segment must stay between 64 MiB and 4 GiB");
  }
  if (parsed.requestBytes < 16 * 1024 || parsed.requestBytes > 256 * 1024) {
    throw new Error("SFTP request size must stay between 16 KiB and 256 KiB");
  }
  if (parsed.requestConcurrency < 1 || parsed.requestConcurrency > 64) {
    throw new Error("SFTP request concurrency must stay between 1 and 64");
  }
  if (parsed.transferLanes < 1 || parsed.transferLanes > 4) {
    throw new Error("One transfer may use between 1 and 4 SFTP lanes");
  }
  if (parsed.laneRequestConcurrency < 1 || parsed.laneRequestConcurrency > 32) {
    throw new Error("Per-lane request concurrency must stay between 1 and 32");
  }

  const resolvedPasswordFile = path.resolve(passwordFile);
  const password = (await fs.readFile(resolvedPasswordFile, "utf8")).replace(/[\r\n]+$/, "");
  if (!password) throw new Error("Storage password file is empty");
  if (/[\r\n]/.test(password)) throw new Error("Storage password must be one line");

  return {
    ...parsed,
    port: Number(parsed.port),
    safeConnectionPool: Number(parsed.safeConnectionPool),
    operationTimeoutMs: Number(parsed.operationTimeoutMs),
    qualificationBytes: Number(parsed.qualificationBytes),
    downloadSegmentBytes: Number(parsed.downloadSegmentBytes),
    chunkBytes: Number(parsed.chunkBytes),
    requestBytes: Number(parsed.requestBytes),
    requestConcurrency: Number(parsed.requestConcurrency),
    transferLanes: Number(parsed.transferLanes),
    laneRequestConcurrency: Number(parsed.laneRequestConcurrency),
    password,
    configPath: path.resolve(configPath),
    passwordFile: resolvedPasswordFile,
  };
}

export function publicConfig(config) {
  const { password: _password, passwordFile: _passwordFile, ...safe } = config;
  return safe;
}
