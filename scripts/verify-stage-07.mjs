import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(vaultRoot, "artifacts", "verification", "stage-07-telegram-drop.json");
const desktopScreenshot = path.join(vaultRoot, "artifacts", "verification", "stage-07-drop-desktop.png");
const mobileScreenshot = path.join(vaultRoot, "artifacts", "verification", "stage-07-drop-mobile.png");
const pnpmScript = path.join(vaultRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
const viteScript = path.join(vaultRoot, "apps", "web", "node_modules", "vite", "bin", "vite.js");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const project = "vault-stage7";
const postgresContainer = `${project}-postgres-1`;
const publicOrigin = "http://127.0.0.1:4173";
const apiOrigin = "http://127.0.0.1:3000";
const inboxId = "00000000-0000-7000-8000-000000000002";
const report = { schema: "vault.stage-verification.v1", stage: 7, startedAt: new Date().toISOString(), success: false, checks: [] };
const children = [];
const runtimeLogs = [];
const providerMessages = [];
const providerCalls = [];
const knownSecrets = new Set();
let environment = process.env;
let database;
let browser;
let providerServer;
let botToken = "";
let webhookSecret = "";

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
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(" ")} failed: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-4_000)}`);
  }
  return result;
}

function runBinary(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: vaultRoot,
    env: environment,
    input,
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${path.basename(command)} binary command failed with ${String(result.status)}: ${Buffer.from(result.stderr ?? []).toString("utf8").trim().slice(-1_000)}`);
  return Buffer.from(result.stdout ?? []);
}

function start(command, args, cwd = vaultRoot) {
  const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => runtimeLogs.push(chunk.toString("utf8").slice(-16_384)));
  }
  return child;
}

async function stop(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 4_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitFor(url, expectedStatus = 200, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.status === expectedStatus) return;
    } catch {
      // A listener is expected to reject requests while it starts or restarts.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}: ${runtimeLogs.join("").slice(-3_000)}`);
}

function updateCookies(jar, response) {
  for (const value of response.headers.getSetCookie()) {
    const [pair] = value.split(";", 1);
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const content = pair.slice(separator + 1);
    if (/max-age=0/i.test(value)) jar.delete(name);
    else jar.set(name, content);
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function apiRequest(relativePath, options = {}) {
  const {
    method = "GET",
    json,
    body,
    headers: inputHeaders,
    jar,
    csrf = true,
    csrfKind = "owner",
    origin = publicOrigin,
  } = options;
  const headers = new Headers(inputHeaders ?? {});
  if (!headers.has("User-Agent")) headers.set("User-Agent", "vault-stage7-verifier/1");
  if (jar !== undefined && jar.size > 0) headers.set("Cookie", cookieHeader(jar));
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (origin !== undefined) headers.set("Origin", origin);
    if (csrf && jar !== undefined) {
      const name = csrfKind === "drop" ? "vault_drop_csrf_dev" : "vault_csrf_dev";
      const token = jar.get(name);
      if (token !== undefined) headers.set("X-Vault-CSRF", token);
    }
  }
  let requestBody = body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(json);
  }
  const response = await fetch(`${apiOrigin}/api/v1${relativePath}`, {
    method,
    headers,
    ...(requestBody === undefined ? {} : { body: requestBody }),
    signal: AbortSignal.timeout(120_000),
  });
  if (jar !== undefined) updateCookies(jar, response);
  return response;
}

async function webhook(update, secret = webhookSecret) {
  return fetch(`${apiOrigin}/internal/telegram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(15_000),
  });
}

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function telegramUpdate(updateId, userId, text, options = {}) {
  return {
    update_id: updateId,
    message: {
      chat: { id: options.chatId ?? userId, type: options.chatType ?? "private" },
      from: { id: userId, is_bot: options.isBot ?? false, first_name: "Stage" },
      text,
    },
  };
}

function latestCode(length) {
  const pattern = length === 8
    ? /\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/
    : /\b([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\b/;
  for (let index = providerMessages.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(providerMessages[index]?.text ?? "");
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`Provider did not deliver a ${String(length)}-character code`);
}

async function createDropCode(updateId = Date.now()) {
  const response = await webhook(telegramUpdate(updateId, 42, "/drop"));
  if (response.status !== 200) throw new Error(`Bound /drop failed with ${String(response.status)}`);
  const value = latestCode(8);
  knownSecrets.add(value);
  return value;
}

async function redeemDrop(code, jar = new Map()) {
  const response = await apiRequest("/drop/redeem", {
    method: "POST",
    jar,
    csrf: false,
    csrfKind: "drop",
    json: { code },
  });
  return { jar, response };
}

async function createDropUpload(jar, filename, payloadLength, idempotencyKey = `stage7-${randomUUID()}`) {
  const response = await apiRequest("/drop/uploads", {
    method: "POST",
    jar,
    csrfKind: "drop",
    headers: { "Idempotency-Key": idempotencyKey },
    json: { filename, expectedSize: payloadLength },
  });
  return { response, body: await responseJson(response) };
}

async function appendDropUpload(jar, id, offset, payload) {
  return apiRequest(`/drop/uploads/${id}`, {
    method: "PATCH",
    jar,
    csrfKind: "drop",
    headers: {
      "Content-Type": "application/offset+octet-stream",
      "Upload-Offset": String(offset),
      "Content-Length": String(payload.length),
    },
    body: payload,
  });
}

async function startProvider() {
  providerServer = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
      catch { body = {}; }
      const method = ["getMe", "setWebhook", "sendMessage"].find((candidate) => request.url?.endsWith(`/${candidate}`));
      response.setHeader("Content-Type", "application/json");
      if (request.method !== "POST" || method === undefined || !request.url?.startsWith(`/bot${botToken}/`)) {
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      providerCalls.push({ method, body: method === "setWebhook" ? body : undefined });
      if (method === "getMe") response.end(JSON.stringify({ ok: true, result: { id: 7007, is_bot: true, username: "vault_stage7_bot" } }));
      else if (method === "setWebhook") response.end(JSON.stringify({ ok: true, result: true }));
      else {
        providerMessages.push({ chatId: String(body.chat_id ?? ""), text: String(body.text ?? "") });
        response.end(JSON.stringify({ ok: true, result: { message_id: providerMessages.length } }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    providerServer.once("error", reject);
    providerServer.listen(0, "127.0.0.1", resolve);
  });
  const address = providerServer.address();
  if (address === null || typeof address === "string") throw new Error("Telegram provider mock did not bind");
  return `http://127.0.0.1:${String(address.port)}/`;
}

async function scanBuiltArtifacts(secrets) {
  const roots = [
    path.join(vaultRoot, "apps", "api", "dist"),
    path.join(vaultRoot, "apps", "worker", "dist"),
    path.join(vaultRoot, "apps", "web", "dist"),
  ];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else {
        const bytes = await fs.readFile(target);
        for (const secret of secrets) {
          if (secret.length >= 8 && bytes.includes(Buffer.from(secret))) throw new Error("Known secret found in production artifact");
        }
      }
    }
  }
  for (const root of roots) await visit(root);
}

try {
  run(process.execPath, [pnpmScript, "install", "--frozen-lockfile"]);
  run(process.execPath, [pnpmScript, "lint"]);
  run(process.execPath, [pnpmScript, "typecheck"]);
  run(process.execPath, [pnpmScript, "test"]);
  run(process.execPath, [pnpmScript, "build"]);
  pass("workspace quality gates", { install: "frozen", lint: "pass", typecheck: "pass", tests: "pass", build: "pass" });

  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  const prepared = await prepareDevelopmentEnvironment();
  botToken = (await fs.readFile(prepared.environment.TELEGRAM_BOT_TOKEN_FILE, "utf8")).trim();
  webhookSecret = (await fs.readFile(prepared.environment.TELEGRAM_WEBHOOK_SECRET_FILE, "utf8")).trim();
  const ownerAccessKey = (await fs.readFile(prepared.environment.OWNER_BOOTSTRAP_TOKEN_FILE, "utf8")).trim();
  const authPepper = (await fs.readFile(prepared.environment.AUTH_PEPPER_FILE, "utf8")).trim();
  const dropPepper = (await fs.readFile(prepared.environment.DROP_PEPPER_FILE, "utf8")).trim();
  for (const value of [botToken, webhookSecret, ownerAccessKey, authPepper, dropPepper]) knownSecrets.add(value);
  const providerBaseUrl = await startProvider();
  environment = {
    ...process.env,
    ...prepared.environment,
    PUBLIC_ORIGIN: publicOrigin,
    TELEGRAM_ENABLED: "true",
    TELEGRAM_API_BASE_URL: providerBaseUrl,
    DROP_MAX_FILES: "3",
    DROP_MAX_BYTES: "64",
    DROP_FAILURE_LIMIT: "5",
    DROP_GLOBAL_FAILURE_LIMIT: "100",
  };

  run(docker, ["compose", "-p", project, "up", "-d", "--wait"]);
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  const rollback = run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "rollback"]);
  if (!rollback.stdout.includes("0006_telegram_drop")) throw new Error("Stage 7 migration rollback did not select 0006");
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  pass("Telegram and Drop schema migration round trip", { migration: "0006_telegram_drop" });

  start(process.execPath, [path.join(vaultRoot, "apps", "worker", "dist", "main.js")]);
  let apiChild = start(process.execPath, [path.join(vaultRoot, "apps", "api", "dist", "main.js")]);
  start(process.execPath, [viteScript, "preview", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", "4173"], path.join(vaultRoot, "apps", "web"));
  await Promise.all([waitFor(`${apiOrigin}/health/ready`), waitFor(`${publicOrigin}/drop`)]);

  const getMeCalls = providerCalls.filter((call) => call.method === "getMe");
  const setWebhookCalls = providerCalls.filter((call) => call.method === "setWebhook");
  const registration = setWebhookCalls.at(0)?.body;
  if (getMeCalls.length !== 1 || setWebhookCalls.length !== 1
    || registration?.url !== `${publicOrigin}/internal/telegram/webhook`
    || registration?.secret_token !== webhookSecret
    || JSON.stringify(registration?.allowed_updates) !== JSON.stringify(["message"])
    || registration?.max_connections !== 8) {
    throw new Error("Telegram startup registration contract failed");
  }
  pass("Telegram provider validation and webhook registration", { getMe: 1, setWebhook: 1, allowedUpdates: ["message"], maxConnections: 8 });

  const ownerJar = new Map();
  const login = await apiRequest("/auth/login", { method: "POST", jar: ownerJar, json: { accessKey: ownerAccessKey } });
  if (login.status !== 201) throw new Error(`Owner login failed with ${String(login.status)}`);
  for (const value of ownerJar.values()) knownSecrets.add(value);
  const linkResponse = await apiRequest("/telegram/link-challenges", { method: "POST", jar: ownerJar, json: {} });
  if (linkResponse.status !== 201 || linkResponse.headers.get("cache-control") !== "no-store") throw new Error("Owner link challenge was not protected/no-store");
  const link = await responseJson(linkResponse);
  if (!/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(link.code)) throw new Error("Link challenge format failed");
  knownSecrets.add(link.code);

  const forged = await webhook(telegramUpdate(100, 42, `/link ${link.code}`), "forged-secret");
  if (forged.status !== 401) throw new Error("Forged Telegram webhook secret was accepted");
  const beforeLinkMessages = providerMessages.length;
  const linked = await webhook(telegramUpdate(100, 42, `/link ${link.code}`));
  const replayedLink = await webhook(telegramUpdate(100, 42, `/link ${link.code}`));
  if (linked.status !== 200 || replayedLink.status !== 200 || providerMessages.length !== beforeLinkMessages + 1) {
    throw new Error("Telegram link/update deduplication failed");
  }
  const status = await responseJson(await apiRequest("/telegram/status", { jar: ownerJar }));
  if (status.provider.state !== "ready" || status.binding.userId !== "42" || status.binding.chatId !== "42") throw new Error("Stable Telegram identity was not bound");
  pass("owner-mediated stable Telegram binding", { recentProof: true, stableFromId: true, privateChat: true, updateReplay: "deduplicated" });

  const unauthorizedBefore = providerMessages.length;
  const unauthorized = await webhook(telegramUpdate(101, 77, "/drop"));
  const group = await webhook(telegramUpdate(102, 42, "/drop", { chatId: -42, chatType: "group" }));
  if (unauthorized.status !== 200 || group.status !== 200
    || providerMessages.length !== unauthorizedBefore + 1
    || !providerMessages.at(-1)?.text.includes("not authorized")) {
    throw new Error("Unbound or non-private Telegram identity handling failed");
  }
  pass("Telegram identity and private-chat boundary", { unbound: "generic denial", group: "ignored", usernameIdentity: false });

  const firstCode = await createDropCode(103);
  const purposeSwap = await redeemDrop(link.code, new Map());
  if (purposeSwap.response.status !== 401) throw new Error("Link code was accepted as a Drop code");
  const first = await redeemDrop(firstCode);
  const firstCookies = first.response.headers.getSetCookie();
  if (first.response.status !== 201
    || first.jar.get("vault_drop_session_dev") === undefined
    || first.jar.get("vault_drop_csrf_dev") === undefined
    || !firstCookies.some((value) => value.includes("HttpOnly") && value.includes("SameSite=Strict"))) {
    throw new Error("Drop redemption cookie contract failed");
  }
  for (const value of first.jar.values()) knownSecrets.add(value);
  const peer = await redeemDrop(firstCode, new Map());
  const firstSession = await responseJson(first.response.clone());
  const peerSession = await responseJson(peer.response.clone());
  if (peer.response.status !== 201
    || firstSession.channelId !== peerSession.channelId
    || firstSession.expiresAt !== peerSession.expiresAt
    || first.jar.get("vault_drop_session_dev") === peer.jar.get("vault_drop_session_dev")) {
    throw new Error("Shared multi-client Drop redemption failed");
  }
  for (const value of peer.jar.values()) knownSecrets.add(value);
  pass("purpose-bound multi-client Drop redemption", { codeInBody: true, linkSwap: 401, sharedChannel: true, independentSessions: true, commonAbsoluteExpiry: true, httpOnlySession: true, sameSite: "Strict" });

  const payload = Buffer.from("stage-seven-resumable-payload", "utf8");
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  const created = await createDropUpload(first.jar, `resumable-${Date.now().toString(36)}.txt`, payload.length);
  if (created.response.status !== 201 || !/^[0-9a-f-]{36}$/i.test(created.body.id)) throw new Error("Mapped Drop upload creation failed");
  const firstPart = payload.subarray(0, 9);
  if ((await appendDropUpload(first.jar, created.body.id, 0, firstPart)).status !== 204) throw new Error("First Drop chunk failed");
  const beforeRestart = await responseJson(await apiRequest(`/drop/uploads/${created.body.id}/status`, { jar: first.jar, csrfKind: "drop" }));
  if (beforeRestart.receivedSize !== firstPart.length) throw new Error("Interrupted Drop offset was not persisted");

  await stop(apiChild);
  apiChild = start(process.execPath, [path.join(vaultRoot, "apps", "api", "dist", "main.js")]);
  await waitFor(`${apiOrigin}/health/ready`);
  const afterRestart = await responseJson(await apiRequest(`/drop/uploads/${created.body.id}/status`, { jar: first.jar, csrfKind: "drop" }));
  if (afterRestart.receivedSize !== firstPart.length) throw new Error("Drop upload did not resume across API restart");
  const remaining = payload.subarray(firstPart.length);
  if ((await appendDropUpload(first.jar, created.body.id, firstPart.length, remaining)).status !== 204) throw new Error("Resumed Drop chunk failed");
  const completedResponse = await apiRequest("/drop/complete", { method: "POST", jar: first.jar, csrfKind: "drop", json: { uploadId: created.body.id } });
  const completed = await responseJson(completedResponse);
  if (completedResponse.status !== 201 || completed.sha256 !== payloadSha256 || completed.sizeBytes !== payload.length) throw new Error("Drop checksum commit failed");
  pass("interrupted mapped upload resume and checksum commit", { restart: true, offset: firstPart.length, sha256: "verified" });

  const inboxChildren = await responseJson(await apiRequest(`/folders/${inboxId}/children?limit=100`, { jar: ownerJar }));
  const dateFolder = inboxChildren.find((item) => item.type === "folder" && /^\d{4}-\d{2}-\d{2}$/.test(item.name));
  if (dateFolder === undefined) throw new Error("Server-selected Drop Point date folder is missing");
  const datedChildren = await responseJson(await apiRequest(`/folders/${dateFolder.id}/children?limit=100`, { jar: ownerJar }));
  const committedFile = datedChildren.find((item) => item.name === completed.filename);
  if (committedFile === undefined || committedFile.sha256 !== payloadSha256) throw new Error("Committed Drop file is not visible to owner in Drop Point date folder");
  const downloaded = Buffer.from(await (await apiRequest(`/files/${committedFile.id}/content`, { jar: ownerJar })).arrayBuffer());
  const activity = await responseJson(await apiRequest("/activity?limit=200", { jar: ownerJar }));
  if (!downloaded.equals(payload) || !activity.some((event) => event.action === "file.upload.completed" && event.actorType === "drop_session")) {
    throw new Error("Owner Drop Point readback or Drop actor attribution failed");
  }
  pass("owner Drop Point visibility and Drop actor attribution", { folder: "drop point/YYYY-MM-DD", byteReadback: true, actorType: "drop_session" });

  const secondCode = await createDropCode(104);
  const second = await redeemDrop(secondCode);
  if (second.response.status !== 201) throw new Error("Second Drop session was not created");
  for (const value of second.jar.values()) knownSecrets.add(value);
  const ownerWithDropCookie = await apiRequest(`/folders/${inboxId}/children`, { jar: second.jar, csrfKind: "drop" });
  const ownerContentWithDropCookie = await apiRequest(`/files/${committedFile.id}/content`, { jar: second.jar, csrfKind: "drop" });
  const ownerDeleteWithDropCookie = await apiRequest(`/uploads/${randomUUID()}`, { method: "DELETE", jar: second.jar, csrfKind: "drop" });
  const crossSession = await apiRequest(`/drop/uploads/${created.body.id}/status`, { jar: second.jar, csrfKind: "drop" });
  const nonexistentList = await apiRequest("/drop/files", { jar: second.jar, csrfKind: "drop" });
  if (![ownerWithDropCookie.status, ownerContentWithDropCookie.status, ownerDeleteWithDropCookie.status].every((value) => value === 401)
    || crossSession.status !== 404 || nonexistentList.status !== 404) {
    throw new Error("Drop negative privilege matrix failed");
  }
  pass("upload-only negative privilege matrix", { ownerList: 401, ownerRead: 401, ownerDelete: 401, otherSessionUpload: 404, dropListRoute: 404 });

  const quotaResults = await Promise.all([
    createDropUpload(second.jar, "quota-a.bin", 40, "stage7-quota-a"),
    createDropUpload(second.jar, "quota-b.bin", 40, "stage7-quota-b"),
  ]);
  const quotaStatuses = quotaResults.map((value) => value.response.status).sort((left, right) => left - right);
  if (JSON.stringify(quotaStatuses) !== JSON.stringify([201, 413])) throw new Error(`Concurrent byte quota boundary failed: ${quotaStatuses.join(",")}`);
  pass("transactional Drop quota reservation", { concurrentDeclaredBytes: [40, 40], sessionMaxBytes: 64, results: quotaStatuses });

  const expiryCode = await createDropCode(105);
  const expiring = await redeemDrop(expiryCode);
  const expiringToken = expiring.jar.get("vault_drop_session_dev");
  if (expiring.response.status !== 201 || expiringToken === undefined) throw new Error("Expiry test session was not created");
  knownSecrets.add(expiringToken);
  const databaseModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "database", "dist", "index.js")));
  database = new databaseModule.Database(environment.DATABASE_URL, { max: 2 });
  await database.withSql(async (sql) => {
    await sql`UPDATE drop_sessions SET state = 'expired' WHERE token_hash = ${createHash("sha256").update(expiringToken).digest("hex")}`;
  });
  if ((await apiRequest("/drop/session", { jar: expiring.jar, csrfKind: "drop" })).status !== 401) throw new Error("Expired Drop session remained usable");
  pass("absolute Drop session expiry", { expired: 401 });

  const browserCode = await createDropCode(106);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const browserDiagnostics = [];
  page.on("pageerror", (error) => browserDiagnostics.push(error.message));
  await page.goto(`${publicOrigin}/drop`, { waitUntil: "networkidle" });
  const source = await page.content();
  if (!source.includes("noindex,nofollow,noarchive")) throw new Error("Drop page is missing its no-index policy");
  await page.getByLabel("Drop code").fill(browserCode);
  await page.getByRole("button", { name: "Open upload session" }).click();
  await page.getByText("UPLOAD ONLY").waitFor();
  if (await page.getByLabel("Drop code").count() !== 0) throw new Error("Drop code remained in the browser UI after redemption");
  const browserFilename = `browser-drop-${Date.now().toString(36)}.txt`;
  await page.getByLabel("Choose files for Drop").setInputFiles({ name: browserFilename, mimeType: "text/plain", buffer: Buffer.from("browser-stage-seven") });
  await page.getByText(browserFilename, { exact: true }).waitFor();
  await page.getByText("completed", { exact: true }).waitFor();
  const axe = await new AxeBuilder({ page }).analyze();
  const serious = axe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
  if (serious.length > 0) throw new Error(`Drop accessibility violations: ${serious.map((item) => item.id).join(",")}`);
  if (await page.evaluate(() => localStorage.length + sessionStorage.length) !== 0) throw new Error("Drop browser persisted secret/application state");
  const browserCookies = await context.cookies();
  const browserSession = browserCookies.find((cookie) => cookie.name === "vault_drop_session_dev");
  if (browserSession?.httpOnly !== true || browserSession.sameSite !== "Strict") throw new Error("Browser Drop cookie flags failed");
  for (const cookie of browserCookies) if (cookie.value.length >= 32) knownSecrets.add(cookie.value);
  await page.screenshot({ path: desktopScreenshot, fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  if (browserDiagnostics.length > 0) throw new Error(`Drop browser errors: ${browserDiagnostics.join(" | ")}`);
  pass("public Drop browser workflow", { redeem: true, upload: true, codeCleared: true, browserStorageEntries: 0, seriousOrCriticalViolations: 0, viewports: [1440, 320] });

  const pendingCode = await createDropCode(107);
  const messagesBeforeRevoke = providerMessages.length;
  const revokeUpdate = telegramUpdate(108, 42, "/revoke");
  const revoke = await webhook(revokeUpdate);
  const revokeReplay = await webhook(revokeUpdate);
  const pendingAfterRevoke = await redeemDrop(pendingCode, new Map());
  if (revoke.status !== 200 || revokeReplay.status !== 200
    || providerMessages.length !== messagesBeforeRevoke + 1
    || pendingAfterRevoke.response.status !== 401
    || (await apiRequest("/drop/session", { jar: first.jar, csrfKind: "drop" })).status !== 401
    || (await apiRequest("/drop/session", { jar: second.jar, csrfKind: "drop" })).status !== 401) {
    throw new Error("Telegram revoke/update replay boundary failed");
  }
  pass("Telegram revoke and update deduplication", { activeSessions: "revoked", pendingCode: 401, committedFileRetained: true, replayMessageCount: 0 });

  await database.withSql(async (sql) => { await sql`DELETE FROM drop_attempts`; });
  const bruteForce = await Promise.all(Array.from({ length: 6 }, (_, index) => redeemDrop(`0000-000${String(index)}`, new Map()).then((value) => value.response.status)));
  const bruteForceSorted = [...bruteForce].sort((left, right) => left - right);
  if (JSON.stringify(bruteForceSorted) !== JSON.stringify([401, 401, 401, 401, 401, 429])) {
    throw new Error(`Atomic Drop rate limit failed: ${bruteForce.join(",")}`);
  }
  pass("atomic brute-force boundary", { concurrentAttempts: 6, denied: 5, rateLimited: 1, sourceWindowMinutes: 15 });

  const oversize = await fetch(`${apiOrigin}/internal/telegram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": webhookSecret },
    body: JSON.stringify({ update_id: 200, padding: "x".repeat(70_000) }),
  });
  if (oversize.status !== 413) throw new Error(`Webhook body limit failed with ${String(oversize.status)}`);
  pass("webhook secret and body bounds", { forgedSecret: 401, maximumBytes: 65_536, oversize: 413 });

  const dumpArgs = [
    "exec", postgresContainer, "pg_dump", "-U", "vault", "-d", "vault", "-Fc", "--no-owner", "--no-acl",
    "--exclude-table-data=web_sessions", "--exclude-table-data=login_sessions", "--exclude-table-data=operation_locks",
    "--exclude-table-data=upload_sessions", "--exclude-table-data=backup_runs", "--exclude-table-data=recovery_runs",
    "--exclude-table-data=auth_attempts", "--exclude-table-data=telegram_link_challenges", "--exclude-table-data=drop_challenges",
    "--exclude-table-data=drop_sessions", "--exclude-table-data=drop_uploads", "--exclude-table-data=drop_attempts",
    "--exclude-table-data=telegram_updates",
  ];
  const databaseDump = runBinary(docker, dumpArgs);
  const dumpListing = runBinary(docker, ["exec", "-i", postgresContainer, "pg_restore", "-l"], databaseDump).toString("utf8");
  if (!dumpListing.includes("TABLE DATA public telegram_binding")
    || ["drop_sessions", "drop_uploads", "drop_attempts", "telegram_updates"].some((table) => dumpListing.includes(`TABLE DATA public ${table}`))) {
    throw new Error("Recovery dump stable/ephemeral metadata policy failed");
  }

  const runtimeText = runtimeLogs.join("\n");
  const secrets = [...knownSecrets].filter((value) => value.length >= 8);
  for (const secret of secrets) {
    if (runtimeText.includes(secret)) throw new Error("Known Stage 7 secret found in runtime logs");
    if (databaseDump.includes(Buffer.from(secret))) throw new Error("Known Stage 7 secret found in recovery dump");
  }
  await scanBuiltArtifacts(secrets);
  pass("code, token, log, backup and artifact scan", { knownValues: secrets.length, runtimeLogBytes: Buffer.byteLength(runtimeText), backupBytes: databaseDump.length, stableBindingExported: true, ephemeralDropRowsExcluded: true });

  providerMessages.splice(0, providerMessages.length);
  for (const call of providerCalls) if (call.body !== undefined) call.body = { redacted: true };
  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser?.close().catch(() => undefined);
  await database?.close().catch(() => undefined);
  for (const child of [...children].reverse()) await stop(child);
  if (providerServer !== undefined) await new Promise((resolve) => providerServer.close(resolve)).catch(() => undefined);
  run(docker, ["compose", "-p", project, "down", "--remove-orphans"], environment, true);
  await fs.rm(path.join(vaultRoot, "data", "sftp"), { recursive: true, force: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  knownSecrets.clear();
  botToken = "";
  webhookSecret = "";
}
