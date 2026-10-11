// Browser acceptance on synthetic local data. No backend or production data is touched.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createStaticServer } from "../infra/production/static-server.mjs";

const staticServer = process.env.SATURN_UI_ORIGIN ? undefined : createStaticServer({ root: path.resolve("apps/web/dist") });
if (staticServer) await new Promise((resolve, reject) => { staticServer.once("error", reject); staticServer.listen(0, "127.0.0.1", resolve); });
const origin = process.env.SATURN_UI_ORIGIN ?? `http://127.0.0.1:${staticServer.address().port}`;
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname), "This fixture runner is local only");
const output = path.resolve(process.env.SATURN_UI_OUTPUT ?? "../.audit/2026-10-11/storage-new");
await fs.mkdir(output, { recursive: true });
const rootId = "00000000-0000-7000-8000-000000000001";
const now = "2026-10-11T12:00:00.000Z";
const resource = (id, type, name, parentId = rootId, mimeType) => ({ id, type, name, parentId, storagePath: name, sizeBytes: type === "folder" ? 32 * 1024 ** 2 : 1024 ** 2, mimeType, status: "active", createdAt: now, updatedAt: now });
const root = resource(rootId, "folder", "root");
const rootFixtures = [
  ["00000000-0000-7000-8000-000000000002", "# drop point"],
  ["00000000-0000-7000-8000-000000000003", "# mastermind"],
  ["00000000-0000-7000-8000-000000000004", "# sync windows"],
  ["00000000-0000-7000-8000-000000000005", "# volt"],
  ["00000000-0000-7000-8000-000000000006", "# laboratory"],
  ["00000000-0000-7000-8000-000000000007", "# sync inner services"],
  ["00000000-0000-7000-8000-000000000008", "# references"],
  ["00000000-0000-7000-8000-000000000009", "# sync outdoor connections"],
];
const roots = rootFixtures.map(([id, name]) => resource(id, "folder", name));
const current = roots.find((item) => item.name === "# drop point");
assert.ok(current);
const files = [
  resource("fixture-folder", "folder", "Project materials", current.id),
  resource("fixture-image", "file", "Saturn cover.svg", current.id, "image/svg+xml"),
  resource("fixture-video", "file", "Project walkthrough.mp4", current.id, "video/mp4"),
  resource("fixture-pdf", "file", "Architecture.pdf", current.id, "application/pdf"),
  resource("fixture-readme", "file", "README.md", current.id, "text/markdown"),
  resource("fixture-archive", "file", "assets.zip", current.id, "application/zip"),
];
const share = { id: "fixture-share", resourceId: "fixture-folder", resourceType: "folder", resourceName: "Project materials", resourceSize: 32 * 1024 ** 2, mode: "download_folder", state: "active", locked: false, downloadCount: 0, createdAt: now, updatedAt: now };
const preferences = { accentColor: "#00a8ff", sidebarMode: "fixed", navigationOrder: ["dashboard", "files", "inbox", "shared", "synchronization", "trash", "settings"], dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"], settingsOrder: ["appearance", "security", "storage", "backup", "gryphon", "updates", "logs"], trashRetentionDays: 30, uploadBufferGiB: 110, maximumUploadFileGiB: 20, updatedAt: now };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="#202a35"/><circle cx="340" cy="155" r="75" fill="#d7c7a5"/><ellipse cx="340" cy="155" rx="170" ry="35" fill="none" stroke="#b4a480" stroke-width="16" transform="rotate(-18 340 155)"/><circle cx="85" cy="65" r="2" fill="white"/><circle cx="560" cy="250" r="3" fill="white"/></svg>';
const checks = [], errors = [], writes = [];
let scenario = "normal", broken = false, uploaded, uploadState;
const browser = await chromium.launch({ headless: true });
let activePage;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", acceptDownloads: true });
  const page = await context.newPage();
  activePage = page;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), endpoint = url.pathname.replace("/api/v1", ""), method = request.method();
    const send = body => route.fulfill({ json: body });
    if (!["GET", "HEAD"].includes(method)) writes.push({ endpoint, method });
    if (endpoint === "/auth/public-appearance") return send({ accentColor: preferences.accentColor });
    if (endpoint === "/auth/session") return send({ state: "authenticated" });
    if (endpoint === "/auth/preferences") return send(method === "PUT" ? { ...request.postDataJSON(), updatedAt: now } : preferences);
    if (endpoint === "/public/reachability") return send({ status: "ready" });
    if (endpoint.startsWith("/folders/resolve")) {
      if (scenario === "error") return route.fulfill({ status: 503, json: { code: "unavailable" } });
      return send(url.searchParams.get("path") ? [root, current] : [root]);
    }
    if (endpoint.includes("/children")) return send(endpoint.includes(rootId) ? roots : scenario === "empty" ? [] : scenario === "single" ? [files[4]] : scenario === "many" ? Array.from({ length: 120 }, (_, i) => ({ ...files[i % files.length], id: `many-${i}`, name: i === 0 ? `${"long-filename-".repeat(15)}.md` : `${String(i).padStart(3, "0")} ${files[i % files.length].name}` })) : [...files, ...(uploaded ? [uploaded] : [])]);
    if (endpoint.startsWith("/archives/jobs")) return send([]);
    if (endpoint === "/shares") return send([share]);
    if (endpoint === "/uploads" && method === "POST") { uploadState = { ...request.postDataJSON(), receivedSize: 0, id: "fixture-upload" }; return send(uploadState); }
    if (endpoint === "/uploads/fixture-upload" && method === "HEAD") return route.fulfill({ status: 200, headers: { "Upload-Offset": String(uploadState.receivedSize), "Upload-Length": String(uploadState.expectedSize), "Upload-Status": "uploading" } });
    if (endpoint === "/uploads/fixture-upload" && method === "PATCH") { uploadState.receivedSize += request.postDataBuffer().length; return route.fulfill({ status: 204 }); }
    if (endpoint === "/uploads/fixture-upload/complete") { uploaded = resource("fixture-uploaded", "file", uploadState.filename, uploadState.parentId, "text/plain"); uploaded.sizeBytes = uploadState.expectedSize; return send({ resource: uploaded }); }
    if (endpoint.startsWith("/resources/")) return send(roots.find(item => endpoint.endsWith(item.id)) ?? current);
    if (endpoint.startsWith("/files/") && (/\/(content|preview)/).test(endpoint)) {
      if (broken) return route.fulfill({ status: 404 });
      return route.fulfill({ status: 200, contentType: endpoint.includes("fixture-image") ? "image/svg+xml" : "text/plain", headers: url.searchParams.has("transferId") ? { "Content-Disposition": 'attachment; filename="download.txt"' } : {}, body: endpoint.includes("fixture-image") ? svg : "Verified fixture bytes" });
    }
    return route.fulfill({ status: 404, json: { code: "fixture_unimplemented" } });
  });
  const open = async (url = "/storage-new/%23%20drop%20point") => { await page.goto(origin + url); await expect(page.getByRole("heading", { name: url === "/storage-new" ? "Your storage" : "# drop point", exact: true })).toBeVisible(); await expect(page.locator(".storage-new-grid[aria-busy=false]")).toBeVisible(); };
  const geometry = async label => {
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, workspace: document.querySelector(".storage-new").getBoundingClientRect().width }));
    assert.ok(dimensions.page <= dimensions.viewport, `${label}: horizontal overflow ${JSON.stringify(dimensions)}`);
    checks.push({ check: label, ...dimensions });
  };
  for (const width of [320, 375, 720, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 }); await open(); await geometry(`nested ${width}px`);
    await expect(page.getByRole("link", { name: "Download README.md", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(output, `nested-${width}.png`), fullPage: true });
    await open("/storage-new"); await geometry(`root ${width}px`);
    await page.screenshot({ path: path.join(output, `root-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await open("/storage-new");
  await expect(page.getByRole("article")).toHaveCount(rootFixtures.length);
  for (const [, name] of rootFixtures) await expect(page.getByRole("article", { name, exact: true })).toBeVisible();
  checks.push({ check: "all eight canonical v3 system roots are visible", roots: rootFixtures.map(([, name]) => name), state: "PASS" });
  await page.getByRole("article", { name: "# sync windows", exact: true }).click({ button: "right" });
  for (const action of ["Move", "Copy to folder", "Copy", "Cut", "Delete", "Rename"]) {
    await expect(page.getByRole("menuitem", { name: action, exact: true })).toBeDisabled();
  }
  await page.screenshot({ path: path.join(output, "protected-root-menu-1440.png"), fullPage: false });
  await page.keyboard.press("Escape");
  checks.push({ check: "canonical v3 system root mutation actions are disabled", state: "PASS" });
  await page.setViewportSize({ width: 1440, height: 1000 }); await open();
  await page.getByRole("button", { name: "README.md", exact: true }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Selection actions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Actions for README.md", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.screenshot({ path: path.join(output, "selected-1440.png"), fullPage: true });
  await page.getByRole("article", { name: "README.md", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, "right-click-1440.png"), fullPage: false });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("article", { name: "README.md", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: "Versions", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Overwrite", exact: true })).toBeEnabled();
  await expect(page.getByRole("menuitem", { name: "Move", exact: true })).toBeEnabled();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("article", { name: "README.md", exact: true })).toBeFocused();
  await expect(page.getByRole("toolbar", { name: "Selection actions" })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview README.md", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Preview README.md", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  checks.push({ check: "selection, context menu, preview and Escape", state: "PASS" });
  await page.setViewportSize({ width: 320, height: 480 }); await open();
  await page.getByRole("article", { name: "README.md", exact: true }).click({ button: "right" });
  const menu = page.getByRole("menu");
  const bounds = await menu.boundingBox();
  assert.ok(bounds.x >= 8 && bounds.x + bounds.width <= 312 && bounds.y >= 8 && bounds.y + bounds.height <= 472);
  await menu.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(menu).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Compress to ZIP", exact: true })).toBeFocused();
  await page.screenshot({ path: path.join(output, "right-click-320-short.png"), fullPage: false });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("article", { name: "README.md", exact: true })).toBeFocused();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.evaluate(() => window.scrollBy(0, -10));
  await expect(menu).toHaveCount(0);
  checks.push({ check: "short-screen menu bounds, own scroll, keyboard End and Escape focus", state: "PASS" });
  await page.setViewportSize({ width: 1440, height: 1000 }); await open();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download README.md", exact: true }).click();
  const download = await downloadEvent; assert.equal(await download.failure(), null);
  assert.equal(await fs.readFile(await download.path(), "utf8"), "Verified fixture bytes");
  checks.push({ check: "download receives fixture bytes", state: "PASS" });
  await page.getByLabel("Choose files to upload", { exact: true }).setInputFiles({ name: "important.conf", mimeType: "text/plain", buffer: Buffer.from("precious bytes") });
  await expect(page.getByRole("article", { name: "important.conf", exact: true })).toBeVisible();
  assert.equal(uploadState.parentId, current.id); assert.equal(uploadState.receivedSize, 14);
  checks.push({ check: "file chooser runs resumable upload protocol", state: "PASS" });
  uploaded = undefined;
  const transfer = await page.evaluateHandle(() => { const dt = new DataTransfer(); dt.items.add(new File(["drop bytes"], "drop.conf", { type: "text/plain" })); return dt; });
  await page.locator(".storage-new").dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(page.locator(".storage-drop-overlay")).toBeVisible();
  await page.locator(".storage-new").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.getByRole("article", { name: "drop.conf", exact: true })).toBeVisible();
  assert.equal(uploadState.receivedSize, 10);
  checks.push({ check: "drag and drop runs resumable upload protocol", state: "PASS" });
  await page.getByRole("searchbox", { name: "Search storage", exact: true }).fill("not-found");
  await expect(page.getByText("No matching items. Try another search.", { exact: true })).toBeVisible();
  for (const variant of ["empty", "single", "many", "error"]) {
    scenario = variant; uploaded = undefined; await open();
    if (variant === "error") { await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible(); scenario = "normal"; await page.getByRole("button", { name: "Try again", exact: true }).click(); await expect(page.getByRole("article", { name: "README.md", exact: true })).toBeVisible(); }
    if (variant === "many") await expect(page.locator(".storage-new-file")).toHaveCount(120);
    await geometry(variant); await page.screenshot({ path: path.join(output, `${variant}.png`), fullPage: true });
  }
  scenario = "normal"; broken = true; await open();
  await expect(page.locator(".storage-new-file__visual img")).toBeHidden();
  await expect(page.getByRole("button", { name: "Preview Saturn cover.svg", exact: true }).locator("svg")).toBeVisible();
  checks.push({ check: "missing thumbnail retains type icon", state: "PASS" });
  broken = false;
  for (const accentColor of ["#00a8ff", "#ffff88", "#ffffff"]) {
    preferences.accentColor = accentColor; await open(); await geometry(`accent ${accentColor}`);
    const contrast = await page.evaluate(() => {
      const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d"); canvas.width = 1; canvas.height = 1;
      const luminance = color => {
        ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = [...ctx.getImageData(0, 0, 1, 1).data].map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
        return .2126 * r + .7152 * g + .0722 * b;
      };
      const ink = luminance(getComputedStyle(document.querySelector(".storage-new-kicker")).color);
      const surface = luminance(getComputedStyle(document.querySelector(".storage-new")).backgroundColor);
      return (Math.max(ink, surface) + .05) / (Math.min(ink, surface) + .05);
    });
    assert.ok(contrast >= 4.5, `Accent ${accentColor} text contrast: ${contrast}`);
    checks.push({ check: `accent text contrast ${accentColor}`, ratio: contrast, state: "PASS" });
  }
  await page.goto(origin + "/files");
  await expect(page.locator(".storage-workspace .storage-collection")).toBeVisible();
  assert.equal(await page.locator(".storage-workspace").evaluate(node => getComputedStyle(node).backgroundColor), "rgb(0, 0, 0)");
  assert.equal(await page.locator(".content").evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: path.join(output, "original-1440.png"), fullPage: true });
  checks.push({ check: "original table and black theme survive switching", state: "PASS" });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ state: "PASS", origin, coverage: "Production web bundle with synthetic API; no real backend, storage or production", checks, writes, errors }, null, 2));
  console.log(JSON.stringify({ state: "PASS", checks: checks.length, report: path.join(output, "result.json") }));
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ state: "FAIL", checks, errors, failure: String(error) }, null, 2)); throw error;
} finally { await browser.close(); if (staticServer) await new Promise(resolve => staticServer.close(resolve)); }
