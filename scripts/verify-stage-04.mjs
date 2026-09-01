import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(vaultRoot, "artifacts", "verification", "stage-04-protection-audit.json");
const pnpmScript = path.join(vaultRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const report = { schema: "vault.stage-verification.v1", stage: 4, startedAt: new Date().toISOString(), success: false, checks: [] };
const children = [];
let environment = process.env;
let ownerToken = "";

function pass(name, detail = {}) {
  report.checks.push({ name, status: "pass", detail });
  process.stdout.write(`PASS ${name}\n`);
}

function run(command, args, selectedEnvironment = environment, allowFailure = false) {
  const result = spawnSync(command, args, { cwd: vaultRoot, env: selectedEnvironment, encoding: "utf8", windowsHide: true });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(" ")} failed: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-3_000)}`);
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
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3000/health/ready", { signal: AbortSignal.timeout(5_000) });
      if (response.status === 200) return;
    } catch {
      // Startup polling is expected to fail until both artifacts are listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("API did not become ready");
}

async function request(relativePath, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("Authorization", `Bearer ${ownerToken}`);
  let body;
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  } else if (options.body !== undefined) body = options.body;
  return fetch(`http://127.0.0.1:3000/api/v1${relativePath}`, {
    method: options.method ?? "GET",
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
}

async function jsonRequest(relativePath, options, expectedStatus) {
  const response = await request(relativePath, options);
  const text = await response.text();
  if (response.status !== expectedStatus) throw new Error(`${options.method ?? "GET"} ${relativePath} returned ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : undefined;
}

async function uploadFile({ parentId, filename, payload, key, overwriteResourceId }) {
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const upload = await jsonRequest("/uploads", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    json: {
      parentId,
      filename,
      expectedSize: payload.length,
      expectedSha256: sha256,
      ...(overwriteResourceId === undefined ? {} : { overwriteResourceId }),
    },
  }, 201);
  const chunk = await request(`/uploads/${upload.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" },
    body: payload,
  });
  if (chunk.status !== 204) throw new Error(`Upload chunk returned ${chunk.status}`);
  return jsonRequest(`/uploads/${upload.id}/complete`, { method: "POST" }, 201);
}

async function download(resourceId) {
  const response = await request(`/files/${resourceId}/content`);
  if (response.status !== 200) throw new Error(`Download returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

try {
  run(process.execPath, [pnpmScript, "install", "--frozen-lockfile"]);
  run(process.execPath, [pnpmScript, "lint"]);
  run(process.execPath, [pnpmScript, "typecheck"]);
  run(process.execPath, [pnpmScript, "test"]);
  run(process.execPath, [pnpmScript, "build"]);
  pass("workspace quality gates", { install: "frozen", lint: "pass", typecheck: "pass", tests: "pass", build: "pass" });

  run(docker, ["compose", "-p", "vault-stage4", "down", "--remove-orphans"], environment, true);
  await fs.rm(path.join(vaultRoot, "data", "sftp"), { recursive: true, force: true });
  const prepared = await prepareDevelopmentEnvironment();
  environment = { ...process.env, ...prepared.environment };
  ownerToken = (await fs.readFile(prepared.environment.OWNER_BOOTSTRAP_TOKEN_FILE, "utf8")).trim();
  run(docker, ["compose", "-p", "vault-stage4", "up", "-d", "--wait"]);
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  const rollback = run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "rollback"]);
  if (!rollback.stdout.includes("0003_protection_audit")) throw new Error("Protection migration rollback did not select 0003");
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  pass("protection schema migration round trip", { migration: "0003_protection_audit" });

  startArtifact("apps/worker/dist/main.js");
  startArtifact("apps/api/dist/main.js");
  await waitForReady();
  pass("Stage 4 production artifacts ready");

  const suffix = Date.now().toString(36);
  const rootId = "00000000-0000-7000-8000-000000000004";
  const folder = await jsonRequest("/folders", { method: "POST", json: { parentId: rootId, name: `Protection-${suffix}` } }, 201);
  const originalPayload = Buffer.from(`original protected bytes ${suffix}`);
  const replacementPayload = Buffer.from(`replacement protected bytes ${suffix}`);
  const original = await uploadFile({ parentId: folder.id, filename: "versioned.bin", payload: originalPayload, key: `initial-${suffix}` });
  const overwritten = await uploadFile({
    parentId: folder.id,
    filename: "versioned.bin",
    payload: replacementPayload,
    key: `overwrite-${suffix}`,
    overwriteResourceId: original.resource.id,
  });
  if (overwritten.resource.id !== original.resource.id || !(await download(original.resource.id)).equals(replacementPayload)) {
    throw new Error("Overwrite did not preserve identity/current bytes");
  }
  const versions = await jsonRequest(`/files/${original.resource.id}/versions`, {}, 200);
  const originalDigest = createHash("sha256").update(originalPayload).digest("hex");
  const archived = versions.find((item) => item.sha256 === originalDigest);
  if (archived === undefined || !archived.storagePath.startsWith("_system/versions/")) throw new Error("Old current version was not archived");
  const restoredVersion = await jsonRequest(`/files/${original.resource.id}/versions/${archived.id}/restore`, {
    method: "POST",
    headers: { "Idempotency-Key": `version-restore-${suffix}` },
  }, 201);
  if (restoredVersion.id !== original.resource.id || !(await download(original.resource.id)).equals(originalPayload)) {
    throw new Error("Version restore round trip failed");
  }
  pass("overwrite and version restore round trip", { stableResourceId: original.resource.id, versions: versions.length });

  const trashed = await jsonRequest(`/resources/${original.resource.id}`, {
    method: "DELETE",
    headers: { "Idempotency-Key": `trash-${suffix}` },
  }, 200);
  const trashRestored = await jsonRequest(`/resources/${original.resource.id}/restore`, {
    method: "POST",
    headers: { "Idempotency-Key": `trash-restore-${suffix}` },
  }, 201);
  if (trashed.status !== "trashed" || trashRestored.id !== original.resource.id || !(await download(original.resource.id)).equals(originalPayload)) {
    throw new Error("Trash restore round trip failed");
  }
  pass("trash restore round trip", { retentionDays: 90, stableResourceId: original.resource.id });

  await jsonRequest("/folders", { method: "POST", json: { parentId: rootId, name: ownerToken } }, 201);
  const activity = await jsonRequest("/activity?limit=100", {}, 200);
  const actions = new Set(activity.map((item) => item.action));
  for (const required of ["file.overwritten", "file.version.restored", "resource.trashed", "resource.restored"]) {
    if (!actions.has(required)) throw new Error(`Audit action missing: ${required}`);
  }
  const exportResponse = await request("/activity/export?limit=1000", { headers: { Accept: "application/x-ndjson" } });
  const auditExport = await exportResponse.text();
  if (exportResponse.status !== 200 || auditExport.includes(ownerToken) || !auditExport.includes("[REDACTED]")) {
    throw new Error("Audit export redaction failed");
  }
  pass("bounded activity and redacted JSONL export", { events: activity.length });

  const immutable = run(docker, [
    "exec",
    "vault-stage4-postgres-1",
    "psql",
    "-U",
    "vault",
    "-d",
    "vault",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "UPDATE audit_events SET action='tampered' WHERE sequence=(SELECT min(sequence) FROM audit_events)",
  ], environment, true);
  if (immutable.status === 0 || !`${immutable.stdout}${immutable.stderr}`.includes("append-only")) {
    throw new Error("Audit update was not rejected by the database");
  }
  pass("database-enforced append-only audit");

  const purge = await jsonRequest("/diagnostics/reconciliation/purge", { method: "POST", json: { limit: 100 } }, 201);
  if (purge.state !== "disabled" || purge.purged !== 0) throw new Error("Purge was not fail-closed");
  pass("purge fail-closed by default");

  const missing = await uploadFile({ parentId: folder.id, filename: "missing.bin", payload: Buffer.from("missing"), key: `missing-${suffix}` });
  const sized = await uploadFile({ parentId: folder.id, filename: "sized.bin", payload: Buffer.from("1234"), key: `sized-${suffix}` });
  const hashed = await uploadFile({ parentId: folder.id, filename: "hashed.bin", payload: Buffer.from("abcd"), key: `hashed-${suffix}` });
  const localStorageRoot = path.join(vaultRoot, "data", "sftp");
  await fs.unlink(path.join(localStorageRoot, ...missing.resource.storagePath.split("/")));
  await fs.writeFile(path.join(localStorageRoot, ...sized.resource.storagePath.split("/")), "12");
  await fs.writeFile(path.join(localStorageRoot, ...hashed.resource.storagePath.split("/")), "wxyz");
  const orphanPath = path.join(localStorageRoot, "drive", `orphan-${suffix}.bin`);
  await fs.writeFile(orphanPath, "unknown but preserved");
  const reconciliation = await jsonRequest("/diagnostics/reconciliation", { method: "POST", json: { mode: "full_hash" }, timeoutMs: 120_000 }, 201);
  const issues = await jsonRequest(`/diagnostics/reconciliation/${reconciliation.id}/issues?limit=100`, {}, 200);
  const issueTypes = new Set(issues.map((item) => item.issueType));
  for (const expected of ["missing", "size_mismatch", "checksum_mismatch", "orphaned"]) {
    if (!issueTypes.has(expected)) throw new Error(`Reconciliation issue missing: ${expected}`);
  }
  const orphan = issues.find((item) => item.issueType === "orphaned" && item.storagePath.endsWith(`orphan-${suffix}.bin`));
  if (orphan === undefined || !await fs.stat(path.join(localStorageRoot, ...String(orphan.actual.orphanPath).split("/"))).then(() => true, () => false)) {
    throw new Error("Orphan was not preserved in its run namespace");
  }
  pass("reconciliation mismatch fixtures", { issueTypes: [...issueTypes].sort(), orphanPreserved: true });

  const liveOutput = run(process.execPath, [path.join(vaultRoot, "scripts", "verify-stage-04-live.mjs")]);
  const liveResult = JSON.parse(liveOutput.stdout.trim().split(/\r?\n/).at(-1) ?? "null");
  if (liveResult?.success !== true || liveResult.cleanup !== true) throw new Error("Live DEV protection round trip failed");
  pass("live DEV overwrite and restore round trips", liveResult);

  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  for (const child of [...children].reverse()) await stopChild(child);
  run(docker, ["compose", "-p", "vault-stage4", "down", "--remove-orphans"], environment, true);
  await fs.rm(path.join(vaultRoot, "data", "sftp"), { recursive: true, force: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  ownerToken = "";
}
