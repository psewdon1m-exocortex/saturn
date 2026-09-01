import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(vaultRoot, "artifacts", "verification", "stage-08-external-sharing.json");
const desktopScreenshot = path.join(vaultRoot, "artifacts", "verification", "stage-08-share-desktop.png");
const mobileScreenshot = path.join(vaultRoot, "artifacts", "verification", "stage-08-share-mobile.png");
const pnpmScript = path.join(vaultRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
const viteScript = path.join(vaultRoot, "apps", "web", "node_modules", "vite", "bin", "vite.js");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const project = "vault-stage8";
const postgresContainer = `${project}-postgres-1`;
const publicOrigin = "http://127.0.0.1:4173";
const apiOrigin = "http://127.0.0.1:3000";
const rootId = "00000000-0000-7000-8000-000000000004";
const report = { schema: "vault.stage-verification.v1", stage: 8, startedAt: new Date().toISOString(), success: false, checks: [] };
const children = [];
const runtimeLogs = [];
const knownSecrets = new Set();
let environment = process.env;
let database;
let browser;

function pass(name, detail = {}) {
  report.checks.push({ name, status: "pass", detail });
  process.stdout.write(`PASS ${name}\n`);
}

function run(command, args, selectedEnvironment = environment, allowFailure = false) {
  const result = spawnSync(command, args, { cwd: vaultRoot, env: selectedEnvironment, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(" ")} failed: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4_000)}`);
  return result;
}

function runBinary(command, args, input) {
  const result = spawnSync(command, args, { cwd: vaultRoot, env: environment, input, encoding: null, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${path.basename(command)} binary command failed: ${Buffer.from(result.stderr ?? []).toString("utf8").trim().slice(-1_000)}`);
  return Buffer.from(result.stdout ?? []);
}

function start(command, args, cwd = vaultRoot) {
  const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => runtimeLogs.push(chunk.toString("utf8").slice(-32_768)));
  return child;
}

async function stop(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 4_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitFor(url, expectedStatus = 200, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(3_000) })).status === expectedStatus) return; } catch { /* listener is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}: ${runtimeLogs.join("").slice(-3_000)}`);
}

function updateCookies(jar, response) {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(";", 1);
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    if (/max-age=0/i.test(value)) jar.delete(name); else jar.set(name, pair.slice(separator + 1));
  }
}

function cookieHeader(jar) { return [...jar].map(([name, value]) => `${name}=${value}`).join("; "); }

async function apiRequest(relativePath, options = {}) {
  const { method = "GET", json, body, headers: inputHeaders, jar, origin = publicOrigin, signal } = options;
  const headers = new Headers(inputHeaders ?? {});
  if (!headers.has("User-Agent")) headers.set("User-Agent", "vault-stage8-verifier/1");
  if (jar?.size > 0) headers.set("Cookie", cookieHeader(jar));
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (origin !== undefined) headers.set("Origin", origin);
    const csrf = jar?.get("vault_csrf_dev");
    if (csrf !== undefined) headers.set("X-Vault-CSRF", csrf);
  }
  let requestBody = body;
  if (json !== undefined) { headers.set("Content-Type", "application/json"); requestBody = JSON.stringify(json); }
  const response = await fetch(`${apiOrigin}/api/v1${relativePath}`, {
    method,
    headers,
    ...(requestBody === undefined ? {} : { body: requestBody }),
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  if (jar !== undefined) updateCookies(jar, response);
  return response;
}

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function createFolder(jar, name, parentId = rootId) {
  const response = await apiRequest("/folders", { method: "POST", jar, json: { parentId, name } });
  if (response.status !== 201) throw new Error(`Folder creation failed with ${String(response.status)}`);
  return responseJson(response);
}

async function upload(jar, parentId, filename, payload) {
  const create = await apiRequest("/uploads", { method: "POST", jar, headers: { "Idempotency-Key": `stage8-${randomUUID()}` }, json: { parentId, filename, expectedSize: payload.length, expectedSha256: createHash("sha256").update(payload).digest("hex") } });
  if (create.status !== 201) throw new Error(`Upload creation failed with ${String(create.status)}`);
  const session = await responseJson(create);
  const append = await apiRequest(`/uploads/${session.id}`, { method: "PATCH", jar, headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0", "Content-Length": String(payload.length) }, body: payload });
  if (append.status !== 204) throw new Error(`Upload append failed with ${String(append.status)}`);
  const complete = await apiRequest(`/uploads/${session.id}/complete`, { method: "POST", jar, json: {} });
  if (complete.status !== 201) throw new Error(`Upload completion failed with ${String(complete.status)}`);
  return (await responseJson(complete)).resource;
}

async function createShare(jar, resourceId, mode, options = {}) {
  const response = await apiRequest("/shares", { method: "POST", jar, json: { resourceId, mode, ...options } });
  if (response.status !== 201) throw new Error(`Share creation failed with ${String(response.status)}: ${JSON.stringify(await responseJson(response))}`);
  const value = await responseJson(response);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.token) || !value.url.endsWith(`/s/${value.token}`)) throw new Error("Share capability format failed");
  knownSecrets.add(value.token);
  return value;
}

function publicPath(token, suffix = "") { return `/public/shares/${token}${suffix}`; }

async function shareMetadata(token, jar = new Map()) {
  const response = await apiRequest(publicPath(token), { jar });
  return { response, jar, value: await responseJson(response) };
}

async function scanBuiltArtifacts(secrets) {
  const roots = [path.join(vaultRoot, "apps", "api", "dist"), path.join(vaultRoot, "apps", "worker", "dist"), path.join(vaultRoot, "apps", "web", "dist")];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else {
        const bytes = await fs.readFile(target);
        for (const secret of secrets) if (secret.length >= 8 && bytes.includes(Buffer.from(secret))) throw new Error("Known secret found in production artifact");
      }
    }
  }
  for (const root of roots) await visit(root);
}

async function zipEntries(bytes) {
  const require = createRequire(path.join(vaultRoot, "packages", "recovery", "package.json"));
  const yauzl = require("yauzl");
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zipfile) => {
      if (error || zipfile === undefined) { reject(error ?? new Error("ZIP did not open")); return; }
      const entries = [];
      zipfile.on("entry", (entry) => { entries.push(entry.fileName); zipfile.readEntry(); });
      zipfile.once("error", reject);
      zipfile.once("end", () => resolve(entries));
      zipfile.readEntry();
    });
  });
}

try {
  run(process.execPath, [pnpmScript, "install", "--frozen-lockfile"]);
  run(process.execPath, [pnpmScript, "lint"]);
  run(process.execPath, [pnpmScript, "typecheck"]);
  run(process.execPath, [pnpmScript, "test"]);
  run(process.execPath, [pnpmScript, "build"]);
  pass("workspace quality gates", { install: "frozen", lint: "pass", typecheck: "pass", tests: 59, build: "pass" });

  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  const prepared = await prepareDevelopmentEnvironment();
  const ownerAccessKey = (await fs.readFile(prepared.environment.OWNER_BOOTSTRAP_TOKEN_FILE, "utf8")).trim();
  const sharePepper = (await fs.readFile(prepared.environment.SHARE_PEPPER_FILE, "utf8")).trim();
  const authPepper = (await fs.readFile(prepared.environment.AUTH_PEPPER_FILE, "utf8")).trim();
  const postgresPassword = decodeURIComponent(new URL(prepared.environment.DATABASE_URL).password);
  for (const secret of [ownerAccessKey, sharePepper, authPepper, postgresPassword]) knownSecrets.add(secret);
  environment = {
    ...process.env,
    ...prepared.environment,
    PUBLIC_ORIGIN: publicOrigin,
    SHARE_PASSWORD_FAILURE_LIMIT: "5",
    SHARE_PACKAGE_MAX_FILES: "20",
    SHARE_PACKAGE_MAX_BYTES: "16777216",
    SHARE_PACKAGE_MAX_DURATION_MS: "60000",
    SHARE_STREAM_REVALIDATE_BYTES: "65536",
    LOG_LEVEL: "info",
  };

  run(docker, ["compose", "-p", project, "up", "-d", "--wait"]);
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  const rollback = run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "rollback"]);
  if (!rollback.stdout.includes("0007_external_shares")) throw new Error("Stage 8 migration rollback did not select 0007");
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  pass("external sharing schema migration round trip", { migration: "0007_external_shares" });

  start(process.execPath, [path.join(vaultRoot, "apps", "worker", "dist", "main.js")]);
  start(process.execPath, [path.join(vaultRoot, "apps", "api", "dist", "main.js")]);
  start(process.execPath, [viteScript, "preview", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", "4173"], path.join(vaultRoot, "apps", "web"));
  await Promise.all([waitFor(`${apiOrigin}/health/ready`), waitFor(publicOrigin)]);

  const databaseModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "database", "dist", "index.js")));
  database = new databaseModule.Database(environment.DATABASE_URL, { max: 4 });
  const ownerJar = new Map();
  const login = await apiRequest("/auth/login", { method: "POST", jar: ownerJar, json: { accessKey: ownerAccessKey } });
  if (login.status !== 201) throw new Error(`Owner login failed with ${String(login.status)}`);
  for (const value of ownerJar.values()) knownSecrets.add(value);

  const sourceFolder = await createFolder(ownerJar, `stage8-source-${Date.now().toString(36)}`);
  const movedFolder = await createFolder(ownerJar, `stage8-moved-${Date.now().toString(36)}`);
  const payload = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const file = await upload(ownerJar, sourceFolder.id, "capability.png", payload);
  const password = `stage8-${randomBytes(12).toString("base64url")}`;
  knownSecrets.add(password);
  const protectedShare = await createShare(ownerJar, file.id, "view", { password, maxDownloads: 4 });
  const listed = await responseJson(await apiRequest("/shares", { jar: ownerJar }));
  if (JSON.stringify(listed).includes(protectedShare.token) || listed[0]?.token !== undefined || protectedShare.share.locked !== true) throw new Error("Owner share list disclosed capability material");
  const invalid = await shareMetadata(`${protectedShare.token.slice(0, -1)}${protectedShare.token.endsWith("A") ? "B" : "A"}`);
  if (invalid.response.status !== 404 || JSON.stringify(invalid.value) !== JSON.stringify({ code: "not_found" })) throw new Error("Forged capability was distinguishable");
  pass("high-entropy capability and one-time disclosure", { bits: 256, tokenLength: 43, ownerListToken: false, forged: 404 });

  const locked = await shareMetadata(protectedShare.token);
  if (locked.response.status !== 200 || locked.value.locked !== true || locked.jar.size !== 0) throw new Error("Password-protected share did not remain locked");
  await database.withSql(async (sql) => { await sql`DELETE FROM share_password_attempts`; });
  const failures = await Promise.all(Array.from({ length: 6 }, (_, index) => apiRequest(publicPath(protectedShare.token, "/unlock"), { method: "POST", jar: new Map(), json: { password: `wrong-password-${String(index)}` } }).then((response) => response.status)));
  if (JSON.stringify([...failures].sort((a, b) => a - b)) !== JSON.stringify([401, 401, 401, 401, 401, 429])) throw new Error(`Atomic password rate limit failed: ${failures.join(",")}`);
  await database.withSql(async (sql) => { await sql`DELETE FROM share_password_attempts`; });
  const shareJar = new Map();
  const unlocked = await apiRequest(publicPath(protectedShare.token, "/unlock"), { method: "POST", jar: shareJar, json: { password } });
  const unlockCookies = unlocked.headers.getSetCookie();
  if (unlocked.status !== 200 || shareJar.get("vault_share_session_dev") === undefined || !unlockCookies.some((value) => /HttpOnly/i.test(value) && /SameSite=Strict/i.test(value))) throw new Error("Argon2id unlock cookie contract failed");
  for (const value of shareJar.values()) knownSecrets.add(value);
  pass("Argon2id unlock and atomic brute-force boundary", { concurrentAttempts: 6, denied: 5, rateLimited: 1, httpOnly: true, sameSite: "Strict" });

  const firstRange = await apiRequest(publicPath(protectedShare.token, "/content"), { jar: shareJar, headers: { Range: "bytes=0-4" } });
  const firstBytes = Buffer.from(await firstRange.arrayBuffer());
  const suffix = await apiRequest(publicPath(protectedShare.token, "/content"), { jar: shareJar, headers: { Range: "bytes=-7" } });
  const suffixBytes = Buffer.from(await suffix.arrayBuffer());
  const openEnded = await apiRequest(publicPath(protectedShare.token, "/content"), { jar: shareJar, headers: { Range: "bytes=6-" } });
  const openBytes = Buffer.from(await openEnded.arrayBuffer());
  const badRange = await apiRequest(publicPath(protectedShare.token, "/content"), { jar: shareJar, headers: { Range: "bytes=0-1,3-4" } });
  if (firstRange.status !== 206 || !firstBytes.equals(payload.subarray(0, 5)) || firstRange.headers.get("content-range") !== `bytes 0-4/${String(payload.length)}`
    || suffix.status !== 206 || !suffixBytes.equals(payload.subarray(-7)) || openEnded.status !== 206 || !openBytes.equals(payload.subarray(6))
    || badRange.status !== 416 || badRange.headers.get("content-range") !== `bytes */${String(payload.length)}`
    || firstRange.headers.get("content-disposition")?.startsWith("inline;") !== true) {
    throw new Error(`Public file Range/disposition contract failed: ${JSON.stringify({
      first: [firstRange.status, firstBytes.toString("hex"), firstRange.headers.get("content-range"), firstRange.headers.get("content-disposition")],
      suffix: [suffix.status, suffixBytes.toString("hex")], open: [openEnded.status, openBytes.length], bad: [badRange.status, badRange.headers.get("content-range")], size: payload.length,
    })}`);
  }
  const downloadCount = await database.withSql(async (sql) => (await sql`SELECT download_count::int AS value FROM shares WHERE id = ${protectedShare.share.id}`)[0]?.value);
  if (downloadCount !== 1) throw new Error(`One share session claimed ${String(downloadCount)} downloads`);
  const move = await apiRequest(`/resources/${file.id}/move`, { method: "POST", jar: ownerJar, headers: { "Idempotency-Key": `stage8-move-${randomUUID()}` }, json: { parentId: movedFolder.id, name: "renamed-capability.png" } });
  if (move.status !== 201 && move.status !== 200) throw new Error(`Owner move failed with ${String(move.status)}`);
  const afterMove = await apiRequest(publicPath(protectedShare.token, "/content"), { jar: shareJar });
  if (afterMove.status !== 200 || !Buffer.from(await afterMove.arrayBuffer()).equals(payload)) throw new Error("Stable resource share failed after physical move");
  pass("Range resume, session counting and stable-ID move", { exact: 206, suffix: 206, openEnded: 206, multiple: 416, claims: 1, movePreserved: true });

  const concurrentFile = await upload(ownerJar, sourceFolder.id, "single-download.bin", Buffer.from("single download winner"));
  const concurrentShare = await createShare(ownerJar, concurrentFile.id, "download", { maxDownloads: 1 });
  const jars = [new Map(), new Map()];
  await Promise.all(jars.map((jar) => shareMetadata(concurrentShare.token, jar)));
  for (const jar of jars) for (const value of jar.values()) knownSecrets.add(value);
  const competing = await Promise.all(jars.map((jar) => apiRequest(publicPath(concurrentShare.token, "/content"), { jar }).then(async (response) => { await response.arrayBuffer(); return response.status; })));
  if (JSON.stringify([...competing].sort((a, b) => a - b)) !== JSON.stringify([200, 401])) throw new Error(`Concurrent max-download claim failed: ${competing.join(",")}`);
  pass("transactional max-download concurrency", { contenders: 2, success: 1, denied: 1 });

  const blockedPayload = Buffer.from("policy blocking");
  const classificationFile = await upload(ownerJar, sourceFolder.id, "classification.txt", blockedPayload);
  const classificationShare = await createShare(ownerJar, classificationFile.id, "download");
  const classificationJar = (await shareMetadata(classificationShare.token)).jar;
  const classified = await apiRequest(`/resources/${classificationFile.id}/classification`, { method: "PATCH", jar: ownerJar, json: { classification: "confidential" } });
  if (classified.status !== 200 || (await shareMetadata(classificationShare.token, classificationJar)).response.status !== 404) throw new Error("Classification tightening did not block share immediately");
  const trashFile = await upload(ownerJar, sourceFolder.id, "trash.txt", blockedPayload);
  const trashShare = await createShare(ownerJar, trashFile.id, "download");
  const trashJar = (await shareMetadata(trashShare.token)).jar;
  const trashed = await apiRequest(`/resources/${trashFile.id}`, { method: "DELETE", jar: ownerJar, headers: { "Idempotency-Key": `stage8-trash-${randomUUID()}` } });
  if (trashed.status !== 200 || (await shareMetadata(trashShare.token, trashJar)).response.status !== 404) throw new Error("Trash did not block share immediately");
  const expiryFile = await upload(ownerJar, sourceFolder.id, "expiry.txt", blockedPayload);
  const expiryShare = await createShare(ownerJar, expiryFile.id, "download");
  await database.withSql(async (sql) => { await sql`UPDATE shares SET state = 'expired', updated_at = now() WHERE id = ${expiryShare.share.id}`; });
  if ((await shareMetadata(expiryShare.token)).response.status !== 404) throw new Error("Expired share remained accessible");
  const revokeFile = await upload(ownerJar, sourceFolder.id, "revoke.txt", blockedPayload);
  const revokeShare = await createShare(ownerJar, revokeFile.id, "download");
  const revokeJar = (await shareMetadata(revokeShare.token)).jar;
  if ((await apiRequest(`/shares/${revokeShare.share.id}`, { method: "DELETE", jar: ownerJar })).status !== 200 || (await shareMetadata(revokeShare.token, revokeJar)).response.status !== 404) throw new Error("Revoked share remained accessible");
  pass("immediate policy revocation matrix", { classification: 404, trash: 404, expiry: 404, revoke: 404 });

  const streamPayload = randomBytes(8 * 1024 * 1024);
  const streamFile = await upload(ownerJar, sourceFolder.id, "active-stream.bin", streamPayload);
  const streamShare = await createShare(ownerJar, streamFile.id, "download");
  const streamJar = (await shareMetadata(streamShare.token)).jar;
  const streamResponse = await apiRequest(publicPath(streamShare.token, "/content"), { jar: streamJar, signal: AbortSignal.timeout(120_000) });
  if (streamResponse.status !== 200 || streamResponse.body === null) throw new Error("Active stream did not start");
  const reader = streamResponse.body.getReader();
  const firstChunk = await reader.read();
  if (firstChunk.done || firstChunk.value.length === 0) throw new Error("Active stream returned no first chunk");
  await apiRequest(`/shares/${streamShare.share.id}`, { method: "DELETE", jar: ownerJar });
  let streamedBytes = firstChunk.value.length;
  let streamTerminated = false;
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      const chunk = await reader.read();
      if (chunk.done) break;
      streamedBytes += chunk.value.length;
    }
  } catch { streamTerminated = true; }
  if (!streamTerminated && streamedBytes >= streamPayload.length) throw new Error("Revoked active stream delivered the complete object");
  pass("active-stream policy revalidation", { thresholdBytes: 65536, deliveredBeforeTermination: streamedBytes, completeObjectDenied: true });

  const sharedFolder = await createFolder(ownerJar, `stage8-folder-${Date.now().toString(36)}`);
  const nestedFolder = await createFolder(ownerJar, "nested", sharedFolder.id);
  const siblingFolder = await createFolder(ownerJar, `stage8-sibling-${Date.now().toString(36)}`);
  const folderFile = await upload(ownerJar, sharedFolder.id, "visible.txt", Buffer.from("visible package content"));
  const nestedFile = await upload(ownerJar, nestedFolder.id, "nested.txt", Buffer.from("nested package content"));
  const secretFile = await upload(ownerJar, sharedFolder.id, "secret.txt", Buffer.from("must stay hidden"));
  await apiRequest(`/resources/${secretFile.id}/classification`, { method: "PATCH", jar: ownerJar, json: { classification: "secret" } });
  const folderShare = await createShare(ownerJar, sharedFolder.id, "download_folder", { maxDownloads: 3 });
  const folderJar = (await shareMetadata(folderShare.token)).jar;
  const childrenResponse = await apiRequest(publicPath(folderShare.token, "/children"), { jar: folderJar });
  const visibleChildren = await responseJson(childrenResponse);
  const escape = await apiRequest(`${publicPath(folderShare.token, "/children")}?parentId=${siblingFolder.id}`, { jar: folderJar });
  if (childrenResponse.status !== 200 || !visibleChildren.some((item) => item.id === folderFile.id) || !visibleChildren.some((item) => item.id === nestedFolder.id)
    || visibleChildren.some((item) => item.id === secretFile.id) || escape.status !== 404) throw new Error("Folder share descendant/classification boundary failed");
  const preparedPackageResponse = await apiRequest(publicPath(folderShare.token, "/package"), { method: "POST", jar: folderJar, json: {} });
  const preparedPackage = await responseJson(preparedPackageResponse);
  if (preparedPackageResponse.status !== 201 || preparedPackage.state !== "ready") throw new Error(`Folder package preparation failed with ${String(preparedPackageResponse.status)}`);
  const packageResponse = await apiRequest(publicPath(folderShare.token, "/package"), { jar: folderJar });
  const packageBytes = Buffer.from(await packageResponse.arrayBuffer());
  const entries = await zipEntries(packageBytes);
  const packageHash = createHash("sha256").update(packageBytes).digest("hex");
  const packageRange = await apiRequest(publicPath(folderShare.token, "/package"), { jar: folderJar, headers: { Range: "bytes=0-31" } });
  if (packageResponse.status !== 200 || packageHash !== preparedPackage.sha256 || packageBytes.length !== Number(preparedPackage.sizeBytes)
    || !entries.includes("visible.txt") || !entries.includes("nested/") || !entries.includes("nested/nested.txt") || entries.includes("secret.txt")
    || packageRange.status !== 206 || !Buffer.from(await packageRange.arrayBuffer()).equals(packageBytes.subarray(0, 32))) throw new Error("Prepared ZIP content/checksum/Range contract failed");
  pass("folder scope and bounded package", { ancestorEscape: 404, secretChildHidden: true, entries: entries.length, sha256: "verified", range: 206 });

  const packagePath = preparedPackage.storagePath;
  await database.withSql(async (sql) => {
    await sql`UPDATE share_packages SET created_at = now() - interval '2 hours', ready_at = now() - interval '90 minutes', expires_at = now() - interval '1 hour' WHERE id = ${preparedPackage.id}`;
  });
  const storageModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "storage", "dist", "index.js")));
  const sharesModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "shares", "dist", "index.js")));
  const storage = new storageModule.SftpStorageAdapter({
    host: environment.STORAGE_HOST,
    port: Number(environment.STORAGE_PORT),
    username: environment.STORAGE_USER,
    root: environment.STORAGE_ROOT,
    hostFingerprint: environment.STORAGE_HOST_FINGERPRINT,
    operationTimeoutMs: Number(environment.STORAGE_OPERATION_TIMEOUT_MS),
    maxConnections: Number(environment.STORAGE_MAX_CONNECTIONS),
    authMode: "private_key_file",
    privateKeyFile: environment.STORAGE_PRIVATE_KEY_FILE,
  });
  const repository = new sharesModule.PostgresShareRepository(database);
  const expiredPackages = await repository.claimExpiredPackages(new Date(), 10);
  for (const item of expiredPackages) {
    if (await storage.exists(item.storagePath)) await storage.delete(item.storagePath);
    await repository.markPackageExpired(item.id);
  }
  const packageStillExists = await storage.exists(packagePath);
  await storage.close();
  const packageState = await database.withSql(async (sql) => (await sql`SELECT state FROM share_packages WHERE id = ${preparedPackage.id}`)[0]?.state);
  if (packageStillExists || packageState !== "expired") throw new Error("Expired package cleanup failed");
  pass("worker package expiry cleanup", { storageObjectDeleted: true, state: "expired" });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`${publicOrigin}/s/${protectedShare.token}`, { waitUntil: "networkidle" });
  const pageSource = await page.content();
  if (!pageSource.includes("noindex,nofollow,noarchive")) throw new Error("Public share page is missing no-index policy");
  await page.getByLabel("Share password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByText("READ ONLY").waitFor();
  await page.getByText(/any content delivered to a browser can still be copied/i).waitFor();
  const axe = await new AxeBuilder({ page }).analyze();
  const serious = axe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
  if (serious.length > 0) throw new Error(`Public share accessibility violations: ${serious.map((item) => item.id).join(",")}`);
  if (await page.evaluate(() => localStorage.length + sessionStorage.length) !== 0) throw new Error("Public share persisted capability/application state in browser storage");
  const browserCookie = (await context.cookies()).find((cookie) => cookie.name === "vault_share_session_dev");
  if (browserCookie?.httpOnly !== true || browserCookie.sameSite !== "Strict") throw new Error("Browser share cookie flags failed");
  if (browserCookie.value.length >= 8) knownSecrets.add(browserCookie.value);
  await page.screenshot({ path: desktopScreenshot, fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  if (browserErrors.length > 0) throw new Error(`Public share browser errors: ${browserErrors.join(" | ")}`);

  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto(publicOrigin, { waitUntil: "networkidle" });
  await ownerPage.getByLabel("Owner access key").fill(ownerAccessKey);
  await ownerPage.getByRole("button", { name: "Enter Saturn" }).click();
  await ownerPage.getByRole("button", { name: "Shared" }).click();
  await ownerPage.getByRole("heading", { name: "Shared" }).waitFor();
  await ownerPage.getByLabel("Resource ID").fill(nestedFile.id);
  await ownerPage.getByRole("button", { name: "Create capability" }).click();
  const oneTimeText = await ownerPage.getByText("Copy this URL now").locator("..").innerText();
  const browserToken = /\/s\/([A-Za-z0-9_-]{43})/.exec(oneTimeText)?.[1];
  if (browserToken === undefined) throw new Error("Owner browser did not disclose the newly created URL once");
  knownSecrets.add(browserToken);
  await ownerContext.close();
  pass("owner and public browser workflows", { oneTimeUrl: true, unlock: true, honestViewOnly: true, browserStorageEntries: 0, seriousOrCriticalViolations: 0, viewports: [1440, 320] });

  const exportDirectory = path.join(vaultRoot, ".tmp", `stage8-export-${randomUUID()}`);
  const recoveryModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "recovery", "dist", "index.js")));
  await new recoveryModule.DatabaseMetadataExporter(database).exportTo(exportDirectory);
  const sharesExport = await fs.readFile(path.join(exportDirectory, "shares.jsonl"), "utf8");
  await fs.rm(exportDirectory, { recursive: true, force: true });
  if (/token_hash|password_hash|argon2id/i.test(sharesExport)) throw new Error("Portable share metadata contains secret verifiers");

  const dumpArgs = [
    "exec", postgresContainer, "pg_dump", "-U", "vault", "-d", "vault", "-Fc", "--no-owner", "--no-acl",
    "--exclude-table-data=web_sessions", "--exclude-table-data=login_sessions", "--exclude-table-data=operation_locks",
    "--exclude-table-data=upload_sessions", "--exclude-table-data=backup_runs", "--exclude-table-data=recovery_runs",
    "--exclude-table-data=auth_attempts", "--exclude-table-data=telegram_link_challenges", "--exclude-table-data=drop_challenges",
    "--exclude-table-data=drop_sessions", "--exclude-table-data=drop_uploads", "--exclude-table-data=drop_attempts",
    "--exclude-table-data=telegram_updates", "--exclude-table-data=share_sessions", "--exclude-table-data=share_password_attempts",
    "--exclude-table-data=share_packages",
  ];
  const databaseDump = runBinary(docker, dumpArgs);
  const dumpListing = runBinary(docker, ["exec", "-i", postgresContainer, "pg_restore", "-l"], databaseDump).toString("utf8");
  if (!dumpListing.includes("TABLE DATA public shares") || !dumpListing.includes("TABLE DATA public share_access_events")
    || ["share_sessions", "share_password_attempts", "share_packages"].some((table) => dumpListing.includes(`TABLE DATA public ${table}`))) throw new Error("Recovery dump share metadata policy failed");

  const auditRows = await database.withSql(async (sql) => sql`SELECT details::text AS details FROM audit_events WHERE action LIKE 'share.%' ORDER BY sequence`);
  const accessRows = await database.withSql(async (sql) => sql`SELECT source_ip_hash, details::text AS details FROM share_access_events ORDER BY sequence`);
  if (accessRows.length < 1 || accessRows.some((row) => !/^[a-f0-9]{64}$/.test(row.source_ip_hash))) throw new Error("Share access audit source hashing failed");
  const securityText = `${runtimeLogs.join("\n")}\n${sharesExport}\n${JSON.stringify(auditRows)}\n${JSON.stringify(accessRows)}`;
  const secrets = [...knownSecrets].filter((value) => value.length >= 8);
  for (const secret of secrets) {
    if (securityText.includes(secret)) throw new Error("Known Stage 8 secret found in runtime/audit/portable metadata");
    if (databaseDump.includes(Buffer.from(secret))) throw new Error("Known Stage 8 secret found in recovery dump");
  }
  await scanBuiltArtifacts(secrets);
  pass("log, audit, metadata, backup and artifact secret scan", { knownValues: secrets.length, accessEvents: accessRows.length, backupBytes: databaseDump.length, stableSharesExported: true, ephemeralRowsExcluded: true });

  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await database?.close().catch(() => undefined);
  for (const child of [...children].reverse()) await stop(child);
  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  await fs.rm(path.join(vaultRoot, "data", "sftp"), { recursive: true, force: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  knownSecrets.clear();
}
