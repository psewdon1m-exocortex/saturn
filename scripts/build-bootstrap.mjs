import { createPublicKey } from "node:crypto";
import fs from "node:fs";

const [templatePath, ed25519Path, rsaPath, outputPath, version] = process.argv.slice(2);
if (!templatePath || !ed25519Path || !rsaPath || !outputPath || !/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Usage: build-bootstrap.mjs <template> <ed25519.pem> <rsa.pem> <output> <version>");
const edPem = fs.readFileSync(ed25519Path, "utf8");
const rsaPem = fs.readFileSync(rsaPath, "utf8");
const edKey = createPublicKey(edPem);
const rsaKey = createPublicKey(rsaPem);
if (edKey.asymmetricKeyType !== "ed25519") throw new Error("Saturn bootstrap requires Ed25519 installer trust");
if (rsaKey.asymmetricKeyType !== "rsa" || (rsaKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) throw new Error("Saturn bootstrap requires RSA-3072 updater trust");
if (/PRIVATE KEY/.test(edPem + rsaPem)) throw new Error("Refusing to embed private key material");
const template = fs.readFileSync(templatePath, "utf8");
const replacements = new Map([
  ["__SATURN_BOOTSTRAP_RELEASE_VERSION__", version],
  ["__SATURN_BOOTSTRAP_ED25519_PUBLIC_KEY_BASE64__", Buffer.from(edPem).toString("base64")],
  ["__SATURN_BOOTSTRAP_RSA_PUBLIC_KEY_BASE64__", Buffer.from(rsaPem).toString("base64")],
]);
let output = template;
for (const [placeholder, value] of replacements) {
  if (output.split(placeholder).length !== 2) throw new Error(`Expected exactly one ${placeholder}`);
  output = output.replace(placeholder, value);
}
if (output.includes("__SATURN_BOOTSTRAP_") || /PRIVATE KEY/.test(output)) throw new Error("Unsafe generated bootstrap");
fs.writeFileSync(outputPath, output, { mode: 0o755 });
