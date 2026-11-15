import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = path.join(root, "node_modules", "pnpm", "bin", "pnpm.cjs");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const project = `saturn-pressure-${randomUUID().slice(0, 8)}`;
const namespace = project.replaceAll("_", "-");
const runtime = path.join(root, ".tmp", namespace);
const reportPath = path.join(root, "artifacts", "verification", "upload-pressure.json");
const report = { schema: "saturn.upload-pressure.v1", startedAt: new Date().toISOString(), success: false, checks: [] };
const children = [];
const logs = [];
let environment = process.env;
let database;

function run(command, args, selectedEnvironment = environment, allowFailure = false) {
  const result = spawnSync(command, args, { cwd: root, env: selectedEnvironment, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(" ")} failed: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-8_000)}`);
  return result;
}

function start(command, args) {
  const child = spawn(command, args, { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => logs.push(chunk.toString("utf8").slice(-32_768)));
  return child;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 4_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.unref(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Could not reserve a port")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function updateCookies(jar, response) {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(";", 1); const separator = pair.indexOf("="); if (separator < 1) continue;
    if (/max-age=0/i.test(value)) jar.delete(pair.slice(0, separator)); else jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader(jar) { return [...jar].map(([name, value]) => `${name}=${value}`).join("; "); }
function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function pass(name, detail) { report.checks.push({ name, status: "pass", detail }); process.stdout.write(`PASS ${name}\n`); }

try {
  run(process.execPath, [pnpm, "build"]);
  const [postgresPort, sftpPort, apiPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const prepared = await prepareDevelopmentEnvironment({ postgresPort, sftpPort, runtimeNamespace: namespace });
  const apiOrigin = `http://127.0.0.1:${String(apiPort)}`;
  environment = {
    ...process.env,
    ...prepared.environment,
    PUBLIC_ORIGIN: apiOrigin,
    API_PORT: String(apiPort),
    STORAGE_RUNTIME_CONFIG_DIR: path.join(runtime, "storage-runtime"),
    DROP_BUFFER_DIRECTORY: path.join(runtime, "drop-buffer"),
    DROP_BUFFER_MAX_BYTES: String(2 * 1024 ** 3),
    DROP_BUFFER_MIN_FREE_BYTES: "0",
    DROP_MAX_BYTES: String(2 * 1024 ** 3),
    UPLOAD_MAX_BYTES: String(1024 ** 3),
    BACKUP_MAX_RUN_BYTES: String(1024 ** 3),
    BACKUP_DAILY_QUOTA_BYTES: String(2 * 1024 ** 3),
    BACKUP_STORED_QUOTA_BYTES: String(2 * 1024 ** 3),
    DROP_DRAIN_INTERVAL_MS: "60000",
    LOG_LEVEL: "info",
  };
  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  run(docker, ["compose", "-p", project, "up", "-d", "--wait"], environment);
  run(process.execPath, [pnpm, "--filter", "@saturn/database", "migrate"], environment);
  start(process.execPath, [path.join(root, "apps", "worker", "dist", "main.js")]);
  start(process.execPath, [path.join(root, "apps", "api", "dist", "main.js")]);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${apiOrigin}/health/ready`, { signal: AbortSignal.timeout(2_000) })).status === 200) break; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if ((await fetch(`${apiOrigin}/health/ready`)).status !== 200) throw new Error(`API did not become ready: ${logs.join("").slice(-4_000)}`);

  const databaseModule = await import(pathToFileURL(path.join(root, "packages", "database", "dist", "index.js")));
  database = new databaseModule.Database(environment.DATABASE_URL, { max: 4 });
  await database.withSql((sql) => sql`UPDATE owner_preferences SET upload_buffer_gib=2, maximum_upload_file_gib=1, updated_at=now()`);
  const ownerKey = (await fs.readFile(environment.OWNER_BOOTSTRAP_TOKEN_FILE, "utf8")).trim();
  const ownerJar = new Map();

  async function request(relative, options = {}) {
    const headers = new Headers(options.headers ?? {}); headers.set("User-Agent", "saturn-upload-pressure/1");
    const jar = options.jar; if (jar?.size) headers.set("Cookie", cookieHeader(jar));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(options.method ?? "GET")) {
      headers.set("Origin", apiOrigin);
      const csrf = relative.startsWith("/drop/") ? jar?.get("vault_drop_csrf_dev") ?? jar?.get("vault_csrf_dev") : jar?.get("vault_csrf_dev");
      if (csrf) headers.set("X-Vault-CSRF", csrf);
    }
    let body = options.body;
    if (options.json !== undefined) { headers.set("Content-Type", "application/json"); body = JSON.stringify(options.json); }
    const response = await fetch(`${apiOrigin}/api/v1${relative}`, { method: options.method ?? "GET", headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(120_000) });
    if (jar) updateCookies(jar, response);
    return response;
  }
  async function value(response) { const text = await response.text(); return text ? JSON.parse(text) : undefined; }
  const login = await request("/auth/login", { method: "POST", jar: ownerJar, json: { accessKey: ownerKey } });
  if (login.status !== 201) throw new Error(`Owner login failed: ${String(login.status)}`);

  const oneGiB = 1024 ** 3;
  const ownerLimit = await request("/uploads", { method: "POST", jar: ownerJar, headers: { "Idempotency-Key": "pressure-owner-oversize" }, json: { parentId: "00000000-0000-7000-8000-000000000004", filename: "too-large-owner.bin", expectedSize: oneGiB + 1 } });
  if (ownerLimit.status !== 413 || (await value(ownerLimit)).code !== "payload_too_large") throw new Error(`Owner oversize classification failed: ${String(ownerLimit.status)}`);
  pass("owner maximum file limit", { status: 413, uploadReserved: false });

  const enrollment = await value(await request("/devices/enrollments", { method: "POST", jar: ownerJar, json: { name: "Pressure Windows" } }));
  const windows = await value(await request("/device-enrollments/redeem", { method: "POST", json: { code: enrollment.code, version: "pressure-test" } }));
  const windowsHeaders = { Authorization: `Bearer ${windows.token}` };
  const oversizedSync = await request("/sync/uploads", { method: "POST", headers: windowsHeaders, json: { path: "sync/Pressure Windows/too-large.bin", expectedSize: oneGiB + 1, expectedSha256: "a".repeat(64), idempotencyKey: "b".repeat(64), ifNoneMatch: "*" } });
  if (oversizedSync.status !== 413 || (await value(oversizedSync)).code !== "payload_too_large") throw new Error(`Windows oversize classification failed: ${String(oversizedSync.status)}`);
  pass("Windows resumable maximum file limit", { status: 413, checkpointCreated: false });

  const backup = await value(await request("/backup-services", { method: "POST", jar: ownerJar, json: { slug: "pressure-backup", name: "Pressure backup", requireEncryption: false, maxBackupBytes: 64, dailyQuotaBytes: 128, storedQuotaBytes: 128, maxConcurrentRuns: 1 } }));
  const backupHeaders = { Authorization: `Bearer ${backup.token}`, "Idempotency-Key": "pressure-backup-oversize", "Content-Type": "application/json" };
  const oversizedBackup = await request("/backups/pressure-backup/runs", { method: "POST", headers: backupHeaders, body: JSON.stringify({ filename: "too-large.bin", createdAt: new Date().toISOString(), backupType: "full", expectedSize: 65, sha256: "c".repeat(64), sourceVersion: "pressure-1", encrypted: false }) });
  if (oversizedBackup.status !== 413 || (await value(oversizedBackup)).code !== "limit") throw new Error(`Backup oversize classification failed: ${String(oversizedBackup.status)}`);
  pass("internal backup maximum run limit", { status: 413, runReserved: false });

  await request("/drop/internal/session", { method: "POST", jar: ownerJar });
  const makeDrop = (name, bytes, key) => request("/drop/uploads", { method: "POST", jar: ownerJar, headers: { "Idempotency-Key": key }, json: { filename: name, expectedSize: bytes } });
  const oversizedDrop = await makeDrop("pressure-drop-too-large.bin", oneGiB + 1, "pressure-drop-oversize");
  if (oversizedDrop.status !== 413 || (await value(oversizedDrop)).code !== "payload_too_large") throw new Error(`Drop oversize classification failed: ${String(oversizedDrop.status)}`);
  pass("Drop maximum file limit", { status: 413, uploadReserved: false });
  const first = await makeDrop("pressure-800.bin", 800 * 1024 ** 2, "pressure-drop-800");
  if (first.status !== 201) throw new Error(`First Drop reservation failed: ${String(first.status)}`);
  const firstValue = await value(first);
  const race = await Promise.all([makeDrop("pressure-race-a.bin", 600 * 1024 ** 2, "pressure-drop-race-a"), makeDrop("pressure-race-b.bin", 600 * 1024 ** 2, "pressure-drop-race-b")]);
  const raceStatuses = race.map((response) => response.status).sort((a, b) => a - b);
  if (raceStatuses.join(",") !== "201,413") throw new Error(`Drop atomic reservation race failed: ${raceStatuses.join(",")}`);
  const acceptedRace = race.find((response) => response.status === 201); const acceptedRaceValue = await value(acceptedRace);
  const nearLimit = await makeDrop("pressure-400.bin", 400 * 1024 ** 2, "pressure-drop-400");
  if (nearLimit.status !== 201) throw new Error(`Drop near-limit reservation failed: ${String(nearLimit.status)}`);
  const nearLimitValue = await value(nearLimit);
  const refused = await makeDrop("pressure-refused.bin", 100 * 1024 ** 2, "pressure-drop-refused");
  if (refused.status !== 413 || (await value(refused)).code !== "drop_quota_exhausted") throw new Error(`Drop refusal failed: ${String(refused.status)}`);
  pass("Drop buffer atomic high-watermark refusal", { concurrent: raceStatuses, refusal: 413, reservedGiB: 1.8 });

  async function ownerUpload(filename, bytes, key) {
    const created = await value(await request("/uploads", { method: "POST", jar: ownerJar, headers: { "Idempotency-Key": key }, json: { parentId: "00000000-0000-7000-8000-000000000004", filename, expectedSize: bytes.length, expectedSha256: sha(bytes) } }));
    const patch = await request(`/uploads/${created.id}`, { method: "PATCH", jar: ownerJar, headers: { "Upload-Offset": "0", "Content-Length": String(bytes.length), "Content-Type": "application/offset+octet-stream" }, body: bytes });
    const complete = await request(`/uploads/${created.id}/complete`, { method: "POST", jar: ownerJar });
    if (patch.status !== 204 || complete.status !== 201) throw new Error(`Owner upload under Drop pressure failed: ${String(patch.status)}/${String(complete.status)}`);
  }
  await ownerUpload("owner-under-pressure.txt", Buffer.from("owner"), "pressure-owner-small");

  const syncBytes = Buffer.from("windows");
  const syncCreated = await value(await request("/sync/uploads", { method: "POST", headers: windowsHeaders, json: { path: "sync/Pressure Windows/under-pressure.txt", expectedSize: syncBytes.length, expectedSha256: sha(syncBytes), idempotencyKey: "d".repeat(64), ifNoneMatch: "*" } }));
  const syncPatch = await request(`/sync/uploads/${syncCreated.id}`, { method: "PATCH", headers: { ...windowsHeaders, "Upload-Offset": "0", "Content-Length": String(syncBytes.length), "Content-Type": "application/offset+octet-stream" }, body: syncBytes });
  const syncComplete = await request(`/sync/uploads/${syncCreated.id}/complete`, { method: "POST", headers: windowsHeaders });
  if (syncPatch.status !== 200 || syncComplete.status !== 201) throw new Error(`Windows upload under Drop pressure failed: ${String(syncPatch.status)}/${String(syncComplete.status)}`);

  const plutoEnrollment = await value(await request("/devices/enrollments", { method: "POST", jar: ownerJar, json: { name: "Pressure Pluto", deviceKind: "pluto" } }));
  const pluto = await value(await request("/pluto/enrollments/redeem", { method: "POST", json: { code: plutoEnrollment.code, version: "pressure-test" } }));
  const plutoBytes = Buffer.from("pluto");
  const plutoUpload = await request("/pluto/files?path=under-pressure.txt", { method: "PUT", headers: { Authorization: `Bearer ${pluto.token}`, "X-Content-Sha256": sha(plutoBytes), "If-None-Match": "*", "Content-Type": "application/octet-stream" }, body: plutoBytes });
  if (plutoUpload.status !== 200) throw new Error(`Pluto upload under Drop pressure failed: ${String(plutoUpload.status)} ${await plutoUpload.text()}`);

  const backupBytes = Buffer.from("backup");
  const backupRun = await value(await request("/backups/pressure-backup/runs", { method: "POST", headers: { Authorization: `Bearer ${backup.token}`, "Idempotency-Key": "pressure-backup-small" }, json: { filename: "under-pressure.bin", createdAt: new Date().toISOString(), backupType: "full", expectedSize: backupBytes.length, sha256: sha(backupBytes), sourceVersion: "pressure-2", encrypted: false } }));
  const backupPatch = await request(`/backups/pressure-backup/runs/${backupRun.id}/upload`, { method: "PATCH", headers: { Authorization: `Bearer ${backup.token}`, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream" }, body: backupBytes });
  const backupComplete = await request(`/backups/pressure-backup/runs/${backupRun.id}/complete`, { method: "POST", headers: { Authorization: `Bearer ${backup.token}` } });
  if (backupPatch.status !== 204 || backupComplete.status !== 201) throw new Error(`Backup under Drop pressure failed: ${String(backupPatch.status)}/${String(backupComplete.status)}`);
  pass("non-Drop channels remain independent under local buffer pressure", { owner: "stored", windows: "stored", pluto: "stored", backup: "stored" });

  for (const id of [firstValue.id, acceptedRaceValue.id, nearLimitValue.id]) {
    const cancelled = await request(`/drop/uploads/${id}`, { method: "DELETE", jar: ownerJar });
    if (cancelled.status !== 200) throw new Error(`Drop cancellation failed: ${String(cancelled.status)}`);
  }
  const capacity = await value(await request("/drop/buffer", { jar: ownerJar }));
  const parts = await fs.readdir(path.join(runtime, "drop-buffer")).catch(() => []);
  if (capacity.capacity.reservedBytes !== 0 || parts.some((name) => name.endsWith(".part"))) throw new Error(`Drop cancellation leaked capacity or parts: ${JSON.stringify(capacity.capacity)}/${parts.join(",")}`);
  const databaseCounts = await database.withSql(async (sql) => ({
    oversizedUploads: Number((await sql`SELECT count(*)::int AS count FROM upload_sessions WHERE expected_size > ${oneGiB}`)[0]?.count ?? -1),
    oversizedDropUploads: Number((await sql`SELECT count(*)::int AS count FROM drop_uploads WHERE expected_size > ${oneGiB}`)[0]?.count ?? -1),
    oversizedBackups: Number((await sql`SELECT count(*)::int AS count FROM service_backup_runs WHERE expected_size > 64`)[0]?.count ?? -1),
  }));
  if (databaseCounts.oversizedUploads !== 0 || databaseCounts.oversizedDropUploads !== 0 || databaseCounts.oversizedBackups !== 0) throw new Error(`Oversized reservations leaked: ${JSON.stringify(databaseCounts)}`);
  pass("cancellation and rejection leave no leaked capacity", { reservedBytes: 0, partFiles: 0, ...databaseCounts });
  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await database?.close().catch(() => undefined);
  for (const child of [...children].reverse()) await stop(child);
  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  await fs.rm(runtime, { recursive: true, force: true }).catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
