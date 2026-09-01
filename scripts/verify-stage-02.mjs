import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareDevelopmentEnvironment } from "./prepare-dev.mjs";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(vaultRoot, "artifacts", "verification", "stage-02-foundation.json");
const pnpmScript = path.join(vaultRoot, "node_modules", "pnpm", "bin", "pnpm.cjs");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const report = { schema: "vault.stage-verification.v1", stage: 2, startedAt: new Date().toISOString(), success: false, checks: [] };
const children = [];

function pass(name, detail = {}) {
  report.checks.push({ name, status: "pass", detail });
  process.stdout.write(`PASS ${name}\n`);
}

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd: vaultRoot,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-2_000);
    throw new Error(`${path.basename(command)} ${args.join(" ")} failed: ${output}`);
  }
  return result.stdout.trim();
}

async function waitForResponse(url, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const body = await response.json();
      last = { status: response.status, body };
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${JSON.stringify(last)}`);
}

function startArtifact(relativePath, environment) {
  const child = spawn(process.execPath, [path.join(vaultRoot, relativePath)], {
    cwd: vaultRoot,
    env: environment,
    windowsHide: true,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function listTextFiles(root) {
  const files = [];
  const excludedDirectories = new Set([".git", ".pnpm-store", ".secrets", ".tmp", "artifacts", "data", "node_modules"]);
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (/\.(?:c?js|mjs|ts|tsx|json|ya?ml|md|html|css|map|sql)$/i.test(entry.name)) files.push(target);
    }
  };
  await visit(root);
  return files;
}

async function assertNoSecretLeak() {
  const secretFiles = [
    path.join(vaultRoot, "docs", "server_password.txt"),
    path.join(vaultRoot, ".secrets", "dev-postgres-password"),
    path.join(vaultRoot, ".secrets", "dev-owner-bootstrap-token"),
    path.join(vaultRoot, ".tmp", "sftp", "dev_client_ed25519"),
    path.join(vaultRoot, ".tmp", "sftp", "ssh_host_ed25519_key"),
  ];
  const needles = [];
  for (const file of secretFiles) {
    try {
      const value = (await fs.readFile(file, "utf8")).trim();
      if (value.length >= 16) needles.push(value);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  let scanned = 0;
  for (const file of await listTextFiles(vaultRoot)) {
    if (path.resolve(file) === path.resolve(path.join(vaultRoot, "docs", "server_password.txt"))) continue;
    const stat = await fs.stat(file);
    if (stat.size > 5 * 1024 * 1024) continue;
    const content = await fs.readFile(file, "utf8");
    if (needles.some((needle) => content.includes(needle))) {
      throw new Error(`Exact secret value leaked into ${path.relative(vaultRoot, file)}`);
    }
    scanned += 1;
  }
  return { files: scanned, exactSecrets: needles.length };
}

let environment = process.env;
try {
  run(process.execPath, [pnpmScript, "install", "--frozen-lockfile"]);
  pass("frozen-install");
  for (const script of ["lint", "typecheck", "test", "build"]) {
    run(process.execPath, [pnpmScript, script]);
    pass(script);
  }
  const prepared = await prepareDevelopmentEnvironment();
  environment = { ...process.env, ...prepared.environment };
  run(docker, ["compose", "-p", "vault-dev", "config", "--quiet"], environment);
  pass("compose-config");
  run(docker, ["compose", "-p", "vault-dev", "up", "-d", "--wait"], environment);
  pass("infrastructure-health");
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"], environment);
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "rollback"], environment);
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"], environment);
  pass("migration-roundtrip");

  const api = startArtifact("apps/api/dist/main.js", environment);
  const worker = startArtifact("apps/worker/dist/main.js", environment);
  await waitForResponse("http://127.0.0.1:3000/health/ready", (result) => result.status === 200);
  await waitForResponse("http://127.0.0.1:3001/health/ready", (result) => result.status === 200);
  pass("production-artifact-readiness");

  run(docker, ["compose", "-p", "vault-dev", "stop", "sftp"], environment);
  const apiStorageDown = await waitForResponse("http://127.0.0.1:3000/health/ready", (result) => result.status === 503);
  const workerStorageDown = await waitForResponse("http://127.0.0.1:3001/health/ready", (result) => result.status === 503);
  if (apiStorageDown.body.checks.storage?.detail !== "storage_unavailable"
      || workerStorageDown.body.checks.storage?.detail !== "storage_unavailable") {
    throw new Error("Storage failure was not classified correctly");
  }
  await waitForResponse("http://127.0.0.1:3000/health/live", (result) => result.status === 200);
  await waitForResponse("http://127.0.0.1:3001/health/live", (result) => result.status === 200);
  run(docker, ["compose", "-p", "vault-dev", "up", "-d", "--wait", "sftp"], environment);
  pass("storage-failure-and-recovery");

  run(docker, ["compose", "-p", "vault-dev", "stop", "postgres"], environment);
  const apiDatabaseDown = await waitForResponse("http://127.0.0.1:3000/health/ready", (result) => result.status === 503);
  const workerDatabaseDown = await waitForResponse("http://127.0.0.1:3001/health/ready", (result) => result.status === 503);
  if (apiDatabaseDown.body.checks.database?.detail !== "database_unavailable"
      || workerDatabaseDown.body.checks.database?.detail !== "database_unavailable") {
    throw new Error("Database failure was not classified correctly");
  }
  await waitForResponse("http://127.0.0.1:3000/health/live", (result) => result.status === 200);
  await waitForResponse("http://127.0.0.1:3001/health/live", (result) => result.status === 200);
  run(docker, ["compose", "-p", "vault-dev", "up", "-d", "--wait", "postgres"], environment);
  run(process.execPath, [pnpmScript, "--filter", "@saturn/database", "migrate"], environment);
  await waitForResponse("http://127.0.0.1:3000/health/ready", (result) => result.status === 200);
  pass("database-failure-and-recovery");

  const webIndex = await fs.readFile(path.join(vaultRoot, "apps", "web", "dist", "index.html"), "utf8");
  if (!webIndex.includes("noindex,nofollow,noarchive")) throw new Error("Web artifact lacks private noindex policy");
  pass("web-private-artifact");
  pass("secret-scan", await assertNoSecretLeak());
  await Promise.all([stopChild(api), stopChild(worker)]);
  report.success = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message.slice(0, 2_000) };
  process.exitCode = 1;
} finally {
  await Promise.all(children.map(stopChild));
  try { run(docker, ["compose", "-p", "vault-dev", "down", "--remove-orphans"], environment); }
  catch (error) {
    report.cleanupFailure = error.message.slice(0, 500);
    report.success = false;
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ stage: 2, result: report.success ? "PASS" : "FAIL", checks: report.checks.length })}\n`);
}
