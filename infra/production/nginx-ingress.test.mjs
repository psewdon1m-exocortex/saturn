import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const config = await fs.readFile(new URL("./nginx.saturn.conf.example", import.meta.url), "utf8");
const environment = await fs.readFile(new URL("./.env.production.example", import.meta.url), "utf8");

function locationBody(pattern) {
  const match = config.match(pattern);
  assert.ok(match, `missing Nginx location matching ${String(pattern)}`);
  return match[1];
}

test("owner UI and API use the public-authenticated ingress profile", () => {
  const ownerApi = locationBody(/location \/api\/ \{([\s\S]*?)\n    \}/);
  const ownerUi = locationBody(/location \/ \{([\s\S]*?)\n    \}/);
  assert.doesNotMatch(ownerApi, /\b(?:allow|deny)\b/);
  assert.doesNotMatch(ownerUi, /\b(?:allow|deny)\b/);
  assert.match(ownerApi, /proxy_pass http:\/\/saturn_api;/);
  assert.match(ownerUi, /proxy_pass http:\/\/saturn_web;/);
});

test("health remains host-local and unknown TLS SNI fails closed", () => {
  for (const route of ["live", "ready"]) {
    const body = locationBody(new RegExp(`location = /health/${route} \\{([\\s\\S]*?)\\n    \\}`));
    assert.match(body, /allow 127\.0\.0\.1;/);
    assert.match(body, /allow ::1;/);
    assert.match(body, /deny all;/);
  }
  assert.match(config, /listen 443 ssl default_server;/);
  assert.match(config, /ssl_reject_handshake on;/);
});

test("canonical public origin is an explicit operator input", () => {
  const operatorSection = environment.split("# RELEASE LOCK")[0];
  assert.match(operatorSection, /^VAULT_DOMAIN=drive\.replace-me\.example$/m);
  assert.match(operatorSection, /^PUBLIC_ORIGIN=https:\/\/drive\.replace-me\.example$/m);
});
