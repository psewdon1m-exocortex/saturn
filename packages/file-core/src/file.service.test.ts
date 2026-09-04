import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "@saturn/storage";
import { FileService } from "./file.service.js";
import {
  BACKUPS_RESOURCE_ID,
  DROP_POINT_RESOURCE_ID,
  LABORATORY_RESOURCE_ID,
  MASTERMIND_RESOURCE_ID,
  ROOT_RESOURCE_ID,
  SYNC_RESOURCE_ID,
  VOLT_RESOURCE_ID,
  type FileOperation,
  type FileVersion,
  type Resource,
  type SecurityClassification,
  type UploadSession,
  type UploadStatus,
} from "./models.js";
import type {
  CommitUploadRecord,
  CommitOverwriteRecord,
  CommitVersionRestoreRecord,
  CompleteUploadRecordResult,
  CopiedResourceRecord,
  CreateUploadRecord,
  FileRepository,
} from "./repository.js";

class MemoryRepository implements FileRepository {
  readonly resources = new Map<string, Resource>();
  readonly uploads = new Map<string, UploadSession>();
  readonly operations = new Map<string, FileOperation>();
  readonly versions = new Map<string, FileVersion>();
  readonly locks = new Map<string, { operationId: string; expiresAt: Date }>();
  purgeFailuresRemaining = 0;

  constructor() {
    const now = new Date();
    this.resources.set(ROOT_RESOURCE_ID, {
      id: ROOT_RESOURCE_ID,
      type: "folder",
      name: "root",
      storagePath: "",
      sizeBytes: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    for (const [id, name] of [
      [DROP_POINT_RESOURCE_ID, "drop point"],
      [LABORATORY_RESOURCE_ID, "laboratory"],
      [BACKUPS_RESOURCE_ID, "backups"],
      [MASTERMIND_RESOURCE_ID, "mastermind"],
      [SYNC_RESOURCE_ID, "sync"],
      [VOLT_RESOURCE_ID, "volt"],
    ] as const) {
      this.resources.set(id, {
        id,
        parentId: ROOT_RESOURCE_ID,
        type: "folder",
        name,
        storagePath: name,
        sizeBytes: 0,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  async getResource(id: string) { return this.resources.get(id); }
  async getChild(parentId: string, name: string) {
    return [...this.resources.values()].find((item) => item.parentId === parentId && item.name.toLowerCase() === name.toLowerCase() && item.status === "active");
  }
  async listChildren(parentId: string, offset: number, limit: number) {
    return [...this.resources.values()].filter((item) => item.parentId === parentId && item.status === "active").slice(offset, offset + limit);
  }

  async listTrash(offset: number, limit: number) {
    return [...this.resources.values()].filter((item) => item.status === "trashed" && item.trashedFromParentId !== undefined).slice(offset, offset + limit);
  }
  async listTree(storagePath: string) {
    return [...this.resources.values()]
      .filter((item) => item.storagePath === storagePath || item.storagePath.startsWith(`${storagePath}/`))
      .sort((left, right) => left.storagePath.length - right.storagePath.length);
  }
  async createFolder(record: { readonly id: string; readonly parentId: string; readonly name: string; readonly storagePath: string }) {
    const now = new Date();
    const resource: Resource = { ...record, type: "folder", sizeBytes: 0, status: "active", createdAt: now, updatedAt: now };
    this.resources.set(resource.id, resource);
    this.#adjustAncestorSizes(record.parentId, 0);
    return resource;
  }
  async setSecurityClassification(id: string, classification: SecurityClassification) {
    const current = this.resources.get(id);
    if (current === undefined) throw new Error("missing");
    const updated = { ...current, securityClassification: classification, updatedAt: new Date() };
    this.resources.set(id, updated);
    return updated;
  }
  async getUpload(id: string) { return this.uploads.get(id); }
  async getUploadByIdempotencyKey(key: string) {
    return [...this.uploads.values()].find((item) => item.idempotencyKey === key);
  }
  async createUpload(record: CreateUploadRecord) {
    const now = new Date();
    const upload: UploadSession = {
      ...record,
      receivedSize: 0,
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    this.uploads.set(upload.id, upload);
    return upload;
  }
  async updateUploadProgress(id: string, expectedOffset: number, newOffset: number) {
    const current = this.uploads.get(id);
    if (current === undefined || current.receivedSize !== expectedOffset) throw new Error("Upload offset changed concurrently");
    const upload: UploadSession = { ...current, receivedSize: newOffset, status: "uploading", updatedAt: new Date() };
    this.uploads.set(id, upload);
    return upload;
  }
  async setUploadState(id: string, state: UploadStatus, fields: { readonly actualSha256?: string } = {}) {
    const current = this.uploads.get(id);
    if (current === undefined) throw new Error("Upload missing");
    const upload: UploadSession = { ...current, status: state, ...fields, updatedAt: new Date() };
    this.uploads.set(id, upload);
    return upload;
  }
  async commitUpload(record: CommitUploadRecord): Promise<CompleteUploadRecordResult> {
    const now = new Date();
    const resource: Resource = {
      id: record.resourceId,
      type: "file",
      parentId: record.parentId,
      name: record.filename,
      storagePath: record.storagePath,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      currentVersionId: record.versionId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const current = this.uploads.get(record.uploadId);
    if (current === undefined) throw new Error("Upload missing");
    const upload: UploadSession = {
      ...current,
      status: "active",
      resourceId: resource.id,
      actualSha256: record.sha256,
      updatedAt: now,
    };
    this.resources.set(resource.id, resource);
    this.uploads.set(upload.id, upload);
    this.#adjustAncestorSizes(record.parentId, record.sizeBytes);
    this.versions.set(record.versionId, {
      id: record.versionId,
      resourceId: resource.id,
      storagePath: record.storagePath,
      sha256: record.sha256,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType,
      reason: "initial",
      state: "active",
      createdAt: now,
    });
    return { upload, resource };
  }
  async commitOverwrite(record: CommitOverwriteRecord): Promise<CompleteUploadRecordResult> {
    const current = this.uploads.get(record.uploadId);
    const existing = this.resources.get(record.resourceId);
    const previous = this.versions.get(record.previousVersionId);
    if (current === undefined || existing === undefined || previous === undefined) throw new Error("Overwrite fixture missing");
    const now = new Date();
    this.versions.set(previous.id, {
      ...previous,
      storagePath: record.previousVersionArchivePath,
      archivedAt: now,
      ...(record.previousVersionPurgeAfter === undefined ? {} : { purgeAfter: record.previousVersionPurgeAfter }),
    });
    this.versions.set(record.versionId, {
      id: record.versionId,
      resourceId: record.resourceId,
      storagePath: record.storagePath,
      sha256: record.sha256,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType,
      reason: "overwrite",
      state: "active",
      createdAt: now,
    });
    const resource: Resource = {
      ...existing,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      mimeType: record.mimeType,
      currentVersionId: record.versionId,
      updatedAt: now,
    };
    const upload: UploadSession = { ...current, status: "active", resourceId: resource.id, actualSha256: record.sha256, updatedAt: now };
    this.resources.set(resource.id, resource);
    this.uploads.set(upload.id, upload);
    if (existing.parentId !== undefined) this.#adjustAncestorSizes(existing.parentId, record.sizeBytes - existing.sizeBytes);
    return { upload, resource };
  }
  async getVersion(resourceId: string, versionId: string) {
    const item = this.versions.get(versionId);
    return item?.resourceId === resourceId ? item : undefined;
  }
  async listVersions(resourceId: string, offset: number, limit: number) {
    return [...this.versions.values()].filter((item) => item.resourceId === resourceId).slice(offset, offset + limit);
  }
  async getOperation(idempotencyKey: string) {
    return [...this.operations.values()].find((item) => item.idempotencyKey === idempotencyKey);
  }
  async createOperation(record: {
    readonly id: string;
    readonly operationType: FileOperation["operationType"];
    readonly idempotencyKey: string;
    readonly resourceId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }) {
    const operation: FileOperation = { ...record, state: "created" };
    this.operations.set(operation.id, operation);
    return operation;
  }
  async setOperationState(id: string, state: string, fields: { readonly resourceId?: string; readonly errorCode?: string } = {}) {
    const current = this.operations.get(id);
    if (current === undefined) throw new Error("Operation missing");
    this.operations.set(id, { ...current, state, ...fields });
  }
  async acquireLocks(operationId: string, lockKeys: readonly string[], expiresAt: Date) {
    const now = Date.now();
    for (const [key, lock] of this.locks) if (lock.expiresAt.getTime() <= now) this.locks.delete(key);
    if (lockKeys.some((key) => this.locks.has(key))) return false;
    for (const key of lockKeys) this.locks.set(key, { operationId, expiresAt });
    return true;
  }
  async releaseLocks(operationId: string) {
    for (const [key, lock] of this.locks) if (lock.operationId === operationId) this.locks.delete(key);
  }
  async moveTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
    readonly parentId: string;
    readonly name: string;
    readonly oldPath: string;
    readonly newPath: string;
  }) {
    const original = this.resources.get(record.resourceId);
    if (original === undefined || original.parentId === undefined) throw new Error("Moved resource missing");
    for (const [id, item] of this.resources) {
      if (item.storagePath === record.oldPath || item.storagePath.startsWith(`${record.oldPath}/`)) {
        const suffix = item.storagePath.slice(record.oldPath.length);
        this.resources.set(id, {
          ...item,
          storagePath: `${record.newPath}${suffix}`,
          ...(id === record.resourceId ? { parentId: record.parentId, name: record.name } : {}),
          updatedAt: new Date(),
        });
      }
    }
    if (original.parentId === record.parentId) this.#adjustAncestorSizes(record.parentId, 0);
    else {
      this.#adjustAncestorSizes(original.parentId, -original.sizeBytes);
      this.#adjustAncestorSizes(record.parentId, original.sizeBytes);
    }
    await this.setOperationState(record.operationId, "active");
    const result = this.resources.get(record.resourceId);
    if (result === undefined) throw new Error("Moved resource missing");
    return result;
  }
  async createCopiedTree(record: {
    readonly operationId: string;
    readonly rootResourceId: string;
    readonly resources: readonly CopiedResourceRecord[];
  }) {
    const now = new Date();
    for (const item of record.resources) {
      this.resources.set(item.id, {
        id: item.id,
        type: item.type,
        parentId: item.parentId,
        name: item.name,
        storagePath: item.storagePath,
        ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
        sizeBytes: item.sizeBytes,
        ...(item.sha256 === undefined ? {} : { sha256: item.sha256 }),
        ...(item.versionId === undefined ? {} : { currentVersionId: item.versionId }),
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
    const copiedRoot = record.resources.find((item) => item.id === record.rootResourceId);
    if (copiedRoot === undefined) throw new Error("Copied root metadata missing");
    this.#adjustAncestorSizes(copiedRoot.parentId, copiedRoot.sizeBytes);
    await this.setOperationState(record.operationId, "active", { resourceId: record.rootResourceId });
    const result = this.resources.get(record.rootResourceId);
    if (result === undefined) throw new Error("Copied resource missing");
    return result;
  }
  async trashTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
    readonly oldPath: string;
    readonly trashPath: string;
    readonly purgeAfter: Date;
  }) {
    const original = this.resources.get(record.resourceId);
    if (original === undefined || original.parentId === undefined) throw new Error("Trash resource missing");
    for (const [id, item] of this.resources) {
      if (item.storagePath === record.oldPath || item.storagePath.startsWith(`${record.oldPath}/`)) {
        this.resources.set(id, {
          ...item,
          storagePath: `${record.trashPath}${item.storagePath.slice(record.oldPath.length)}`,
          status: "trashed",
          ...(id === record.resourceId ? {
            trashedFromParentId: original.parentId,
            trashedFromName: original.name,
            purgeAfter: record.purgeAfter,
          } : {}),
          updatedAt: new Date(),
        });
        if (item.currentVersionId !== undefined) {
          const version = this.versions.get(item.currentVersionId);
          if (version !== undefined) this.versions.set(version.id, {
            ...version,
            storagePath: `${record.trashPath}${item.storagePath.slice(record.oldPath.length)}`,
          });
        }
      }
    }
    this.#adjustAncestorSizes(original.parentId, -original.sizeBytes);
    await this.setOperationState(record.operationId, "active");
    const result = this.resources.get(record.resourceId);
    if (result === undefined) throw new Error("Trashed resource missing");
    return result;
  }
  async restoreTree(record: {
    readonly operationId: string;
    readonly resourceId: string;
    readonly oldPath: string;
    readonly restoredPath: string;
    readonly parentId: string;
    readonly name: string;
  }) {
    const original = this.resources.get(record.resourceId);
    if (original === undefined) throw new Error("Restore fixture missing");
    for (const [id, item] of this.resources) {
      if (item.storagePath === record.oldPath || item.storagePath.startsWith(`${record.oldPath}/`)) {
        this.resources.set(id, {
          ...item,
          storagePath: `${record.restoredPath}${item.storagePath.slice(record.oldPath.length)}`,
          status: "active",
          ...(id === record.resourceId ? { parentId: record.parentId, name: record.name } : {}),
          updatedAt: new Date(),
        });
      }
    }
    const restored = this.resources.get(record.resourceId);
    if (restored === undefined) throw new Error("Restore fixture missing");
    const clean: Resource = { ...restored };
    delete (clean as { trashedFromParentId?: string }).trashedFromParentId;
    delete (clean as { trashedFromName?: string }).trashedFromName;
    delete (clean as { purgeAfter?: Date }).purgeAfter;
    this.resources.set(clean.id, clean);
    this.#adjustAncestorSizes(record.parentId, original.sizeBytes);
    await this.setOperationState(record.operationId, "active");
    return clean;
  }
  async purgeTrashFile(record: { readonly operationId: string; readonly resourceId: string }) {
    if (this.purgeFailuresRemaining > 0) {
      this.purgeFailuresRemaining -= 1;
      throw new Error("Simulated purge database failure");
    }
    const existing = this.resources.get(record.resourceId);
    if (existing === undefined || existing.type !== "file" || existing.status !== "trashed" || existing.trashedFromParentId === undefined) {
      throw new Error("Trash file fixture missing");
    }
    for (const [id, version] of this.versions) {
      if (version.resourceId === record.resourceId) this.versions.set(id, { ...version, state: "expired" });
    }
    const purged: Resource = { ...existing, status: "purged", updatedAt: new Date() };
    delete (purged as { purgeAfter?: Date }).purgeAfter;
    this.resources.set(purged.id, purged);
    await this.setOperationState(record.operationId, "active", { resourceId: record.resourceId });
    return purged;
  }
  async commitVersionRestore(record: CommitVersionRestoreRecord) {
    const existing = this.resources.get(record.resourceId);
    const previous = this.versions.get(record.previousVersionId);
    if (existing === undefined || previous === undefined) throw new Error("Version restore fixture missing");
    const now = new Date();
    this.versions.set(previous.id, {
      ...previous,
      storagePath: record.previousVersionArchivePath,
      archivedAt: now,
      ...(record.previousVersionPurgeAfter === undefined ? {} : { purgeAfter: record.previousVersionPurgeAfter }),
    });
    this.versions.set(record.newVersionId, {
      id: record.newVersionId,
      resourceId: record.resourceId,
      storagePath: record.storagePath,
      sha256: record.sha256,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType,
      reason: "manual",
      state: "active",
      createdAt: now,
    });
    const restored: Resource = {
      ...existing,
      sha256: record.sha256,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType,
      currentVersionId: record.newVersionId,
      updatedAt: now,
    };
    this.resources.set(restored.id, restored);
    if (existing.parentId !== undefined) this.#adjustAncestorSizes(existing.parentId, record.sizeBytes - existing.sizeBytes);
    await this.setOperationState(record.operationId, "active");
    return restored;
  }

  #adjustAncestorSizes(folderId: string, deltaBytes: number) {
    let current = this.resources.get(folderId);
    while (current !== undefined && current.type === "folder" && current.status === "active") {
      const updated = { ...current, sizeBytes: current.sizeBytes + deltaBytes, updatedAt: new Date() };
      this.resources.set(updated.id, updated);
      current = updated.parentId === undefined ? undefined : this.resources.get(updated.parentId);
    }
  }
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("FileService upload state machine", () => {
  it("allows ordinary root folders while canonical roots remain renameable and copyable but immovable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-root-policy-"));
    const storage = new LocalStorageAdapter(root);
    const repository = new MemoryRepository();
    const service = new FileService(repository, storage);
    try {
      await storage.initialize();
      await service.initializeStorage();

      const ordinary = await service.createFolder(ROOT_RESOURCE_ID, "ordinary");
      const nested = await service.createFolder(ordinary.id, "nested");
      const promoted = await service.moveResource(nested.id, {
        parentId: ROOT_RESOURCE_ID,
        name: "promoted",
        idempotencyKey: "root-promote-001",
      });
      expect(promoted.parentId).toBe(ROOT_RESOURCE_ID);
      const copied = await service.copyResource(promoted.id, {
        parentId: ROOT_RESOURCE_ID,
        name: "promoted copy",
        idempotencyKey: "root-copy-001",
      });
      expect(copied.storagePath).toBe("promoted copy");
      expect((await service.trashResource(ordinary.id, { idempotencyKey: "root-trash-001" })).status).toBe("trashed");

      const renamedSync = await service.moveResource(SYNC_RESOURCE_ID, {
        parentId: ROOT_RESOURCE_ID,
        name: "device files",
        idempotencyKey: "canonical-rename-001",
      });
      expect(renamedSync.storagePath).toBe("device files");
      expect(await storage.exists("sync")).toBe(false);
      await service.initializeStorage();
      expect(await storage.exists("device files")).toBe(true);
      expect(await storage.exists("sync")).toBe(false);

      await expect(service.moveResource(SYNC_RESOURCE_ID, {
        parentId: promoted.id,
        idempotencyKey: "canonical-move-001",
      })).rejects.toThrow(/can be renamed but cannot be moved/);
      const copiedSync = await service.copyResource(SYNC_RESOURCE_ID, {
        parentId: ROOT_RESOURCE_ID,
        name: "sync copy",
        idempotencyKey: "canonical-copy-001",
      });
      expect(copiedSync.storagePath).toBe("sync copy");
      await expect(service.trashResource(SYNC_RESOURCE_ID, { idempotencyKey: "canonical-trash-001" })).rejects.toThrow(/cannot be trashed/);
      await expect(service.createFolder(ROOT_RESOURCE_ID, "sync")).rejects.toThrow(/root name is reserved/);
      await expect(service.createFolder(ROOT_RESOURCE_ID, "_system")).rejects.toThrow(/root name is reserved/);
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a logical folder path to its stable resource chain", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-path-resolution-"));
    const storage = new LocalStorageAdapter(root);
    const service = new FileService(new MemoryRepository(), storage);
    try {
      await storage.initialize();
      await service.initializeStorage();
      const archive = await service.createFolder(ROOT_RESOURCE_ID, "Archive");
      const photos = await service.createFolder(archive.id, "Photos 2026");

      expect((await service.resolveFolderPath(["archive", "photos 2026"])).map((resource) => resource.id)).toEqual([
        ROOT_RESOURCE_ID,
        archive.id,
        photos.id,
      ]);
      await expect(service.resolveFolderPath(["archive", "missing"])).rejects.toThrow(/not found/);
      await expect(service.resolveFolderPath(["archive", ".."]))
        .rejects.toThrow(/reserved/);
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates a folder and commits a resumable upload only after checksum verification", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-file-service-"));
    const storage = new LocalStorageAdapter(root);
    const repository = new MemoryRepository();
    const service = new FileService(repository, storage);
    const payload = Buffer.from("hello resumable vault");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    try {
      await storage.initialize();
      await service.initializeStorage();
      const rootFolder = await service.createFolder(ROOT_RESOURCE_ID, "Documents");
      expect(rootFolder.storagePath).toBe("Documents");
      await expect(service.createUpload({
        parentId: ROOT_RESOURCE_ID,
        filename: "root-file.txt",
        expectedSize: 0,
        idempotencyKey: "upload-root-rejected",
      })).rejects.toThrow(/cannot be uploaded directly/);
      const folder = await service.createFolder(SYNC_RESOURCE_ID, "Documents");
      const upload = await service.createUpload({
        parentId: folder.id,
        filename: "note.txt",
        expectedSize: payload.length,
        expectedSha256: sha256,
        idempotencyKey: "upload-test-001",
      });
      const repeated = await service.createUpload({
        parentId: folder.id,
        filename: "note.txt",
        expectedSize: payload.length,
        expectedSha256: sha256,
        idempotencyKey: "upload-test-001",
      });
      expect(repeated.id).toBe(upload.id);
      await service.appendUpload(upload.id, 0, 5, Readable.from(payload.subarray(0, 5)));
      await expect(service.appendUpload(upload.id, 4, 1, Readable.from("x"))).rejects.toThrow(/offset mismatch/);
      await service.appendUpload(upload.id, 5, payload.length - 5, Readable.from(payload.subarray(5)));
      const completed = await service.completeUpload(upload.id);
      expect(completed.resource.sha256).toBe(sha256);
      expect(completed.resource.storagePath).toBe("sync/Documents/note.txt");
      expect((await service.completeUpload(upload.id)).resource.id).toBe(completed.resource.id);
      expect((await service.getResource(folder.id)).sizeBytes).toBe(payload.length);
      expect((await service.getResource(SYNC_RESOURCE_ID)).sizeBytes).toBe(payload.length);
      expect((await service.getResource(ROOT_RESOURCE_ID)).sizeBytes).toBe(payload.length);
      const download = await service.openDownload(completed.resource.id, 6, 9);
      expect((await collect(download.stream)).toString()).toBe("resumable");
      expect(await storage.exists(upload.tempPath)).toBe(false);

      const archive = await service.createFolder(SYNC_RESOURCE_ID, "Archive");
      const moved = await service.moveResource(completed.resource.id, {
        parentId: archive.id,
        name: "moved.txt",
        idempotencyKey: "move-test-001",
      });
      expect(moved.id).toBe(completed.resource.id);
      expect(moved.storagePath).toBe("sync/Archive/moved.txt");
      expect((await service.getResource(folder.id)).sizeBytes).toBe(0);
      expect((await service.getResource(archive.id)).sizeBytes).toBe(payload.length);
      expect((await service.getResource(SYNC_RESOURCE_ID)).sizeBytes).toBe(payload.length);
      expect((await service.getResource(ROOT_RESOURCE_ID)).sizeBytes).toBe(payload.length);
      expect((await service.moveResource(completed.resource.id, {
        parentId: archive.id,
        name: "moved.txt",
        idempotencyKey: "move-test-001",
      })).id).toBe(moved.id);

      const replacement = Buffer.from("replacement content");
      const replacementSha = createHash("sha256").update(replacement).digest("hex");
      const overwrite = await service.createUpload({
        parentId: archive.id,
        filename: "moved.txt",
        expectedSize: replacement.length,
        expectedSha256: replacementSha,
        overwriteResourceId: moved.id,
        idempotencyKey: "overwrite-test-001",
      });
      await service.appendUpload(overwrite.id, 0, replacement.length, Readable.from(replacement));
      const overwritten = await service.completeUpload(overwrite.id);
      expect(overwritten.resource.id).toBe(moved.id);
      expect(overwritten.resource.sha256).toBe(replacementSha);
      expect((await service.getResource(archive.id)).sizeBytes).toBe(replacement.length);
      expect((await service.getResource(ROOT_RESOURCE_ID)).sizeBytes).toBe(replacement.length);
      const versions = await service.listVersions(moved.id);
      expect(versions).toHaveLength(2);
      const originalVersion = versions.find((item) => item.sha256 === sha256);
      if (originalVersion === undefined) throw new Error("Original version fixture missing");
      const versionRestored = await service.restoreVersion(moved.id, originalVersion.id, {
        idempotencyKey: "version-restore-test-001",
      });
      expect(versionRestored.id).toBe(moved.id);
      expect(versionRestored.sha256).toBe(sha256);
      expect((await service.getResource(archive.id)).sizeBytes).toBe(payload.length);
      expect((await service.getResource(ROOT_RESOURCE_ID)).sizeBytes).toBe(payload.length);
      expect((await collect((await service.openDownload(moved.id)).stream)).toString()).toBe(payload.toString());

      const copied = await service.copyResource(moved.id, {
        parentId: folder.id,
        name: "copied.txt",
        idempotencyKey: "copy-test-001",
      });
      expect(copied.id).not.toBe(moved.id);
      expect((await collect((await service.openDownload(copied.id)).stream)).toString()).toBe(payload.toString());
      expect((await service.getResource(folder.id)).sizeBytes).toBe(payload.length);
      expect((await service.getResource(SYNC_RESOURCE_ID)).sizeBytes).toBe(payload.length * 2);
      expect((await service.getResource(ROOT_RESOURCE_ID)).sizeBytes).toBe(payload.length * 2);
      expect((await service.copyResource(moved.id, {
        parentId: folder.id,
        name: "copied.txt",
        idempotencyKey: "copy-test-001",
      })).id).toBe(copied.id);

      const trashed = await service.trashResource(copied.id, { idempotencyKey: "trash-test-001" });
      expect(trashed.status).toBe("trashed");
      expect(trashed.storagePath).toMatch(/^_system\/trash\/\d{4}\/\d{2}\//);
      expect(trashed.purgeAfter?.getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60 * 1_000);
      expect(await storage.exists(trashed.storagePath)).toBe(true);
      expect((await service.getResource(folder.id)).sizeBytes).toBe(0);
      expect((await service.getResource(ROOT_RESOURCE_ID)).sizeBytes).toBe(payload.length);
      const restored = await service.restoreResource(copied.id, { idempotencyKey: "trash-restore-test-001" });
      expect(restored.id).toBe(copied.id);
      expect(restored.status).toBe("active");
      expect((await service.getResource(folder.id)).sizeBytes).toBe(payload.length);
      expect((await service.getResource(SYNC_RESOURCE_ID)).sizeBytes).toBe(payload.length * 2);
      expect((await service.getResource(ROOT_RESOURCE_ID)).sizeBytes).toBe(payload.length * 2);
      expect((await collect((await service.openDownload(restored.id)).stream)).toString()).toBe(payload.toString());

      const trashedAgain = await service.trashResource(moved.id, { idempotencyKey: "trash-purge-test-001" });
      const versionStoragePaths = [...new Set((await repository.listVersions(moved.id, 0, 100)).map((version) => version.storagePath))];
      expect(versionStoragePaths.length).toBeGreaterThan(1);
      expect((await Promise.all(versionStoragePaths.map((storagePath) => storage.exists(storagePath)))).every(Boolean)).toBe(true);
      expect(await storage.exists(trashedAgain.storagePath)).toBe(true);
      repository.purgeFailuresRemaining = 1;
      await expect(service.purgeTrashFile(moved.id, { idempotencyKey: "purge-test-001" })).rejects.toThrow(/database failure/);
      expect(await storage.exists(trashedAgain.storagePath)).toBe(false);
      expect((await Promise.all(versionStoragePaths.map((storagePath) => storage.exists(storagePath)))).every((exists) => !exists)).toBe(true);
      const purged = await service.purgeTrashFile(moved.id, { idempotencyKey: "purge-test-001" });
      expect(purged.status).toBe("purged");
      expect(purged.purgeAfter).toBeUndefined();
      expect(await storage.exists(trashedAgain.storagePath)).toBe(false);
      expect((await repository.listVersions(moved.id, 0, 100)).every((version) => version.state === "expired")).toBe(true);
      expect((await repository.listTrash(0, 100)).some((item) => item.id === moved.id)).toBe(false);
      expect((await service.purgeTrashFile(moved.id, { idempotencyKey: "purge-test-001" })).status).toBe("purged");
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails final verification when the expected checksum differs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-file-checksum-"));
    const storage = new LocalStorageAdapter(root);
    const repository = new MemoryRepository();
    const service = new FileService(repository, storage);
    try {
      await storage.initialize();
      await service.initializeStorage();
      const upload = await service.createUpload({
        parentId: SYNC_RESOURCE_ID,
        filename: "bad.bin",
        expectedSize: 3,
        expectedSha256: "0".repeat(64),
        idempotencyKey: "upload-test-bad",
      });
      await service.appendUpload(upload.id, 0, 3, Readable.from("abc"));
      await expect(service.completeUpload(upload.id)).rejects.toThrow(/checksum/);
      expect((await service.getUpload(upload.id)).status).toBe("failed_final");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("commits zero-byte files and rolls a short first chunk back before retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-file-edge-"));
    const storage = new LocalStorageAdapter(root);
    const repository = new MemoryRepository();
    const service = new FileService(repository, storage);
    try {
      await storage.initialize();
      await service.initializeStorage();
      const limited = new FileService(repository, storage, { uploadMaxBytes: 2 });
      await expect(limited.createUpload({
        parentId: SYNC_RESOURCE_ID,
        filename: "too-large.bin",
        expectedSize: 3,
        idempotencyKey: "upload-limit-001",
      })).rejects.toThrow(/size/);
      const empty = await service.createUpload({
        parentId: SYNC_RESOURCE_ID,
        filename: "empty.txt",
        expectedSize: 0,
        idempotencyKey: "upload-empty-001",
      });
      const completedEmpty = await service.completeUpload(empty.id);
      expect(completedEmpty.resource.sizeBytes).toBe(0);
      expect((await storage.stat(completedEmpty.resource.storagePath)).size).toBe(0);

      const retry = await service.createUpload({
        parentId: SYNC_RESOURCE_ID,
        filename: "retry.bin",
        expectedSize: 3,
        idempotencyKey: "upload-short-001",
      });
      await expect(service.appendUpload(retry.id, 0, 3, Readable.from("ab"))).rejects.toThrow(/Content-Length/);
      expect(await storage.exists(retry.tempPath)).toBe(false);
      await service.appendUpload(retry.id, 0, 3, Readable.from("abc"));
      expect((await service.completeUpload(retry.id)).resource.sizeBytes).toBe(3);
    } finally {
      await storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
