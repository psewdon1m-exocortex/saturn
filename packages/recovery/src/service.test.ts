import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import { SaturnBackupService } from "./service.js";
import type { BackupManifest, LogicalDatabaseToolchain, MetadataExporter, RecoveryLimits } from "./types.js";

const roots: string[] = [];
const limits: RecoveryLimits = {
  maxArchiveBytes: 2 * 1024 * 1024,
  maxMemberBytes: 1024 * 1024,
  maxExtractedBytes: 4 * 1024 * 1024,
  maxEntries: 64,
  maxCompressionRatio: 200,
  maxManifestBytes: 64 * 1024,
};

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "vault-restore-"));
  roots.push(value);
  return value;
}

async function archive(output: string, databaseValue: string, extraMember?: string): Promise<void> {
  const values = new Map<string, Buffer>([
    ["database/database.dump", Buffer.from(databaseValue)],
    ["config/public.json", Buffer.from("{}")],
    ["deployment/compose.yaml", Buffer.from("services: {}")],
    ["migrations/0001_test.up.sql", Buffer.from("SELECT 1")],
    ["metadata/resources.jsonl", Buffer.from("\n")],
    ["metadata/audit_events.jsonl", Buffer.from("\n")],
  ]);
  if (extraMember !== undefined) values.set(extraMember, Buffer.from("bad"));
  const createdAt = new Date("2026-08-26T00:00:00.000Z");
  const manifest: BackupManifest = {
    schema: "vault.backup.v1",
    backupId: randomUUID(),
    createdAt: createdAt.toISOString(),
    database: { engine: "postgresql", logicalFormat: "custom" },
    members: [...values].map(([memberPath, value]) => ({
      path: memberPath,
      sizeBytes: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
      mediaType: "application/octet-stream",
    })),
  };
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, createWriteStream(output));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { mtime: createdAt });
  for (const [memberPath, value] of values) zip.addBuffer(value, memberPath, { mtime: createdAt });
  zip.end({ comment: "", forceZip64Format: false });
  await done;
}

class FakeDatabase implements LogicalDatabaseToolchain {
  value = "original";
  restores = 0;
  failNextVerification = false;

  createDump(outputPath: string): Promise<void> {
    return fs.writeFile(outputPath, this.value, { flag: "wx" });
  }

  async restoreDump(dumpPath: string): Promise<void> {
    this.restores += 1;
    this.value = await fs.readFile(dumpPath, "utf8");
  }

  verifyRestoredDatabase(): Promise<Record<string, number>> {
    if (this.failNextVerification) {
      this.failNextVerification = false;
      return Promise.reject(new Error("injected post-restore failure"));
    }
    return Promise.resolve({ resources: this.value === "original" ? 1 : 2 });
  }
}

function fakeMetadata(): MetadataExporter {
  return {
    async exportTo(directory: string) {
      await fs.mkdir(directory, { recursive: true });
      const members = [];
      for (const name of ["resources", "audit_events"]) {
        const sourcePath = path.join(directory, `${name}.jsonl`);
        await fs.writeFile(sourcePath, "\n");
        members.push({ path: `metadata/${name}.jsonl`, sourcePath, mediaType: "application/x-ndjson" });
      }
      return members;
    },
  };
}

describe("SaturnBackupService restore boundary", () => {
  it("rejects a hostile archive before database mutation", async () => {
    const directory = await root();
    const input = path.join(directory, "hostile.zip");
    await archive(input, "target", "metadata/unknown.jsonl");
    const database = new FakeDatabase();
    const service = new SaturnBackupService({ spoolRoot: path.join(directory, "spool"), limits, database, metadata: fakeMetadata() });
    await expect(service.restore({ archivePath: input, mode: "clean" })).rejects.toThrow(/unknown member/);
    expect(database.restores).toBe(0);
    expect(database.value).toBe("original");
  });

  it("returns to a pre-restore snapshot after a post-restore failure", async () => {
    const directory = await root();
    const input = path.join(directory, "target.zip");
    await archive(input, "target");
    const compose = path.join(directory, "compose.yaml");
    const migrations = path.join(directory, "migrations");
    await fs.mkdir(migrations);
    await fs.writeFile(compose, "services: {}\n");
    await fs.writeFile(path.join(migrations, "0001_test.up.sql"), "SELECT 1;\n");
    await fs.writeFile(path.join(migrations, "0001_test.down.sql"), "SELECT 1;\n");
    const database = new FakeDatabase();
    database.failNextVerification = true;
    const service = new SaturnBackupService({ spoolRoot: path.join(directory, "spool"), limits, database, metadata: fakeMetadata() });
    let barrierCalls = 0;
    let barrierActive = false;
    await expect(service.restore({
      archivePath: input,
      mode: "replace",
      snapshotOutputPath: path.join(directory, "snapshot.zip"),
      snapshotInput: { publicConfiguration: {}, deploymentManifestPath: compose, migrationsDirectory: migrations },
    }, undefined, async (action) => {
      barrierCalls += 1;
      barrierActive = true;
      try { return await action(); }
      finally { barrierActive = false; }
    })).rejects.toThrow(/injected post-restore failure/);
    expect(barrierCalls).toBe(1);
    expect(barrierActive).toBe(false);
    expect(database.restores).toBe(2);
    expect(database.value).toBe("original");
    await expect(fs.stat(path.join(directory, "snapshot.zip"))).resolves.toBeDefined();
  });
});
