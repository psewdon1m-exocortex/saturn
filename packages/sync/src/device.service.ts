import { createHmac, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { AuditSink } from "@saturn/audit";
import { type FileService, type Resource } from "@saturn/file-core";
import { v7 as uuidv7 } from "uuid";
import {
  MASTERMIND_RESOURCE_ID,
  VOLT_RESOURCE_ID,
  SYNC_RESOURCE_ID,
  type DavEntry,
  type DavRead,
  type DeviceContext,
  type DeviceOptions,
  type DeviceRecord,
  type DeviceRepository,
  type DeviceRights,
  type PublicDevice,
} from "./types.js";

const scopeAliases: ReadonlyMap<string, string> = new Map<string, string>([
  ["mastermind", MASTERMIND_RESOURCE_ID],
  ["sync", SYNC_RESOURCE_ID],
  ["volt", VOLT_RESOURCE_ID],
] as const);
const idAliases: ReadonlyMap<string, string> = new Map<string, string>([...scopeAliases].map(([alias, id]) => [id, alias]));

export class DeviceServiceError extends Error {
  constructor(readonly code: "unauthorized" | "forbidden" | "not_found" | "precondition_required" | "precondition_failed" | "conflict" | "rate_limited" | "invalid_path" | "limit") {
    super(code);
  }
}

function publicDevice(value: DeviceRecord): PublicDevice {
  return { id: value.id, name: value.name, state: value.state, scopeIds: value.scopeIds, rights: value.rights, ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }), ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }), createdAt: value.createdAt, updatedAt: value.updatedAt, ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }) };
}

export function resourceEtag(resource: Resource): string {
  return resource.type === "file" && resource.sha256 !== undefined
    ? `"sha256-${resource.sha256}"`
    : `"resource-${resource.id}-${String(resource.updatedAt.getTime())}"`;
}

export function normalizeDavPath(raw: string): readonly string[] {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw new DeviceServiceError("invalid_path"); }
  if (decoded.includes("\\") || /%2e|%2f|%5c/i.test(decoded) || containsControl(decoded)) throw new DeviceServiceError("invalid_path");
  const value = decoded.replace(/^\/+|\/+$/g, "");
  if (!value) return [];
  const segments = value.split("/");
  if (segments.length > 128 || segments.some((item) => !item || item === "." || item === ".." || item.length > 255)) throw new DeviceServiceError("invalid_path");
  return segments;
}

function validRights(rights: DeviceRights): boolean {
  return rights.read || rights.write || rights.move || rights.delete;
}

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80 || containsControl(name)) throw new Error("Device name is invalid");
  return name;
}

export class DeviceService {
  readonly #pepper: Buffer;

  constructor(private readonly input: { readonly repository: DeviceRepository; readonly files: FileService; readonly pepper: string; readonly options: DeviceOptions; readonly audit?: AuditSink }) {
    if (input.pepper.length < 32 || /[\r\n]/.test(input.pepper)) throw new Error("Device pepper is invalid");
    this.#pepper = Buffer.from(input.pepper, "utf8");
  }

  #hash(token: string): string { return createHmac("sha256", this.#pepper).update("device-capability-token\0").update(token).digest("hex"); }

  async createDevice(value: { readonly name: string; readonly scopeIds: readonly string[]; readonly rights: DeviceRights; readonly expiresAt?: Date }, now = new Date()) {
    if (!this.input.options.enabled) throw new DeviceServiceError("forbidden");
    const scopeIds = [...new Set(value.scopeIds)];
    if (scopeIds.length < 1 || scopeIds.length > 3 || scopeIds.some((id) => !idAliases.has(id)) || !validRights(value.rights)) throw new Error("Device scope or rights are invalid");
    if (value.expiresAt !== undefined && value.expiresAt <= now) throw new Error("Device expiry is invalid");
    const token = randomBytes(32).toString("base64url");
    const record = await this.input.repository.create({ id: uuidv7(), name: cleanName(value.name), tokenHash: this.#hash(token), scopeIds, rights: value.rights, ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }), createdAt: now });
    await this.#audit("device.created", record.id, { name: record.name, scopeIds: record.scopeIds, rights: record.rights });
    return { token, device: publicDevice(record) };
  }

  async listDevices(offset = 0, limit = 100): Promise<readonly PublicDevice[]> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Device page is invalid");
    return (await this.input.repository.list(offset, limit)).map(publicDevice);
  }

  async updateDevice(id: string, value: { readonly name?: string; readonly scopeIds?: readonly string[]; readonly rights?: DeviceRights; readonly expiresAt?: Date | null }, now = new Date()): Promise<PublicDevice> {
    if (value.scopeIds !== undefined && (value.scopeIds.length < 1 || value.scopeIds.length > 3 || value.scopeIds.some((item) => !idAliases.has(item)))) throw new Error("Device scopes are invalid");
    if (value.rights !== undefined && !validRights(value.rights)) throw new Error("Device rights are invalid");
    const updated = await this.input.repository.update(id, { ...(value.name === undefined ? {} : { name: cleanName(value.name) }), ...(value.scopeIds === undefined ? {} : { scopeIds: [...new Set(value.scopeIds)] }), ...(value.rights === undefined ? {} : { rights: value.rights }), ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }) }, now);
    await this.#audit("device.updated", updated.id, { scopeIds: updated.scopeIds, rights: updated.rights });
    return publicDevice(updated);
  }

  async revokeDevice(id: string, now = new Date()): Promise<PublicDevice> {
    const value = await this.input.repository.revoke(id, now);
    await this.#audit("device.revoked", id, {});
    return publicDevice(value);
  }

  async authenticate(authorization: string | undefined, now = new Date()): Promise<DeviceContext> {
    if (!this.input.options.enabled || authorization === undefined) throw new DeviceServiceError("unauthorized");
    let token = "";
    if (authorization.startsWith("Bearer ")) token = authorization.slice(7);
    else if (authorization.startsWith("Basic ")) {
      let decoded = "";
      try { decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8"); } catch { throw new DeviceServiceError("unauthorized"); }
      const separator = decoded.indexOf(":");
      if (separator < 0) throw new DeviceServiceError("unauthorized");
      token = decoded.slice(separator + 1) || decoded.slice(0, separator);
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DeviceServiceError("unauthorized");
    const device = await this.input.repository.authenticate(this.#hash(token), now);
    if (device === undefined) throw new DeviceServiceError("unauthorized");
    return { device };
  }

  async propfind(context: DeviceContext, rawPath: string, depth: 0 | 1): Promise<readonly DavEntry[]> {
    this.#right(context, "read");
    const segments = normalizeDavPath(rawPath);
    if (segments.length === 0) {
      const entries: DavEntry[] = [];
      for (const id of context.device.scopeIds) {
        const alias = idAliases.get(id);
        if (alias !== undefined) entries.push({ path: alias, resource: await this.input.files.getResource(id) });
      }
      return entries;
    }
    const target = await this.#resolve(context, segments);
    const entries: DavEntry[] = [{ path: segments.join("/"), resource: target.resource }];
    if (depth === 1 && target.resource.type === "folder") {
      const children: Resource[] = [];
      while (children.length <= this.input.options.propfindMaxItems) {
        const remaining = this.input.options.propfindMaxItems + 1 - children.length;
        const requested = Math.min(500, remaining);
        const batch = await this.input.files.listChildren(target.resource.id, children.length, requested);
        children.push(...batch);
        if (batch.length < requested) break;
      }
      if (children.length > this.input.options.propfindMaxItems) throw new DeviceServiceError("limit");
      entries.push(...children.map((resource) => ({ path: [...segments, resource.name].join("/"), resource })));
    }
    return entries;
  }

  async openRead(context: DeviceContext, rawPath: string, range?: { readonly offset: number; readonly length?: number }): Promise<DavRead> {
    this.#right(context, "read");
    const target = await this.#resolve(context, normalizeDavPath(rawPath));
    if (target.resource.type !== "file") throw new DeviceServiceError("not_found");
    const offset = range?.offset ?? 0;
    const length = range?.length ?? target.resource.sizeBytes - offset;
    const opened = await this.input.files.openDownload(target.resource.id, offset, range?.length, this.#actor(context));
    return { resource: opened.resource, stream: opened.stream, offset, length, partial: range !== undefined };
  }

  async put(context: DeviceContext, rawPath: string, source: Readable, size: number, conditions: { readonly ifMatch?: string; readonly ifNoneMatch?: string }): Promise<{ readonly resource: Resource; readonly created: boolean; readonly conflict: boolean }> {
    this.#right(context, "write");
    if (!Number.isSafeInteger(size) || size < 0) throw new DeviceServiceError("limit");
    const segments = normalizeDavPath(rawPath);
    if (segments.length < 2) throw new DeviceServiceError("invalid_path");
    const parent = await this.#resolve(context, segments.slice(0, -1));
    if (parent.resource.type !== "folder") throw new DeviceServiceError("not_found");
    const filename = segments.at(-1) ?? "";
    const current = await this.#child(parent.resource.id, filename);
    if (current === undefined) {
      if (conditions.ifMatch !== undefined && conditions.ifMatch !== "*") throw new DeviceServiceError("precondition_failed");
      const resource = await this.#upload(context, parent.resource.id, filename, source, size);
      return { resource, created: true, conflict: false };
    }
    if (current.type !== "file") throw new DeviceServiceError("conflict");
    const currentEtag = resourceEtag(current);
    if (conditions.ifMatch === undefined) throw new DeviceServiceError("precondition_required");
    if (conditions.ifMatch !== "*" && conditions.ifMatch !== currentEtag) {
      const conflictName = this.#conflictName(filename, context.device);
      const conflict = await this.#upload(context, parent.resource.id, conflictName, source, size);
      await this.input.repository.recordConflict({ id: uuidv7(), deviceId: context.device.id, resourceId: current.id, conflictResourceId: conflict.id, baseEtag: conditions.ifMatch, currentEtag, state: "open", createdAt: new Date() });
      await this.#audit("sync.conflict.created", context.device.id, { resourceId: current.id, conflictResourceId: conflict.id, baseEtag: conditions.ifMatch, currentEtag }, this.#actor(context));
      return { resource: conflict, created: true, conflict: true };
    }
    if (conditions.ifNoneMatch === "*") throw new DeviceServiceError("precondition_failed");
    const resource = await this.#upload(context, parent.resource.id, filename, source, size, current.id);
    return { resource, created: false, conflict: false };
  }

  async createCollection(context: DeviceContext, rawPath: string): Promise<Resource> {
    this.#right(context, "write");
    const segments = normalizeDavPath(rawPath);
    if (segments.length < 2) throw new DeviceServiceError("invalid_path");
    const parent = await this.#resolve(context, segments.slice(0, -1));
    if (await this.#child(parent.resource.id, segments.at(-1) ?? "")) throw new DeviceServiceError("conflict");
    return this.input.files.createFolder(parent.resource.id, segments.at(-1) ?? "", this.#actor(context));
  }

  async move(context: DeviceContext, sourcePath: string, destinationPath: string, copy: boolean, overwrite: boolean): Promise<Resource> {
    this.#right(context, "move");
    const sourceSegments = normalizeDavPath(sourcePath);
    const destinationSegments = normalizeDavPath(destinationPath);
    if (sourceSegments.length < 2 || destinationSegments.length < 2 || sourceSegments[0] !== destinationSegments[0]) throw new DeviceServiceError("forbidden");
    const source = await this.#resolve(context, sourceSegments);
    const parent = await this.#resolve(context, destinationSegments.slice(0, -1));
    const name = destinationSegments.at(-1) ?? "";
    const existing = await this.#child(parent.resource.id, name);
    if (existing !== undefined) {
      if (!overwrite) throw new DeviceServiceError("precondition_failed");
      throw new DeviceServiceError("conflict");
    }
    const mutation = { parentId: parent.resource.id, name, idempotencyKey: `dav-${copy ? "copy" : "move"}-${uuidv7()}`, auditActor: this.#actor(context) };
    return copy ? this.input.files.copyResource(source.resource.id, mutation) : this.input.files.moveResource(source.resource.id, mutation);
  }

  async remove(context: DeviceContext, rawPath: string, now = new Date()): Promise<Resource> {
    this.#right(context, "delete");
    const segments = normalizeDavPath(rawPath);
    if (segments.length < 2) throw new DeviceServiceError("forbidden");
    const target = await this.#resolve(context, segments);
    const count = await this.#treeCount(target.resource);
    if (!(await this.input.repository.reserveDelete({ deviceId: context.device.id, itemCount: count, since: new Date(now.getTime() - this.input.options.deleteWindowMs), limit: this.input.options.deleteMaxItems, occurredAt: now }))) throw new DeviceServiceError("rate_limited");
    return this.input.files.trashResource(target.resource.id, { idempotencyKey: `dav-delete-${uuidv7()}`, auditActor: this.#actor(context) });
  }

  async #resolve(context: DeviceContext, segments: readonly string[]): Promise<{ readonly resource: Resource; readonly scopeId: string }> {
    const alias = segments[0];
    if (alias === undefined) throw new DeviceServiceError("not_found");
    const scopeId = scopeAliases.get(alias);
    if (scopeId === undefined || !context.device.scopeIds.includes(scopeId)) throw new DeviceServiceError("not_found");
    let resource = await this.input.files.getResource(scopeId).catch(() => undefined);
    if (resource === undefined || resource.status !== "active") throw new DeviceServiceError("not_found");
    for (const name of segments.slice(1)) {
      resource = await this.#child(resource.id, name);
      if (resource === undefined || resource.status !== "active") throw new DeviceServiceError("not_found");
    }
    return { resource, scopeId };
  }

  async #child(parentId: string, name: string): Promise<Resource | undefined> {
    for (let offset = 0; ; offset += 500) {
      const children = await this.input.files.listChildren(parentId, offset, 500);
      const found = children.find((item) => item.name === name && item.status === "active");
      if (found !== undefined) return found;
      if (children.length < 500) return undefined;
    }
  }

  async #upload(context: DeviceContext, parentId: string, filename: string, source: Readable, size: number, overwriteResourceId?: string): Promise<Resource> {
    const upload = await this.input.files.createUpload({ parentId, filename, expectedSize: size, idempotencyKey: `dav-upload-${uuidv7()}`, ...(overwriteResourceId === undefined ? {} : { overwriteResourceId }), auditActor: this.#actor(context) });
    let offset = 0;
    try {
      for await (const raw of source) {
        const value = Buffer.from(raw as Uint8Array);
        for (let cursor = 0; cursor < value.length; cursor += this.input.options.uploadChunkMaxBytes) {
          const chunk = value.subarray(cursor, Math.min(cursor + this.input.options.uploadChunkMaxBytes, value.length));
          await this.input.files.appendUpload(upload.id, offset, chunk.length, Readable.from(chunk));
          offset += chunk.length;
        }
      }
      if (offset !== size) throw new Error("WebDAV body length differs from Content-Length");
      return (await this.input.files.completeUpload(upload.id)).resource;
    } catch (error) {
      await this.input.files.abandonUpload(upload.id).catch(() => undefined);
      throw error;
    }
  }

  #conflictName(filename: string, device: DeviceRecord): string {
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : "";
    const safeDevice = device.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "device";
    return `${stem} (conflict ${new Date().toISOString().slice(0, 10)} ${safeDevice}-${device.id.slice(0, 6)})${extension}`;
  }

  async #treeCount(resource: Resource): Promise<number> {
    if (resource.type === "file") return 1;
    let total = 1;
    for (let offset = 0; ; offset += 500) {
      const children = await this.input.files.listChildren(resource.id, offset, 500);
      for (const child of children) total += await this.#treeCount(child);
      if (total > this.input.options.deleteMaxItems || children.length < 500) return total;
    }
  }

  #right(context: DeviceContext, right: keyof DeviceRights): void {
    if (!context.device.rights[right]) throw new DeviceServiceError("forbidden");
  }

  #actor(context: DeviceContext) { return { type: "device_token", id: context.device.id }; }

  async #audit(action: string, subjectId: string, details: Readonly<Record<string, unknown>>, actor = { type: "owner_session", id: "owner" }): Promise<void> {
    await this.input.audit?.write({ actorType: actor.type, actorId: actor.id, action, outcome: "success", correlationId: `${action}:${uuidv7()}`, details: { subjectId, ...details } });
  }
}
