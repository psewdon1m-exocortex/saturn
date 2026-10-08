import { Readable } from "node:stream";
import { BACKUPS_RESOURCE_ID, type FileService, type Resource } from "@saturn/file-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceService, DeviceServiceError, normalizeDavPath, resourceEtag } from "./device.service.js";
import { MASTERMIND_RESOURCE_ID, VOLT_RESOURCE_ID, SYNC_RESOURCE_ID, type DeviceEnrollmentRecord, type DeviceRecord, type DeviceRepository, type DeviceRights, type SyncConflict } from "./types.js";

const now = new Date("2026-08-26T00:00:00.000Z");
const rights: DeviceRights = { read: true, write: true, move: true, delete: true };

class MemoryRepository implements DeviceRepository {
  values: DeviceRecord[] = [];
  conflicts: SyncConflict[] = [];
  deleteTotal = 0;
  enrollments = new Map<string, DeviceEnrollmentRecord>();

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
  async update(id: string, input: Parameters<DeviceRepository["update"]>[1], updatedAt: Date) {
    const current = this.values.find((item) => item.id === id);
    if (current === undefined) throw new Error("Device not found");
    const base = { ...current, ...(input.syncRootId === undefined ? {} : { syncRootId: input.syncRootId }), ...(input.tokenHash === undefined ? {} : { tokenHash: input.tokenHash }), ...(input.name === undefined ? {} : { name: input.name }), ...(input.scopeIds === undefined ? {} : { scopeIds: input.scopeIds }), ...(input.rights === undefined ? {} : { rights: input.rights }), updatedAt };
    let value: DeviceRecord;
    if (input.expiresAt === null) {
      value = { id: base.id, name: base.name, deviceKind: base.deviceKind, ...(base.syncRootId === undefined ? {} : { syncRootId: base.syncRootId }), tokenHash: base.tokenHash, state: base.state, scopeIds: base.scopeIds, rights: base.rights, ...(base.lastUsedAt === undefined ? {} : { lastUsedAt: base.lastUsedAt }), ...(base.lastSeenAt === undefined ? {} : { lastSeenAt: base.lastSeenAt }), ...(base.clientPlatform === undefined ? {} : { clientPlatform: base.clientPlatform }), ...(base.clientVersion === undefined ? {} : { clientVersion: base.clientVersion }), createdAt: base.createdAt, updatedAt: base.updatedAt, ...(base.revokedAt === undefined ? {} : { revokedAt: base.revokedAt }) };
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
  async createEnrollment(value: DeviceEnrollmentRecord) { this.enrollments.set(value.codeHash, value); }
  async redeemEnrollment(codeHash: string, tokenHash: string, redeemedAt: Date, kind: "windows_sync" | "pluto" = "windows_sync") {
    const enrollment = this.enrollments.get(codeHash);
    if (enrollment === undefined || enrollment.consumedAt !== undefined || enrollment.expiresAt <= redeemedAt) return undefined;
    const current = this.values.find((item) => item.id === enrollment.deviceId && item.state === "active" && item.deviceKind === kind);
    if (current === undefined) return undefined;
    this.enrollments.set(codeHash, { ...enrollment, consumedAt: redeemedAt });
    const value = { ...current, tokenHash, lastSeenAt: redeemedAt, updatedAt: redeemedAt };
    this.values[this.values.indexOf(current)] = value;
    return value;
  }
  async recordPresence(id: string, platform: "windows" | "linux", version: string, seenAt: Date, plutoStatus?: DeviceRecord["plutoStatus"]) {
    const current = this.values.find((item) => item.id === id);
    if (current === undefined) throw new Error("Device not found");
    const value: DeviceRecord = { ...current, clientPlatform: platform, clientVersion: version, lastSeenAt: seenAt, updatedAt: seenAt, ...(plutoStatus === undefined ? {} : { plutoStatus }) };
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
    [BACKUPS_RESOURCE_ID, folder(BACKUPS_RESOURCE_ID, "root", "backups")],
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
  async limitVersions() {}
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

  it("enrolls Pluto once into its named folder, isolates peers, caps versions and preserves files on revoke", async () => {
    const enrollment = await service.createPlutoEnrollment("External configs", now);
    expect(enrollment.device).toMatchObject({ name: "External configs", deviceKind: "pluto", syncFolderName: "External configs", rights: { read: true, write: true, move: false, delete: false } });
    await expect(service.redeemWindowsEnrollment(enrollment.code, "test", now)).rejects.toMatchObject({ code: "unauthorized" });
    const a = await service.redeemPlutoEnrollment(enrollment.code, "0.1.0", now);
    expect(a.device).toMatchObject({ clientPlatform: "linux", plutoStatus: { enabled: false } });
    await expect(service.redeemPlutoEnrollment(enrollment.code, "0.1.0", now)).rejects.toMatchObject({ code: "unauthorized" });
    const peer = await service.createPlutoEnrollment("Other configs", now);
    const context = await service.authenticate(`Bearer ${a.token}`, now);
    expect(await service.plutoPath(context, "etc/app")).toBe("pluto/External%20configs/etc/app");
    await expect(service.plutoPath(context, "../Other configs")).rejects.toMatchObject({ code: "invalid_path" });
    await service.createCollection(context, "pluto/External configs/etc");
    const retention = vi.spyOn(files, "limitVersions");
    const uploaded = await service.put(context, "pluto/External configs/etc/app.conf", Readable.from("x"), 1, { ifNoneMatch: "*", expectedSha256: "a".repeat(64) });
    expect(retention).toHaveBeenCalledWith(uploaded.resource.id, 10);
    await expect(service.propfind(context, "pluto/Other configs", 1)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.put(context, "pluto/Other configs/stolen", Readable.from("x"), 1, {})).rejects.toMatchObject({ code: "not_found" });
    await expect(service.remove(context, "pluto/External configs/etc/app.conf")).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.move(context, "pluto/External configs/etc/app.conf", "pluto/External configs/etc/moved", false, false)).rejects.toMatchObject({ code: "forbidden" });
    if (peer.device.syncRootId === undefined) throw new Error("Peer root was not assigned");
    await expect(service.updateDevice(a.device.id, { scopeIds: [peer.device.syncRootId] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.updateDevice(a.device.id, { rights })).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.put(context, "pluto/External configs/etc/app.conf", Readable.from("y"), 1, { ifMatch: '"stale"' })).rejects.toMatchObject({ code: "precondition_failed" });
    const replacement = await service.createWindowsEnrollmentForDevice(a.device.id, now);
    const reconnected = await service.redeemPlutoEnrollment(replacement.code, "0.1.1", now);
    await expect(service.authenticate(`Bearer ${a.token}`, now)).rejects.toMatchObject({ code: "unauthorized" });
    const heartbeat = await service.plutoHeartbeat(`Bearer ${reconnected.token}`, "0.1.1", { enabled: true, intervalSeconds: 60, uploadedFiles: 1 }, now);
    expect(heartbeat.clientPlatform).toBe("linux");
    await service.revokeDevice(a.device.id, now);
    await expect(service.authenticate(`Bearer ${reconnected.token}`, now)).rejects.toMatchObject({ code: "unauthorized" });
    expect(files.resources.get(uploaded.resource.id)?.status).toBe("active");
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

  it("exchanges a Windows setup code once and records heartbeat presence", async () => {
    const enrollment = await service.createWindowsEnrollment("Office PC", now);
    expect(enrollment).toMatchObject({ device: { name: "Office PC", deviceKind: "windows_sync", syncFolderName: "Office PC", scopeIds: [enrollment.device.syncRootId] } });
    expect(enrollment.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const redeemed = await service.redeemWindowsEnrollment(enrollment.code, "0.2.0", now);
    expect(redeemed.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redeemed.device).toMatchObject({ clientPlatform: "windows", clientVersion: "0.2.0", lastSeenAt: now });
    await expect(service.redeemWindowsEnrollment(enrollment.code, "0.2.0", now)).rejects.toMatchObject({ code: "unauthorized" });
    const heartbeatAt = new Date(now.getTime() + 30_000);
    await expect(service.heartbeat(`Bearer ${redeemed.token}`, "windows", "0.2.1", heartbeatAt)).resolves.toMatchObject({ clientVersion: "0.2.1", lastSeenAt: heartbeatAt });
  });

  it("isolates two Windows connections, including every DAV mutation and their root folders", async () => {
    const first = await service.createWindowsEnrollment("Office PC", now);
    const second = await service.createWindowsEnrollment("Домашний ПК", now);
    const a = await service.redeemWindowsEnrollment(first.code, "0.2.0", now);
    const b = await service.redeemWindowsEnrollment(second.code, "0.2.0", now);
    const context = await service.authenticate(`Bearer ${a.token}`, now);
    const peer = await service.authenticate(`Bearer ${b.token}`, now);
    const own = "sync/Office%20PC", other = "sync/Домашний%20ПК";
    expect((await service.propfind(context, "", 1)).map(item => item.path)).toEqual(["sync/Office PC"]);
    await service.createCollection(context, `${own}/Documents`);
    await service.put(context, `${own}/Documents/note.txt`, Readable.from(["x"]), 1, { ifNoneMatch: "*" });
    await service.createCollection(peer, `${other}/Documents`);
    await service.put(peer, `${other}/Documents/private.txt`, Readable.from(["y"]), 1, { ifNoneMatch: "*" });
    for (const path of ["sync", other, `${other}/Documents/private.txt`]) {
      await expect(service.propfind(context, path, 1)).rejects.toMatchObject({ code: "not_found" });
      await expect(service.openRead(context, path)).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(service.put(context, `${other}/new.txt`, Readable.from(["z"]), 1, {})).rejects.toMatchObject({ code: "not_found" });
    await expect(service.createCollection(context, `${other}/new`)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.remove(context, `${other}/Documents/private.txt`)).rejects.toMatchObject({ code: "not_found" });
    for (const copy of [false, true]) {
      await expect(service.move(context, `${own}/Documents/note.txt`, `${other}/stolen.txt`, copy, false)).rejects.toMatchObject({ code: "not_found" });
      await expect(service.move(context, `${other}/Documents/private.txt`, `${own}/stolen.txt`, copy, false)).rejects.toMatchObject({ code: "not_found" });
      await expect(service.move(context, own, `${own}/nested`, copy, false)).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(service.remove(context, own)).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.updateDevice(a.device.id, { scopeIds: [SYNC_RESOURCE_ID] })).rejects.toMatchObject({ code: "forbidden" });
    await service.move(context, `${own}/Documents/note.txt`, `${own}/Documents/renamed.txt`, false, false);
    await service.move(context, `${own}/Documents/renamed.txt`, `${own}/Documents/copy.txt`, true, false);
    await service.remove(context, `${own}/Documents/copy.txt`);
    await expect(service.createWindowsEnrollment("Office PC", now)).rejects.toMatchObject({ code: "conflict" });
    const replacement = await service.createWindowsEnrollmentForDevice(a.device.id, now);
    expect(replacement.device.syncRootId).toBe(a.device.syncRootId);
    const reconnected = await service.redeemWindowsEnrollment(replacement.code, "0.2.1", now);
    await expect(service.authenticate(`Bearer ${a.token}`, now)).rejects.toMatchObject({ code: "unauthorized" });
    expect(reconnected.device.syncFolderName).toBe("Office PC");
    expect((await service.propfind(peer, other, 1)).length).toBeGreaterThan(0);
  });

  it("fails closed for legacy Windows credentials and rejects unsafe folder names", async () => {
    const legacy = await service.createDevice({ name: "Legacy PC", deviceKind: "windows_sync", scopeIds: [SYNC_RESOURCE_ID], rights }, now);
    await expect(service.authenticate(`Bearer ${legacy.token}`, now)).rejects.toMatchObject({ code: "forbidden" });
    const setup = await service.createWindowsEnrollmentForDevice(legacy.device.id, now);
    await expect(service.authenticate(`Bearer ${legacy.token}`, now)).rejects.toMatchObject({ code: "unauthorized" });
    const redeemed = await service.redeemWindowsEnrollment(setup.code, "0.2.1", now);
    expect(redeemed.device.syncRootId).toBeDefined();
    for (const name of ["..", "folder/child", "folder\\child"]) await expect(service.createWindowsEnrollment(name, now)).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("contains DAV enumeration to stable scoped roots", async () => {
    const created = await service.createDevice({ name: "Notes", scopeIds: [MASTERMIND_RESOURCE_ID], rights }, now);
    const context = await service.authenticate(`Bearer ${created.token}`, now);
    expect((await service.propfind(context, "", 1)).map((item) => item.path)).toEqual(["mastermind"]);
    await expect(service.propfind(context, "sync", 0)).rejects.toMatchObject({ code: "not_found" });
  });

  it("coalesces fragmented DAV bodies without changing bytes or acknowledged offsets", async () => {
    const created = await service.createDevice({ name: "Notes", scopeIds: [MASTERMIND_RESOURCE_ID], rights }, now);
    const context = await service.authenticate(`Bearer ${created.token}`, now);
    const append = vi.spyOn(files, "appendUpload");
    await service.put(context, "mastermind/fragmented.bin", Readable.from(Array.from({ length: 19 }, (_, index) => Buffer.from([index]))), 19,
      { ifNoneMatch: "*" });
    expect(append.mock.calls.map((call) => [call[1], call[2]])).toEqual([[0, 8], [8, 8], [16, 3]]);
    expect(Buffer.concat([...files.uploadBytes.values()][0] ?? [])).toEqual(Buffer.from(Array.from({ length: 19 }, (_, index) => index)));
  });

  it("abandons an oversized fragmented body before committing a resource", async () => {
    const created = await service.createDevice({ name: "Notes", scopeIds: [MASTERMIND_RESOURCE_ID], rights }, now);
    const context = await service.authenticate(`Bearer ${created.token}`, now);
    const abandon = vi.spyOn(files, "abandonUpload");
    await expect(service.put(context, "mastermind/overflow.bin", Readable.from([Buffer.alloc(5), Buffer.alloc(6)]), 10,
      { ifNoneMatch: "*" })).rejects.toThrow("exceeds Content-Length");
    expect(abandon).toHaveBeenCalledOnce();
    expect([...files.resources.values()].some((value) => value.name === "overflow.bin")).toBe(false);
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
