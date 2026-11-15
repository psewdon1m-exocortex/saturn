import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { onTestFinished } from "vitest";
import { migrate } from "./migrate.js";

// Guarded migrations intentionally bind functions to public. A search_path
// schema is not an isolated migration target. Never migrate the supplied DB.
export async function isolatedTestDatabase(adminUrl: string, cutoff?: number, storageRoot?: string) {
  const name = "saturn_test_" + randomUUID().replaceAll("-", "");
  const evidenceRoot = process.env.SATURN_TEST_ISOLATION_EVIDENCE_DIR;
  if (evidenceRoot !== undefined) {
    const temp = await fs.realpath(os.tmpdir());
    const local = new URL(adminUrl);
    if (!storageRoot || !path.isAbsolute(evidenceRoot) || local.hostname !== "127.0.0.1") {
      throw new Error("Retained isolated test requires a loopback database and an owned storage directory");
    }
    for (const candidate of [evidenceRoot, storageRoot]) {
      const stat = await fs.lstat(candidate);
      const real = await fs.realpath(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(candidate) !== real || path.dirname(real) !== temp) {
        throw new Error("Retained test paths must be real direct children of the isolated temporary directory");
      }
    }
    await fs.writeFile(path.join(evidenceRoot, name + ".json"), JSON.stringify({
      name, storageRoot: path.resolve(storageRoot), cutoff: cutoff ?? null,
    }), { flag: "wx", mode: 0o600 });
  }
  const admin = postgres(adminUrl, { max: 1 });
  const url = new URL(adminUrl);
  url.pathname = "/" + name;
  url.searchParams.delete("options");
  let created = false, directory: string | undefined;
  onTestFinished(async () => {
    try {
      if (evidenceRoot !== undefined) return;
      if (created) {
        if (!/^saturn_test_[a-f0-9]{32}$/.test(name) || new URL(adminUrl).pathname === "/" + name) throw Error("Invalid owned test database identity");
        await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      }
      if (directory) {
        const target = path.resolve(directory);
        if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("saturn-test-migrations-")) throw Error("Invalid migration fixture cleanup path");
        await fs.rm(target, { recursive: true, force: true });
      }
    } finally { await admin.end({ timeout: 2 }); }
  });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  created = true;
  const all = fileURLToPath(new URL("../migrations/", import.meta.url));
  if (cutoff !== undefined) {
    if (!Number.isSafeInteger(cutoff) || cutoff < 1) throw Error("Invalid migration cutoff");
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-test-migrations-"));
    for (const file of await fs.readdir(all)) if (/^\d{4}_.*\.(up|down)\.sql$/.test(file) && Number(file.slice(0, 4)) <= cutoff) {
      await fs.copyFile(path.join(all, file), path.join(directory, file));
    }
  }
  const migrations = directory ?? all;
  await migrate(url.toString(), migrations);
  return { url: url.toString(), migrations, retained: evidenceRoot !== undefined };
}
