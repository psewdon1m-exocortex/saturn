// Production web bundle, synthetic API fixtures and ephemeral loopback server only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createStaticServer } from "../infra/production/static-server.mjs";

const output = path.resolve(process.env.SATURN_DOCUMENTATION_OUTPUT ?? "../.audit/2026-10-11/documentation");
await fs.mkdir(output, { recursive: true });
const server = createStaticServer({ root: path.resolve("apps/web/dist") });
const browser = await chromium.launch({ headless: true });
const checks = [], errors = [], unexpected = [];
let page, sessionState = "authenticated";
const preferences = {
  accentColor: "#00a8ff", sidebarMode: "fixed", navigationOrder: ["dashboard", "files", "storage-new", "inbox", "shared", "synchronization", "trash", "settings"],
  dashboardOrder: ["cpu", "ram", "disk", "uptime", "storage", "drop", "reachability", "tasks"],
  settingsOrder: ["appearance", "security", "storage", "backup", "gryphon", "updates", "logs"],
  trashRetentionDays: 30, uploadBufferGiB: 110, maximumUploadFileGiB: 20, updatedAt: "2026-10-11T12:00:00Z",
};
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const endpoint = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (route.request().method() !== "GET") unexpected.push(`${route.request().method()} ${endpoint}`);
    if (endpoint === "/auth/session" && sessionState === "anonymous") return route.fulfill({ status: 401, json: { code: "unauthorized" } });
    const values = {
      "/auth/public-appearance": { accentColor: preferences.accentColor },
      "/auth/session": { state: sessionState }, "/auth/preferences": preferences,
      "/public/reachability": { status: "ready" },
    };
    if (endpoint.includes("/children") || endpoint === "/shares" || endpoint === "/archives/jobs") return route.fulfill({ json: [] });
    if (endpoint.startsWith("/folders/resolve")) return route.fulfill({ json: [{ id: "00000000-0000-7000-8000-000000000001", type: "folder", name: "root", storagePath: "", sizeBytes: 0, status: "active", createdAt: preferences.updatedAt, updatedAt: preferences.updatedAt }] });
    await route.fulfill({ json: values[endpoint] ?? {} });
  });
  const navigation = () => page.getByRole("navigation", { name: "Documentation navigation" });
  const article = () => page.getByRole("region", { name: "Saturn operator guide" });
  const search = () => page.getByRole("searchbox", { name: "Search documentation" });
  const load = async () => {
    const response = await page.goto(`${origin}/documentation`);
    assert.equal(response.status(), 200);
    assert.match(response.headers()["x-robots-tag"], /noindex/);
    await expect(search()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  };
  const offsets = () => page.evaluate(() => ({
    page: window.scrollY,
    nav: document.querySelector(".documentation-nav").scrollTop,
    article: document.querySelector(".documentation-article").scrollTop,
  }));
  const geometry = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const value = await page.evaluate(() => {
      const nav = document.querySelector(".documentation-nav"), article = document.querySelector(".documentation-article"), grid = document.querySelector(".documentation-page");
      const nr = nav.getBoundingClientRect(), ar = article.getBoundingClientRect();
      return {
        windowWidth: innerWidth, height: innerHeight, pageHeight: document.documentElement.scrollHeight, pageWidth: document.documentElement.scrollWidth,
        nav: { x: nr.x, y: nr.y, width: nr.width, height: nr.height, max: nav.scrollHeight - nav.clientHeight },
        article: { x: ar.x, y: ar.y, width: ar.width, height: ar.height },
        owners: [...grid.querySelectorAll("*")].filter(el => el.scrollHeight > el.clientHeight + 1 && ["auto", "scroll"].includes(getComputedStyle(el).overflowY)).map(el => el.className),
        outerOverflow: getComputedStyle(grid).overflowY,
        currentCount: document.querySelectorAll('.documentation-link[aria-current="location"]').length,
        hiddenScrollbars: [nav, article].every(el => getComputedStyle(el).scrollbarWidth === "none"),
      };
    });
    assert.ok(value.pageHeight <= value.height + 1, JSON.stringify(value));
    assert.ok(value.pageWidth <= value.windowWidth, JSON.stringify(value));
    assert.equal(value.outerOverflow, "hidden");
    assert.equal(value.currentCount, 1);
    assert.ok(value.hiddenScrollbars);
    assert.deepEqual(value.owners.sort(), ["documentation-article", "documentation-nav"]);
    assert.ok(value.article.height >= 25);
    if (value.windowWidth > 1000) {
      assert.equal(value.nav.width, 220); assert.equal(value.article.x - value.nav.x - value.nav.width, 30);
      assert.ok(value.article.width <= 1120);
    } else assert.ok(value.article.y > value.nav.y + value.nav.height);
    return value;
  };

  for (const [width, height] of [[1920, 1080], [1440, 1000], [1024, 768], [1000, 800], [768, 700], [720, 800], [390, 844], [320, 640], [720, 420], [320, 320]]) {
    await page.setViewportSize({ width, height }); await load();
    const measured = await geometry();
    await article().evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(navigation().locator('[aria-current="location"]')).toHaveText("Diagnostics and recovery checks");
    await expect.poll(async () => (await offsets()).nav).toBe(0);
    await expect.poll(async () => (await offsets()).page).toBe(0);
    if ([1440, 390, 320].includes(width) && height > 420) {
      await article().evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: path.join(output, `documentation-${width}.png`), fullPage: true });
    }
    checks.push({ name: `bounded workspace and two scroll owners ${width}x${height}`, state: "PASS", measured });
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await load();
  let box = await navigation().boundingBox();
  await page.mouse.move(box.x + 100, box.y + 110); await page.mouse.wheel(0, 450);
  await expect.poll(async () => (await offsets()).nav).toBeGreaterThan(0);
  assert.equal((await offsets()).article, 0); assert.equal((await offsets()).page, 0);
  await navigation().evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.mouse.wheel(0, 600); await page.waitForTimeout(200);
  assert.equal((await offsets()).page, 0); assert.equal((await offsets()).article, 0);
  const navPosition = (await offsets()).nav;
  box = await article().boundingBox(); await page.mouse.move(box.x + 80, box.y + 100); await page.mouse.wheel(0, 800);
  await expect.poll(async () => (await offsets()).article).toBeGreaterThan(0);
  assert.equal((await offsets()).nav, navPosition); assert.equal((await offsets()).page, 0);
  checks.push({ name: "independent wheel scrolling and boundary containment", state: "PASS" });

  await navigation().evaluate(el => { el.scrollTop = 0; });
  await navigation().getByRole("button", { name: "Uploads and interruptions" }).focus();
  const navBefore = (await offsets()).nav;
  await page.keyboard.press("Enter");
  await expect(navigation().locator('[aria-current="location"]')).toHaveText("Uploads and interruptions");
  const targetOffset = await page.evaluate(() => document.getElementById("guide-upload").getBoundingClientRect().top - document.querySelector(".documentation-article").getBoundingClientRect().top);
  assert.ok(Math.abs(targetOffset - 31) <= 1, `reading offset ${targetOffset}`);
  assert.equal((await offsets()).nav, navBefore); assert.equal((await offsets()).page, 0);
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Uploads and interruptions");
  checks.push({ name: "keyboard activation, focus and 30px inner reading offset", state: "PASS" });

  await article().focus(); await page.keyboard.press("End");
  await expect(navigation().locator('[aria-current="location"]')).toHaveText("Diagnostics and recovery checks");
  assert.equal((await offsets()).nav, navBefore);
  await page.keyboard.press("Home");
  await expect(navigation().locator('[aria-current="location"]')).toHaveText("Introduction");
  await navigation().focus(); await page.keyboard.press("End");
  await expect.poll(async () => (await offsets()).nav).toBeGreaterThan(navBefore);
  assert.equal((await offsets()).article, 0); assert.equal((await offsets()).page, 0);
  checks.push({ name: "native keyboard scrolling of each region", state: "PASS" });

  await navigation().evaluate(el => { el.scrollTop = 0; });
  await article().evaluate(el => { el.scrollTop = 1800; });
  const searchBefore = await search().boundingBox();
  await search().fill("  DPAPI  ");
  await expect(navigation().locator(".documentation-link")).toHaveCount(1);
  await expect(navigation().locator('[aria-current="location"]')).toHaveText("Neptune Windows");
  assert.equal((await offsets()).article, 0);
  await expect(search()).toHaveValue("  DPAPI  ");
  const searchWithClear = await search().boundingBox();
  assert.equal(searchBefore.width, searchWithClear.width);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search()).toBeFocused(); await expect(search()).toHaveValue("");
  await search().fill("Pluto"); await page.keyboard.press("Escape"); await expect(search()).toHaveValue("");
  await search().fill("no-matching-topic-xyz"); await expect(article().getByRole("status")).toBeVisible();
  await expect(navigation().locator('[aria-current="location"]')).toHaveCount(0);
  await page.screenshot({ path: path.join(output, "documentation-no-results.png"), fullPage: true });
  await page.getByRole("button", { name: "Clear search" }).click();
  assert.equal(new URL(page.url()).search, "");
  checks.push({ name: "body search, normalization, empty state, clear, Escape and stable search geometry", state: "PASS" });

  await page.setViewportSize({ width: 320, height: 640 });
  await navigation().getByRole("button", { name: "Diagnostics and recovery checks" }).click();
  await expect(navigation().locator('[aria-current="location"]')).toHaveText("Diagnostics and recovery checks");
  const table = page.getByRole("region", { name: "Troubleshooting table" });
  await table.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  assert.ok(await table.evaluate(el => el.scrollLeft > 0));
  assert.equal(await page.evaluate(() => window.scrollX), 0);
  await article().evaluate(el => { el.scrollTop = 0; });
  await page.setViewportSize({ width: 768, height: 600 }); await geometry();
  await expect(navigation().locator('[aria-current="location"]')).toHaveText("Introduction");
  checks.push({ name: "narrow table overflow, viewport resize and current-section synchronization", state: "PASS" });

  preferences.sidebarMode = "auto-hide"; await page.setViewportSize({ width: 1440, height: 1000 }); await load();
  const measured = await geometry(); assert.equal(measured.nav.width, 220);
  await page.locator(".sidebar-activation-strip").hover();
  await expect(page.getByRole("button", { name: "Storage", exact: true })).toBeVisible();
  await geometry();
  await page.getByRole("button", { name: "Storage", exact: true }).click();
  await expect(search()).toHaveCount(0);
  await page.getByRole("button", { name: "Documentation", exact: true }).click();
  await expect(search()).toBeVisible(); assert.deepEqual(await offsets(), { page: 0, nav: 0, article: 0 });
  checks.push({ name: "auto-hide sidebar, leaving and reopening resets both owners", state: "PASS" });

  await article().focus();
  await page.mouse.move(1000, 300);
  await expect(page.locator("#primary-navigation")).toHaveAttribute("aria-hidden", "true");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await navigation().getByRole("button", { name: "Host services recovery" }).click();
  await expect(navigation().locator('[aria-current="location"]')).toHaveText("Host services recovery");
  assert.equal((await offsets()).page, 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  checks.push({ name: "normal-motion article navigation reaches the same current section", state: "PASS" });

  const accessibility = await new AxeBuilder({ page }).include(".documentation-workspace").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  assert.deepEqual(accessibility.violations, [], JSON.stringify(accessibility.violations));
  checks.push({ name: "WCAG A/AA automated documentation checks", state: "PASS" });
  sessionState = "anonymous";
  await page.goto(`${origin}/documentation`);
  await expect(page.getByLabel("Access Key", { exact: true })).toBeVisible();
  await expect(search()).toHaveCount(0); await expect(article()).toHaveCount(0);
  checks.push({ name: "direct Documentation route retains owner authentication", state: "PASS" });
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ state: "PASS", checks, errors, unexpected, limitations: ["Synthetic API fixtures; no production or backend mutations", "Chromium only; no real touch hardware or mobile virtual keyboard", "Guide layout/accessibility checks do not prove file-backup or restore reliability"] }, null, 2));
  console.log(`PASS: ${checks.length} documentation browser checks`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }).catch(() => undefined);
  await fs.writeFile(path.join(output, "result.json"), JSON.stringify({ state: "FAIL", checks, errors, error: String(error) }, null, 2));
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
