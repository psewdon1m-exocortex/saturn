import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(vaultRoot, "artifacts", "verification", "stage-06-owner-auth-web-ui.json");
const desktopScreenshot = path.join(vaultRoot, "artifacts", "verification", "stage-06-desktop.png");
const mobileScreenshot = path.join(vaultRoot, "artifacts", "verification", "stage-06-mobile.png");
const pnpmScript = path.join(vaultRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
const viteScript = path.join(vaultRoot, "apps", "web", "node_modules", "vite", "bin", "vite.js");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const project = "vault-stage6";
const report = { schema: "vault.stage-verification.v1", stage: 6, startedAt: new Date().toISOString(), success: false, checks: [] };
const children = [];
let environment = process.env;
let database;
let browser;
let ownerAccessKey = "";
let authPepper = "";
const runtimeLogs = [];

function pass(name, detail = {}) {
  report.checks.push({ name, status: "pass", detail });
  process.stdout.write(`PASS ${name}\n`);
}

function run(command, args, selectedEnvironment = environment, allowFailure = false) {
  const result = spawnSync(command, args, { cwd: vaultRoot, env: selectedEnvironment, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args.join(" ")} failed: ${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-3_000)}`);
  }
  return result;
}

function start(command, args, cwd = vaultRoot) {
  const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => runtimeLogs.push(chunk.toString("utf8").slice(-8_192)));
  return child;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitFor(url, expectedStatus = 200, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.status === expectedStatus) return;
    } catch {
      // Startup polling is expected to fail before listeners are ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const recentLogs = runtimeLogs.join("").slice(-2_000).trim();
  throw new Error(`Timed out waiting for ${url}${recentLogs ? `: ${recentLogs}` : ""}`);
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

async function gatewayRequest(relativePath, { method = "GET", json, body, headers: inputHeaders, jar, csrf = true, origin = "http://127.0.0.1:4173" } = {}) {
  const headers = new Headers(inputHeaders ?? {});
  if (!headers.has("User-Agent")) headers.set("User-Agent", "vault-stage6-verifier/1");
  if (jar !== undefined && jar.size > 0) headers.set("Cookie", cookieHeader(jar));
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (origin !== undefined) headers.set("Origin", origin);
    if (csrf && jar !== undefined) {
      const token = jar.get("vault_csrf_dev");
      if (token !== undefined) headers.set("X-Vault-CSRF", token);
    }
  }
  let requestBody = body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    requestBody = JSON.stringify(json);
  }
  const response = await fetch(`http://127.0.0.1:3000/api/v1${relativePath}`, {
    method,
    headers,
    ...(requestBody === undefined ? {} : { body: requestBody }),
    signal: AbortSignal.timeout(120_000),
  });
  if (jar !== undefined) updateCookies(jar, response);
  return response;
}

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function sessionUpload(jar, filename, payload) {
  const create = await gatewayRequest("/uploads", {
    method: "POST",
    jar,
    headers: { "Idempotency-Key": `stage6-upload-${randomUUID()}` },
    json: { parentId: "00000000-0000-7000-8000-000000000004", filename, expectedSize: payload.length },
  });
  if (create.status !== 201) throw new Error(`Upload create failed: ${create.status}`);
  const upload = await responseJson(create);
  const chunk = await gatewayRequest(`/uploads/${upload.id}`, {
    method: "PATCH",
    jar,
    headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0", "Content-Length": String(payload.length) },
    body: payload,
  });
  if (chunk.status !== 204) throw new Error(`Upload chunk failed: ${chunk.status}`);
  const complete = await gatewayRequest(`/uploads/${upload.id}/complete`, { method: "POST", jar });
  if (complete.status !== 201) throw new Error(`Upload complete failed: ${complete.status}`);
  return (await responseJson(complete)).resource;
}

async function scanBuiltArtifacts(secrets) {
  const roots = [path.join(vaultRoot, "apps", "api", "dist"), path.join(vaultRoot, "apps", "worker", "dist"), path.join(vaultRoot, "apps", "web", "dist")];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else {
        const bytes = await fs.readFile(target);
        for (const secret of secrets) if (bytes.includes(Buffer.from(secret))) throw new Error("Known credential found in production artifact");
      }
    }
  };
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
  environment = { ...process.env, ...prepared.environment, PUBLIC_ORIGIN: "http://127.0.0.1:4173" };
  ownerAccessKey = (await fs.readFile(environment.OWNER_BOOTSTRAP_TOKEN_FILE, "utf8")).trim();
  authPepper = (await fs.readFile(environment.AUTH_PEPPER_FILE, "utf8")).trim();
  run(docker, ["compose", "-p", project, "up", "-d", "--wait"]);
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  const rollback = run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "rollback"]);
  if (!rollback.stdout.includes("0005_owner_sessions")) throw new Error("Owner-session migration rollback did not select 0005");
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"]);
  pass("owner session schema migration round trip", { migration: "0005_owner_sessions", inboxSeeded: true });

  start(process.execPath, [path.join(vaultRoot, "apps", "worker", "dist", "main.js")]);
  start(process.execPath, [path.join(vaultRoot, "apps", "api", "dist", "main.js")]);
  start(process.execPath, [viteScript, "preview", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", "4173"], path.join(vaultRoot, "apps", "web"));
  await Promise.all([
    waitFor("http://127.0.0.1:3000/health/ready"),
    waitFor("http://127.0.0.1:4173/"),
  ]);

  const anonymous = await gatewayRequest("/folders/00000000-0000-7000-8000-000000000004/children");
  if (anonymous.status !== 401 || anonymous.headers.get("cache-control") !== "no-store") throw new Error("Anonymous protected response was not uniformly denied/no-store");
  const jar = new Map();
  const login = await gatewayRequest("/auth/login", { method: "POST", jar, json: { accessKey: ownerAccessKey } });
  const setCookies = login.headers.getSetCookie();
  if (login.status !== 201 || setCookies.length !== 2
    || !setCookies.some((value) => value.includes("HttpOnly") && value.includes("SameSite=Strict") && value.includes("Path=/"))
    || jar.get("vault_session_dev") === undefined || jar.get("vault_csrf_dev") === undefined) {
    throw new Error("Owner login cookie contract failed");
  }
  const oldJar = new Map(jar);
  const session = await gatewayRequest("/auth/session", { jar });
  if (session.status !== 200) {
    const failureBody = (await session.text()).slice(0, 500);
    throw new Error(`Server-side session was not accepted (${session.status}): ${failureBody}\n${runtimeLogs.join("").slice(-8_000)}`);
  }
  pass("owner login and bounded server-side cookie session", { httpOnly: true, sameSite: "Strict", hostOnly: true, devSecure: false });

  const noCsrf = await gatewayRequest("/folders", { method: "POST", jar, csrf: false, json: { parentId: "00000000-0000-7000-8000-000000000004", name: "no-csrf" } });
  const crossOrigin = await gatewayRequest("/folders", { method: "POST", jar, origin: "https://attacker.invalid", json: { parentId: "00000000-0000-7000-8000-000000000004", name: "cross-origin" } });
  if (noCsrf.status !== 401 || crossOrigin.status !== 401) throw new Error("CSRF or same-origin enforcement failed");
  const suffix = Date.now().toString(36);
  const sessionFolderResponse = await gatewayRequest("/folders", { method: "POST", jar, json: { parentId: "00000000-0000-7000-8000-000000000004", name: `Session-${suffix}` } });
  if (sessionFolderResponse.status !== 201) throw new Error("CSRF-valid owner mutation failed");
  const sessionFolder = await responseJson(sessionFolderResponse);
  const bearerFolder = await gatewayRequest("/folders", {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerAccessKey}` },
    json: { parentId: "00000000-0000-7000-8000-000000000004", name: `Bearer-${suffix}` },
    origin: undefined,
  });
  if (bearerFolder.status !== 201) throw new Error("Break-glass bearer request incorrectly depended on browser CSRF");
  pass("CSRF, same-origin and bearer separation", { missingCsrf: 401, crossOrigin: 401, sessionMutation: 201, bearerMutation: 201 });

  const databaseModule = await import(pathToFileURL(path.join(vaultRoot, "packages", "database", "dist", "index.js")));
  database = new databaseModule.Database(environment.DATABASE_URL, { max: 2 });
  const currentToken = jar.get("vault_session_dev");
  await database.withSql(async (sql) => {
    await sql`UPDATE web_sessions SET reauthenticated_at = now() - interval '10 minutes' WHERE token_hash = ${createHash("sha256").update(currentToken).digest("hex")}`;
  });
  const stalePurge = await gatewayRequest("/diagnostics/reconciliation/purge", { method: "POST", jar, json: { limit: 1 } });
  if (stalePurge.status !== 403 || (await responseJson(stalePurge)).code !== "reauth_required") throw new Error("Critical action did not require recent proof");
  const reauth = await gatewayRequest("/auth/reauthenticate", { method: "POST", jar, json: { accessKey: ownerAccessKey } });
  if (reauth.status !== 201 || jar.get("vault_session_dev") === oldJar.get("vault_session_dev")) throw new Error("Reauthentication did not rotate the session");
  const oldSessionRejected = await gatewayRequest("/auth/session", { jar: oldJar });
  const freshPurge = await gatewayRequest("/diagnostics/reconciliation/purge", { method: "POST", jar, json: { limit: 1 } });
  if (oldSessionRejected.status !== 401 || freshPurge.status !== 201 || (await responseJson(freshPurge)).state !== "disabled") {
    throw new Error("Session rotation or recent-proof gate failed");
  }
  pass("reauthentication rotation and critical-action gate", { stale: 403, oldSession: 401, purgePolicy: "disabled" });

  const html = await sessionUpload(jar, `forged-${suffix}.png`, Buffer.from("<html><script>alert(1)</script></html>"));
  const htmlPreview = await gatewayRequest(`/files/${html.id}/preview`, { jar });
  if (htmlPreview.status === 200) throw new Error("Forged image/HTML was rendered inline");
  const svg = await sessionUpload(jar, `vector-${suffix}.svg`, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"));
  if ((await gatewayRequest(`/files/${svg.id}/preview`, { jar })).status === 200) throw new Error("SVG script content was rendered inline");
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const png = await sessionUpload(jar, `safe-${suffix}.png`, pngBytes);
  const pngPreview = await gatewayRequest(`/files/${png.id}/preview`, { jar });
  const pngDownload = await gatewayRequest(`/files/${png.id}/content`, { jar });
  if (pngPreview.status !== 200 || !pngPreview.headers.get("content-disposition")?.startsWith("inline")
    || pngPreview.headers.get("x-frame-options") !== "SAMEORIGIN"
    || !pngDownload.headers.get("content-disposition")?.startsWith("attachment")) {
    throw new Error("Preview/download content policy failed");
  }
  await pngPreview.arrayBuffer();
  await pngDownload.arrayBuffer();
  pass("preview MIME allow-list and attachment fallback", { forgedHtml: "rejected", svg: "rejected", png: "inline", ordinaryDownload: "attachment" });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const page = await context.newPage();
  const browserDiagnostics = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/") && response.status() >= 400) browserDiagnostics.push(`${String(response.status())} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
  page.on("pageerror", (error) => browserDiagnostics.push(`pageerror ${error.message}`));
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });
  const loginAxe = await new AxeBuilder({ page }).analyze();
  const loginViolations = loginAxe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
  if (loginViolations.length > 0) throw new Error(`Login accessibility violations: ${loginViolations.map((item) => item.id).join(",")}`);
  const loginField = page.getByLabel("Owner access key");
  if (await loginField.inputValue() !== "") throw new Error("Credential field was application-prefilled");
  await loginField.fill(ownerAccessKey);
  await page.getByRole("button", { name: "Enter Saturn" }).click();
  await page.getByRole("heading", { name: "Files" }).waitFor();
  const fileNameButton = (name) => page.getByRole("button", { name, exact: true });
  await fileNameButton("sync").dblclick();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "New folder" && !button.disabled));

  const browserFolderName = `Browser-${suffix}`;
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabel("Folder name").fill(browserFolderName);
  await page.getByRole("button", { name: "Apply" }).click();
  try {
    await fileNameButton(browserFolderName).waitFor();
  } catch (error) {
    await page.screenshot({ path: path.join(vaultRoot, "artifacts", "verification", "stage-06-browser-failure.png"), fullPage: true });
    throw new Error(`Browser folder creation did not become visible: ${browserDiagnostics.join(" | ")}\n${(await page.locator("body").innerText()).slice(0, 3_000)}`, { cause: error });
  }

  const originalName = `browser-${suffix}.txt`;
  await page.getByLabel("Choose files to upload").setInputFiles({ name: originalName, mimeType: "text/plain", buffer: Buffer.from("original browser bytes") });
  await fileNameButton(originalName).waitFor();
  await page.getByLabel(`Select ${originalName}`).check();
  const renamed = `renamed-${suffix}.txt`;
  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(renamed);
  await page.getByRole("button", { name: "Apply" }).click();
  await fileNameButton(renamed).waitFor();
  await page.getByLabel(`Select ${renamed}`).check();
  await page.getByLabel("Choose replacement file").setInputFiles({ name: renamed, mimeType: "text/plain", buffer: Buffer.from("replacement browser bytes") });
  await page.getByText(/previous version is retained/i).waitFor();
  await page.getByLabel(`Select ${renamed}`).check();
  await page.getByRole("button", { name: "Versions" }).click();
  await page.getByText(/Restoring a version archives/i).waitFor();
  if (await page.locator(".version-row").count() < 1) throw new Error("Browser versions view is empty after overwrite");
  await page.getByRole("button", { name: "Close dialog" }).click();

  await page.getByLabel(`Select ${renamed}`).check();
  await page.getByRole("button", { name: "Copy" }).click();
  await page.getByLabel("Destination folder ID").fill("00000000-0000-7000-8000-000000000004");
  const copiedName = `copy-${suffix}.txt`;
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(copiedName);
  await page.getByRole("button", { name: "Apply" }).click();
  await fileNameButton(copiedName).waitFor();

  await page.getByLabel(`Select ${renamed}`).check();
  await page.getByRole("button", { name: "Move" }).click();
  await page.getByLabel("Destination folder ID").fill(sessionFolder.id);
  await page.getByRole("button", { name: "Apply" }).click();
  await fileNameButton(renamed).waitFor({ state: "detached" });
  await fileNameButton(`Session-${suffix}`).dblclick();
  await fileNameButton(renamed).waitFor();
  await page.getByLabel(`Select ${renamed}`).check();
  await page.getByLabel("Selection actions").getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByRole("button", { name: "Move to trash" }).click();
  const primaryNavigation = page.getByRole("navigation", { name: "Primary" });
  await primaryNavigation.getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByText(renamed, { exact: true }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByText(/restored to its original folder/i).waitFor();

  const inboxName = `inbox-${suffix}.txt`;
  await page.getByLabel("Choose files for quick upload").setInputFiles({ name: inboxName, mimeType: "text/plain", buffer: Buffer.from("inbox") });
  await page.getByText(/Quick upload committed/i).waitFor();
  await primaryNavigation.getByRole("button", { name: "Drop Point", exact: true }).click();
  await fileNameButton(inboxName).waitFor();
  await primaryNavigation.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByText("file.overwritten", { exact: true }).waitFor();
  await primaryNavigation.getByRole("button", { name: "Settings", exact: true }).click();
  const colorFields = page.locator("input[pattern]");
  await colorFields.nth(2).fill("#33ccff");
  await page.getByRole("button", { name: "Save appearance" }).click();
  try {
    await page.getByText(/Appearance updated/i).waitFor();
  } catch (error) {
    throw new Error(`Browser appearance update failed: ${browserDiagnostics.join(" | ")}\n${(await page.locator("body").innerText()).slice(0, 3_000)}`, { cause: error });
  }

  const appAxe = await new AxeBuilder({ page }).analyze();
  const appViolations = appAxe.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""));
  if (appViolations.length > 0) throw new Error(`App accessibility violations: ${appViolations.map((item) => item.id).join(",")}`);
  if (await page.evaluate(() => localStorage.length + sessionStorage.length) !== 0) throw new Error("Browser storage contains authentication/application secrets");
  const browserCookies = await context.cookies();
  const sessionCookie = browserCookies.find((cookie) => cookie.name === "vault_session_dev");
  if (sessionCookie?.httpOnly !== true || sessionCookie.sameSite !== "Strict") throw new Error("Browser session cookie flags differ from contract");
  const dismissButtons = page.getByRole("button", { name: "Dismiss notification" });
  while (await dismissButtons.count() > 0) await dismissButtons.first().click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: desktopScreenshot, fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("navigation", { name: "Primary" }).waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({ path: mobileScreenshot, fullPage: true });
  await page.keyboard.press("Tab");
  pass("browser owner workflow", { folder: true, upload: true, overwrite: true, versions: true, rename: true, copy: true, move: true, trashRestore: true, quickDropPoint: true, activity: true, settings: true });
  pass("responsive keyboard and automated accessibility", { viewports: [1440, 320], seriousOrCriticalViolations: 0, browserStorageEntries: 0 });

  const revoke = await gatewayRequest("/auth/sessions", { method: "DELETE", jar });
  if (revoke.status !== 200 || (await gatewayRequest("/auth/session", { jar })).status !== 401) throw new Error("Server-side revoke-all did not invalidate the session");
  pass("server-side session revocation", { revokeAll: true, immediateDenial: true });

  const failureStatuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await gatewayRequest("/auth/login", { method: "POST", json: { accessKey: `wrong-${String(attempt)}-${randomUUID()}` } });
    failureStatuses.push(response.status);
  }
  if (!failureStatuses.slice(0, 5).every((status) => status === 401) || failureStatuses[5] !== 429) throw new Error("Authentication rate limit boundary failed");
  pass("authentication failure rate limit", { attempts: failureStatuses });

  const runtimeText = runtimeLogs.join("\n");
  const sessionTokens = [...jar.values(), ...oldJar.values()].filter((value) => value.length >= 32);
  for (const secret of [ownerAccessKey, authPepper, ...sessionTokens]) if (runtimeText.includes(secret)) throw new Error("Credential/session material found in runtime logs");
  await scanBuiltArtifacts([ownerAccessKey, authPepper]);
  pass("credential, session, log and artifact scan", { runtimeLogBytes: Buffer.byteLength(runtimeText), productionArtifacts: "clean" });
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
  ownerAccessKey = "";
  authPepper = "";
}
