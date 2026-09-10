import { v7 as uuidv7 } from "uuid";
import type { AuditSink } from "@saturn/audit";
import { ROOT_RESOURCE_ID, type FileService, type Resource } from "@saturn/file-core";
import type { ArchiveJobRepository } from "./repository.js";
import type { ArchiveFormat, ArchiveJob, CreateArchiveJobInput, ExtractArchiveJobInput } from "./types.js";

const ARCHIVE_EXTENSION = /\.(zip|rar)$/i;

function assertSafeLabel(value: string, label: string): string {
  const normalized = value.trim().normalize("NFC");
  let hasControlCharacter = false;
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) { hasControlCharacter = true; break; }
  }
  if (!normalized || normalized.length > 255 || normalized === "." || normalized === ".." || normalized.includes("\\") || normalized.includes("/") || hasControlCharacter) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export function normalizeArchiveOutputName(value: string): string {
  const name = assertSafeLabel(value, "Archive name");
  return name.toLocaleLowerCase().endsWith(".zip") ? name : `${name}.zip`;
}

export function archiveOutputFolderName(value: string): string {
  const name = assertSafeLabel(value, "Archive filename").replace(ARCHIVE_EXTENSION, "").trim();
  return assertSafeLabel(name || "archive", "Archive folder name");
}

export function archiveFormatForResource(resource: Pick<Resource, "type" | "name" | "mimeType">): ArchiveFormat | undefined {
  if (resource.type !== "file") return undefined;
  const mimeType = resource.mimeType?.toLocaleLowerCase();
  if (mimeType === "application/zip" || resource.name.toLocaleLowerCase().endsWith(".zip")) return "zip";
  if (mimeType === "application/vnd.rar" || mimeType === "application/x-rar-compressed" || resource.name.toLocaleLowerCase().endsWith(".rar")) return "rar";
  return undefined;
}

async function resourceBytes(files: FileService, resource: Resource): Promise<number> {
  if (resource.type === "file") return resource.sizeBytes;
  let total = 0;
  for (let offset = 0; ; offset += 500) {
    const page = await files.listChildren(resource.id, offset, 500);
    for (const child of page) total += await resourceBytes(files, child);
    if (page.length < 500) return total;
  }
}

function removeSelectedDescendants(resources: readonly Resource[]): readonly Resource[] {
  return resources.filter((candidate) => !resources.some((parent) => parent.id !== candidate.id
    && parent.type === "folder"
    && candidate.storagePath.startsWith(`${parent.storagePath}/`)));
}

export class ArchiveService {
  constructor(
    private readonly repository: ArchiveJobRepository,
    private readonly files: FileService,
    private readonly audit?: AuditSink,
  ) {}

  async createArchive(input: CreateArchiveJobInput, now = new Date()): Promise<ArchiveJob> {
    const parent = await this.files.getResource(input.destinationParentId);
    if (parent.type !== "folder" || parent.status !== "active") throw new Error("Archive destination is not an active folder");
    if (parent.id === ROOT_RESOURCE_ID) throw new Error("Archives cannot be created directly in the Saturn root");
    const uniqueIds = [...new Set(input.sourceResourceIds)];
    if (uniqueIds.length < 1 || uniqueIds.length > 1_000) throw new Error("Archive selection is invalid");
    const resources = removeSelectedDescendants(await Promise.all(uniqueIds.map((id) => this.files.getResource(id))));
    if (resources.some((resource) => resource.status !== "active" || resource.parentId !== parent.id)) {
      throw new Error("Archive selection must contain active items from the destination folder");
    }
    const totalBytes = (await Promise.all(resources.map((resource) => resourceBytes(this.files, resource)))).reduce((sum, value) => sum + value, 0);
    const id = uuidv7();
    const job = await this.repository.create({
      id,
      kind: "compress_zip",
      format: "zip",
      state: "queued",
      requestedState: "running",
      destinationParentId: parent.id,
      sourceResourceIds: resources.map((resource) => resource.id),
      outputName: normalizeArchiveOutputName(input.outputName),
      totalBytes,
      processedBytes: 0,
      createdAt: now,
      updatedAt: now,
    });
    await this.writeAudit("archive.compression.queued", job, { sourceCount: resources.length, totalBytes });
    return job;
  }

  async extractArchive(input: ExtractArchiveJobInput, now = new Date()): Promise<ArchiveJob> {
    const source = await this.files.getResource(input.sourceResourceId);
    const format = archiveFormatForResource(source);
    if (format === undefined || source.status !== "active" || source.parentId === undefined) throw new Error("Resource is not an extractable ZIP or RAR archive");
    const parent = await this.files.getResource(source.parentId);
    if (parent.type !== "folder" || parent.status !== "active") throw new Error("Archive parent is not active");
    const baseName = archiveOutputFolderName(source.name);
    const siblings: Resource[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.files.listChildren(parent.id, offset, 500);
      siblings.push(...page);
      if (page.length < 500) break;
    }
    const existingNames = new Set(siblings.map((item) => item.name.toLocaleLowerCase()));
    let outputName = baseName;
    for (let suffix = 2; existingNames.has(outputName.toLocaleLowerCase()); suffix += 1) outputName = `${baseName} (${String(suffix)})`;
    const id = uuidv7();
    const job = await this.repository.create({
      id,
      kind: "extract",
      format,
      state: "queued",
      requestedState: "running",
      destinationParentId: parent.id,
      sourceResourceId: source.id,
      sourceResourceIds: [],
      outputName,
      totalBytes: source.sizeBytes,
      processedBytes: 0,
      createdAt: now,
      updatedAt: now,
    });
    await this.writeAudit("archive.extraction.queued", job, { sourceResourceId: source.id, format });
    return job;
  }

  async getJob(id: string): Promise<ArchiveJob> {
    const job = await this.repository.get(id);
    if (job === undefined) throw new Error("Archive job not found");
    return job;
  }

  listJobs(destinationParentId?: string, limit = 50): Promise<readonly ArchiveJob[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Archive job limit is invalid");
    return this.repository.list(destinationParentId, limit);
  }

  async control(id: string, action: "pause" | "resume" | "cancel"): Promise<ArchiveJob> {
    const current = await this.getJob(id);
    if (["completed", "failed", "cancelled"].includes(current.state)) throw new Error("Archive job is not controllable");
    if (action === "pause" && !["queued", "scanning", "compressing", "extracting"].includes(current.state)) {
      throw new Error("Archive job cannot be paused during verification or commit");
    }
    if (action === "resume" && current.requestedState !== "paused" && current.state !== "paused") throw new Error("Archive job is not paused");
    const requested = action === "resume" ? "running" : action === "pause" ? "paused" : "cancelled";
    const updated = await this.repository.setRequestedState(id, requested);
    const auditAction = action === "pause" ? "paused" : action === "resume" ? "resumed" : "cancelled";
    await this.writeAudit(`archive.job.${auditAction}`, updated, { previousState: current.state });
    return updated;
  }

  private async writeAudit(action: string, job: ArchiveJob, details: Record<string, unknown>): Promise<void> {
    await this.audit?.write({
      actorType: "owner",
      actorId: "owner",
      action,
      ...((job.sourceResourceId ?? job.resultResourceId) === undefined ? {} : { resourceId: job.sourceResourceId ?? job.resultResourceId }),
      outcome: "success",
      correlationId: `${action}:${job.id}`,
      details: { jobId: job.id, kind: job.kind, outputName: job.outputName, ...details },
    }).catch(() => undefined);
  }
}
