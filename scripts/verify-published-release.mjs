import { constants, createHash, createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedNames = (version) => [
  "bootstrap.sh",
  "release-manifest.json",
  `saturn-${version}.sbom.json`,
  `saturn-${version}.zip`,
  `saturn-${version}.zip.sha256`,
  "saturn-ed25519.pem",
  "saturn-release.json",
  "saturn-release.json.sig.json",
  "saturn.pem",
].sort();

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyRsaManifest(manifest, signatureDocument, publicKeyBytes) {
  const signature = JSON.parse(signatureDocument.toString("utf8"));
  if (signature.schema !== "exocortex.release-signature.v1" || signature.algorithm !== "RSA-PSS-SHA256") {
    throw new Error("Published RSA signature metadata is invalid");
  }
  const publicKey = createPublicKey(publicKeyBytes);
  const keyId = sha256(publicKey.export({ type: "spki", format: "der" }));
  if (signature.key_id !== keyId) throw new Error("Published RSA signature key ID mismatch");
  const valid = verify("sha256", manifest, {
    key: publicKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  }, Buffer.from(signature.signature, "base64"));
  if (!valid) throw new Error("Published RSA signature verification failed");
}

async function fetchResponse(url, attempts = 6) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "saturn-release-verifier" },
        redirect: "follow",
      });
      if (response.ok) return response;
      failure = new Error(`Anonymous release request failed with ${response.status}: ${url}`);
    } catch (error) {
      failure = error;
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  throw failure;
}

async function json(url) {
  return (await fetchResponse(url)).json();
}

async function resolveTagCommit(apiRoot, tag) {
  const reference = await json(`${apiRoot}/git/ref/tags/${encodeURIComponent(tag)}`);
  let object = reference.object;
  for (let depth = 0; depth < 4 && object.type === "tag"; depth += 1) {
    object = (await json(`${apiRoot}/git/tags/${object.sha}`)).object;
  }
  if (object.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error("Release tag does not resolve to a commit");
  return object.sha;
}

async function main() {
  const [sourceArgument] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const tag = process.env.GITHUB_REF_NAME;
  const revision = process.env.GITHUB_SHA;
  const version = process.env.RELEASE_VERSION;
  if (!sourceArgument || !repository || !tag || !revision || !version) {
    throw new Error("Usage requires <local-release-dir> plus GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SHA and RELEASE_VERSION");
  }
  if (tag !== `saturn-v${version}`) throw new Error("Release tag/version mismatch");
  const source = path.resolve(sourceArgument);
  const apiRoot = `https://api.github.com/repos/${repository}`;
  const tagCommit = await resolveTagCommit(apiRoot, tag);
  const mainCommit = (await json(`${apiRoot}/git/ref/heads/main`)).object.sha;
  if (tagCommit !== revision || mainCommit !== revision) throw new Error("Published tag, candidate revision and current main must match exactly");

  const release = await json(`${apiRoot}/releases/tags/${encodeURIComponent(tag)}`);
  if (release.draft || !release.prerelease || release.tag_name !== tag) throw new Error("Candidate release must be a visible prerelease before final qualification");
  const expected = expectedNames(version);
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  if (JSON.stringify([...assets.keys()].sort()) !== JSON.stringify(expected)) throw new Error("Published release asset inventory mismatch");

  const download = path.join(root, ".release-evidence", "published");
  await fs.rm(download, { recursive: true, force: true });
  await fs.mkdir(download, { recursive: true });
  for (const name of expected) {
    const local = await fs.readFile(path.join(source, name));
    const response = await fetchResponse(assets.get(name).browser_download_url);
    const remote = Buffer.from(await response.arrayBuffer());
    if (remote.length !== local.length || sha256(remote) !== sha256(local)) throw new Error(`Published asset bytes differ from the signed candidate: ${name}`);
    await fs.writeFile(path.join(download, name), remote);
  }

  const zipName = `saturn-${version}.zip`;
  const checksum = (await fs.readFile(path.join(download, `${zipName}.sha256`), "utf8")).trim();
  if (checksum !== `${sha256(await fs.readFile(path.join(download, zipName)))}  ${zipName}`) throw new Error("Published ZIP checksum file mismatch");
  verifyRsaManifest(
    await fs.readFile(path.join(download, "saturn-release.json")),
    await fs.readFile(path.join(download, "saturn-release.json.sig.json")),
    await fs.readFile(path.join(download, "saturn.pem")),
  );
  const bundleVerification = spawnSync(process.execPath, [
    path.join(root, "scripts", "release-bundle.mjs"),
    "verify",
    path.join(download, "release-manifest.json"),
    path.join(download, "saturn-ed25519.pem"),
    path.join(download, zipName),
    path.join(download, `saturn-${version}.sbom.json`),
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (bundleVerification.status !== 0) throw new Error(`Published signed bundle verification failed: ${bundleVerification.stderr || bundleVerification.stdout}`);
  process.stdout.write(`${JSON.stringify({ state: "verified", tag, revision, assets: expected, anonymous: true })}\n`);
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
