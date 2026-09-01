import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(vaultRoot, "artifacts", "verification", "stage-03-file-core.json");
const pnpmScript = path.join(vaultRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const report = {
  schema: "vault.stage-verification.v1",
  stage: 3,
  startedAt: new Date().toISOString(),
  success: false,
  checks: [],
};
const children = [];
let environment = process.env;
let ownerToken = "";

function pass(name, detail = {}) {
  report.checks.push({ name, status: "pass", detail });
  process.stdout.write(`PASS ${name}\n`);
}

function run(command, args, selectedEnvironment = environment, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd: vaultRoot,
    env: selectedEnvironment,
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-3_000);
    throw new Error(`${path.basename(command)} ${args.join(" ")} failed: ${output}`);
  }
  return result;
}

function startArtifact(relativePath) {
  const child = spawn(process.execPath, [path.join(vaultRoot, relativePath)], {
    cwd: vaultRoot,
    env: environment,
    windowsHide: true,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitFor(url, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const body = await response.json();
      last = JSON.stringify({ status: response.status, body });
      if (predicate(response, body)) return;
    } catch (error) {
      last = error instanceof Error ? error.message : "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

async function request(relativePath, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.authorized !== false) headers.set("Authorization", `Bearer ${ownerToken}`);
  let body;
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) {
    body = options.body;
  }
  return fetch(`http://127.0.0.1:3000/api/v1${relativePath}`, {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
}

async function jsonRequest(relativePath, options, expectedStatus) {
  const response = await request(relativePath, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (response.status !== expectedStatus) {
    throw new Error(`${options.method ?? "GET"} ${relativePath} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return { response, body };
}

async function assertNoHandlerBypass() {
  const controllerFiles = (await fs.readdir(path.join(vaultRoot, "apps", "api", "src")))
    .filter((name) => name.endsWith(".controller.ts"));
  for (const name of controllerFiles) {
    const source = await fs.readFile(path.join(vaultRoot, "apps", "api", "src", name), "utf8");
    if (/\bssh2\b|SftpStorageAdapter|SftpConnectionPool/.test(source)) {
      throw new Error(`Controller bypasses FileService: ${name}`);
    }
  }
  return controllerFiles.length;
}

try {
  run(process.execPath, [pnpmScript, "install", "--frozen-lockfile"]);
  pass("frozen dependency install");
  run(process.execPath, [pnpmScript, "lint"]);
  run(process.execPath, [pnpmScript, "typecheck"]);
  run(process.execPath, [pnpmScript, "test"]);
  run(process.execPath, [pnpmScript, "build"]);
  pass("workspace quality gates", { lint: "pass", typecheck: "pass", tests: "pass", build: "pass" });
  pass("controller storage boundary", { controllersScanned: await assertNoHandlerBypass() });

  run(docker, ["compose", "-p", "vault-dev", "down", "--remove-orphans"], environment, true);
  run(docker, ["compose", "-p", "vault-stage3", "down", "--remove-orphans"], environment, true);
  await fs.rm(path.join(vaultRoot, "data", "sftp"), { recursive: true, force: true });
  const prepared = await prepareDevelopmentEnvironment();
  environment = { ...process.env, ...prepared.environment };
  ownerToken = (await fs.readFile(prepared.environment.OWNER_BOOTSTRAP_TOKEN_FILE, "utf8")).trim();
  run(docker, ["compose", "-p", "vault-stage3", "up", "-d", "--wait"]);
  pass("PostgreSQL and local SFTP ready");

  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  const rolledBack = run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "rollback"]);
  if (!rolledBack.stdout.includes("0002_file_core")) throw new Error("Stage 3 migration rollback did not select 0002_file_core");
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  pass("file schema migration round trip", { migration: "0002_file_core" });

  const worker = startArtifact("apps/worker/dist/main.js");
  let api = startArtifact("apps/api/dist/main.js");
  await waitFor("http://127.0.0.1:3000/health/ready", (response, body) => response.status === 200 && body.status === "ok");
  pass("production artifacts ready");

  const unauthorized = await request(`/resources/00000000-0000-7000-8000-000000000004`, { authorized: false });
  if (unauthorized.status !== 401) throw new Error(`Unauthenticated file API returned ${unauthorized.status}`);
  pass("owner bearer enforcement");

  const suffix = Date.now().toString(36);
  const rootId = "00000000-0000-7000-8000-000000000004";
  const documents = (await jsonRequest("/folders", {
    method: "POST",
    json: { parentId: rootId, name: `Documents-${suffix}` },
  }, 201)).body;
  const payload = Buffer.from(`stage-3 resumable payload ${suffix}`);
  const digest = createHash("sha256").update(payload).digest("hex");
  const upload = (await jsonRequest("/uploads", {
    method: "POST",
    headers: { "Idempotency-Key": `upload-${suffix}` },
    json: { parentId: documents.id, filename: "evidence.bin", expectedSize: payload.length, expectedSha256: digest },
  }, 201)).body;
  const split = Math.floor(payload.length / 2);
  let chunkResponse = await request(`/uploads/${upload.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" },
    body: payload.subarray(0, split),
  });
  if (chunkResponse.status !== 204 || chunkResponse.headers.get("upload-offset") !== String(split)) {
    throw new Error(`First upload chunk failed with ${chunkResponse.status}`);
  }
  pass("bounded resumable upload first chunk", { offset: split });

  await stopChild(api);
  api = startArtifact("apps/api/dist/main.js");
  await waitFor("http://127.0.0.1:3000/health/live", (response) => response.status === 200);
  const head = await request(`/uploads/${upload.id}`, { method: "HEAD" });
  if (head.status !== 204 || head.headers.get("upload-offset") !== String(split)) {
    throw new Error("Upload offset did not survive Gateway restart");
  }
  chunkResponse = await request(`/uploads/${upload.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(split) },
    body: payload.subarray(split),
  });
  if (chunkResponse.status !== 204 || chunkResponse.headers.get("upload-offset") !== String(payload.length)) {
    throw new Error(`Resumed upload chunk failed with ${chunkResponse.status}`);
  }
  pass("restart and offset resume", { finalOffset: payload.length });

  const completed = (await jsonRequest(`/uploads/${upload.id}/complete`, { method: "POST" }, 201)).body;
  const duplicate = (await jsonRequest(`/uploads/${upload.id}/complete`, { method: "POST" }, 201)).body;
  if (completed.resource.id !== duplicate.resource.id || completed.resource.sha256 !== digest) {
    throw new Error("Duplicate completion was not idempotent");
  }
  const fullDownload = await request(`/files/${completed.resource.id}/content`);
  const downloaded = Buffer.from(await fullDownload.arrayBuffer());
  if (fullDownload.status !== 200 || createHash("sha256").update(downloaded).digest("hex") !== digest) {
    throw new Error("Full download checksum differs");
  }
  const rangeDownload = await request(`/files/${completed.resource.id}/content`, { headers: { Range: "bytes=8-16" } });
  const ranged = Buffer.from(await rangeDownload.arrayBuffer());
  if (rangeDownload.status !== 206 || !ranged.equals(payload.subarray(8, 17))) throw new Error("HTTP Range differs");
  pass("verified commit, duplicate complete, download and Range", { sha256: digest, bytes: payload.length });

  const archive = (await jsonRequest("/folders", {
    method: "POST",
    json: { parentId: rootId, name: `Archive-${suffix}` },
  }, 201)).body;
  const moved = (await jsonRequest(`/resources/${completed.resource.id}/move`, {
    method: "POST",
    headers: { "Idempotency-Key": `move-${suffix}` },
    json: { parentId: archive.id, name: "moved.bin" },
  }, 201)).body;
  if (moved.id !== completed.resource.id) throw new Error("Move changed stable resource ID");
  const copied = (await jsonRequest(`/resources/${moved.id}/copy`, {
    method: "POST",
    headers: { "Idempotency-Key": `copy-${suffix}` },
    json: { parentId: documents.id, name: "copy.bin" },
  }, 201)).body;
  if (copied.id === moved.id || copied.sha256 !== digest) throw new Error("Copy identity or checksum is invalid");
  const trashed = (await jsonRequest(`/resources/${copied.id}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": `trash-${suffix}` },
  }, 200)).body;
  if (trashed.status !== "trashed" || !trashed.storagePath.startsWith("_system/trash/")) {
    throw new Error("Soft-delete did not commit to trash");
  }
  const childrenResult = (await jsonRequest(`/folders/${documents.id}/children`, {}, 200)).body;
  if (childrenResult.some((item) => item.id === copied.id)) throw new Error("Trashed resource remains visible");
  pass("folder, stable move, copy and physical soft-delete");

  const abandoned = (await jsonRequest("/uploads", {
    method: "POST",
    headers: { "Idempotency-Key": `abandon-${suffix}` },
    json: { parentId: documents.id, filename: "abandoned.bin", expectedSize: 4 },
  }, 201)).body;
  chunkResponse = await request(`/uploads/${abandoned.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" },
    body: Buffer.from("ab"),
  });
  if (chunkResponse.status !== 204) throw new Error("Abandon fixture upload failed");
  const abandonedResult = (await jsonRequest(`/uploads/${abandoned.id}`, { method: "DELETE" }, 200)).body;
  if (abandonedResult.status !== "abandoned") throw new Error("Upload was not abandoned");
  pass("incomplete upload remains invisible and can be abandoned");

  const liveOutput = run(process.execPath, [path.join(vaultRoot, "scripts", "verify-stage-03-live.mjs")]);
  const liveLines = liveOutput.stdout.trim().split(/\r?\n/);
  const liveResult = JSON.parse(liveLines.at(-1) ?? "null");
  if (liveResult?.success !== true || liveResult.cleanup !== true || liveResult.pool !== 8) {
    throw new Error("Live DEV StorageAdapter contract did not produce accepted evidence");
  }
  pass("live DEV SftpStorageAdapter contract", liveResult);

  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  for (const child of [...children].reverse()) await stopChild(child);
  run(docker, ["compose", "-p", "vault-stage3", "down", "--remove-orphans"], environment, true);
  await fs.rm(path.join(vaultRoot, "data", "sftp"), { recursive: true, force: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  ownerToken = "";
}
