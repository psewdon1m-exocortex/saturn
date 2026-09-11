import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStaticServer } from "./static-server.mjs";

test("serves only the Saturn SPA allow-list and immutable assets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-static-"));
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "index.html"), "saturn-index");
  await fs.writeFile(path.join(root, "robots.txt"), "User-agent: *\nDisallow: /\n");
  await fs.writeFile(path.join(root, "assets", "app-abc.js"), "console.log('saturn')");
  await fs.writeFile(path.join(root, "assets", "app.js.map"), "secret-source-map");
  const server = createStaticServer({ root });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert(address !== null && typeof address === "object");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const spa = await fetch(`${origin}/files/archive/photos`);
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), "saturn-index");
    assert.equal(spa.headers.get("cache-control"), "private, no-store");
    assert.match(spa.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const asset = await fetch(`${origin}/assets/app-abc.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(await asset.text(), "console.log('saturn')");
    assert.equal((await fetch(`${origin}/assets/app.js.map`)).status, 404);
    assert.equal((await fetch(`${origin}/.env`)).status, 404);
    assert.equal((await fetch(`${origin}/unknown`)).status, 404);
    assert.equal((await fetch(`${origin}/health/live`)).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
