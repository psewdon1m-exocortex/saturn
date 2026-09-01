import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SftpStorageAdapter } from "../packages/storage/dist/index.js";

const vaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const passwordFile = path.join(vaultRoot, "docs", "server_password.txt");
const namespace = `_vault-stage3-adapter-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const adapter = new SftpStorageAdapter({
  host: "u657278-sub1.your-storagebox.de",
  port: 22,
  username: "u657278-sub1",
  root: ".",
  hostFingerprint: "SHA256:EMlfI8GsRIfpVkoW1H2u0zYVpFGKkIMKHFZIRkf2ioI",
  authMode: "password_file",
  passwordFile,
  operationTimeoutMs: 60_000,
  maxConnections: 8,
});
const created = [];
let result;

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

try {
  await fs.access(passwordFile);
  if (await adapter.exists(namespace)) throw new Error("Generated DEV namespace unexpectedly exists");
  await adapter.mkdir(namespace);
  created.push(namespace);
  const source = `${namespace}/source.bin`;
  const copy = `${namespace}/copy.bin`;
  const renamed = `${namespace}/renamed.bin`;
  const first = Buffer.from("provider-neutral ");
  const second = Buffer.from("SFTP adapter contract");
  const expected = Buffer.concat([first, second]);
  await adapter.write(source, Readable.from(first), { offset: 0, create: true, exclusive: true, truncate: true });
  created.push(source);
  await adapter.write(source, Readable.from(second), { offset: first.length, create: false });
  await adapter.write(source, Readable.from("rollback"), { offset: expected.length, create: false });
  await adapter.truncate(source, expected.length);
  const attributes = await adapter.stat(source);
  if (attributes.size !== expected.length) throw new Error("DEV truncate/stat contract failed");
  const range = await collect(await adapter.openRead(source, { offset: first.length, length: second.length }));
  if (!range.equals(second)) throw new Error("DEV range contract failed");
  const digest = createHash("sha256").update(await collect(await adapter.openRead(source))).digest("hex");
  const expectedDigest = createHash("sha256").update(expected).digest("hex");
  if (digest !== expectedDigest) throw new Error("DEV full checksum contract failed");
  await adapter.copy(source, copy);
  created.push(copy);
  await adapter.rename(copy, renamed);
  created.pop();
  created.push(renamed);
  const listing = await adapter.list(namespace, undefined, 100);
  if (listing.entries.length !== 2) throw new Error("DEV list contract failed");
  const parallel = await Promise.all(Array.from({ length: 8 }, () => adapter.stat(source)));
  if (parallel.some((entry) => entry.size !== expected.length)) throw new Error("DEV pool contract failed");
  const capacity = await adapter.statFs();
  if (capacity.availableBytes <= 0 || capacity.totalBytes < capacity.availableBytes) throw new Error("DEV statFs contract failed");
  result = {
    success: true,
    bytes: expected.length,
    sha256: digest,
    pool: parallel.length,
    range: "pass",
    truncate: "pass",
    cleanup: true,
  };
} finally {
  for (const target of [...created].reverse()) {
    if (await adapter.exists(target).catch(() => false)) await adapter.delete(target);
  }
  await adapter.close();
}
if (result !== undefined) process.stdout.write(`${JSON.stringify(result)}\n`);
