import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import yazl from "yazl";
import { z } from "zod";
import type {
  BackupManifest,
  BackupMember,
  CreatedBackup,
  ManifestMember,
  RecoveryLimits,
  ValidatedBackup,
} from "./types.js";

const digestPattern = /^[a-f0-9]{64}$/;
const manifestMemberSchema = z.object({
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(digestPattern),
  mediaType: z.string().min(1).max(200),
}).strict();
const manifestSchema = z.object({
  schema: z.literal("vault.backup.v1"),
  backupId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  database: z.object({ engine: z.literal("postgresql"), logicalFormat: z.literal("custom") }).strict(),
  members: z.array(manifestMemberSchema),
}).strict();

const portableMetadataMembers = new Set([
  "metadata/migrations.jsonl",
  "metadata/resources.jsonl",
  "metadata/file_versions.jsonl",
  "metadata/operation_journal.jsonl",
  "metadata/audit_events.jsonl",
  "metadata/reconciliation_runs.jsonl",
  "metadata/reconciliation_issues.jsonl",
  "metadata/backup_runs.jsonl",
  "metadata/recovery_runs.jsonl",
  "metadata/telegram_binding.jsonl",
  "metadata/shares.jsonl",
  "metadata/devices.jsonl",
  "metadata/sync_conflicts.jsonl",
  "metadata/backup_services.jsonl",
  "metadata/service_backup_runs.jsonl",
  "metadata/service_backup_restore_tests.jsonl",
  "metadata/laboratory_clients.jsonl",
  "metadata/laboratory_assets.jsonl",
]);

function isAllowedMember(memberPath: string): boolean {
  return memberPath === "database/database.dump"
    || memberPath === "config/public.json"
    || memberPath === "deployment/compose.yaml"
    || memberPath === "secrets/recovery.age"
    || portableMetadataMembers.has(memberPath)
    || /^migrations\/\d+_[a-z0-9_-]+\.(up|down)\.sql$/i.test(memberPath);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

export function validateArchiveMemberPath(value: string): string {
  if (value !== value.normalize("NFC")) throw new Error("Archive member path must be NFC-normalized");
  if (!value || value.startsWith("/") || value.includes("\\") || containsControlCharacter(value)) {
    throw new Error("Archive member path is unsafe");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Archive member path is unsafe");
  if (/^[A-Za-z]:/.test(value)) throw new Error("Archive member path is absolute");
  return value;
}

async function hashFile(filePath: string): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    hash.update(data);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function assertNoKnownSecrets(filePath: string, knownSecrets: readonly string[]): Promise<void> {
  const secrets = knownSecrets.filter((secret) => Buffer.byteLength(secret) >= 8).map((secret) => Buffer.from(secret));
  if (secrets.length === 0) return;
  const overlap = Math.max(...secrets.map((secret) => secret.length)) - 1;
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath)) {
    const data = Buffer.concat([tail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (secrets.some((secret) => data.includes(secret))) throw new Error("Backup member contains a configured secret");
    tail = overlap <= 0 ? Buffer.alloc(0) : data.subarray(Math.max(0, data.length - overlap));
  }
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zip) => error === null ? resolve(zip) : reject(error));
  });
}

function closeZip(zip: ZipFile): void {
  try {
    zip.close();
  } catch {
    // A parser error may already have closed the descriptor.
  }
}

async function listEntries(filePath: string): Promise<readonly Entry[]> {
  const zip = await openZip(filePath);
  return await new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    const fail = (error: Error) => { closeZip(zip); reject(error); };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on("end", () => { closeZip(zip); resolve(entries); });
    zip.readEntry();
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error === null
      ? resolve(stream)
      : reject(error));
  });
}

async function readEntryBuffer(filePath: string, selectedName: string, maximumBytes: number): Promise<Buffer> {
  const zip = await openZip(filePath);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      closeZip(zip);
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => { void (async () => {
      try {
        if (entry.fileName !== selectedName) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > maximumBytes) throw new Error("Manifest exceeds configured limit");
        const chunks: Buffer[] = [];
        let bytes = 0;
        const stream = await openEntryStream(zip, entry);
        for await (const chunk of stream) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > maximumBytes) throw new Error("Manifest exceeds configured limit");
          chunks.push(data);
        }
        settled = true;
        closeZip(zip);
        resolve(Buffer.concat(chunks));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    })(); });
    zip.on("end", () => fail(new Error("Backup manifest is missing")));
    zip.readEntry();
  });
}

async function extractEntries(
  archivePath: string,
  extractionDirectory: string,
  expected: ReadonlyMap<string, ManifestMember>,
): Promise<number> {
  const zip = await openZip(archivePath);
  let total = 0;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      closeZip(zip);
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => { void (async () => {
      try {
        if (entry.fileName === "manifest.json") {
          zip.readEntry();
          return;
        }
        const manifestMember = expected.get(entry.fileName);
        if (manifestMember === undefined) throw new Error("ZIP contains an unknown member");
        const outputPath = path.join(extractionDirectory, ...entry.fileName.split("/"));
        await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
        const stream = await openEntryStream(zip, entry);
        const hash = createHash("sha256");
        let bytes = 0;
        stream.on("data", (chunk: Buffer) => { hash.update(chunk); bytes += chunk.length; });
        await pipeline(stream, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
        if (bytes !== manifestMember.sizeBytes || hash.digest("hex") !== manifestMember.sha256) {
          throw new Error("Backup member digest or size mismatch");
        }
        total += bytes;
        zip.readEntry();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    })(); });
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      closeZip(zip);
      resolve(total);
    });
    zip.readEntry();
  });
}

export class BackupArchiveValidator {
  readonly #limits: RecoveryLimits;

  constructor(limits: RecoveryLimits) {
    this.#limits = limits;
  }

  async validate(archivePath: string, extractionDirectory: string): Promise<ValidatedBackup> {
    const archiveInfo = await fs.stat(archivePath);
    if (!archiveInfo.isFile() || archiveInfo.size < 1 || archiveInfo.size > this.#limits.maxArchiveBytes) {
      throw new Error("Backup archive size is invalid");
    }
    const entries = await listEntries(archivePath);
    if (entries.length < 2 || entries.length > this.#limits.maxEntries) throw new Error("Backup entry count is invalid");
    const names = new Set<string>();
    let declaredExtractedBytes = 0;
    for (const entry of entries) {
      const memberPath = validateArchiveMemberPath(entry.fileName);
      if (entry.fileName.endsWith("/")) throw new Error("Directory entries are forbidden");
      if (names.has(memberPath)) throw new Error("Duplicate ZIP member is forbidden");
      names.add(memberPath);
      if (entry.uncompressedSize > this.#limits.maxMemberBytes) throw new Error("Backup member exceeds configured limit");
      const ratio = entry.uncompressedSize === 0 ? 1 : entry.uncompressedSize / Math.max(1, entry.compressedSize);
      if (ratio > this.#limits.maxCompressionRatio) throw new Error("Backup compression ratio exceeds configured limit");
      declaredExtractedBytes += entry.uncompressedSize;
      if (declaredExtractedBytes > this.#limits.maxExtractedBytes) throw new Error("Backup extracted size exceeds configured limit");
    }
    const manifestBytes = await readEntryBuffer(archivePath, "manifest.json", this.#limits.maxManifestBytes);
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8"))) as BackupManifest;
    const expected = new Map<string, ManifestMember>();
    for (const member of manifest.members) {
      validateArchiveMemberPath(member.path);
      if (member.path === "manifest.json" || expected.has(member.path)) throw new Error("Backup manifest contains a duplicate member");
      if (!isAllowedMember(member.path)) throw new Error("Backup manifest contains an unknown member");
      expected.set(member.path, member);
    }
    for (const required of [
      "database/database.dump",
      "config/public.json",
      "deployment/compose.yaml",
      "metadata/resources.jsonl",
      "metadata/audit_events.jsonl",
    ]) {
      if (!expected.has(required)) throw new Error(`Backup required member is missing: ${required}`);
    }
    if (![...expected.keys()].some((name) => /^migrations\/\d+_[a-z0-9_-]+\.up\.sql$/i.test(name))) {
      throw new Error("Backup contains no forward migration");
    }
    if (names.size !== expected.size + 1 || !names.has("manifest.json")) throw new Error("ZIP and manifest member sets differ");
    for (const entry of entries) {
      if (entry.fileName === "manifest.json") continue;
      const member = expected.get(entry.fileName);
      if (member === undefined || member.sizeBytes !== entry.uncompressedSize) throw new Error("ZIP member metadata differs from manifest");
    }
    await fs.mkdir(extractionDirectory, { recursive: false, mode: 0o700 });
    try {
      const extractedBytes = await extractEntries(archivePath, extractionDirectory, expected);
      if (extractedBytes !== manifest.members.reduce((sum, member) => sum + member.sizeBytes, 0)) {
        throw new Error("Extracted backup size differs from manifest");
      }
      const archiveDigest = await hashFile(archivePath);
      return {
        archivePath,
        extractionDirectory,
        archiveBytes: archiveInfo.size,
        archiveSha256: archiveDigest.sha256,
        extractedBytes,
        manifest,
      };
    } catch (error) {
      await fs.rm(extractionDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}

export class ManifestedZipBackupWriter {
  readonly #limits: RecoveryLimits;
  readonly #validator: BackupArchiveValidator;
  readonly #knownSecrets: readonly string[];

  constructor(limits: RecoveryLimits, knownSecrets: readonly string[] = []) {
    this.#limits = limits;
    this.#validator = new BackupArchiveValidator(limits);
    this.#knownSecrets = knownSecrets;
  }

  async create(input: {
    readonly backupId: string;
    readonly createdAt: Date;
    readonly outputPath: string;
    readonly members: readonly BackupMember[];
    readonly validationDirectory: string;
  }): Promise<CreatedBackup> {
    if (input.members.length < 1 || input.members.length + 1 > this.#limits.maxEntries) throw new Error("Backup entry count is invalid");
    const names = new Set<string>();
    const manifestMembers: ManifestMember[] = [];
    let total = 0;
    for (const member of [...input.members].sort((left, right) => left.path.localeCompare(right.path))) {
      const memberPath = validateArchiveMemberPath(member.path);
      if (memberPath === "manifest.json" || names.has(memberPath)) throw new Error("Backup member path is duplicate or reserved");
      if (!isAllowedMember(memberPath)) throw new Error("Backup member path is not allow-listed");
      names.add(memberPath);
      await assertNoKnownSecrets(member.sourcePath, this.#knownSecrets);
      const digest = await hashFile(member.sourcePath);
      if (digest.bytes > this.#limits.maxMemberBytes) throw new Error("Backup member exceeds configured limit");
      total += digest.bytes;
      if (total > this.#limits.maxExtractedBytes) throw new Error("Backup extracted size exceeds configured limit");
      manifestMembers.push({ path: memberPath, sizeBytes: digest.bytes, sha256: digest.sha256, mediaType: member.mediaType });
    }
    const manifest: BackupManifest = {
      schema: "vault.backup.v1",
      backupId: input.backupId,
      createdAt: input.createdAt.toISOString(),
      database: { engine: "postgresql", logicalFormat: "custom" },
      members: manifestMembers,
    };
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifestBuffer.length > this.#limits.maxManifestBytes) throw new Error("Manifest exceeds configured limit");
    await fs.mkdir(path.dirname(input.outputPath), { recursive: true, mode: 0o700 });
    await fs.access(input.outputPath).then(
      () => { throw new Error("Backup output already exists"); },
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      },
    );
    const partPath = `${input.outputPath}.${input.backupId}.part`;
    const zip = new yazl.ZipFile();
    const archivePipeline = pipeline(zip.outputStream, createWriteStream(partPath, { flags: "wx", mode: 0o600 }));
    try {
      zip.addBuffer(manifestBuffer, "manifest.json", { mtime: input.createdAt, mode: 0o600 });
      for (const member of input.members) {
        zip.addFile(member.sourcePath, member.path, { mtime: input.createdAt, mode: 0o600 });
      }
      zip.end({ forceZip64Format: false, comment: "" });
      await archivePipeline;
      const archiveInfo = await fs.stat(partPath);
      if (archiveInfo.size > this.#limits.maxArchiveBytes) throw new Error("Backup archive exceeds configured limit");
      const validated = await this.#validator.validate(partPath, input.validationDirectory);
      for (const member of validated.manifest.members) {
        await assertNoKnownSecrets(path.join(validated.extractionDirectory, ...member.path.split("/")), this.#knownSecrets);
      }
      await fs.rename(partPath, input.outputPath);
      return {
        archivePath: input.outputPath,
        archiveBytes: validated.archiveBytes,
        archiveSha256: validated.archiveSha256,
        extractedBytes: validated.extractedBytes,
        manifest,
      };
    } catch (error) {
      zip.end();
      await fs.rm(partPath, { force: true });
      throw error;
    } finally {
      await fs.rm(input.validationDirectory, { recursive: true, force: true });
    }
  }
}
