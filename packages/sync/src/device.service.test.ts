import { Readable } from "node:stream";
import type { FileService, Resource } from "@saturn/file-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceService, DeviceServiceError, normalizeDavPath, resourceEtag } from "./device.service.js";
import { MASTERMIND_RESOURCE_ID, VOLT_RESOURCE_ID, SYNC_RESOURCE_ID, type DeviceRecord, type DeviceRepository, type DeviceRights, type SyncConflict } from "./types.js";

const now = new Date("2026-08-26T00:00:00.000Z");
const rights: DeviceRights = { read: true, write: true, move: true, delete: true };

class MemoryRepository implements DeviceRepository {
  values: DeviceRecord[] = [];
  conflicts: SyncConflict[] = [];
  deleteTotal = 0;

  async create(input: Omit<DeviceRecord, "state" | "updatedAt" | "lastUsedAt">): Promise<DeviceRecord> {
    const value: DeviceRecord = { ...input, state: "active", updatedAt: input.createdAt };
    this.values.push(value);
    return value;
  }
  async getById(id: string) { return this.values.find((item) => item.id === id); }
  async authenticate(tokenHash: string, usedAt: Date) {
    const index = this.values.findIndex((item) => item.tokenHash === tokenHash && item.state === "active" && (item.expiresAt === undefined || item.expiresAt > usedAt));
    if (index < 0) return undefined;
    const value = { ...this.values[index] as DeviceRecord, lastUsedAt: usedAt, updatedAt: usedAt };
    this.values[index] = value;
    return value;
  }
  async list(offset: number, limit: number) { return this.values.slice(offset, offset + limit); }
  async update(id: string, input: { readonly name?: string; readonly scopeIds?: readonly string[]; readonly rights?: DeviceRights; readonly expiresAt?: Date | null }, updatedAt: Date) {
    const current = this.values.find((item) => item.id === id);
    if (current === undefined) throw new Error("Device not found");
    const base = { ...current, ...(input.name === undefined ? {} : { name: input.name }), ...(input.scopeIds === undefined ? {} : { scopeIds: input.scopeIds }), ...(input.rights === undefined ? {} : { rights: input.rights }), updatedAt };
    let value: DeviceRecord;
    if (input.expiresAt === null) {
      value = { id: base.id, name: base.name, tokenHash: base.tokenHash, state: base.state, scopeIds: base.scopeIds, rights: base.rights, ...(base.lastUsedAt === undefined ? {} : { lastUsedAt: base.lastUsedAt }), createdAt: base.createdAt, updatedAt: base.updatedAt, ...(base.revokedAt === undefined ? {} : { revokedAt: base.revokedAt }) };
    } else value = { ...base, ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }) };
    this.values[this.values.indexOf(current)] = value;
    return value;
  }
  async revoke(id: string, revokedAt: Date) {
    const current = this.values.find((item) => item.id === id);
    if (current === undefined) throw new Error("Device not found");
    const value: DeviceRecord = { ...current, state: "revoked", revokedAt, updatedAt: revokedAt };
    this.values[this.values.indexOf(current)] = value;
    return value;
  }
  async reserveDelete(input: { readonly itemCount: number; readonly limit: number }) {
    if (this.deleteTotal + input.itemCount > input.limit) return false;
    this.deleteTotal += input.itemCount;
    return true;
  }
  async recordConflict(input: SyncConflict) { this.conflicts.push(input); }
}

function folder(id: string, parentId: string | undefined, name: string): Resource {
  return { id, type: "folder", ...(parentId === undefined ? {} : { parentId }), name, storagePath: name, sizeBytes: 0, status: "active", securityClassification: id === VOLT_RESOURCE_ID ? "confidential" : "internal", createdAt: now, updatedAt: now };
}

class MemoryFiles {
  resources = new Map<string, Resource>([
    [MASTERMIND_RESOURCE_ID, folder(MASTERMIND_RESOURCE_ID, "root", "mastermind")],
    [SYNC_RESOURCE_ID, folder(SYNC_RESOURCE_ID, "root", "sync")],
    [VOLT_RESOURCE_ID, folder(VOLT_RESOURCE_ID, "root", "volt")],
  ]);
  uploadBytes = new Map<string, Buffer[]>();
  uploads = new Map<string, { parentId: string; filename: string; overwriteResourceId?: string }>();

  async getResource(id: string) { const value = this.resources.get(id); if (value === undefined) throw new Error("Resource not found"); return value; }
  async listChildren(parentId: string, offset = 0, limit = 500) { return [...this.resources.values()].filter((item) => item.parentId === parentId && item.status === "active").slice(offset, offset + limit); }
  async createFolder(parentId: string, name: string) { const value = folder(crypto.randomUUID(), parentId, name); this.resources.set(value.id, value); return value; }
  async createUpload(input: { readonly parentId?: string; readonly filename: string; readonly overwriteResourceId?: string }) {
    const id = crypto.randomUUID();
    this.uploads.set(id, { parentId: input.parentId ?? MASTERMIND_RESOURCE_ID, filename: input.filename, ...(input.overwriteResourceId === undefined ? {} : { overwriteResourceId: input.overwriteResourceId }) });
    this.uploadBytes.set(id, []);
    return { id };
  }
  async appendUpload(id: string, _offset: number, _length: number, source: Readable) { for await (const chunk of source) this.uploadBytes.get(id)?.push(Buffer.from(chunk as Uint8Array)); return { id }; }
  async completeUpload(id: string) {
    const upload = this.uploads.get(id); if (upload === undefined) throw new Error("Upload not found");
    const bytes = Buffer.concat(this.uploadBytes.get(id) ?? []);
    const targetId = upload.overwriteResourceId ?? crypto.randomUUID();
    const value: Resource = { id: targetId, type: "file", parentId: upload.parentId, name: upload.filename, storagePath: `mastermind/${upload.filename}`, mimeType: "application/octet-stream", sizeBytes: bytes.length, sha256: Buffer.from(bytes).toString("hex").padEnd(64, "0").slice(0, 64), status: "active", securityClassification: "internal", createdAt: now, updatedAt: now };
    this.resources.set(targetId, value);
    return { resource: value };
  }
  async abandonUpload() { return {}; }
  async openDownload(id: string) { return { resource: await this.getResource(id), stream: Readable.from([]) }; }
  async moveResource(id: string, input: { readonly parentId: string; readonly name?: string }) { const current = await this.getResource(id); const value = { ...current, parentId: input.parentId, name: input.name ?? current.name }; this.resources.set(id, value); return value; }
  async copyResource(id: string, input: { readonly parentId: string; readonly name?: string }) { const current = await this.getResource(id); const value = { ...current, id: crypto.randomUUID(), parentId: input.parentId, name: input.name ?? current.name }; this.resources.set(value.id, value); return value; }
  async trashResource(id: string) { const current = await this.getResource(id); const value: Resource = { ...current, status: "trashed" }; this.resources.set(id, value); return value; }
}

describe("DeviceService", () => {
  let repository: MemoryRepository;
  let files: MemoryFiles;
  let service: DeviceService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    repository = new MemoryRepository();
    files = new MemoryFiles();
    service = new DeviceService({ repository, files: files as unknown as FileService, pepper: "device-pepper-value-that-is-long-enough-123", options: { enabled: true, publicOrigin: "https://vault.test", uploadChunkMaxBytes: 8, propfindMaxItems: 100, deleteMaxItems: 2, deleteWindowMs: 900_000 } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes one decoded logical path and rejects traversal variants", () => {
    expect(normalizeDavPath("mastermind/Notes/a%20b.md")).toEqual(["mastermind", "Notes", "a b.md"]);
    for (const value of ["mastermind/../sync", "mastermind/%252e%252e/sync", "mastermind%2F..%2Fsync", "mastermind\\sync"]) {
      expect(() => normalizeDavPath(value)).toThrow(DeviceServiceError);
    }
  });

  it("discloses a 256-bit token once, stores only HMAC and supports revoke", async () => {
    const created = await service.createDevice({ name: "Laptop", scopeIds: [MASTERMIND_RESOURCE_ID], rights }, now);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repository.values[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(await service.listDevices())).not.toContain(created.token);
    const context = await service.authenticate(`Basic ${Buffer.from(`device:${created.token}`).toString("base64")}`, now);
    expect(context.device.id).toBe(created.device.id);
    await service.revokeDevice(created.device.id, now);
    await expect(service.authenticate(`Bearer ${created.token}`, now)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("contains DAV enumeration to stable scoped roots", async () => {
    const created = await service.createDevice({ name: "Notes", scopeIds: [MASTERMIND_RESOURCE_ID], rights }, now);
    const context = await service.authenticate(`Bearer ${created.token}`, now);
    expect((await service.propfind(context, "", 1)).map((item) => item.path)).toEqual(["mastermind"]);
    await expect(service.propfind(context, "sync", 0)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps the current resource and records a conflict copy for stale If-Match", async () => {
    const current: Resource = { id: crypto.randomUUID(), type: "file", parentId: MASTERMIND_RESOURCE_ID, name: "note.md", storagePath: "mastermind/note.md", mimeType: "text/markdown", sizeBytes: 3, sha256: "a".repeat(64), status: "active", securityClassification: "internal", createdAt: now, updatedAt: now };
    files.resources.set(current.id, current);
    const created = await service.createDevice({ name: "Laptop", scopeIds: [MASTERMIND_RESOURCE_ID], rights }, now);
    const context = await service.authenticate(`Bearer ${created.token}`, now);
    const result = await service.put(context, "mastermind/note.md", Readable.from(Buffer.from("new")), 3, { ifMatch: '"stale"' });
    expect(result.conflict).toBe(true);
    expect(files.resources.get(current.id)?.sha256).toBe("a".repeat(64));
    expect(result.resource.name).toMatch(/^note \(conflict 2026-08-26 Laptop-/);
    expect(repository.conflicts[0]).toMatchObject({ resourceId: current.id, conflictResourceId: result.resource.id, currentEtag: resourceEtag(current) });
  });
});
