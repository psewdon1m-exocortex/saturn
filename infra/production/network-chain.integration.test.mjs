import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

// Explicit, disposable fixture only. Missing infrastructure must fail, never skip.
test('N14 real two-hop current-template ingress and committed mutation is never replayed', { timeout: 120000 }, async () => {
  assert.ok(process.env.NETWORK_CHAIN_FIXTURE, 'NETWORK_CHAIN_FIXTURE manifest is required');
  const manifestPath = resolve(process.env.NETWORK_CHAIN_FIXTURE);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.match(manifest.image, /^nginx@sha256:[a-f0-9]{64}$/);
  assert.match(manifest.runId, /^network-[a-z0-9-]+$/);
  const directory = resolve(manifest.directory);
  assert.ok(directory.includes('network-targeted-validation'), 'own fixture directory required');
  mkdirSync(directory, { recursive: true });
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const network = manifest.runId, rear = `${network}-rear`, front = `${network}-front`;
  const containers = [];
  const seen = [];
  let effects = 0;
  let firstUploadChunk;
  const api = http.createServer(async (req, res) => {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; hash.update(chunk); if (req.url.includes('observe-stream')) firstUploadChunk?.(); }
    seen.push({ method: req.method, path: req.url, bytes, hash: hash.digest('hex'), authorization: req.headers.authorization === 'Bearer fixture-only', condition: req.headers['if-match'], offset: req.headers['upload-offset'], encoding: req.headers['content-encoding'] });
    if (req.url.includes('lost-ack')) { effects++; req.socket.destroy(); return; }
    if (req.url.includes('wait')) await new Promise(r => setTimeout(r, 150));
    const status = Number(new URL(req.url, 'http://fixture').searchParams.get('status') || 200);
    res.writeHead(status, { 'Content-Type': 'application/json', 'ETag': '"fixture-etag"', 'Retry-After': '2', 'Upload-Offset': String(bytes) });
    res.end(JSON.stringify({ code: 'fixture', bytes }));
  });
  const web = http.createServer((_, res) => { res.writeHead(418); res.end('WRONG_WEB_UPSTREAM'); });
  await Promise.all([new Promise(r => api.listen(0, '0.0.0.0', r)), new Promise(r => web.listen(0, '0.0.0.0', r))]);
  const template = readFileSync(new URL('./nginx.saturn.conf.example', import.meta.url), 'utf8');
  assert.ok(template.includes('location ^~ /sync/v1/'), 'missing guarded route is a failure');
  const certificate = join(directory, 'saturn.crt'), key = join(directory, 'saturn.key');
  const openssl = manifest.openssl || 'openssl';
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=drive.replace-me.example', '-addext', 'subjectAltName=DNS:drive.replace-me.example', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
  const ca = readFileSync(certificate);
  try {
    docker('network', 'create', '--label', `network-validation=${network}`, network);
    // Docker's host gateway remains reachable; the fixture's own HTTP ports
    // are the only upstreams, never a production service.
    for (const [name, upstream] of [[rear, `host.docker.internal:${api.address().port}`], [front, `${rear}:443`]]) {
      let config = template.replace('127.0.0.1:3000', upstream).replace('127.0.0.1:8080', `host.docker.internal:${web.address().port}`);
      if (name === front) config = config.replaceAll('proxy_pass http://saturn_api', 'proxy_pass https://saturn_api').replace('proxy_http_version 1.1;', 'proxy_http_version 1.1; proxy_ssl_server_name on; proxy_ssl_name drive.replace-me.example; proxy_ssl_verify on; proxy_ssl_trusted_certificate /etc/nginx/tls/saturn.crt;');
      writeFileSync(join(directory, `${name}.conf`), config);
      docker('run', '-d', '--name', name, '--label', `network-validation=${network}`, '--network', network, '--add-host', `host.docker.internal:${manifest.hostAddress || 'host-gateway'}`, '-p', '127.0.0.1::443', '--mount', `type=bind,source=${directory},target=/etc/nginx/tls,readonly`, '--mount', `type=bind,source=${join(directory, `${name}.conf`)},target=/etc/nginx/conf.d/default.conf,readonly`, manifest.image);
      containers.push(name);
    }
    const port = Number(docker('port', front, '443/tcp').split(':').at(-1));
    const request = (path, method = 'GET', body = Buffer.alloc(0), extra = {}) => new Promise((resolveResponse, reject) => {
      const req = https.request({ host: '127.0.0.1', port, servername: 'drive.replace-me.example', ca, path, method, headers: { Host: 'drive.replace-me.example', Authorization: 'Bearer fixture-only', 'If-Match': '"expected"', 'Upload-Offset': '17', 'Content-Encoding': 'identity', 'Content-Length': body.length, ...extra }, timeout: 10000 }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); res.on('error', reject);
      }); req.on('error', reject); req.on('timeout', () => req.destroy(new Error('fixture request timeout'))); req.end(body);
    });
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) { try { ready = (await request('/sync/v1/ready')).status === 200; } catch {} if (!ready) await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'two-hop fixture must reach API');
    const chunkObserved = new Promise(r => { firstUploadChunk = r; });
    let upload;
    const streamed = new Promise((resolveResponse, reject) => {
      upload = https.request({ host: '127.0.0.1', port, servername: 'drive.replace-me.example', ca, path: '/sync/v1/observe-stream', method: 'PUT', headers: { Host: 'drive.replace-me.example', 'Content-Length': '2048' } }, res => { res.resume(); res.on('end', () => resolveResponse(res.statusCode)); });
      upload.on('error', reject); upload.write(Buffer.alloc(1024));
    });
    try {
      await Promise.race([chunkObserved, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('request buffered before upstream')), 3000); timer.unref(); })]);
      upload.end(Buffer.alloc(1024)); assert.equal(await streamed, 200);
    } catch (error) { upload.destroy(); await streamed.catch(() => {}); throw error; }
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/sync/v1/roots/test/chunk?offset=17', '/api/v1/test?q=a%20b', '/dav/test?q=1']) {
        const body = Buffer.from('wire bytes'); const response = await request(path, method, body);
        assert.equal(response.status, 200); assert.equal(response.headers.etag, '"fixture-etag"'); assert.equal(response.headers['retry-after'], '2');
        const last = seen.at(-1); assert.equal(last.path, path); assert.equal(last.method, method); assert.equal(last.hash, createHash('sha256').update(body).digest('hex'));
        assert.ok(last.authorization); assert.equal(last.condition, '"expected"'); assert.equal(last.offset, '17'); assert.equal(last.encoding, 'identity');
      }
    }
    for (const status of [401, 403, 407, 409, 429, 503]) {
      const response = await request(`/sync/v1/error?status=${status}`);
      assert.equal(response.status, status); assert.deepEqual(JSON.parse(response.body), { code: 'fixture', bytes: 0 }); assert.equal(response.headers['retry-after'], '2');
    }
    const metadata = JSON.stringify({ fixture: 'x'.repeat(4 * 1024 * 1024 - 14) });
    assert.equal(Buffer.byteLength(metadata), 4 * 1024 * 1024);
    const nearLimit = Buffer.concat([
      Buffer.from('--fixture\r\nContent-Type: application/json\r\n\r\n' + metadata + '\r\n'),
      Buffer.from('--fixture\r\nContent-Type: application/octet-stream\r\n\r\n'),
      Buffer.alloc(32 * 1024 * 1024, 42), Buffer.from('\r\n--fixture--\r\n'),
    ]);
    assert.equal((await request('/sync/v1/roots/test/small-batches/data', 'POST', nearLimit, { 'Content-Type': 'multipart/related; boundary=fixture' })).status, 200);
    assert.equal(seen.at(-1).bytes, nearLimit.length);
    const before = seen.length;
    assert.equal((await request('/sync/v1/too-large', 'POST', Buffer.alloc(0), { 'Content-Length': 40 * 1024 * 1024 + 1 })).status, 413);
    assert.equal(seen.length, before, 'oversized body reached the API');
    const lost = await request('/sync/v1/lost-ack', 'POST', Buffer.from('original'));
    assert.equal(lost.status, 502); assert.equal(effects, 1, 'proxy replayed a committed mutation');
    assert.equal((await request('/sync/v1/wait')).status, 200);
    const version = docker('exec', front, 'sh', '-c', 'nginx -v 2>&1');
    assert.ok(version.includes(manifest.version), 'manifest version does not match pinned runtime');
    writeFileSync(join(directory, 'trace.json'), JSON.stringify({ image: manifest.image, version, templateSha256: createHash('sha256').update(template).digest('hex'), effects, seen }, null, 2));
  } finally {
    for (const name of containers.reverse()) { try { writeFileSync(join(directory, `${name}.log`), docker('logs', name)); } catch {} try { docker('rm', '-f', name); } catch {} }
    try { docker('network', 'rm', network); } catch {}
    api.closeAllConnections(); web.closeAllConnections(); await Promise.all([new Promise(r => api.close(r)), new Promise(r => web.close(r))]);
  }
});
