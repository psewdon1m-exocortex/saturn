import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { v7 as uuidv7 } from "uuid";
import type { AuditSink } from "@saturn/audit";
import type { StorageAdapter } from "@saturn/storage";
import { joinStoragePath, normalizeStorageName, SATURN_BUSINESS_ROOT_DIRECTORIES, SATURN_SYSTEM_DIRECTORIES } from "@saturn/storage";
import type { CopiedResourceRecord, FileRepository, UploadLimits } from "./repository.js";
import { archivedVersionPurgeAfter } from "./retention.js";
import { detectContentType } from "./content-type.js";
import {
  DROP_POINT_RESOURCE_ID,
  BACKUPS_RESOURCE_ID,
  LABORATORY_RESOURCE_ID,
  MASTERMIND_RESOURCE_ID,
  ROOT_RESOURCE_ID,
  SYNC_RESOURCE_ID,
  VOLT_RESOURCE_ID,
  type CompleteUploadResult,
  type CopyResourceInput,
  type CreateUploadInput,
  type FileOperation,
  type FileVersion,
  type MoveResourceInput,
  type Resource,
  type ResourceMutationInput,
  type SecurityClassification,
  type UploadSession,
} from "./models.js";

export interface FileServiceOptions {
  readonly uploadMaxBytes?: number;
  readonly uploadChunkMaxBytes?: number;
  readonly uploadIncompleteTtlMs?: number;
  readonly trashRetentionMs?: number;
  readonly auditSink?: AuditSink;
}
const CANONICAL_ROOT_RESOURCE_IDS = [
  DROP_POINT_RESOURCE_ID,
  LABORATORY_RESOURCE_ID,
  BACKUPS_RESOURCE_ID,
  MASTERMIND_RESOURCE_ID,
  SYNC_RESOURCE_ID,
  VOLT_RESOURCE_ID,
] as const;
const CANONICAL_ROOT_RESOURCE_ID_SET = new Set<string>(CANONICAL_ROOT_RESOURCE_IDS);
const CANONICAL_DEFAULT_NAME_BY_ID = new Map<string, string>([
  [DROP_POINT_RESOURCE_ID, "drop point"],
  [LABORATORY_RESOURCE_ID, "laboratory"],
  [BACKUPS_RESOURCE_ID, "backups"],
  [MASTERMIND_RESOURCE_ID, "mastermind"],
  [SYNC_RESOURCE_ID, "sync"],
  [VOLT_RESOURCE_ID, "volt"],
]);
const RESERVED_ROOT_NAMES = new Set([...SATURN_BUSINESS_ROOT_DIRECTORIES, "_system"].map((name) => name.toLocaleLowerCase()));
const MUTATION_LOCK_MS = 60 * 60 * 1_000;
const UPLOAD_LOCK_MS = 6 * 60 * 60 * 1_000;
const PURGE_DELETE_CONCURRENCY = 8;

class ReconciliationRequiredError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super("Operation rollback failed and reconciliation is required");
    this.original = original;
  }
}

function validateIdempotencyKey(key: string): string {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new Error("Idempotency key is invalid");
  return key;
}

async function hashStream(stream: Readable): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function collectBounded(stream: Readable, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new Error("MIME probe exceeded its bound");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class FileService {
  readonly #repository: FileRepository;
  readonly #storage: StorageAdapter;
  readonly #uploadMaxBytes: number;
  readonly #uploadBufferMaxBytes: number;
  readonly #uploadChunkMaxBytes: number;
  readonly #uploadIncompleteTtlMs: number;
  readonly #trashRetentionMs: number;
  readonly #audit: AuditSink | undefined;
  readonly #activePurges = new Map<string, Promise<Resource>>();

  constructor(repository: FileRepository, storage: StorageAdapter, options: FileServiceOptions = {}) {
    this.#repository = repository;
    this.#storage = storage;
    this.#uploadMaxBytes = options.uploadMaxBytes ?? 20 * 1024 * 1024 * 1024;
    this.#uploadBufferMaxBytes = 110 * 1024 * 1024 * 1024;
    this.#uploadChunkMaxBytes = options.uploadChunkMaxBytes ?? 8 * 1024 * 1024;
    this.#uploadIncompleteTtlMs = options.uploadIncompleteTtlMs ?? 24 * 60 * 60 * 1_000;
    this.#trashRetentionMs = options.trashRetentionMs ?? 30 * 24 * 60 * 60 * 1_000;
    this.#audit = options.auditSink;
  }

  async initializeStorage(): Promise<void> {
    for (const directory of SATURN_SYSTEM_DIRECTORIES) {
      if (!(await this.#storage.exists(directory))) await this.#storage.mkdir(directory);
    }
    for (const id of CANONICAL_ROOT_RESOURCE_IDS) {
      const resource = await this.getResource(id);
      if (resource.type !== "folder" || resource.parentId !== ROOT_RESOURCE_ID || resource.status !== "active" || resource.storagePath.includes("/")) {
        throw new Error(`Canonical Saturn root is invalid: ${id}`);
      }
      if (!(await this.#storage.exists(resource.storagePath))) await this.#storage.mkdir(resource.storagePath);
      if ((await this.#storage.stat(resource.storagePath)).type !== "directory") throw new Error(`Canonical Saturn root is not a directory: ${id}`);
    }
  }

  async getResource(id: string): Promise<Resource> {
    const resource = await this.#repository.getResource(id);
    if (resource === undefined) throw new Error("Resource not found");
    return resource;
  }

  async getUploadLimits(): Promise<UploadLimits> {
    const configured = await this.#repository.getUploadLimits();
    const limits = configured ?? { bufferMaxBytes: this.#uploadBufferMaxBytes, maximumFileBytes: this.#uploadMaxBytes };
    if (!Number.isSafeInteger(limits.bufferMaxBytes) || limits.bufferMaxBytes < 1
      || !Number.isSafeInteger(limits.maximumFileBytes) || limits.maximumFileBytes < 1
      || limits.maximumFileBytes * 10 > limits.bufferMaxBytes * 9) {
      throw new Error("Upload limits are invalid");
    }
    return limits;
  }

  async listChildren(parentId = ROOT_RESOURCE_ID, offset = 0, limit = 100): Promise<readonly Resource[]> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Folder offset is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Folder limit is invalid");
    const parent = await this.getResource(parentId);
    if (parent.type !== "folder" || parent.status !== "active") throw new Error("Parent folder is not active");
    return this.#repository.listChildren(parentId, offset, limit);
  }

  async resolveFolderPath(segments: readonly string[], rootId = ROOT_RESOURCE_ID): Promise<readonly Resource[]> {
    if (segments.length > 128) throw new Error("Folder path exceeds 128 segments");
    const root = await this.getResource(rootId);
    if (root.type !== "folder" || root.status !== "active") throw new Error("Folder path root is not active");
    const resources: Resource[] = [root];
    let current = root;
    for (const rawSegment of segments) {
      const segment = normalizeStorageName(rawSegment);
      const child = await this.#repository.getChild(current.id, segment);
      if (child === undefined || child.type !== "folder" || child.status !== "active") throw new Error("Folder path not found");
      resources.push(child);
      current = child;
    }
    return resources;
  }

  async listTrash(offset = 0, limit = 100): Promise<readonly Resource[]> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Trash offset is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Trash limit is invalid");
    return this.#repository.listTrash(offset, limit);
  }

  async createFolder(parentId: string, rawName: string, auditActor?: { readonly type: string; readonly id: string }): Promise<Resource> {
    const parent = await this.getResource(parentId);
    if (parent.type !== "folder" || parent.status !== "active") throw new Error("Parent folder is not active");
    const name = normalizeStorageName(rawName);
    this.#assertRootNameAvailable(parent.id, name);
    if (await this.#repository.getChild(parentId, name)) throw new Error("A sibling with this name already exists");
    const storagePath = joinStoragePath(parent.storagePath, name);
    await this.#storage.mkdir(storagePath);
    try {
      const resource = await this.#repository.createFolder({ id: uuidv7(), parentId, name, storagePath });
      await this.#writeAudit("folder.created", `folder:${resource.id}`, resource.id, { parentId, name }, auditActor);
      return resource;
    } catch (error) {
      await this.#storage.delete(storagePath).catch(() => undefined);
      throw error;
    }
  }

  async setSecurityClassification(resourceId: string, classification: SecurityClassification): Promise<Resource> {
    if (!["public", "internal", "confidential", "secret"].includes(classification)) throw new Error("Security classification is invalid");
    const current = await this.getResource(resourceId);
    if (current.status !== "active") throw new Error("Resource is not active");
    if ((current.storagePath === "volt" || current.storagePath.startsWith("volt/")) && !["confidential", "secret"].includes(classification)) {
      throw new Error("Volt resources cannot be downgraded below confidential");
    }
    const updated = await this.#repository.setSecurityClassification(resourceId, classification);
    await this.#writeAudit("resource.classification.changed", `classification:${resourceId}:${uuidv7()}`, resourceId, {
      previous: current.securityClassification ?? "internal",
      current: classification,
    });
    return updated;
  }

  async createUpload(input: CreateUploadInput): Promise<UploadSession> {
    validateIdempotencyKey(input.idempotencyKey);
    const limits = await this.getUploadLimits();
    if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0 || input.expectedSize > limits.maximumFileBytes) {
      throw new Error("Upload size is invalid");
    }
    const expectedSha256 = input.expectedSha256?.toLowerCase();
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Expected SHA-256 is invalid");
    let parentId = input.parentId ?? ROOT_RESOURCE_ID;
    let filename = normalizeStorageName(input.filename);
    let overwrite: Resource | undefined;
    if (input.overwriteResourceId !== undefined) {
      overwrite = await this.getResource(input.overwriteResourceId);
      if (overwrite.type !== "file" || overwrite.status !== "active" || overwrite.parentId === undefined) {
        throw new Error("Overwrite target is not an active file");
      }
      if (input.parentId !== undefined && input.parentId !== overwrite.parentId) throw new Error("Overwrite parent differs from target");
      if (filename.toLocaleLowerCase() !== overwrite.name.toLocaleLowerCase()) throw new Error("Overwrite filename differs from target");
      parentId = overwrite.parentId;
      filename = overwrite.name;
    }
    const parent = await this.getResource(parentId);
    if (parent.type !== "folder" || parent.status !== "active") throw new Error("Upload parent is not active");
    if (parent.id === ROOT_RESOURCE_ID) throw new Error("Files cannot be uploaded directly into the Saturn root");
    const existing = await this.#repository.getUploadByIdempotencyKey(input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.parentId !== parentId || existing.filename.toLocaleLowerCase() !== filename.toLocaleLowerCase() || existing.expectedSize !== input.expectedSize
        || (input.overwriteResourceId !== undefined && existing.overwriteResourceId !== input.overwriteResourceId)
        || (existing.auditActorType ?? "owner_bootstrap") !== (input.auditActor?.type ?? "owner_bootstrap")
        || (existing.auditActorId ?? "owner") !== (input.auditActor?.id ?? "owner")) {
        throw new Error("Idempotency key was already used for different upload parameters");
      }
      return existing;
    }
    if (overwrite === undefined) {
      const sibling = await this.#repository.getChild(parentId, filename);
      if (sibling !== undefined) {
        if (sibling.type !== "file" || sibling.status !== "active") throw new Error("A folder with this name already exists");
        overwrite = sibling;
        filename = sibling.name;
      }
    }
    const id = uuidv7();
    const upload = await this.#repository.createUpload({
      id,
      idempotencyKey: input.idempotencyKey,
      parentId,
      filename,
      tempPath: `_system/incoming/${id}.part`,
      targetPath: joinStoragePath(parent.storagePath, filename),
      expectedSize: input.expectedSize,
      ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      ...(overwrite === undefined ? {} : { overwriteResourceId: overwrite.id }),
      ...(input.auditActor === undefined ? {} : { auditActorType: input.auditActor.type, auditActorId: input.auditActor.id }),
      expiresAt: new Date(Date.now() + this.#uploadIncompleteTtlMs),
    });
    await this.#writeAudit("upload.created", `upload:${input.idempotencyKey}`, undefined, {
      uploadId: upload.id,
      parentId,
      filename,
      expectedSize: input.expectedSize,
      ...(overwrite === undefined ? {} : { overwriteResourceId: overwrite.id }),
    }, input.auditActor);
    return upload;
  }

  async getUpload(id: string): Promise<UploadSession> {
    const upload = await this.#repository.getUpload(id);
    if (upload === undefined) throw new Error("Upload session not found");
    return upload;
  }

  async abandonUpload(id: string): Promise<UploadSession> {
    const lockId = uuidv7();
    if (!(await this.#repository.acquireLocks(lockId, [`upload:${id}`], new Date(Date.now() + MUTATION_LOCK_MS)))) {
      throw new Error("Upload is locked by another operation");
    }
    try {
      const upload = await this.getUpload(id);
      if (upload.status === "abandoned") return upload;
      if (upload.status === "active" || upload.status === "committing") throw new Error("Committed upload cannot be abandoned");
      if (await this.#storage.exists(upload.tempPath)) await this.#storage.delete(upload.tempPath);
      const abandoned = await this.#repository.setUploadState(id, "abandoned");
      await this.#writeAudit("upload.abandoned", `upload-abandon:${id}`, undefined, { uploadId: id }, {
        type: upload.auditActorType ?? "owner_bootstrap",
        id: upload.auditActorId ?? "owner",
      });
      return abandoned;
    } finally {
      await this.#repository.releaseLocks(lockId);
    }
  }

  async appendUpload(id: string, offset: number, contentLength: number, source: Readable): Promise<UploadSession> {
    const lockId = uuidv7();
    if (!(await this.#repository.acquireLocks(lockId, [`upload:${id}`], new Date(Date.now() + UPLOAD_LOCK_MS)))) {
      throw new Error("Upload is locked by another operation");
    }
    try {
      const upload = await this.getUpload(id);
      if (!["created", "uploading", "failed_retryable"].includes(upload.status)) throw new Error("Upload does not accept chunks in its current state");
      if (offset !== upload.receivedSize) throw new Error(`Upload offset mismatch; expected ${String(upload.receivedSize)}`);
      if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > this.#uploadChunkMaxBytes
        || offset + contentLength > upload.expectedSize) {
        throw new Error("Upload chunk length is invalid");
      }
      const written = await this.#storage.write(upload.tempPath, source, {
        offset,
        create: offset === 0,
        exclusive: offset === 0,
        truncate: false,
      });
      if (written !== contentLength) {
        await this.#rollbackPartialChunk(upload.tempPath, offset);
        throw new Error("Received chunk length differs from Content-Length");
      }
      return await this.#repository.updateUploadProgress(id, offset, offset + written);
    } catch (error) {
      const upload = await this.#repository.getUpload(id);
      if (upload !== undefined && upload.receivedSize === offset) {
        await this.#rollbackPartialChunk(upload.tempPath, offset).catch(() => undefined);
      }
      await this.#repository.setUploadState(id, "failed_retryable", { errorCode: "chunk_write_failed" });
      throw error;
    } finally {
      await this.#repository.releaseLocks(lockId);
    }
  }

  async completeUpload(id: string): Promise<CompleteUploadResult> {
    const preliminary = await this.getUpload(id);
    if (preliminary.status === "active" && preliminary.resourceId !== undefined) {
      return { upload: preliminary, resource: await this.getResource(preliminary.resourceId) };
    }
    const lockId = uuidv7();
    const destinationLock = `upload-target:${preliminary.parentId}:${preliminary.filename.toLocaleLowerCase()}`;
    if (!(await this.#acquireLocksWithin(lockId, [`upload:${id}`, destinationLock], UPLOAD_LOCK_MS, 30_000))) {
      throw new Error("Upload is locked by another operation");
    }
    try {
      const upload = await this.getUpload(id);
      if (upload.status === "active" && upload.resourceId !== undefined) {
        return { upload, resource: await this.getResource(upload.resourceId) };
      }
      if (!["created", "uploading", "failed_retryable"].includes(upload.status)) throw new Error("Upload cannot be completed in its current state");
      if (upload.receivedSize !== upload.expectedSize) throw new Error("Upload is incomplete");
      await this.#repository.setUploadState(id, "verifying");
      if (upload.expectedSize === 0 && !(await this.#storage.exists(upload.tempPath))) {
        await this.#storage.write(upload.tempPath, Readable.from(Buffer.alloc(0)), {
          offset: 0,
          create: true,
          exclusive: true,
          truncate: true,
        });
      }
      const attributes = await this.#storage.stat(upload.tempPath);
      if (attributes.size !== upload.expectedSize) {
        await this.#repository.setUploadState(id, "failed_final", { errorCode: "size_mismatch" });
        throw new Error("Stored upload size differs from expected size");
      }
      const digest = await hashStream(await this.#storage.openRead(upload.tempPath));
      if (digest.bytes !== upload.expectedSize || (upload.expectedSha256 !== undefined && digest.sha256 !== upload.expectedSha256)) {
        await this.#repository.setUploadState(id, "failed_final", { actualSha256: digest.sha256, errorCode: "checksum_mismatch" });
        throw new Error("Upload checksum verification failed");
      }
      const probeBytes = Math.min(upload.expectedSize, 64 * 1024);
      const probe = probeBytes === 0 ? Buffer.alloc(0) : await collectBounded(
        await this.#storage.openRead(upload.tempPath, { offset: 0, length: probeBytes }),
        64 * 1024,
      );
      const mimeType = await detectContentType(upload.filename, probe);
      await this.#repository.setUploadState(id, "committing", { actualSha256: digest.sha256 });
      const target = upload.overwriteResourceId === undefined
        ? await this.#repository.getChild(upload.parentId, upload.filename)
        : await this.getResource(upload.overwriteResourceId);
      if (target !== undefined) {
        if (target.type !== "file" || target.status !== "active" || target.currentVersionId === undefined
          || target.parentId !== upload.parentId || target.name.toLocaleLowerCase() !== upload.filename.toLocaleLowerCase()) {
          await this.#repository.setUploadState(id, "failed_final", { errorCode: "overwrite_target_invalid" });
          throw new Error("Overwrite target is not an active versioned file");
        }
        if (!(await this.#storage.exists(upload.targetPath))) {
          await this.#repository.setUploadState(id, "failed_retryable", { errorCode: "overwrite_target_missing" });
          throw new Error("Overwrite target is missing from storage");
        }
        const archiveDirectory = `_system/versions/${target.id}/${target.currentVersionId}`;
        const archivePath = joinStoragePath(archiveDirectory, target.name);
        await this.#ensureDirectoryChain(archiveDirectory);
        await this.#storage.rename(upload.targetPath, archivePath);
        try {
          await this.#storage.rename(upload.tempPath, upload.targetPath);
        } catch (error) {
          await this.#storage.rename(archivePath, upload.targetPath).catch(() => undefined);
          await this.#repository.setUploadState(id, "failed_retryable", { errorCode: "overwrite_storage_failed" });
          throw error;
        }
        try {
          const previousVersionPurgeAfter = archivedVersionPurgeAfter(target.retentionClass ?? "general", new Date());
          const completed = await this.#repository.commitOverwrite({
            uploadId: upload.id,
            resourceId: target.id,
            versionId: uuidv7(),
            parentId: upload.parentId,
            filename: upload.filename,
            storagePath: upload.targetPath,
            sizeBytes: upload.expectedSize,
            sha256: digest.sha256,
            mimeType,
            previousVersionId: target.currentVersionId,
            previousVersionArchivePath: archivePath,
            ...(previousVersionPurgeAfter === undefined ? {} : { previousVersionPurgeAfter }),
          });
          await this.#writeAudit("file.overwritten", `upload-complete:${upload.id}`, target.id, {
            previousVersionId: target.currentVersionId,
            currentVersionId: completed.resource.currentVersionId,
            sha256: digest.sha256,
          }, { type: upload.auditActorType ?? "owner_bootstrap", id: upload.auditActorId ?? "owner" });
          return completed;
        } catch (error) {
          try {
            await this.#storage.rename(upload.targetPath, upload.tempPath);
            await this.#storage.rename(archivePath, upload.targetPath);
            await this.#repository.setUploadState(id, "failed_retryable", { errorCode: "overwrite_database_failed" });
          } catch {
            await this.#repository.setUploadState(id, "committing", { errorCode: "reconciliation_required" });
          }
          throw error;
        }
      }
      if (await this.#storage.exists(upload.targetPath)) {
        await this.#repository.setUploadState(id, "failed_final", { errorCode: "target_exists" });
        throw new Error("Upload target already exists");
      }
      await this.#storage.rename(upload.tempPath, upload.targetPath);
      try {
        const completed = await this.#repository.commitUpload({
          uploadId: upload.id,
          resourceId: uuidv7(),
          versionId: uuidv7(),
          parentId: upload.parentId,
          filename: upload.filename,
          storagePath: upload.targetPath,
          sizeBytes: upload.expectedSize,
          sha256: digest.sha256,
          mimeType,
        });
        await this.#writeAudit("file.upload.completed", `upload-complete:${upload.id}`, completed.resource.id, {
          sizeBytes: upload.expectedSize,
          sha256: digest.sha256,
          mimeType,
        }, { type: upload.auditActorType ?? "owner_bootstrap", id: upload.auditActorId ?? "owner" });
        return completed;
      } catch (error) {
        try {
          await this.#storage.rename(upload.targetPath, upload.tempPath);
          await this.#repository.setUploadState(id, "failed_retryable", { actualSha256: digest.sha256, errorCode: "database_commit_failed" });
        } catch {
          await this.#repository.setUploadState(id, "committing", { actualSha256: digest.sha256, errorCode: "reconciliation_required" });
        }
        throw error;
      }
    } catch (error) {
      const current = await this.#repository.getUpload(id);
      if (current?.status === "verifying") {
        await this.#repository.setUploadState(id, "failed_retryable", { errorCode: "verification_interrupted" });
      }
      throw error;
    } finally {
      await this.#repository.releaseLocks(lockId);
    }
  }

  async openDownload(resourceId: string, offset = 0, length?: number, auditActor?: { readonly type: string; readonly id: string }): Promise<{ readonly resource: Resource; readonly stream: Readable }> {
    const resource = await this.getResource(resourceId);
    if (resource.type !== "file" || resource.status !== "active") throw new Error("Resource is not an active file");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > resource.sizeBytes) throw new Error("Download offset is invalid");
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 1 || offset + length > resource.sizeBytes)) {
      throw new Error("Download length is invalid");
    }
    const stream = await this.#storage.openRead(resource.storagePath, { offset, ...(length === undefined ? {} : { length }) });
    await this.#writeAudit("file.download.opened", `download:${uuidv7()}`, resource.id, {
      offset,
      length: length ?? resource.sizeBytes - offset,
    }, auditActor);
    return { resource, stream };
  }

  async openVersionDownload(resourceId: string, versionId: string, offset = 0, length?: number, auditActor?: { readonly type: string; readonly id: string }): Promise<{ readonly resource: Resource; readonly version: FileVersion; readonly stream: Readable }> {
    const resource = await this.getResource(resourceId);
    if (resource.type !== "file" || resource.status !== "active") throw new Error("Resource is not an active file");
    const version = await this.#repository.getVersion(resourceId, versionId);
    if (version === undefined || version.state !== "active") throw new Error("File version not found");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > version.sizeBytes) throw new Error("Download offset is invalid");
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 1 || offset + length > version.sizeBytes)) throw new Error("Download length is invalid");
    const stream = await this.#storage.openRead(version.storagePath, { offset, ...(length === undefined ? {} : { length }) });
    await this.#writeAudit("file.version.download.opened", `version-download:${uuidv7()}`, resource.id, {
      versionId,
      offset,
      length: length ?? version.sizeBytes - offset,
    }, auditActor);
    return { resource, version, stream };
  }

  async moveResource(resourceId: string, input: MoveResourceInput): Promise<Resource> {
    const source = await this.getResource(resourceId);
    const completed = await this.#completedMutation("move", input.idempotencyKey, resourceId);
    if (completed !== undefined) return completed;
    if (source.id === ROOT_RESOURCE_ID || source.status !== "active") throw new Error("Resource cannot be moved");
    const targetParent = await this.getResource(input.parentId);
    if (targetParent.type !== "folder" || targetParent.status !== "active") throw new Error("Move destination is not active");
    const name = normalizeStorageName(input.name ?? source.name);
    if (CANONICAL_ROOT_RESOURCE_ID_SET.has(source.id) && targetParent.id !== ROOT_RESOURCE_ID) {
      throw new Error("Canonical Saturn roots can be renamed but cannot be moved");
    }
    if (targetParent.id === ROOT_RESOURCE_ID && source.type !== "folder") throw new Error("Only folders can be placed directly in the Saturn root");
    this.#assertRootNameAvailable(targetParent.id, name, source.id);
    const newPath = joinStoragePath(targetParent.storagePath, name);
    if (source.type === "folder" && (targetParent.storagePath === source.storagePath || targetParent.storagePath.startsWith(`${source.storagePath}/`))) {
      throw new Error("A folder cannot be moved into itself");
    }
    if (newPath === source.storagePath) return source;
    const sibling = await this.#repository.getChild(targetParent.id, name);
    if (sibling !== undefined && sibling.id !== source.id) throw new Error("A sibling with this name already exists");
    const tree = await this.#repository.listTree(source.storagePath);
    const operation = await this.#beginMutation("move", input.idempotencyKey, source.id, {
      oldPath: source.storagePath,
      newPath,
      parentId: targetParent.id,
      name,
    });
    if (operation.state === "active" && operation.resourceId !== undefined) return this.getResource(operation.resourceId);
    return this.#withMutationLocks(operation, [...tree.map((item) => `resource:${item.id}`), `resource:${targetParent.id}`], async () => {
      await this.#repository.setOperationState(operation.id, "storage_committing");
      await this.#storage.rename(source.storagePath, newPath);
      try {
        const moved = await this.#repository.moveTree({
          operationId: operation.id,
          resourceId: source.id,
          parentId: targetParent.id,
          name,
          oldPath: source.storagePath,
          newPath,
        });
        await this.#writeAudit("resource.moved", `mutation:${input.idempotencyKey}`, moved.id, {
          oldPath: source.storagePath,
          newPath,
        }, input.auditActor);
        return moved;
      } catch (error) {
        await this.#rollbackRename(operation.id, newPath, source.storagePath);
        throw error;
      }
    });
  }

  async copyResource(resourceId: string, input: CopyResourceInput): Promise<Resource> {
    const source = await this.getResource(resourceId);
    const completed = await this.#completedMutation("copy", input.idempotencyKey, resourceId);
    if (completed !== undefined) return completed;
    if (source.id === ROOT_RESOURCE_ID || source.status !== "active") throw new Error("Resource cannot be copied");
    const targetParent = await this.getResource(input.parentId);
    if (targetParent.type !== "folder" || targetParent.status !== "active") throw new Error("Copy destination is not active");
    const name = normalizeStorageName(input.name ?? source.name);
    if (targetParent.id === ROOT_RESOURCE_ID && source.type !== "folder") throw new Error("Only folders can be placed directly in the Saturn root");
    this.#assertRootNameAvailable(targetParent.id, name, source.id);
    const targetPath = joinStoragePath(targetParent.storagePath, name);
    if (source.type === "folder" && (targetPath === source.storagePath || targetPath.startsWith(`${source.storagePath}/`))) {
      throw new Error("A folder cannot be copied into itself");
    }
    if (await this.#repository.getChild(targetParent.id, name)) throw new Error("A sibling with this name already exists");
    const tree = await this.#repository.listTree(source.storagePath);
    const operation = await this.#beginMutation("copy", input.idempotencyKey, source.id, {
      sourcePath: source.storagePath,
      targetPath,
      parentId: targetParent.id,
      name,
    });
    if (operation.state === "active" && operation.resourceId !== undefined) return this.getResource(operation.resourceId);
    const idBySource = new Map(tree.map((item) => [item.id, uuidv7()]));
    const rootResourceId = idBySource.get(source.id);
    if (rootResourceId === undefined) throw new Error("Copy tree has no root");
    const records: CopiedResourceRecord[] = tree.map((item) => {
      const id = idBySource.get(item.id);
      if (id === undefined) throw new Error("Copy resource ID mapping is incomplete");
      const relative = item.storagePath === source.storagePath ? "" : item.storagePath.slice(source.storagePath.length + 1);
      const storagePath = relative ? joinStoragePath(targetPath, relative) : targetPath;
      const parentId = item.id === source.id
        ? targetParent.id
        : item.parentId === undefined ? targetParent.id : idBySource.get(item.parentId);
      if (parentId === undefined) throw new Error("Copy parent ID mapping is incomplete");
      return {
        id,
        ...(item.type === "file" ? { versionId: uuidv7() } : {}),
        type: item.type,
        parentId,
        name: item.id === source.id ? name : item.name,
        storagePath,
        ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
        sizeBytes: item.sizeBytes,
        ...(item.sha256 === undefined ? {} : { sha256: item.sha256 }),
      };
    });
    return this.#withMutationLocks(operation, [...tree.map((item) => `resource:${item.id}`), `resource:${targetParent.id}`], async () => {
      const created: string[] = [];
      try {
        for (const [index, item] of tree.entries()) {
          const destination = records[index]?.storagePath;
          if (destination === undefined) throw new Error("Copy path mapping is incomplete");
          if (item.type === "folder") await this.#storage.mkdir(destination);
          else await this.#storage.copy(item.storagePath, destination);
          created.push(destination);
        }
        await this.#repository.setOperationState(operation.id, "storage_committed");
        const copied = await this.#repository.createCopiedTree({ operationId: operation.id, rootResourceId, resources: records });
        await this.#writeAudit("resource.copied", `mutation:${input.idempotencyKey}`, copied.id, {
          sourceResourceId: source.id,
          targetPath,
        }, input.auditActor);
        return copied;
      } catch (error) {
        await this.#cleanupPaths(created);
        await this.#repository.setOperationState(operation.id, "failed_retryable", { errorCode: "copy_failed" });
        throw error;
      }
    });
  }

  async trashResource(resourceId: string, input: ResourceMutationInput): Promise<Resource> {
    const source = await this.getResource(resourceId);
    const completed = await this.#completedMutation("trash", input.idempotencyKey, resourceId);
    if (completed !== undefined) return completed;
    if (source.id === ROOT_RESOURCE_ID || CANONICAL_ROOT_RESOURCE_ID_SET.has(source.id) || source.status !== "active") throw new Error("Resource cannot be trashed");
    const tree = await this.#repository.listTree(source.storagePath);
    const configuredRetentionDays = await this.#repository.getTrashRetentionDays();
    const retentionMs = Number.isSafeInteger(configuredRetentionDays) && configuredRetentionDays >= 1 && configuredRetentionDays <= 365
      ? configuredRetentionDays * 24 * 60 * 60 * 1_000
      : this.#trashRetentionMs;
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const trashDirectory = `_system/trash/${year}/${month}/${source.id}`;
    const trashPath = joinStoragePath(trashDirectory, source.name);
    const operation = await this.#beginMutation("trash", input.idempotencyKey, source.id, {
      oldPath: source.storagePath,
      trashPath,
    });
    if (operation.state === "active" && operation.resourceId !== undefined) return this.getResource(operation.resourceId);
    return this.#withMutationLocks(operation, tree.map((item) => `resource:${item.id}`), async () => {
      await this.#ensureDirectoryChain(trashDirectory);
      await this.#repository.setOperationState(operation.id, "storage_committing");
      await this.#storage.rename(source.storagePath, trashPath);
      try {
        const trashed = await this.#repository.trashTree({
          operationId: operation.id,
          resourceId: source.id,
          oldPath: source.storagePath,
          trashPath,
          purgeAfter: new Date(now.getTime() + retentionMs),
        });
        await this.#writeAudit("resource.trashed", `mutation:${input.idempotencyKey}`, trashed.id, {
          oldPath: source.storagePath,
          trashPath,
          purgeAfter: trashed.purgeAfter,
        }, input.auditActor);
        return trashed;
      } catch (error) {
        await this.#rollbackRename(operation.id, trashPath, source.storagePath);
        throw error;
      }
    });
  }

  async restoreResource(resourceId: string, input: ResourceMutationInput): Promise<Resource> {
    const source = await this.getResource(resourceId);
    const completed = await this.#completedMutation("restore", input.idempotencyKey, resourceId);
    if (completed !== undefined) return completed;
    if (source.status !== "trashed" || source.trashedFromParentId === undefined || source.trashedFromName === undefined) {
      throw new Error("Resource cannot be restored from trash");
    }
    const parent = await this.getResource(source.trashedFromParentId);
    if (parent.type !== "folder" || parent.status !== "active") throw new Error("Restore parent is not active");
    if (await this.#repository.getChild(parent.id, source.trashedFromName)) throw new Error("Restore target already exists");
    const restoredPath = joinStoragePath(parent.storagePath, source.trashedFromName);
    const tree = await this.#repository.listTree(source.storagePath);
    const operation = await this.#beginMutation("restore", input.idempotencyKey, source.id, {
      oldPath: source.storagePath,
      restoredPath,
      parentId: parent.id,
      name: source.trashedFromName,
    });
    if (operation.state === "active" && operation.resourceId !== undefined) return this.getResource(operation.resourceId);
    return this.#withMutationLocks(operation, [...tree.map((item) => `resource:${item.id}`), `resource:${parent.id}`], async () => {
      await this.#repository.setOperationState(operation.id, "storage_committing");
      await this.#storage.rename(source.storagePath, restoredPath);
      try {
        const restored = await this.#repository.restoreTree({
          operationId: operation.id,
          resourceId: source.id,
          oldPath: source.storagePath,
          restoredPath,
          parentId: parent.id,
          name: source.trashedFromName ?? source.name,
        });
        await this.#writeAudit("resource.restored", `mutation:${input.idempotencyKey}`, restored.id, {
          trashPath: source.storagePath,
          restoredPath,
        });
        return restored;
      } catch (error) {
        await this.#rollbackRename(operation.id, restoredPath, source.storagePath);
        throw error;
      }
    });
  }

  purgeTrashResource(resourceId: string, input: ResourceMutationInput): Promise<Resource> {
    const active = this.#activePurges.get(resourceId);
    if (active !== undefined) return active;
    const execution = this.#executeTrashPurge(resourceId, input);
    const tracked = execution.finally(() => {
      if (this.#activePurges.get(resourceId) === tracked) this.#activePurges.delete(resourceId);
    });
    this.#activePurges.set(resourceId, tracked);
    return tracked;
  }

  async #executeTrashPurge(resourceId: string, input: ResourceMutationInput): Promise<Resource> {
    const source = await this.getResource(resourceId);
    const completed = await this.#completedMutation("purge", input.idempotencyKey, resourceId);
    if (completed !== undefined) return completed;
    if (source.status !== "trashed" || source.trashedFromParentId === undefined) {
      throw new Error("Only a top-level resource in trash can be permanently deleted");
    }
    const tree = await this.#repository.listTree(source.storagePath);
    const versionStoragePaths = new Set<string>();
    for (const item of tree) {
      if (item.type !== "file") continue;
      for (let offset = 0; ; offset += 500) {
        const versions = await this.#repository.listVersions(item.id, offset, 500);
        for (const version of versions) {
          if (version.storagePath !== source.storagePath && !version.storagePath.startsWith(`${source.storagePath}/`)) {
            versionStoragePaths.add(version.storagePath);
          }
        }
        if (versions.length < 500) break;
      }
    }
    const operation = await this.#beginMutation("purge", input.idempotencyKey, source.id, {
      storagePath: source.storagePath,
      resourceType: source.type,
      resourceCount: tree.length,
      versionStorageObjectCount: versionStoragePaths.size,
    });
    if (operation.state === "active" && operation.resourceId !== undefined) return this.getResource(operation.resourceId);
    return this.#withMutationLocks(operation, tree.map((item) => `resource:${item.id}`), async () => {
      try {
        await this.#repository.setOperationState(operation.id, "storage_committing");
        if (await this.#storage.exists(source.storagePath)) {
          await this.#deleteStorageTree(source.storagePath, source.type === "folder" ? "directory" : "file");
        }
        const versionPaths = [...versionStoragePaths];
        for (let offset = 0; offset < versionPaths.length; offset += PURGE_DELETE_CONCURRENCY) {
          await this.#runDeletionBatch(versionPaths.slice(offset, offset + PURGE_DELETE_CONCURRENCY).map((storagePath) => async () => {
            if (await this.#storage.exists(storagePath)) await this.#storage.delete(storagePath);
          }));
        }
        await this.#repository.setOperationState(operation.id, "storage_committed");
        const purged = await this.#repository.purgeTrashTree({ operationId: operation.id, resourceId: source.id });
        await this.#writeAudit("resource.purged_manually", `mutation:${input.idempotencyKey}`, purged.id, {
          storagePath: source.storagePath,
          resourceType: source.type,
          resourceCount: tree.length,
          versionStorageObjectCount: versionStoragePaths.size,
          previousPurgeAfter: source.purgeAfter,
        }, input.auditActor);
        return purged;
      } catch (error) {
        await this.#repository.setOperationState(operation.id, "failed_retryable", { errorCode: "purge_commit_failed" });
        throw error;
      }
    });
  }

  async listVersions(resourceId: string, offset = 0, limit = 100) {
    const resource = await this.getResource(resourceId);
    if (resource.type !== "file") throw new Error("Versions are available only for files");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Version page is invalid");
    }
    return this.#repository.listVersions(resourceId, offset, limit);
  }

  async getVersion(resourceId: string, versionId: string): Promise<FileVersion> {
    const resource = await this.getResource(resourceId);
    if (resource.type !== "file") throw new Error("Versions are available only for files");
    const version = await this.#repository.getVersion(resourceId, versionId);
    if (version === undefined) throw new Error("File version not found");
    return version;
  }

  async restoreVersion(resourceId: string, versionId: string, input: ResourceMutationInput): Promise<Resource> {
    const resource = await this.getResource(resourceId);
    const completed = await this.#completedMutation("version_restore", input.idempotencyKey, resourceId);
    if (completed !== undefined) return completed;
    if (resource.type !== "file" || resource.status !== "active" || resource.currentVersionId === undefined) {
      throw new Error("File version cannot be restored");
    }
    const currentVersionId = resource.currentVersionId;
    if (currentVersionId === versionId) return resource;
    const selected = await this.#repository.getVersion(resourceId, versionId);
    if (selected === undefined || selected.state !== "active") throw new Error("File version not found");
    const operation = await this.#beginMutation("version_restore", input.idempotencyKey, resource.id, {
      versionId,
      currentVersionId,
      storagePath: resource.storagePath,
    });
    if (operation.state === "active" && operation.resourceId !== undefined) return this.getResource(operation.resourceId);
    return this.#withMutationLocks(operation, [`resource:${resource.id}`], async () => {
      const archiveDirectory = `_system/versions/${resource.id}/${currentVersionId}`;
      const archivePath = joinStoragePath(archiveDirectory, resource.name);
      const temporaryPath = `_system/incoming/${operation.id}.restore`;
      await this.#ensureDirectoryChain(archiveDirectory);
      try {
        await this.#storage.copy(selected.storagePath, temporaryPath);
        const digest = await hashStream(await this.#storage.openRead(temporaryPath));
        if (digest.bytes !== selected.sizeBytes || digest.sha256 !== selected.sha256) {
          throw new Error("Restored version checksum verification failed");
        }
        await this.#storage.rename(resource.storagePath, archivePath);
        try {
          await this.#storage.rename(temporaryPath, resource.storagePath);
        } catch (error) {
          await this.#storage.rename(archivePath, resource.storagePath).catch(() => undefined);
          throw error;
        }
        const previousVersionPurgeAfter = archivedVersionPurgeAfter(resource.retentionClass ?? "general", new Date());
        try {
          const restored = await this.#repository.commitVersionRestore({
            operationId: operation.id,
            resourceId: resource.id,
            previousVersionId: currentVersionId,
            previousVersionArchivePath: archivePath,
            ...(previousVersionPurgeAfter === undefined ? {} : { previousVersionPurgeAfter }),
            newVersionId: uuidv7(),
            storagePath: resource.storagePath,
            sha256: selected.sha256,
            sizeBytes: selected.sizeBytes,
            mimeType: selected.mimeType,
          });
          await this.#writeAudit("file.version.restored", `mutation:${input.idempotencyKey}`, resource.id, {
            sourceVersionId: selected.id,
            currentVersionId: restored.currentVersionId,
          });
          return restored;
        } catch (error) {
          try {
            await this.#storage.rename(resource.storagePath, temporaryPath);
            await this.#storage.rename(archivePath, resource.storagePath);
            await this.#storage.delete(temporaryPath);
            await this.#repository.setOperationState(operation.id, "failed_retryable", { errorCode: "version_restore_database_failed" });
          } catch {
            await this.#repository.setOperationState(operation.id, "rollback_failed", { errorCode: "reconciliation_required" });
            throw new ReconciliationRequiredError(error);
          }
          throw error;
        }
      } catch (error) {
        if (await this.#storage.exists(temporaryPath).catch(() => false)) await this.#storage.delete(temporaryPath).catch(() => undefined);
        if (!(error instanceof ReconciliationRequiredError)) {
          await this.#repository.setOperationState(operation.id, "failed_retryable", { errorCode: "version_restore_failed" });
        }
        throw error instanceof ReconciliationRequiredError ? error.original : error;
      }
    });
  }

  #assertRootNameAvailable(parentId: string, name: string, sourceResourceId?: string): void {
    if (parentId !== ROOT_RESOURCE_ID) return;
    const normalized = name.toLocaleLowerCase();
    if (!RESERVED_ROOT_NAMES.has(normalized)) return;
    const ownDefaultName = sourceResourceId === undefined ? undefined : CANONICAL_DEFAULT_NAME_BY_ID.get(sourceResourceId);
    if (ownDefaultName?.toLocaleLowerCase() === normalized) return;
    throw new Error("The requested Saturn root name is reserved");
  }

  async #beginMutation(
    operationType: FileOperation["operationType"],
    rawIdempotencyKey: string,
    resourceId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<FileOperation> {
    const idempotencyKey = `mutation:${validateIdempotencyKey(rawIdempotencyKey)}`;
    const existing = await this.#repository.getOperation(idempotencyKey);
    if (existing !== undefined) {
      if (existing.operationType !== operationType || existing.payload.sourceResourceId !== resourceId) {
        throw new Error("Idempotency key was already used for another operation");
      }
      if (!["active", "failed_retryable"].includes(existing.state)) {
        throw new Error("Operation is already in progress or requires reconciliation");
      }
      return existing;
    }
    return this.#repository.createOperation({
      id: uuidv7(),
      operationType,
      idempotencyKey,
      resourceId,
      payload: { ...payload, sourceResourceId: resourceId },
    });
  }

  async #completedMutation(
    operationType: FileOperation["operationType"],
    rawIdempotencyKey: string,
    sourceResourceId: string,
  ): Promise<Resource | undefined> {
    const existing = await this.#repository.getOperation(`mutation:${validateIdempotencyKey(rawIdempotencyKey)}`);
    if (existing === undefined) return undefined;
    if (existing.operationType !== operationType || existing.payload.sourceResourceId !== sourceResourceId) {
      throw new Error("Idempotency key was already used for another operation");
    }
    return existing.state === "active" && existing.resourceId !== undefined
      ? this.getResource(existing.resourceId)
      : undefined;
  }

  async #withMutationLocks<T>(operation: FileOperation, keys: readonly string[], action: () => Promise<T>): Promise<T> {
    if (!(await this.#repository.acquireLocks(operation.id, keys, new Date(Date.now() + MUTATION_LOCK_MS)))) {
      await this.#repository.setOperationState(operation.id, "failed_retryable", { errorCode: "resource_locked" });
      throw new Error("Resource is locked by another operation");
    }
    try {
      return await action();
    } finally {
      await this.#repository.releaseLocks(operation.id);
    }
  }

  async #acquireLocksWithin(operationId: string, keys: readonly string[], lockTtlMs: number, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    const maximumAttempts = Math.ceil(waitMs / 50) + 1;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (await this.#repository.acquireLocks(operationId, keys, new Date(Date.now() + lockTtlMs))) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
    return false;
  }

  async #rollbackPartialChunk(storagePath: string, offset: number): Promise<void> {
    if (!(await this.#storage.exists(storagePath))) return;
    if (offset === 0) await this.#storage.delete(storagePath);
    else await this.#storage.truncate(storagePath, offset);
  }

  async #rollbackRename(operationId: string, from: string, to: string): Promise<void> {
    try {
      await this.#storage.rename(from, to);
      await this.#repository.setOperationState(operationId, "failed_retryable", { errorCode: "database_commit_failed" });
    } catch {
      await this.#repository.setOperationState(operationId, "rollback_failed", { errorCode: "reconciliation_required" });
    }
  }

  async #ensureDirectoryChain(storagePath: string): Promise<void> {
    let current = "";
    for (const segment of storagePath.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.#storage.exists(current))) await this.#storage.mkdir(current);
    }
  }

  async #deleteStorageTree(storagePath: string, knownType?: "file" | "directory"): Promise<void> {
    const entryType = knownType ?? (await this.#storage.stat(storagePath)).type;
    if (entryType === "file") {
      await this.#storage.delete(storagePath);
      return;
    }
    for (;;) {
      const page = await this.#storage.list(storagePath, undefined, 500);
      for (let offset = 0; offset < page.entries.length; offset += PURGE_DELETE_CONCURRENCY) {
        const children = page.entries.slice(offset, offset + PURGE_DELETE_CONCURRENCY);
        await this.#runDeletionBatch(children.map((child) => async () => this.#deleteStorageTree(child.path, child.type)));
      }
      if (page.nextCursor === undefined) break;
    }
    await this.#storage.delete(storagePath);
  }

  async #runDeletionBatch(actions: readonly (() => Promise<void>)[]): Promise<void> {
    const results = await Promise.allSettled(actions.map(async (action) => action()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed !== undefined) throw failed.reason;
  }

  async #cleanupPaths(paths: readonly string[]): Promise<void> {
    for (const storagePath of [...paths].reverse()) {
      await this.#storage.delete(storagePath).catch(() => undefined);
    }
  }

  async #writeAudit(
    action: string,
    correlationId: string,
    resourceId: string | undefined,
    details: Readonly<Record<string, unknown>>,
    actor: { readonly type: string; readonly id: string } = { type: "owner_bootstrap", id: "owner" },
  ): Promise<void> {
    if (this.#audit === undefined) return;
    try {
      await this.#audit.write({
        actorType: actor.type,
        actorId: actor.id,
        action,
        ...(resourceId === undefined ? {} : { resourceId }),
        outcome: "success",
        correlationId,
        details,
      });
    } catch {
      // File/storage correctness takes precedence. Readiness and reconciliation
      // expose a database outage; an audit outage must never invert a committed rename.
    }
  }
}
