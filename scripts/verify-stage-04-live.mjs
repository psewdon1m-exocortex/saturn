import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SftpStorageAdapter } from "../packages/storage/dist/index.js";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const namespace = `_vault-stage4-live-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const passwordFile = path.join(vaultRoot, "docs", "server_password.txt");
const storageConfig = {
  host: "u657278-sub1.your-storagebox.de",
  port: 22,
  username: "u657278-sub1",
  root: ".",
  hostFingerprint: "SHA256:EMlfI8GsRIfpVkoW1H2u0zYVpFGKkIMKHFZIRkf2ioI",
  authMode: "password_file",
  passwordFile,
  operationTimeoutMs: 60_000,
  maxConnections: 8,
};
const adapter = new SftpStorageAdapter(storageConfig);
const ownerToken = (await fs.readFile(process.env.OWNER_BOOTSTRAP_TOKEN_FILE, "utf8")).trim();
const liveEnvironment = {
  ...process.env,
  API_PORT: "3100",
  STORAGE_HOST: storageConfig.host,
  STORAGE_PORT: String(storageConfig.port),
  STORAGE_USER: storageConfig.username,
  STORAGE_ROOT: namespace,
  STORAGE_HOST_FINGERPRINT: storageConfig.hostFingerprint,
  STORAGE_AUTH_MODE: "password_file",
  STORAGE_PASSWORD_FILE: passwordFile,
  STORAGE_PRIVATE_KEY_FILE: "",
  READINESS_REQUIRE_STORAGE: "true",
  LOG_LEVEL: "silent",
};
let api;

async function stop() {
  if (api === undefined || api.exitCode !== null) return;
  api.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => api.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (api.exitCode === null) api.kill("SIGKILL");
}

async function deleteTree(storagePath) {
  let remaining;
  do {
    const page = await adapter.list(storagePath, undefined, 500);
    remaining = page.entries.length;
    for (const entry of page.entries) {
      if (entry.type === "directory") await deleteTree(entry.path);
      else await adapter.delete(entry.path);
    }
  } while (remaining > 0);
  await adapter.delete(storagePath);
}

async function waitReady() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3100/health/ready", { signal: AbortSignal.timeout(10_000) });
      if (response.status === 200) return;
    } catch {
      // Expected until the live SFTP-backed artifact is listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Live DEV API did not become ready");
}

async function request(relativePath, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("Authorization", `Bearer ${ownerToken}`);
  let body;
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) body = options.body;
  return fetch(`http://127.0.0.1:3100/api/v1${relativePath}`, {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(120_000),
  });
}

async function jsonRequest(relativePath, options, status) {
  const response = await request(relativePath, options);
  const text = await response.text();
  if (response.status !== status) throw new Error(`Live ${relativePath} returned ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

async function upload(parentId, filename, payload, key, overwriteResourceId) {
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const session = await jsonRequest("/uploads", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    json: { parentId, filename, expectedSize: payload.length, expectedSha256: sha256, ...(overwriteResourceId === undefined ? {} : { overwriteResourceId }) },
  }, 201);
  const chunk = await request(`/uploads/${session.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" },
    body: payload,
  });
  if (chunk.status !== 204) throw new Error(`Live chunk returned ${chunk.status}`);
  return jsonRequest(`/uploads/${session.id}/complete`, { method: "POST" }, 201);
}

try {
  if (await adapter.exists(namespace)) throw new Error("Generated live namespace exists");
  await adapter.mkdir(namespace);
  api = spawn(process.execPath, [path.join(vaultRoot, "apps", "api", "dist", "main.js")], {
    cwd: vaultRoot,
    env: liveEnvironment,
    windowsHide: true,
    stdio: "ignore",
  });
  await waitReady();
  const suffix = randomBytes(4).toString("hex");
  const rootId = "00000000-0000-7000-8000-000000000004";
  const folder = await jsonRequest("/folders", { method: "POST", json: { parentId: rootId, name: `Live-${suffix}` } }, 201);
  const originalPayload = Buffer.from(`live-original-${suffix}`);
  const replacementPayload = Buffer.from(`live-replacement-${suffix}`);
  const original = await upload(folder.id, "live.bin", originalPayload, `live-initial-${suffix}`);
  await upload(folder.id, "live.bin", replacementPayload, `live-overwrite-${suffix}`, original.resource.id);
  const versions = await jsonRequest(`/files/${original.resource.id}/versions`, {}, 200);
  const originalSha = createHash("sha256").update(originalPayload).digest("hex");
  const archived = versions.find((item) => item.sha256 === originalSha);
  if (archived === undefined) throw new Error("Live archived version missing");
  await jsonRequest(`/files/${original.resource.id}/versions/${archived.id}/restore`, {
    method: "POST",
    headers: { "Idempotency-Key": `live-version-restore-${suffix}` },
  }, 201);
  await jsonRequest(`/resources/${original.resource.id}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": `live-trash-${suffix}` },
  }, 200);
  const restored = await jsonRequest(`/resources/${original.resource.id}/restore`, {
    method: "POST",
    headers: { "Idempotency-Key": `live-trash-restore-${suffix}` },
  }, 201);
  const downloaded = await request(`/files/${restored.id}/content`);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  if (downloaded.status !== 200 || !bytes.equals(originalPayload)) throw new Error("Live final checksum differs");
  await stop();
  await deleteTree(namespace);
  process.stdout.write(`${JSON.stringify({ success: true, overwrite: "pass", versionRestore: "pass", trashRestore: "pass", cleanup: true })}\n`);
} finally {
  await stop();
  if (await adapter.exists(namespace).catch(() => false)) await deleteTree(namespace);
  await adapter.close();
}
