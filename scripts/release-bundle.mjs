import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import archiver from "archiver";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = await import(pathToFileURL(path.join(root, "packages", "deployment", "dist", "index.js")));
const [command, ...args] = process.argv.slice(2);
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function collectFiles(sourceDirectory, archiveDirectory) {
  const collected = [];
  async function visit(relativeDirectory) {
    const directory = path.join(sourceDirectory, relativeDirectory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      const source = path.join(sourceDirectory, relative);
      if (entry.isSymbolicLink()) throw new Error(`Updater bundle contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) collected.push({ source, name: path.posix.join(archiveDirectory, relative.replaceAll("\\", "/")) });
      else throw new Error(`Updater bundle contains an unsupported member: ${relative}`);
    }
  }
  await visit("");
  return collected;
}

async function archive(files, updaterDirectory, output) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const handle = await fs.open(output, "w", 0o600);
  const stream = handle.createWriteStream();
  const zip = archiver("zip", { zlib: { level: 9 } });
  const complete = new Promise((resolve, reject) => {
    stream.once("close", resolve);
    stream.once("error", reject);
    zip.once("error", reject);
  });
  zip.pipe(stream);
  const entries = [
    ...files.map((file) => ({ source: path.join(root, file), name: file.replaceAll("\\", "/") })),
    ...(await collectFiles(updaterDirectory, "updater")),
  ];
  for (const entry of entries) {
    const bytes = await fs.readFile(entry.source);
    const executable = entry.name.endsWith(".sh") || entry.name.endsWith("/updater-linux-amd64");
    zip.append(bytes, { name: entry.name, date: new Date(0), mode: executable ? 0o700 : 0o600 });
  }
  await zip.finalize();
  await complete;
  await handle.close().catch(() => undefined);
}

if (command === "build") {
  const [version, sourceRevision, appImage, webImage, privateKeyFile, outputArgument] = args;
  if ([version, sourceRevision, appImage, webImage, privateKeyFile, outputArgument].some((value) => value === undefined)) {
    throw new Error("Usage: release-bundle.mjs build <version> <source-revision> <app-image@digest> <web-image@digest> <private-key.pem> <output-dir>");
  }
  const bundleUrl = process.env.VAULT_BUNDLE_URL;
  const updaterDirectoryValue = process.env.UPDATER_BUNDLE_DIR;
  const updaterVersion = process.env.UPDATER_BUNDLE_VERSION;
  if (bundleUrl === undefined) throw new Error("VAULT_BUNDLE_URL is required");
  if (updaterDirectoryValue === undefined || updaterVersion === undefined) throw new Error("UPDATER_BUNDLE_DIR and UPDATER_BUNDLE_VERSION are required");
  const pinnedUpdaterVersion = (await fs.readFile(path.join(root, ".release", "updater.version"), "utf8")).trim();
  if (updaterVersion !== pinnedUpdaterVersion) throw new Error(`Updater bundle version ${updaterVersion} does not match pin ${pinnedUpdaterVersion}`);
  const updaterDirectory = path.resolve(updaterDirectoryValue);
  for (const required of ["install.sh", "updater-linux-amd64", "systemd/updater.service"]) {
    const attributes = await fs.stat(path.join(updaterDirectory, required)).catch(() => undefined);
    if (!attributes?.isFile()) throw new Error(`Verified Updater install bundle is missing ${required}`);
  }

  const output = path.resolve(outputArgument);
  const pnpm = path.join(root, "node_modules", "pnpm", "bin", "pnpm.cjs");
  const licenses = spawnSync(process.execPath, [pnpm, "licenses", "list", "--prod", "--json"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (licenses.status !== 0) throw new Error("SBOM dependency inventory failed");
  const sbomBytes = Buffer.from(licenses.stdout);
  const sbomPath = path.join(output, `vault-${version}.sbom.json`);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(sbomPath, sbomBytes, { mode: 0o600 });
  const bundlePath = path.join(output, `vault-${version}.zip`);
  await archive([
    "compose.production.yaml",
    "infra/production/Caddyfile",
    "infra/production/.env.production.example",
    "infra/production/bootstrap.sh",
    "infra/production/install.sh",
    "infra/production/bot-policy.yaml",
    "docs/implementation/STAGE_13_PRODUCTION_HARDENING_DEPLOYMENT.md",
    "docs/implementation/OPERATIONS.md",
    ".release/updater.version",
  ], updaterDirectory, bundlePath);
  const bundle = await fs.readFile(bundlePath);
  const payload = {
    schema: "vault.release-manifest.v1",
    componentRole: "vault-gateway",
    version,
    sourceRevision,
    createdAt: new Date().toISOString(),
    databaseSchemaGeneration: 14,
    minimumInstallerVersion: "1.0.0",
    bundle: { url: bundleUrl, sha256: sha(bundle), bytes: bundle.length },
    sbom: { sha256: sha(sbomBytes), format: "pnpm-licenses-json" },
    images: { app: appImage, web: webImage },
  };
  const signed = deployment.signReleaseManifest(payload, await fs.readFile(path.resolve(privateKeyFile), "utf8"));
  const manifestPath = path.join(output, "release-manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(signed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(`${bundlePath}.sha256`, `${payload.bundle.sha256.slice(7)}  ${path.basename(bundlePath)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ state: "built", manifest: manifestPath, bundle: bundlePath, bundleSha256: payload.bundle.sha256, sbomSha256: payload.sbom.sha256, updaterVersion })}\n`);
} else if (command === "verify") {
  const [manifestArgument, publicKeyArgument, bundleArgument, sbomArgument] = args;
  if ([manifestArgument, publicKeyArgument, bundleArgument, sbomArgument].some((value) => value === undefined)) {
    throw new Error("Usage: release-bundle.mjs verify <manifest> <public-key.pem> <bundle> <sbom>");
  }
  const manifest = JSON.parse(await fs.readFile(path.resolve(manifestArgument), "utf8"));
  const payload = deployment.verifyReleaseManifest(manifest, await fs.readFile(path.resolve(publicKeyArgument), "utf8"));
  const bundle = await fs.readFile(path.resolve(bundleArgument));
  const sbom = await fs.readFile(path.resolve(sbomArgument));
  if (sha(bundle) !== payload.bundle.sha256 || bundle.length !== payload.bundle.bytes || sha(sbom) !== payload.sbom.sha256) {
    throw new Error("Release bundle or SBOM digest mismatch");
  }
  process.stdout.write(`${JSON.stringify({ state: "verified", version: payload.version, bundleSha256: payload.bundle.sha256, images: payload.images })}\n`);
} else {
  throw new Error("Usage: release-bundle.mjs build | verify");
}
