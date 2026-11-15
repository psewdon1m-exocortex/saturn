import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createStaticServer } from './static-server.mjs';

test('only the existing exact upload hash worker gets WASM permission, including HEAD and malformed paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'saturn-upload-csp-'));
  const server = createStaticServer({ root });
  const asset = '/assets/upload-sha256.worker-Ab12_C-9.js';
  try {
    await fs.mkdir(path.join(root, 'assets'));
    await fs.writeFile(path.join(root, 'index.html'), '<p>test</p>');
    await fs.writeFile(path.join(root, asset), 'self.postMessage("fixture");');
    await fs.writeFile(path.join(root, 'assets/other-worker-Ab12_C-9.js'), 'self.postMessage("other");');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert(address && typeof address === 'object');
    const request = (url, method = 'GET') => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: address.port, path: url, method }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      }); req.on('error', reject); req.end();
    });
    for (const method of ['GET', 'HEAD']) {
      const reply = await request(asset, method);
      assert.equal(reply.status, 200); assert.match(reply.headers['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval'/);
      assert.doesNotMatch(reply.headers['content-security-policy'], /'unsafe-eval'/);
      assert.match(reply.headers['cache-control'], /immutable/); assert.match(reply.headers['content-type'], /javascript/);
      if (method === 'HEAD') assert.equal(reply.body, '');
    }
    for (const url of ['/', '/dashboard', '/assets/other-worker-Ab12_C-9.js', asset + '?x=1', asset + '.extra', '/assets/upload-sha256.worker-aaaaaaaa.js', '/assets/upload-sha256%2eworker-Ab12_C-9.js', '/assets/../assets/upload-sha256.worker-Ab12_C-9.js', '/assets/%ZZ', '/assets/upload-sha256.worker-short.js']) {
      const reply = await request(url);
      assert.doesNotMatch(reply.headers['content-security-policy'], /wasm-unsafe-eval|(?<!wasm-)'unsafe-eval'/, url);
    }
    assert.equal((await request('/assets/upload-sha256.worker-aaaaaaaa.js')).status, 404);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // Exact fixture returned by mkdtemp, never a user-supplied or computed root.
    assert(root.startsWith(path.join(os.tmpdir(), 'saturn-upload-csp-')));
    await fs.rm(root, { recursive: true });
  }
});
