import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const config = await fs.readFile(new URL("./nginx.saturn.conf.example", import.meta.url), "utf8");
const environment = await fs.readFile(new URL("./.env.production.example", import.meta.url), "utf8");
const bootstrap = await fs.readFile(new URL("./bootstrap.sh", import.meta.url), "utf8");
const installer = await fs.readFile(new URL("./install.sh", import.meta.url), "utf8");
const compose = await fs.readFile(new URL("../../compose.production.yaml", import.meta.url), "utf8");
const releaseWorkflow = await fs.readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");

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

test("public appearance exposes only the explicit accent endpoint", () => {
  const appearance = locationBody(/location = \/api\/v1\/auth\/public-appearance \{([\s\S]*?)\n    \}/);
  assert.match(appearance, /proxy_pass http:\/\/saturn_api;/);
  assert.doesNotMatch(appearance, /\b(?:allow|deny)\b/);
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
  assert.match(config, /listen 443 ssl http2;/);
  assert.match(config, /listen \[::\]:443 ssl http2;/);
  assert.doesNotMatch(config, /^\s*http2 on;/m);
});

test("operator input is limited to the login, origin, Kernel and production storage", () => {
  const operatorSection = environment.split("# RELEASE LOCK")[0];
  assert.match(operatorSection, /^VAULT_DOMAIN=drive\.replace-me\.example$/m);
  assert.match(operatorSection, /^PUBLIC_ORIGIN=https:\/\/drive\.replace-me\.example$/m);
  assert.match(operatorSection, /^OWNER_ACCESS_KEY=replace-me-with-owner-access-key$/m);
  assert.deepEqual(
    operatorSection.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).map((line) => line.split("=", 1)[0]),
    ["VAULT_DOMAIN", "PUBLIC_ORIGIN", "OWNER_ACCESS_KEY", "KERNEL_URL", "KERNEL_SERVICE_TOKEN", "STORAGE_HOST", "STORAGE_PORT", "STORAGE_USER", "STORAGE_ROOT", "STORAGE_HOST_FINGERPRINT"],
  );
  assert.doesNotMatch(environment, /VAULT_DEV_STORAGE_|VAULT_SECOND_COPY_ID/);
});

test("installer prepares independent runtime secrets and a dedicated SFTP key", () => {
  assert.match(installer, /for name in database_password auth_pepper drop_pepper share_pepper device_pepper backup_pepper laboratory_pepper/);
  assert.match(installer, /sync_owner_access_key/);
  assert.match(installer, /LEGACY_STORAGE_KEY=\/root\/saturn-storage-ed25519/);
  assert.match(installer, /ssh-keygen -q -t ed25519 .*saturn-production-storage/);
  assert.match(installer, /STORAGE_PUBLIC_KEY=\/etc\/vault\/storage_public_key\.pub/);
  assert.match(installer, /STORAGE_PUBLIC_KEY_RFC4716=\/etc\/vault\/storage_public_key\.rfc4716\.pub/);
  assert.match(installer, /ssh-keygen -e -m RFC4716/);
  assert.match(compose, /\$\{VAULT_RUNTIME_ENV_FILE:-\.\/infra\/production\/\.env\.production\}/);
  assert.match(environment, /^VAULT_RUNTIME_ENV_FILE=\/etc\/vault\/\.env\.production$/m);
  assert.match(installer, /set_config VAULT_RUNTIME_ENV_FILE "\$CONFIG_FILE"/);
  assert.match(installer, /docker run --rm --user 0:0 --network none --read-only --security-opt no-new-privileges --cap-drop ALL/);
  assert.match(installer, /refresh_runtime_secrets/);
  assert.match(installer, /sync_gryphon_validation_secret/);
  assert.match(installer, /install -o root -g root -m 0600 "\$source_file" "\$GRYPHON_VALIDATION_SECRET"/);
  assert.match(installer, /for service in updater neptune gryphon/);
  assert.match(installer, /release-trust\/\$service\.pem/);
  assert.match(installer, /set_config NEPTUNE_CONTROL_TOKEN_FILE \/run\/neptune-control\.token/);
  assert.match(installer, /set_config NEPTUNE_EXPORT_TOKEN_FILE \/run\/neptune-export\.token/);
  assert.match(bootstrap, /for service in updater neptune gryphon/);
  assert.match(bootstrap, /release-trust\/\$service\.pem/);
  assert.match(installer, /bootstrap-credentials\/saturn\.env/);
  assert.match(installer, /stat -c '%u:%a'/);
  assert.match(installer, /rm -f "\$credential_file"/);
  assert.doesNotMatch(installer, /\/opt\/exocortex\/kernel\/\.env/);
  assert.doesNotMatch(installer, /copy_local_kernel_bootstrap/);
  assert.match(compose, /^  secret-runtime-init:$/m);
  assert.match(compose, /runtime_secrets:\/run\/secrets:ro/);
  assert.match(compose, /^  runtime_secrets:$/m);
  assert.doesNotMatch(compose, /uid: "1000"|gid: "1000"/);
  assert.match(compose, /OWNER_ACCESS_KEY: ""/);
  assert.match(compose, /KERNEL_SERVICE_TOKEN: ""/);
  assert.match(environment, /^KERNEL_TOKEN_FILE=\/run\/secrets\/kernel_service_token$/m);
  assert.match(installer, /validate_kernel_service_token/);
  assert.match(compose, /migrate-production-runtime\.mjs/);
  assert.match(compose, /KERNEL_TOKEN_FILE: "\$\{KERNEL_TOKEN_FILE:-\/run\/secrets\/kernel_service_token\}"/);
  assert.match(environment, /^NEPTUNE_CONTROL_TOKEN_FILE=\/run\/neptune-control\.token$/m);
  assert.match(environment, /^NEPTUNE_EXPORT_TOKEN_FILE=\/run\/neptune-export\.token$/m);
  assert.match(compose, /target: \/run\/neptune-control\.token/);
  assert.match(compose, /target: \/run\/neptune-export\.token/);
  assert.doesNotMatch(compose, /target: \/run\/secrets\/neptune-(?:control|export)\.token/);
  assert.doesNotMatch(installer, /release-public-key\.pem[^\n]*storage_private_key/);
});

test("storage clients have public egress and web has a dedicated host-publish network", () => {
  const sharedApplicationConfig = compose.match(/^x-vault-environment:[\s\S]*?(?=^services:)/m)?.[0] ?? "";
  const apiConfig = compose.match(/^  api:[\s\S]*?(?=^  web:)/m)?.[0] ?? "";
  const postgresConfig = compose.match(/^  postgres:[\s\S]*?(?=^  migrate:)/m)?.[0] ?? "";
  const webConfig = compose.match(/^  web:[\s\S]*?(?=^volumes:)/m)?.[0] ?? "";

  assert.match(sharedApplicationConfig, /^    - backend$/m);
  assert.match(sharedApplicationConfig, /^    - storage-egress$/m);
  assert.match(apiConfig, /^      storage-egress:$/m);
  assert.match(compose, /^  backend:\n    internal: true$/m);
  assert.match(compose, /^  storage-egress:\n    driver: bridge$/m);
  assert.match(webConfig, /^      host-publish:$/m);
  assert.match(compose, /^  host-publish:\n    driver: bridge$/m);
  assert.doesNotMatch(postgresConfig, /storage-egress/);
  assert.doesNotMatch(webConfig, /storage-egress/);
});

test("verified bootstrap writes release locks and can refresh a prepared 0.1.4 bundle", () => {
  assert.match(bootstrap, /SATURN_BOOTSTRAP_RELEASE_VERSION/);
  assert.match(bootstrap, /SATURN_BOOTSTRAP_APP_IMAGE/);
  assert.match(bootstrap, /SATURN_BOOTSTRAP_WEB_IMAGE/);
  assert.match(bootstrap, /--refresh/);
  assert.match(bootstrap, /Previous prepared bundle preserved/);
});

test("clean-host bootstrap pins both Saturn public release keys", () => {
  assert.match(bootstrap, /SATURN_EXACT_RELEASE_VERSION="__SATURN_BOOTSTRAP_RELEASE_VERSION__"/);
  assert.match(bootstrap, /SATURN_ED25519_PUBLIC_KEY_B64="__SATURN_BOOTSTRAP_ED25519_PUBLIC_KEY_BASE64__"/);
  assert.match(bootstrap, /SATURN_RSA_PUBLIC_KEY_B64="__SATURN_BOOTSTRAP_RSA_PUBLIC_KEY_BASE64__"/);
  assert.doesNotMatch(bootstrap, /api\.github\.com\/repos/);
  assert.doesNotMatch(bootstrap, /release_base\/saturn\.pem/);
  assert.match(bootstrap, /installed Saturn Ed25519 release key differs from this release/);
  assert.match(bootstrap, /installed Saturn RSA release key differs from this release/);
  assert.match(releaseWorkflow, /openssl pkey .*saturn-ed25519\.pem/);
  assert.match(releaseWorkflow, /--export-public-key artifacts\/release\/saturn\.pem/);
  assert.match(releaseWorkflow, /build-bootstrap\.mjs/);
});
