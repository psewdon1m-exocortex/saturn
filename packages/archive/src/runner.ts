import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { AuditSink } from "@saturn/audit";
import type { FileService, Resource } from "@saturn/file-core";
import type { ArchiveJobRepository } from "./repository.js";
import type { ArchiveJob, ArchiveJobState, ArchiveLimits, ArchiveRuntimeOptions } from "./types.js";

const actor = { type: "system", id: "archive-worker" } as const;

class ArchiveCancelledError extends Error {}
class ArchivePausedError extends Error {}

interface ArchiveEntry {
  readonly resource: Resource;
  readonly memberPath: string;
}

function safeFailureCode(error: unknown): string {
  if (error instanceof ArchiveCancelledError) return "cancelled";
  const message = error instanceof Error ? error.message : String(error);
  if (/ratio/i.test(message)) return "compression_ratio_exceeded";
  if (/size|bytes|large|limit/i.test(message)) return "size_limit_exceeded";
  if (/entry|member|path|symlink|special|duplicate|unsafe/i.test(message)) return "unsafe_archive";
  if (/7-zip|7z/i.test(message)) return "seven_zip_failed";
  return "archive_processing_failed";
}

export function validatePortableMemberPath(value: string): string {
  let hasControlCharacter = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) { hasControlCharacter = true; break; }
  }
  if (value !== value.normalize("NFC") || !value || value.startsWith("/") || value.includes("\\") || hasControlCharacter) {
    throw new Error("Archive member path is unsafe");
  }
  const segments = value.replace(/\/$/, "").split("/");
  if (segments.some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(value)) {
    throw new Error("Archive member path is unsafe");
  }
  return value;
}

function localMemberPath(root: string, memberPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, ...validatePortableMemberPath(memberPath).replace(/\/$/, "").split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Archive member path escapes extraction directory");
  return resolved;
}

function openZip(filePath: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(filePath, {
    lazyEntries: true,
    autoClose: false,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  }, (error, zip) => error === null ? resolve(zip) : reject(error)));
}

function closeZip(zip: ZipFile): void {
  try { zip.close(); } catch { /* the parser may already have closed it */ }
}

function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error === null ? resolve(stream) : reject(error)));
}

function isZipSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

async function digestFile(filePath: string): Promise<{ readonly size: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    hash.update(data);
  }
  return { size, sha256: hash.digest("hex") };
}

async function runCommand(executable: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`7-Zip failed with exit code ${String(code)}: ${Buffer.concat(stderr).toString("utf8").slice(-1_000)}`)));
  });
}

export function validateSevenZipListing(listing: string, limits: Pick<ArchiveLimits, "maxEntries" | "maxMemberBytes" | "maxExtractedBytes" | "maxCompressionRatio">): number {
  let entryCount = 0;
  let total = 0;
  const names = new Set<string>();
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const fields = new Map(block.split(/\r?\n/).map((line) => {
      const index = line.indexOf(" = ");
      return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 3)];
    }));
    const rawMember = fields.get("Path");
    if (!rawMember) continue;
    const member = rawMember.replace(/\\/g, "/");
    validatePortableMemberPath(member);
    if (names.has(member)) throw new Error("Duplicate archive member is forbidden");
    names.add(member);
    const size = Number(fields.get("Size") ?? "0");
    const packed = Number(fields.get("Packed Size") ?? "0");
    const attributes = fields.get("Attributes") ?? "";
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxMemberBytes
      || attributes.includes("L") || fields.has("Symbolic Link") || fields.has("Hard Link")) throw new Error("Unsafe RAR entry is forbidden");
    if (size > 0 && size / Math.max(1, packed) > limits.maxCompressionRatio) throw new Error("Archive compression ratio exceeds configured limit");
    entryCount += 1;
    total += size;
    if (entryCount > limits.maxEntries || total > limits.maxExtractedBytes) throw new Error("RAR extraction limits exceeded");
  }
  return total;
}

export class ArchiveJobRunner {
  constructor(
    private readonly repository: ArchiveJobRepository,
    private readonly files: FileService,
    private readonly options: ArchiveRuntimeOptions,
    private readonly audit?: AuditSink,
  ) {}

  async runNext(workerId = randomUUID()): Promise<ArchiveJob | undefined> {
    const job = await this.repository.claimNext(workerId, this.options.limits.leaseMs, new Date());
    if (job === undefined) return undefined;
    const spoolRoot = path.resolve(this.options.spoolDirectory);
    const workDirectory = path.resolve(spoolRoot, job.id);
    if (!workDirectory.startsWith(`${spoolRoot}${path.sep}`)) throw new Error("Archive spool path is unsafe");
    await fs.rm(workDirectory, { recursive: true, force: true });
    await fs.mkdir(workDirectory, { recursive: true, mode: 0o700 });
    try {
      const completed = job.kind === "compress_zip"
        ? await this.compress(job, workerId, workDirectory)
        : await this.extract(job, workerId, workDirectory);
      await this.writeAudit("archive.job.completed", completed, "success");
      return completed;
    } catch (error) {
      if (error instanceof ArchivePausedError) return await this.repository.get(job.id);
      const cancelled = error instanceof ArchiveCancelledError;
      const failed = await this.repository.setState(job.id, cancelled ? "cancelled" : "failed", {
        failureCode: safeFailureCode(error),
        currentItem: null,
        completedAt: new Date(),
      });
      await this.writeAudit(cancelled ? "archive.job.cancelled" : "archive.job.failed", failed, cancelled ? "success" : "failure", safeFailureCode(error));
      return failed;
    } finally {
      await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async checkpoint(jobId: string, workerId: string, resumeState: ArchiveJobState): Promise<ArchiveJob> {
    const current = await this.repository.get(jobId);
    if (current === undefined || current.requestedState === "cancelled") throw new ArchiveCancelledError("Archive job was cancelled");
    if (current.requestedState === "paused") {
      if (current.state !== "paused") await this.repository.setState(jobId, "paused");
      throw new ArchivePausedError("Archive job was paused");
    }
    await this.repository.renewLease(jobId, workerId, this.options.limits.leaseMs, new Date());
    return current.state === "paused" ? this.repository.setState(jobId, resumeState) : current;
  }

  private async listEntries(resource: Resource, prefix = resource.name): Promise<readonly ArchiveEntry[]> {
    if (resource.type === "file") return [{ resource, memberPath: validatePortableMemberPath(prefix) }];
    const entries: ArchiveEntry[] = [{ resource, memberPath: `${validatePortableMemberPath(prefix)}/` }];
    for (let offset = 0; ; offset += 500) {
      const children = await this.files.listChildren(resource.id, offset, 500);
      for (const child of children) entries.push(...await this.listEntries(child, `${prefix}/${child.name}`));
      if (children.length < 500) return entries;
    }
  }

  private async compress(job: ArchiveJob, workerId: string, workDirectory: string): Promise<ArchiveJob> {
    await this.checkpoint(job.id, workerId, "scanning");
    const selected = await Promise.all(job.sourceResourceIds.map((id) => this.files.getResource(id)));
    const entries = (await Promise.all(selected.map((item) => this.listEntries(item)))).flat();
    if (entries.length > this.options.limits.maxEntries) throw new Error("Archive entry count exceeds configured limit");
    for (const entry of entries) if (entry.resource.sizeBytes > this.options.limits.maxMemberBytes) throw new Error("Archive member size exceeds configured limit");
    const totalBytes = entries.reduce((sum, entry) => sum + (entry.resource.type === "file" ? entry.resource.sizeBytes : 0), 0);
    if (totalBytes > this.options.limits.maxExtractedBytes) throw new Error("Archive content size exceeds configured limit");
    await this.repository.setState(job.id, "compressing", { totalBytes, processedBytes: 0 });
    const outputPath = path.join(workDirectory, "output.zip");
    const archive = archiver("zip", { zlib: { level: 6 }, forceZip64: true });
    const completion = pipeline(archive, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
    let processed = 0;
    try {
      for (const entry of entries) {
        await this.checkpoint(job.id, workerId, "compressing");
        await this.repository.setState(job.id, "compressing", { processedBytes: processed, currentItem: entry.memberPath });
        if (entry.resource.type === "folder") {
          archive.append(Buffer.alloc(0), { name: entry.memberPath });
          continue;
        }
        archive.append(Readable.from(this.controlledResourceChunks(job.id, workerId, entry.resource.id, "compressing", (count) => { processed += count; return processed; })), {
          name: entry.memberPath,
          date: entry.resource.updatedAt,
          mode: 0o600,
        });
      }
      await archive.finalize();
      await completion;
    } catch (error) {
      archive.abort();
      throw error;
    }
    const digest = await digestFile(outputPath);
    if (digest.size > this.options.limits.maxArchiveBytes) throw new Error("ZIP archive exceeds configured size limit");
    await this.repository.setState(job.id, "verifying", { processedBytes: totalBytes, currentItem: null });
    const result = await this.uploadLocalFile(job, workerId, outputPath, digest, "verifying");
    return this.repository.setState(job.id, "completed", { resultResourceId: result.id, processedBytes: totalBytes, completedAt: new Date() });
  }

  private async *controlledChunks(
    jobId: string,
    workerId: string,
    stream: Readable,
    state: ArchiveJobState,
    progress: (bytes: number) => number,
  ): AsyncGenerator<Buffer> {
    for await (const chunk of stream) {
      await this.checkpoint(jobId, workerId, state);
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const processedBytes = progress(data.length);
      await this.repository.setState(jobId, state, { processedBytes });
      yield data;
    }
  }

  private async *controlledResourceChunks(
    jobId: string,
    workerId: string,
    resourceId: string,
    state: ArchiveJobState,
    progress: (bytes: number) => number,
  ): AsyncGenerator<Buffer> {
    const opened = await this.files.openDownload(resourceId, 0, undefined, actor);
    yield* this.controlledChunks(jobId, workerId, opened.stream, state, progress);
  }

  private async extract(job: ArchiveJob, workerId: string, workDirectory: string): Promise<ArchiveJob> {
    if (job.sourceResourceId === undefined) throw new Error("Archive source is missing");
    const archivePath = path.join(workDirectory, `source.${job.format}`);
    const opened = await this.files.openDownload(job.sourceResourceId, 0, undefined, actor);
    if (opened.resource.sizeBytes > this.options.limits.maxArchiveBytes) throw new Error("Archive exceeds configured size limit");
    let downloadedBytes = 0;
    await pipeline(
      Readable.from(this.controlledChunks(job.id, workerId, opened.stream, "scanning", (count) => { downloadedBytes += count; return downloadedBytes; })),
      createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
    );
    const extractionRoot = path.join(workDirectory, "extracted");
    await fs.mkdir(extractionRoot, { recursive: false, mode: 0o700 });
    const declaredTotal = job.format === "zip"
      ? await this.inspectZip(archivePath)
      : await this.inspectRar(archivePath);
    await this.repository.setState(job.id, "extracting", { processedBytes: 0, totalBytes: declaredTotal });
    if (job.format === "zip") await this.extractZip(job, workerId, archivePath, extractionRoot, declaredTotal);
    else await this.extractRar(job, workerId, archivePath, extractionRoot, declaredTotal);
    await this.repository.setState(job.id, "verifying", { currentItem: null });
    const members = await this.inspectExtractedTree(extractionRoot);
    await this.checkpoint(job.id, workerId, "verifying");
    const parent = job.resultResourceId === undefined
      ? await this.files.createFolder(job.destinationParentId, job.outputName, actor)
      : await this.files.getResource(job.resultResourceId);
    if (parent.type !== "folder" || parent.status !== "active" || parent.parentId !== job.destinationParentId) {
      throw new Error("Archive output folder is not available for commit");
    }
    await this.repository.setState(job.id, "committing", { resultResourceId: parent.id, processedBytes: 0, totalBytes: members.totalBytes });
    try {
      let committed = 0;
      await this.commitDirectory(job, workerId, extractionRoot, parent.id, () => committed, (count) => { committed += count; });
      return await this.repository.setState(job.id, "completed", {
        resultResourceId: parent.id,
        processedBytes: members.totalBytes,
        totalBytes: members.totalBytes,
        completedAt: new Date(),
      });
    } catch (error) {
      await this.files.trashResource(parent.id, { idempotencyKey: `archive-cleanup:${job.id}`, auditActor: actor }).catch(() => undefined);
      throw error;
    }
  }

  private async inspectZip(archivePath: string): Promise<number> {
    const zip = await openZip(archivePath);
    let entryCount = 0;
    let totalBytes = 0;
    const names = new Set<string>();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        closeZip(zip);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zip.on("error", fail);
      zip.on("entry", (entry: Entry) => {
        try {
          const member = validatePortableMemberPath(entry.fileName);
          if (names.has(member)) throw new Error("Duplicate archive member is forbidden");
          names.add(member);
          entryCount += 1;
          if (entryCount > this.options.limits.maxEntries || isZipSymlink(entry)) throw new Error("Unsafe ZIP entry is forbidden");
          if (entry.uncompressedSize > this.options.limits.maxMemberBytes) throw new Error("Archive member size exceeds configured limit");
          const ratio = entry.uncompressedSize === 0 ? 1 : entry.uncompressedSize / Math.max(1, entry.compressedSize);
          if (ratio > this.options.limits.maxCompressionRatio) throw new Error("Archive compression ratio exceeds configured limit");
          totalBytes += entry.uncompressedSize;
          if (totalBytes > this.options.limits.maxExtractedBytes) throw new Error("Extracted archive exceeds configured limit");
          zip.readEntry();
        } catch (error) { fail(error); }
      });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        closeZip(zip);
        resolve();
      });
      zip.readEntry();
    });
    return totalBytes;
  }

  private async extractZip(job: ArchiveJob, workerId: string, archivePath: string, extractionRoot: string, declaredTotal: number): Promise<void> {
    const zip = await openZip(archivePath);
    let extractedBytes = 0;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        closeZip(zip);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zip.on("error", fail);
      zip.on("entry", (entry: Entry) => { void (async () => {
        try {
          await this.checkpoint(job.id, workerId, "extracting");
          const member = validatePortableMemberPath(entry.fileName);
          await this.repository.setState(job.id, "extracting", { processedBytes: extractedBytes, totalBytes: declaredTotal, currentItem: member });
          const outputPath = localMemberPath(extractionRoot, member);
          if (member.endsWith("/")) await fs.mkdir(outputPath, { recursive: true, mode: 0o700 });
          else {
            await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
            await pipeline(
              Readable.from(this.controlledChunks(job.id, workerId, await openEntry(zip, entry), "extracting", (count) => {
                extractedBytes += count;
                return extractedBytes;
              })),
              createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
            );
            if ((await fs.stat(outputPath)).size !== entry.uncompressedSize) throw new Error("Extracted member size mismatch");
          }
          zip.readEntry();
        } catch (error) { fail(error); }
      })(); });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        closeZip(zip);
        resolve();
      });
      zip.readEntry();
    });
    if (extractedBytes !== declaredTotal) throw new Error("Extracted ZIP size differs from its inventory");
  }

  private async inspectRar(archivePath: string): Promise<number> {
    const listing = await runCommand(this.options.sevenZipExecutable, ["l", "-slt", "-ba", archivePath]);
    return validateSevenZipListing(listing, this.options.limits);
  }

  private async extractRar(job: ArchiveJob, workerId: string, archivePath: string, extractionRoot: string, declaredTotal: number): Promise<void> {
    await this.checkpoint(job.id, workerId, "extracting");
    await runCommand(this.options.sevenZipExecutable, ["x", "-y", "-bd", "-bb0", `-o${extractionRoot}`, archivePath]);
    await this.checkpoint(job.id, workerId, "extracting");
    await this.repository.setState(job.id, "extracting", { processedBytes: declaredTotal, totalBytes: declaredTotal });
  }

  private async inspectExtractedTree(root: string): Promise<{ readonly entries: number; readonly totalBytes: number }> {
    let entries = 0;
    let totalBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        entries += 1;
        if (entries > this.options.limits.maxEntries) throw new Error("Extracted archive contains too many entries");
        const stat = await fs.lstat(path.join(directory, item.name));
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("Extracted archive contains a link or special file");
        if (stat.isDirectory()) await visit(path.join(directory, item.name));
        else {
          if (stat.size > this.options.limits.maxMemberBytes) throw new Error("Extracted member exceeds configured limit");
          totalBytes += stat.size;
          if (totalBytes > this.options.limits.maxExtractedBytes) throw new Error("Extracted archive exceeds configured limit");
        }
      }
    };
    await visit(root);
    return { entries, totalBytes };
  }

  private async commitDirectory(
    job: ArchiveJob,
    workerId: string,
    localDirectory: string,
    parentId: string,
    currentProgress: () => number,
    addProgress: (bytes: number) => void,
  ): Promise<void> {
    for (const item of await fs.readdir(localDirectory, { withFileTypes: true })) {
      await this.checkpoint(job.id, workerId, "committing");
      const localPath = path.join(localDirectory, item.name);
      await this.repository.setState(job.id, "committing", { processedBytes: currentProgress(), currentItem: item.name });
      if (item.isDirectory()) {
        const folder = await this.ensureFolder(parentId, item.name);
        await this.commitDirectory(job, workerId, localPath, folder.id, currentProgress, addProgress);
      } else if (item.isFile()) {
        const digest = await digestFile(localPath);
        await this.uploadLocalFile({ ...job, destinationParentId: parentId, outputName: item.name }, workerId, localPath, digest, "committing");
        addProgress(digest.size);
      }
    }
  }

  private async ensureFolder(parentId: string, name: string): Promise<Resource> {
    for (let offset = 0; ; offset += 500) {
      const page = await this.files.listChildren(parentId, offset, 500);
      const existing = page.find((item) => item.name === name);
      if (existing !== undefined) {
        if (existing.type !== "folder") throw new Error("Archive member collides with an existing file");
        return existing;
      }
      if (page.length < 500) return this.files.createFolder(parentId, name, actor);
    }
  }

  private async uploadLocalFile(
    job: ArchiveJob,
    workerId: string,
    filePath: string,
    digest: { readonly size: number; readonly sha256: string },
    state: ArchiveJobState,
  ): Promise<Resource> {
    const suffix = createHash("sha256").update(`${job.id}:${job.destinationParentId}:${job.outputName}`).digest("hex").slice(0, 20);
    const upload = await this.files.createUpload({
      parentId: job.destinationParentId,
      filename: job.outputName,
      expectedSize: digest.size,
      expectedSha256: digest.sha256,
      idempotencyKey: `archive:${suffix}`,
      auditActor: actor,
    });
    let offset = upload.receivedSize;
    if (upload.status === "active" && upload.resourceId !== undefined) return this.files.getResource(upload.resourceId);
    for await (const chunk of createReadStream(filePath, { start: offset, highWaterMark: this.options.limits.uploadChunkBytes })) {
      await this.checkpoint(job.id, workerId, state);
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await this.files.appendUpload(upload.id, offset, data.length, Readable.from([data]));
      offset += data.length;
    }
    return (await this.files.completeUpload(upload.id)).resource;
  }

  private async writeAudit(action: string, job: ArchiveJob, outcome: "success" | "failure", failureCode?: string): Promise<void> {
    await this.audit?.write({
      actorType: "system",
      actorId: "archive-worker",
      action,
      ...((job.resultResourceId ?? job.sourceResourceId) === undefined ? {} : { resourceId: job.resultResourceId ?? job.sourceResourceId }),
      outcome,
      correlationId: `${action}:${job.id}`,
      details: { jobId: job.id, kind: job.kind, format: job.format, ...(failureCode === undefined ? {} : { failureCode }) },
    }).catch(() => undefined);
  }
}
