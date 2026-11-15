import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { prepareBrowserTrust } from "./stage13-trust.mjs";

export async function verifyBrowser(origin, root, caFile) {
  const temporary = path.join(root, "browser-tmp");
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  const environment = { ...await prepareBrowserTrust(root, caFile), TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  // This module runs in its own bounded helper/container, so Playwright's
  // parent-side temporary paths and Chromium's child-side paths are both owned.
  Object.assign(process.env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary });
  const context = await chromium.launchPersistentContext(path.join(root, "browser-profile"), { headless: true, env: environment, viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    const response = await page.goto(origin, { waitUntil: "networkidle", timeout: 60_000 });
    if (response?.status() !== 200 || await page.getByLabel("Access Key").count() !== 1 || await page.evaluate(() => localStorage.length + sessionStorage.length) !== 0) throw new Error("Production web entry boundary failed");
    const imageLoaded = await page.locator(".login-brand__icon img").evaluate(async (image) => { await image.decode(); return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0; });
    if (!imageLoaded) throw new Error("Production login brand image failed to load");
    return { entryStatus: 200, accessKeyFields: 1, browserStorage: 0, brandImage: "decoded", trust: "owned NSS CA; Chromium normal certificate verification" };
  } finally { await context.close(); }
}
if (process.argv[1] && path.basename(process.argv[1]) === "stage13-browser.mjs") {
  const root = process.env.STAGE13_BROWSER_ROOT ?? await fs.mkdtemp(path.join(os.tmpdir(), "stage13-browser-"));
  const result = await verifyBrowser(process.env.STAGE13_BROWSER_ORIGIN, root, process.env.STAGE13_BROWSER_CA);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
