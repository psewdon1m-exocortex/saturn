import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import { BackupArchiveValidator, ManifestedZipBackupWriter, validateArchiveMemberPath } from "./archive.js";
import type { BackupManifest, RecoveryLimits } from "./types.js";

const roots: string[] = [];
const limits: RecoveryLimits = {
  maxArchiveBytes: 2 * 1024 * 1024,
  maxMemberBytes: 1024 * 1024,
  maxExtractedBytes: 4 * 1024 * 1024,
  maxEntries: 64,
  maxCompressionRatio: 200,
  maxManifestBytes: 64 * 1024,
};

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-recovery-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredMembers(): Map<string, Buffer> {
  return new Map([
    ["database/database.dump", Buffer.from("PGDMP-safe")],
    ["config/public.json", Buffer.from("{}\n")],
    ["deployment/compose.yaml", Buffer.from("services: {}\n")],
    ["migrations/0001_test.up.sql", Buffer.from("SELECT 1;\n")],
    ["metadata/resources.jsonl", Buffer.from("\n")],
    ["metadata/audit_events.jsonl", Buffer.from("\n")],
  ]);
}

async function writeZip(
  outputPath: string,
  members: ReadonlyMap<string, Buffer>,
  manifestMutator?: (manifest: BackupManifest) => BackupManifest,
): Promise<void> {
  const createdAt = new Date("2026-08-26T00:00:00.000Z");
  let manifest: BackupManifest = {
    schema: "vault.backup.v1",
    backupId: randomUUID(),
    createdAt: createdAt.toISOString(),
    database: { engine: "postgresql", logicalFormat: "custom" },
    members: [...members].map(([memberPath, value]) => ({
      path: memberPath,
      sizeBytes: value.length,
      sha256: digest(value),
      mediaType: "application/octet-stream",
    })),
  };
  manifest = manifestMutator?.(manifest) ?? manifest;
  const zip = new yazl.ZipFile();
  const done = pipeline(zip.outputStream, createWriteStream(outputPath, { flags: "wx" }));
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), "manifest.json", { mtime: createdAt });
  for (const [memberPath, value] of members) zip.addBuffer(value, memberPath, { mtime: createdAt, compress: true });
  zip.end({ comment: "", forceZip64Format: false });
  await done;
}

describe("manifested ZIP backup", () => {
  it("creates and independently validates an allow-listed archive", async () => {
    const root = await temporaryRoot();
    const members = [];
    for (const [memberPath, value] of requiredMembers()) {
      const sourcePath = path.join(root, "sources", ...memberPath.split("/"));
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, value);
      members.push({ path: memberPath, sourcePath, mediaType: "application/octet-stream" });
    }
    const writer = new ManifestedZipBackupWriter(limits, ["known-secret-value"]);
    const output = path.join(root, "backup.zip");
    const created = await writer.create({
      backupId: randomUUID(),
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
      outputPath: output,
      members,
      validationDirectory: path.join(root, "writer-validation"),
    });
    const validated = await new BackupArchiveValidator(limits).validate(output, path.join(root, "reader-validation"));
    expect(validated.archiveSha256).toBe(created.archiveSha256);
    expect(validated.manifest.members).toHaveLength(requiredMembers().size);
    expect(await fs.readFile(path.join(validated.extractionDirectory, "database", "database.dump"), "utf8")).toBe("PGDMP-safe");
  });

  it("rejects unsafe paths and a configured plaintext secret", async () => {
    expect(() => validateArchiveMemberPath("../escape")).toThrow(/unsafe/);
    expect(() => validateArchiveMemberPath("C:/escape")).toThrow(/absolute/);
    expect(() => validateArchiveMemberPath("bad\\name")).toThrow(/unsafe/);
    const root = await temporaryRoot();
    const source = path.join(root, "secret.dump");
    await fs.writeFile(source, "prefix known-secret-value suffix");
    await expect(new ManifestedZipBackupWriter(limits, ["known-secret-value"]).create({
      backupId: randomUUID(),
      createdAt: new Date(),
      outputPath: path.join(root, "secret.zip"),
      members: [{ path: "database/database.dump", sourcePath: source, mediaType: "application/octet-stream" }],
      validationDirectory: path.join(root, "validation"),
    })).rejects.toThrow(/configured secret/);
  });

  it("rejects unknown members and digest mismatches", async () => {
    const root = await temporaryRoot();
    const unknown = requiredMembers();
    unknown.set("metadata/unknown.jsonl", Buffer.from("unknown"));
    const unknownPath = path.join(root, "unknown.zip");
    await writeZip(unknownPath, unknown);
    await expect(new BackupArchiveValidator(limits).validate(unknownPath, path.join(root, "unknown-out"))).rejects.toThrow(/unknown member/);

    const digestPath = path.join(root, "digest.zip");
    await writeZip(digestPath, requiredMembers(), (manifest) => ({
      ...manifest,
      members: manifest.members.map((member) => member.path === "database/database.dump"
        ? { ...member, sha256: "0".repeat(64) }
        : member),
    }));
    await expect(new BackupArchiveValidator(limits).validate(digestPath, path.join(root, "digest-out"))).rejects.toThrow(/digest or size mismatch/);
  });

  it("rejects traversal, corrupt, oversized and excessive-ratio archives", async () => {
    const root = await temporaryRoot();
    const traversalMembers = requiredMembers();
    traversalMembers.set("xx/evil.txt", Buffer.from("bad"));
    const traversalPath = path.join(root, "traversal.zip");
    await writeZip(traversalPath, traversalMembers);
    const bytes = await fs.readFile(traversalPath);
    const before = Buffer.from("xx/evil.txt");
    const after = Buffer.from("../evil.txt");
    let index = 0;
    while ((index = bytes.indexOf(before, index)) >= 0) {
      after.copy(bytes, index);
      index += before.length;
    }
    await fs.writeFile(traversalPath, bytes);
    await expect(new BackupArchiveValidator(limits).validate(traversalPath, path.join(root, "traversal-out"))).rejects.toThrow();

    const corruptPath = path.join(root, "corrupt.zip");
    await fs.writeFile(corruptPath, "not a zip");
    await expect(new BackupArchiveValidator(limits).validate(corruptPath, path.join(root, "corrupt-out"))).rejects.toThrow();

    const oversizedPath = path.join(root, "oversized.zip");
    await writeZip(oversizedPath, requiredMembers());
    await expect(new BackupArchiveValidator({ ...limits, maxMemberBytes: 4 }).validate(oversizedPath, path.join(root, "oversized-out"))).rejects.toThrow(/exceeds configured limit/);

    const ratioMembers = requiredMembers();
    ratioMembers.set("metadata/resources.jsonl", Buffer.alloc(32 * 1024));
    const ratioPath = path.join(root, "ratio.zip");
    await writeZip(ratioPath, ratioMembers);
    await expect(new BackupArchiveValidator({ ...limits, maxCompressionRatio: 2 }).validate(ratioPath, path.join(root, "ratio-out"))).rejects.toThrow(/compression ratio/);

    const duplicateMembers = requiredMembers();
    duplicateMembers.set("migrations/0001_a.up.sql", Buffer.from("SELECT 1"));
    duplicateMembers.set("migrations/0001_b.up.sql", Buffer.from("SELECT 2"));
    const duplicatePath = path.join(root, "duplicate.zip");
    await writeZip(duplicatePath, duplicateMembers);
    const duplicateBytes = await fs.readFile(duplicatePath);
    const uniqueName = Buffer.from("migrations/0001_b.up.sql");
    const duplicateName = Buffer.from("migrations/0001_a.up.sql");
    let duplicateIndex = 0;
    while ((duplicateIndex = duplicateBytes.indexOf(uniqueName, duplicateIndex)) >= 0) {
      duplicateName.copy(duplicateBytes, duplicateIndex);
      duplicateIndex += uniqueName.length;
    }
    await fs.writeFile(duplicatePath, duplicateBytes);
    await expect(new BackupArchiveValidator(limits).validate(duplicatePath, path.join(root, "duplicate-out"))).rejects.toThrow(/Duplicate ZIP member/);
  });
});
