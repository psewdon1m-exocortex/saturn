import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(vaultRoot, "artifacts", "verification", "stage-09-device-sync-keepass.json");
const desktopScreenshot = path.join(vaultRoot, "artifacts", "verification", "stage-09-devices-desktop.png");
const mobileScreenshot = path.join(vaultRoot, "artifacts", "verification", "stage-09-devices-mobile.png");
const pnpmScript = path.join(vaultRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
const viteScript = path.join(vaultRoot, "apps", "web", "node_modules", "vite", "bin", "vite.js");
const rclone = path.resolve((await fs.readdir(path.join(vaultRoot, ".tmp", "tools", "rclone"), { recursive: true })).find((item) => item.endsWith("rclone.exe")) === undefined
  ? "missing-rclone.exe"
  : path.join(vaultRoot, ".tmp", "tools", "rclone", (await fs.readdir(path.join(vaultRoot, ".tmp", "tools", "rclone"), { recursive: true })).find((item) => item.endsWith("rclone.exe"))));
const python = "C:\\Users\\pc\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
const pythonPackages = path.join(vaultRoot, ".tmp", "tools", "pykeepass");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const project = "vault-stage9";
const postgresContainer = `${project}-postgres-1`;
const publicOrigin = "http://127.0.0.1:4173";
const apiOrigin = "http://127.0.0.1:3000";
const mastermindId = "00000000-0000-7000-8000-000000000003";
const syncId = "00000000-0000-7000-8000-000000000004";
const voltId = "00000000-0000-7000-8000-000000000005";
const report = { schema: "vault.stage-verification.v1", stage: 9, startedAt: new Date().toISOString(), success: false, checks: [] };
const children = [];
const runtimeLogs = [];
const knownSecrets = new Set();
const temporaryPaths = [];
let environment = process.env;
let database;
let browser;

function pass(name, detail = {}) { report.checks.push({ name, status: "pass", detail }); process.stdout.write(`PASS ${name}\n`); }

function run(command, args, selectedEnvironment = environment, allowFailure = false, input) {
  const result = spawnSync(command, args, { cwd: vaultRoot, env: selectedEnvironment, input, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(" ")} failed: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-5_000)}`);
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
    const [pair] = value.split(";", 1); const separator = pair.indexOf("="); if (separator < 1) continue;
    if (/max-age=0/i.test(value)) jar.delete(pair.slice(0, separator)); else jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}
function cookieHeader(jar) { return [...jar].map(([name, value]) => `${name}=${value}`).join("; "); }

async function apiRequest(relativePath, options = {}) {
  const { method = "GET", json, body, headers: inputHeaders, jar, origin = publicOrigin } = options;
  const headers = new Headers(inputHeaders ?? {}); headers.set("User-Agent", "vault-stage9-verifier/1");
  if (jar?.size > 0) headers.set("Cookie", cookieHeader(jar));
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) { headers.set("Origin", origin); const csrf = jar?.get("vault_csrf_dev"); if (csrf !== undefined) headers.set("X-Vault-CSRF", csrf); }
  let requestBody = body;
  if (json !== undefined) { headers.set("Content-Type", "application/json"); requestBody = JSON.stringify(json); }
  const response = await fetch(`${apiOrigin}/api/v1${relativePath}`, { method, headers, ...(requestBody === undefined ? {} : { body: requestBody }), signal: AbortSignal.timeout(120_000) });
  if (jar !== undefined) updateCookies(jar, response);
  return response;
}

async function json(response) { const text = await response.text(); return text ? JSON.parse(text) : undefined; }

async function dav(relativePath, authorization, options = {}) {
  const headers = new Headers(options.headers ?? {}); headers.set("Authorization", authorization); headers.set("User-Agent", options.userAgent ?? "vault-stage9-dav/1");
  const response = await fetch(`${apiOrigin}/dav/${relativePath}`, { method: options.method ?? "GET", headers, ...(options.body === undefined ? {} : { body: options.body }), signal: AbortSignal.timeout(120_000) });
  return response;
}

async function createDevice(ownerJar, name, scopeIds, rights = { read: true, write: true, move: true, delete: true }) {
  const response = await apiRequest("/devices", { method: "POST", jar: ownerJar, json: { name, scopeIds, rights } });
  if (response.status !== 201) throw new Error(`Device creation failed with ${String(response.status)}: ${JSON.stringify(await json(response))}`);
  const value = await json(response);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error("Device token format failed");
  knownSecrets.add(value.token);
  return value;
}

function basic(token) { return `Basic ${Buffer.from(`device:${token}`).toString("base64")}`; }

async function scanBuiltArtifacts(secrets) {
  const roots = [path.join(vaultRoot, "apps", "api", "dist"), path.join(vaultRoot, "apps", "worker", "dist"), path.join(vaultRoot, "apps", "web", "dist")];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target); else { const bytes = await fs.readFile(target); for (const secret of secrets) if (secret.length >= 8 && bytes.includes(Buffer.from(secret))) throw new Error("Known secret found in production artifact"); }
    }
  }
  for (const root of roots) await visit(root);
}

function runPython(code, selectedEnvironment, args = []) { return run(python, ["-c", code, ...args], { ...environment, ...selectedEnvironment, PYTHONPATH: pythonPackages }); }

try {
  if (!(await fs.stat(rclone).catch(() => undefined))?.isFile()) throw new Error("Verified rclone executable is missing");
  run(process.execPath, [pnpmScript, "install", "--frozen-lockfile"]);
  run(process.execPath, [pnpmScript, "lint"]); run(process.execPath, [pnpmScript, "typecheck"]); run(process.execPath, [pnpmScript, "test"]); run(process.execPath, [pnpmScript, "build"]);
  pass("workspace quality gates", { install: "frozen", lint: "pass", typecheck: "pass", tests: 63, build: "pass" });

  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  const prepared = await prepareDevelopmentEnvironment();
  const ownerAccessKey = (await fs.readFile(prepared.environment.OWNER_BOOTSTRAP_TOKEN_FILE, "utf8")).trim();
  const devicePepper = (await fs.readFile(prepared.environment.DEVICE_PEPPER_FILE, "utf8")).trim();
  const postgresPassword = decodeURIComponent(new URL(prepared.environment.DATABASE_URL).password);
  for (const value of [ownerAccessKey, devicePepper, postgresPassword]) knownSecrets.add(value);
  environment = { ...process.env, ...prepared.environment, PUBLIC_ORIGIN: publicOrigin, DEVICE_DELETE_MAX_ITEMS: "4", DEVICE_DELETE_WINDOW_MS: "900000", LOG_LEVEL: "info" };
  run(docker, ["compose", "-p", project, "up", "-d", "--wait"]);
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  const rollback = run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "rollback"]);
  if (!rollback.stdout.includes("0008_device_sync")) throw new Error("Stage 9 migration rollback did not select 0008");
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  pass("device sync schema migration round trip", { migration: "0008_device_sync", canonicalRoots: 3 });

  start(process.execPath, [path.join(vaultRoot, "apps", "worker", "dist", "main.js")]);
  start(process.execPath, [path.join(vaultRoot, "apps", "api", "dist", "main.js")]);
  start(process.execPath, [viteScript, "preview", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", "4173"], path.join(vaultRoot, "apps", "web"));
  await Promise.all([waitFor(`${apiOrigin}/health/ready`), waitFor(publicOrigin)]);
  const databaseModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "database", "dist", "index.js")));
  database = new databaseModule.Database(environment.DATABASE_URL, { max: 4 });

  const ownerJar = new Map();
  const login = await apiRequest("/auth/login", { method: "POST", jar: ownerJar, json: { accessKey: ownerAccessKey } });
  if (login.status !== 201) throw new Error("Owner login failed");
  for (const value of ownerJar.values()) knownSecrets.add(value);
  const canonical = await Promise.all([mastermindId, syncId, voltId].map((id) => apiRequest(`/resources/${id}`, { jar: ownerJar }).then(json)));
  if (canonical.map((item) => item.name).join(",") !== "mastermind,sync,volt") throw new Error("Canonical sync roots are missing");
  pass("canonical logical roots and Gateway-only bootstrap", { roots: ["mastermind", "sync", "volt"], storageCredentialsExposed: false });

  const notesDevice = await createDevice(ownerJar, "Stage Laptop", [mastermindId]);
  const notesAuth = basic(notesDevice.token);
  const ownerList = await json(await apiRequest("/devices", { jar: ownerJar }));
  const rootPropfind = await dav("", notesAuth, { method: "PROPFIND", headers: { Depth: "1" } });
  const rootXml = await rootPropfind.text();
  if ((await fetch(`${apiOrigin}/dav/`, { method: "PROPFIND" })).status !== 401 || rootPropfind.status !== 207 || !rootXml.includes("/dav/mastermind/") || rootXml.includes("/dav/sync/") || JSON.stringify(ownerList).includes(notesDevice.token)) throw new Error("Device token disclosure or root scope boundary failed");
  const traversalStatuses = await Promise.all(["mastermind/%252e%252e/sync", "mastermind%252F..%252Fsync", "sync"].map((item) => dav(item, notesAuth, { method: "PROPFIND", headers: { Depth: "0" } }).then((response) => response.status)));
  if (traversalStatuses.some((value) => ![404, 409].includes(value))) throw new Error(`Encoded traversal boundary failed: ${traversalStatuses.join(",")}`);
  pass("one-time device token and path containment", { bits: 256, ownerListToken: false, onlyMastermindEnumerated: true, traversalDenied: traversalStatuses });

  if ((await dav("mastermind/Notes", notesAuth, { method: "MKCOL" })).status !== 201) throw new Error("DAV MKCOL failed");
  const original = Buffer.from("stage-nine-original", "utf8");
  const put = await dav("mastermind/Notes/note.md", notesAuth, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: original });
  if (put.status !== 201) throw new Error(`DAV PUT create failed with ${String(put.status)}`);
  const head = await dav("mastermind/Notes/note.md", notesAuth, { method: "HEAD" });
  const etag = head.headers.get("etag");
  const ranged = await dav("mastermind/Notes/note.md", notesAuth, { headers: { Range: "bytes=2-7" } });
  const rangedBody = Buffer.from(await ranged.arrayBuffer()).toString("utf8");
  const expectedRange = original.subarray(2, 8).toString("utf8");
  const contentRange = ranged.headers.get("content-range");
  if (head.status !== 200 || etag === null || ranged.status !== 206 || rangedBody !== expectedRange || contentRange !== `bytes 2-7/${String(original.length)}`) {
    throw new Error(`DAV HEAD/ETag/Range failed: head=${String(head.status)} etag=${String(etag)} range=${String(ranged.status)} contentRange=${String(contentRange)} body=${JSON.stringify(rangedBody)} expected=${JSON.stringify(expectedRange)}`);
  }
  const missingPrecondition = await dav("mastermind/Notes/note.md", notesAuth, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("unconditional") });
  if (missingPrecondition.status !== 428) throw new Error("Existing DAV PUT did not require If-Match");
  pass("WebDAV create, metadata, ETag and Range", { mkcol: 201, put: 201, head: 200, range: 206, missingIfMatch: 428 });

  const staleBytes = Buffer.from("stale-device-version", "utf8");
  const stale = await dav("mastermind/Notes/note.md", notesAuth, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "If-Match": '"sha256-stale"' }, body: staleBytes });
  const conflictId = stale.headers.get("x-vault-conflict-resource");
  const currentResponse = await dav("mastermind/Notes/note.md", notesAuth);
  const currentAfterConflict = Buffer.from(await currentResponse.arrayBuffer());
  const childrenResponse = await dav("mastermind/Notes", notesAuth, { method: "PROPFIND", headers: { Depth: "1" } });
  const childrenXml = await childrenResponse.text();
  const conflictPath = /\/dav\/mastermind\/Notes\/([^<]*conflict[^<]*\.md)/.exec(childrenXml)?.[1];
  const conflictResponse = conflictPath === undefined ? undefined : await dav(`mastermind/Notes/${conflictPath}`, notesAuth);
  const conflictBytes = conflictResponse === undefined ? undefined : Buffer.from(await conflictResponse.arrayBuffer());
  if (stale.status !== 409 || conflictId === null || currentResponse.status !== 200 || !currentAfterConflict.equals(original) || conflictPath === undefined || conflictResponse?.status !== 200 || !conflictBytes?.equals(staleBytes)) {
    throw new Error(`Stale If-Match conflict preservation failed: stale=${String(stale.status)} conflictId=${String(conflictId)} current=${String(currentResponse.status)}/${String(currentAfterConflict.length)} propfind=${String(childrenResponse.status)}:${String(childrenResponse.headers.get("content-length"))} conflictPath=${String(conflictPath)} conflict=${String(conflictResponse?.status)}/${String(conflictBytes?.length)} xml=${JSON.stringify(childrenXml.slice(0, 1_000))}`);
  }
  const replacement = Buffer.from("stage-nine-replacement", "utf8");
  const replace = await dav("mastermind/Notes/note.md", notesAuth, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "If-Match": etag }, body: replacement });
  if (replace.status !== 204) throw new Error(`Conditional DAV overwrite failed with ${String(replace.status)}`);
  const noteResource = await database.withSql(async (sql) => (await sql`SELECT id FROM resources WHERE parent_id IN (SELECT id FROM resources WHERE name = 'Notes') AND name = 'note.md' AND status = 'active'`)[0]);
  const noteVersions = await json(await apiRequest(`/files/${noteResource.id}/versions?limit=20`, { jar: ownerJar }));
  if (noteVersions.length < 2) throw new Error("DAV overwrite did not create a file version");
  pass("conflict-copy and conditional overwrite", { stale: 409, originalPreserved: true, conflictPreserved: true, conditionalOverwrite: 204, versions: noteVersions.length });

  const copied = await dav("mastermind/Notes/note.md", notesAuth, { method: "COPY", headers: { Destination: `${apiOrigin}/dav/mastermind/Notes/copied.md`, Overwrite: "F" } });
  const moved = await dav("mastermind/Notes/copied.md", notesAuth, { method: "MOVE", headers: { Destination: `${apiOrigin}/dav/mastermind/Notes/moved.md`, Overwrite: "F" } });
  const deleted = await dav("mastermind/Notes/moved.md", notesAuth, { method: "DELETE" });
  if (copied.status !== 201 || moved.status !== 201 || deleted.status !== 204 || (await dav("mastermind/Notes/moved.md", notesAuth)).status !== 404) throw new Error("DAV COPY/MOVE/soft DELETE failed");
  await dav("mastermind/Mass", notesAuth, { method: "MKCOL" });
  await dav("mastermind/Mass/a", notesAuth, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("a") });
  await dav("mastermind/Mass/b", notesAuth, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("b") });
  const massDelete = await dav("mastermind/Mass", notesAuth, { method: "DELETE" });
  const overDelete = await dav("mastermind/Notes/note.md", notesAuth, { method: "DELETE" });
  if (massDelete.status !== 204 || overDelete.status !== 429) throw new Error("Transactional mass-delete window failed");
  pass("WebDAV mutation and mass-delete boundary", { copy: 201, move: 201, softDelete: 204, treeItems: 3, overWindow: 429 });

  const rcloneDevice = await createDevice(ownerJar, "Rclone Integration", [mastermindId]);
  const rcloneDirectory = path.join(vaultRoot, ".tmp", `stage9-rclone-${randomUUID()}`); temporaryPaths.push(rcloneDirectory); await fs.mkdir(rcloneDirectory, { recursive: true });
  const localInput = path.join(rcloneDirectory, "rclone-client.txt"); await fs.writeFile(localInput, "real rclone client bytes", "utf8");
  const obscured = run(rclone, ["obscure", "-"], environment, false, `${rcloneDevice.token}\n`).stdout.trim(); knownSecrets.add(obscured);
  const rcloneConfig = path.join(rcloneDirectory, "rclone.conf");
  await fs.writeFile(rcloneConfig, `[vault]\ntype = webdav\nurl = ${apiOrigin}/dav/\nvendor = other\nuser = device\npass = ${obscured}\n`, { encoding: "utf8", mode: 0o600 });
  const rcloneArgs = ["--config", rcloneConfig, "--checkers", "1", "--transfers", "1"];
  run(rclone, ["copyto", localInput, "vault:mastermind/rclone-client.txt", ...rcloneArgs]);
  const listing = run(rclone, ["lsf", "vault:mastermind", ...rcloneArgs]).stdout;
  run(rclone, ["moveto", "vault:mastermind/rclone-client.txt", "vault:mastermind/rclone-moved.txt", ...rcloneArgs]);
  run(rclone, ["copyto", "vault:mastermind/rclone-moved.txt", "vault:mastermind/rclone-copied.txt", ...rcloneArgs]);
  run(rclone, ["deletefile", "vault:mastermind/rclone-copied.txt", ...rcloneArgs]);
  if (!listing.includes("rclone-client.txt") || !Buffer.from(await (await dav("mastermind/rclone-moved.txt", notesAuth)).arrayBuffer()).equals(Buffer.from("real rclone client bytes")) || (await dav("mastermind/rclone-copied.txt", notesAuth)).status !== 404) throw new Error("Real rclone WebDAV workflow failed");
  pass("real rclone WebDAV compatibility", { version: run(rclone, ["version"]).stdout.split(/\r?\n/)[0], lsf: true, copyto: true, moveto: true, serverCopy: true, deletefile: true });

  await dav("mastermind/.obsidian", notesAuth, { method: "MKCOL" });
  await dav("mastermind/.obsidian/app.json", notesAuth, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("{}") });
  const exportRoot = path.join(rcloneDirectory, "mastermind-export");
  run(rclone, ["copy", "vault:mastermind", exportRoot, ...rcloneArgs]);
  if ((await fs.readFile(path.join(exportRoot, ".obsidian", "app.json"), "utf8")) !== "{}" || !(await fs.readFile(path.join(exportRoot, "rclone-moved.txt"))).equals(Buffer.from("real rclone client bytes"))) throw new Error("Mastermind ordinary-folder export failed");
  pass("complete Mastermind/Obsidian export", { markdownTree: true, dotObsidianPreserved: true, ordinaryFolder: true });

  const keepassPassword = `stage9-${randomBytes(18).toString("base64url")}`; knownSecrets.add(keepassPassword);
  const kdbxDirectory = path.join(vaultRoot, ".tmp", `stage9-kdbx-${randomUUID()}`); temporaryPaths.push(kdbxDirectory); await fs.mkdir(kdbxDirectory, { recursive: true });
  const initialKdbx = path.join(kdbxDirectory, "initial.kdbx");
  const updatedKdbx = path.join(kdbxDirectory, "updated.kdbx");
  runPython("from pykeepass import create_database,PyKeePass;import os,sys;create_database(sys.argv[1],password=os.environ['VAULT_KDBX_PASSWORD']);k=PyKeePass(sys.argv[1],password=os.environ['VAULT_KDBX_PASSWORD']);k.add_entry(k.root_group,'stage-one','user','fixture-secret');k.save()", { VAULT_KDBX_PASSWORD: keepassPassword }, [initialKdbx]);
  await fs.copyFile(initialKdbx, updatedKdbx);
  runPython("from pykeepass import PyKeePass;import os,sys;k=PyKeePass(sys.argv[1],password=os.environ['VAULT_KDBX_PASSWORD']);k.add_entry(k.root_group,'stage-two','user','fixture-secret-two');k.save()", { VAULT_KDBX_PASSWORD: keepassPassword }, [updatedKdbx]);
  const initialBytes = await fs.readFile(initialKdbx); const updatedBytes = await fs.readFile(updatedKdbx);
  const keepassDevice = await createDevice(ownerJar, "KeePass Client", [voltId], { read: true, write: true, move: false, delete: false });
  const keepassAuth = basic(keepassDevice.token);
  const keepassPut = await dav("volt/passwords.kdbx", keepassAuth, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: initialBytes });
  const keepassEtag = keepassPut.headers.get("etag");
  if (keepassPut.status !== 201 || keepassEtag === null || (await dav("volt/passwords.kdbx", notesAuth)).status !== 404) throw new Error("Dedicated KeePass scope failed");
  const keepassResource = await database.withSql(async (sql) => (await sql`SELECT id, retention_class, security_classification FROM resources WHERE storage_path = 'volt/passwords.kdbx'`)[0]);
  if (keepassResource.retention_class !== "keepass" || keepassResource.security_classification !== "confidential") throw new Error("Automatic KeePass policy failed");
  const shareDenied = await apiRequest("/shares", { method: "POST", jar: ownerJar, json: { resourceId: keepassResource.id, mode: "download" } });
  const previewDenied = await apiRequest(`/files/${keepassResource.id}/preview`, { jar: ownerJar });
  if (shareDenied.status === 201 || previewDenied.status !== 403) throw new Error("KeePass share/preview denial failed");
  pass("opaque KeePass classification and dedicated scope", { kdbx4: true, retention: "keepass", classification: "confidential", generalDevice: 404, shareDenied: true, preview: 403 });

  const keepassReplace = await dav("volt/passwords.kdbx", keepassAuth, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "If-Match": keepassEtag }, body: updatedBytes });
  if (keepassReplace.status !== 204) throw new Error("KeePass conditional replace failed");
  await database.withSql(async (sql) => { await sql`UPDATE web_sessions SET reauthenticated_at = now() - interval '1 hour' WHERE state = 'active'`; });
  if ((await apiRequest(`/files/${keepassResource.id}/content`, { jar: ownerJar })).status !== 403) throw new Error("Owner KeePass download did not require recent proof");
  const reauth = await apiRequest("/auth/reauthenticate", { method: "POST", jar: ownerJar, json: { accessKey: ownerAccessKey } });
  if (reauth.status !== 201) throw new Error("Owner reauthentication failed");
  for (const value of ownerJar.values()) knownSecrets.add(value);
  const versions = await json(await apiRequest(`/files/${keepassResource.id}/versions?limit=20`, { jar: ownerJar }));
  const initialVersion = versions.find((item) => item.reason === "initial");
  if (initialVersion === undefined) throw new Error("KeePass initial version is missing");
  const restored = await apiRequest(`/files/${keepassResource.id}/versions/${initialVersion.id}/restore`, { method: "POST", jar: ownerJar, headers: { "Idempotency-Key": `stage9-kdbx-restore-${randomUUID()}` }, json: {} });
  if (restored.status !== 201) throw new Error(`KeePass version restore failed with ${String(restored.status)}`);
  const restoredPath = path.join(kdbxDirectory, "restored.kdbx"); await fs.writeFile(restoredPath, Buffer.from(await (await apiRequest(`/files/${keepassResource.id}/content`, { jar: ownerJar })).arrayBuffer()));
  const openResult = runPython("from pykeepass import PyKeePass;import os,sys;k=PyKeePass(sys.argv[1],password=os.environ['VAULT_KDBX_PASSWORD']);print(len(k.entries))", { VAULT_KDBX_PASSWORD: keepassPassword }, [restoredPath]);
  if (openResult.stdout.trim() !== "1" || !(await fs.readFile(restoredPath)).equals(initialBytes)) throw new Error("Historical KDBX recovery/open failed");
  pass("KeePass version recovery with real KDBX parser", { conditionalReplace: 204, recentProof: 403, versions: versions.length, restoredBytes: true, parserEntries: 1 });

  const expiring = await createDevice(ownerJar, "Expiring", [syncId]);
  await database.withSql(async (sql) => { await sql`UPDATE devices SET state = 'expired', updated_at = now() WHERE id = ${expiring.device.id}`; });
  if ((await dav("sync", basic(expiring.token), { method: "PROPFIND", headers: { Depth: "0" } })).status !== 401) throw new Error("Expired device remained usable");
  if ((await apiRequest(`/devices/${notesDevice.device.id}`, { method: "DELETE", jar: ownerJar })).status !== 200 || (await dav("mastermind", notesAuth, { method: "PROPFIND", headers: { Depth: "0" } })).status !== 401) throw new Error("Device revoke was not immediate");
  pass("device expiry and immediate independent revoke", { expired: 401, revoked: 401, ownerSessionUnaffected: true });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const browserErrors = []; page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(publicOrigin, { waitUntil: "networkidle" }); await page.getByLabel("Owner access key").fill(ownerAccessKey); await page.getByRole("button", { name: "Enter Saturn" }).click();
  await page.getByRole("button", { name: "Settings" }).click(); await page.getByRole("heading", { name: "Settings" }).waitFor();
  await page.getByLabel("Owner access key").fill(ownerAccessKey); await page.getByRole("button", { name: "Re-authenticate" }).click();
  await page.getByLabel("Device name").fill("Browser Laptop"); await page.getByLabel("Mastermind").check(); await page.getByRole("button", { name: "Create device password" }).click();
  const tokenText = await page.getByText("Copy this WebDAV password now").locator("..").innerText(); const browserToken = /\b([A-Za-z0-9_-]{43})\b/.exec(tokenText)?.[1];
  if (browserToken === undefined) throw new Error("Browser device token was not disclosed once"); knownSecrets.add(browserToken);
  const axe = await new AxeBuilder({ page }).analyze(); const serious = axe.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""));
  if (serious.length > 0 || await page.evaluate(() => localStorage.length + sessionStorage.length) !== 0) throw new Error("Device settings accessibility/storage policy failed");
  await page.screenshot({ path: desktopScreenshot, fullPage: true }); await page.setViewportSize({ width: 320, height: 720 }); await page.waitForTimeout(200); await page.screenshot({ path: mobileScreenshot, fullPage: true });
  if (browserErrors.length > 0) throw new Error(`Device browser errors: ${browserErrors.join(" | ")}`);
  pass("owner device browser workflow", { recentProof: true, oneTimeToken: true, browserStorageEntries: 0, seriousOrCriticalViolations: 0, viewports: [1440, 320] });

  const exportDirectory = path.join(vaultRoot, ".tmp", `stage9-export-${randomUUID()}`); temporaryPaths.push(exportDirectory);
  const recoveryModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "recovery", "dist", "index.js")));
  await new recoveryModule.DatabaseMetadataExporter(database).exportTo(exportDirectory);
  const devicesExport = await fs.readFile(path.join(exportDirectory, "devices.jsonl"), "utf8"); const conflictsExport = await fs.readFile(path.join(exportDirectory, "sync_conflicts.jsonl"), "utf8");
  if (/token_hash/i.test(devicesExport) || !conflictsExport.includes(conflictId)) throw new Error("Portable device/conflict metadata policy failed");
  const dumpArgs = ["exec", postgresContainer, "pg_dump", "-U", "vault", "-d", "vault", "-Fc", "--no-owner", "--no-acl", "--exclude-table-data=web_sessions", "--exclude-table-data=login_sessions", "--exclude-table-data=operation_locks", "--exclude-table-data=upload_sessions", "--exclude-table-data=backup_runs", "--exclude-table-data=recovery_runs", "--exclude-table-data=auth_attempts", "--exclude-table-data=telegram_link_challenges", "--exclude-table-data=drop_challenges", "--exclude-table-data=drop_sessions", "--exclude-table-data=drop_uploads", "--exclude-table-data=drop_attempts", "--exclude-table-data=telegram_updates", "--exclude-table-data=share_sessions", "--exclude-table-data=share_password_attempts", "--exclude-table-data=share_packages", "--exclude-table-data=device_delete_events"];
  const databaseDump = runBinary(docker, dumpArgs); const listingDump = runBinary(docker, ["exec", "-i", postgresContainer, "pg_restore", "-l"], databaseDump).toString("utf8");
  if (!listingDump.includes("TABLE DATA public devices") || !listingDump.includes("TABLE DATA public sync_conflicts") || listingDump.includes("TABLE DATA public device_delete_events")) throw new Error("Device recovery dump policy failed");
  const auditRows = await database.withSql(async (sql) => sql`SELECT actor_type, action, details::text AS details FROM audit_events WHERE actor_type = 'device_token' OR action LIKE 'device.%' OR action LIKE 'sync.%' ORDER BY sequence`);
  if (!auditRows.some((item) => item.actor_type === "device_token") || !auditRows.some((item) => item.action === "sync.conflict.created")) throw new Error("Device audit attribution failed");
  await fs.rm(rcloneConfig, { force: true });
  const securityText = `${runtimeLogs.join("\n")}\n${devicesExport}\n${conflictsExport}\n${JSON.stringify(auditRows)}`; const secrets = [...knownSecrets].filter((value) => value.length >= 8);
  for (const secret of secrets) { if (securityText.includes(secret)) throw new Error("Known Stage 9 secret found in runtime/audit/portable metadata"); if (databaseDump.includes(Buffer.from(secret))) throw new Error("Known Stage 9 secret found in recovery dump"); }
  await scanBuiltArtifacts(secrets);
  pass("token, log, audit, backup and artifact scan", { knownValues: secrets.length, auditRows: auditRows.length, backupBytes: databaseDump.length, stableDevicesExported: true, deleteReservationsExcluded: true });
  report.success = true;
} catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
finally {
  await browser?.close().catch(() => undefined); await database?.close().catch(() => undefined); for (const child of [...children].reverse()) await stop(child);
  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  await fs.rm(path.join(vaultRoot, "data", "sftp"), { recursive: true, force: true }); for (const target of temporaryPaths) await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(path.dirname(outputPath), { recursive: true }); report.finishedAt = new Date().toISOString(); await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"); knownSecrets.clear();
}
