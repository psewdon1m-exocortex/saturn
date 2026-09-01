import { createHmac, randomBytes } from "node:crypto";
import type { AuditSink } from "@saturn/audit";
import type { FileVersion, Resource } from "@saturn/file-core";
import { v7 as uuidv7 } from "uuid";
import type {
  LaboratoryAsset,
  LaboratoryAssetMode,
  LaboratoryClient,
  LaboratoryDelivery,
  LaboratoryFileGateway,
  LaboratoryOptions,
  LaboratoryRepository,
  PublicLaboratoryClient,
} from "./types.js";

export class LaboratoryServiceError extends Error {
  constructor(
    readonly code: "disabled" | "not_found" | "unauthorized" | "invalid" | "conflict" | "limit" | "range",
    readonly sizeBytes?: number,
  ) {
    super(code === "range" ? "Laboratory Range is not satisfiable" : "Laboratory request was not accepted");
  }
}

function page(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new LaboratoryServiceError("invalid");
  }
}
function name(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 100 || hasControl(normalized)) throw new LaboratoryServiceError("invalid");
  return normalized;
}
function label(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 240 || hasControl(normalized)) throw new LaboratoryServiceError("invalid");
  return normalized;
}
function filename(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > 255 || normalized.includes("/") || normalized.includes("\\") || hasControl(normalized)) throw new LaboratoryServiceError("invalid");
  return normalized;
}
function isVolt(resource: Resource): boolean {
  return resource.storagePath === "volt" || resource.storagePath.startsWith("volt/");
}
function publicClient(value: LaboratoryClient): PublicLaboratoryClient {
  return { id: value.id, name: value.name, state: value.state,
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }), createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }) };
}
function parseRange(value: string | undefined, size: number): { readonly offset: number; readonly length: number; readonly partial: boolean } {
  if (value === undefined) return { offset: 0, length: size, partial: false };
  if (value.includes(",") || size === 0) throw new LaboratoryServiceError("range", size);
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === "" && match[2] === "")) throw new LaboratoryServiceError("range", size);
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new LaboratoryServiceError("range", size);
    const length = Math.min(suffix, size);
    return { offset: size - length, length, partial: true };
  }
  const offset = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset || end >= size) {
    throw new LaboratoryServiceError("range", size);
  }
  return { offset, length: end - offset + 1, partial: true };
}
function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function markdownText(value: string): string { return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]"); }
function htmlText(value: string): string { return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

export class LaboratoryService {
  readonly #pepper: Buffer;
  #activePublicStreams = 0;

  constructor(private readonly input: {
    readonly repository: LaboratoryRepository;
    readonly files: LaboratoryFileGateway;
    readonly pepper: string;
    readonly options: LaboratoryOptions;
    readonly audit?: AuditSink;
  }) {
    if (input.pepper.length < 32 || /[\r\n]/.test(input.pepper)) throw new Error("Laboratory pepper is invalid");
    this.#pepper = Buffer.from(input.pepper, "utf8");
  }

  #enabled(): void { if (!this.input.options.enabled) throw new LaboratoryServiceError("disabled"); }
  #hmac(token: string): string { return createHmac("sha256", this.#pepper).update("laboratory-client-token\0").update(token).digest("hex"); }
  #token(): string { return randomBytes(32).toString("base64url"); }

  async createClient(clientName: string, now = new Date()): Promise<{ readonly client: PublicLaboratoryClient; readonly token: string }> {
    this.#enabled();
    const token = this.#token();
    const client: LaboratoryClient = { id: uuidv7(), name: name(clientName), tokenHash: this.#hmac(token), state: "active", createdAt: now, updatedAt: now };
    await this.input.repository.createClient(client);
    await this.#audit("laboratory.client.created", client.id, {});
    return { client: publicClient(client), token };
  }
  async listClients(offset = 0, limit = 100): Promise<readonly PublicLaboratoryClient[]> {
    this.#enabled(); page(offset, limit); return (await this.input.repository.listClients(offset, limit)).map(publicClient);
  }
  async rotateClient(id: string, now = new Date()): Promise<{ readonly client: PublicLaboratoryClient; readonly token: string }> {
    this.#enabled(); const token = this.#token();
    const updated = await this.input.repository.rotateClientToken(id, this.#hmac(token), new Date(now.getTime() + this.input.options.tokenRotationGraceMs), now);
    await this.#audit("laboratory.client.token.rotated", id, { overlapMs: this.input.options.tokenRotationGraceMs });
    return { client: publicClient(updated), token };
  }
  async revokeClient(id: string, now = new Date()): Promise<PublicLaboratoryClient> {
    this.#enabled(); const updated = await this.input.repository.revokeClient(id, now); await this.#audit("laboratory.client.revoked", id, {}); return publicClient(updated);
  }

  async createAsset(input: { readonly resourceId: string; readonly mode: LaboratoryAssetMode; readonly label?: string; readonly disposition?: "inline" | "attachment" }, now = new Date()): Promise<LaboratoryAsset> {
    this.#enabled(); const resource = await this.#resource(input.resourceId); this.#modeAllowed(input.mode, resource);
    const version = input.mode === "public_immutable" ? await this.#currentVersion(resource) : undefined;
    const value: LaboratoryAsset = { id: uuidv7(), resourceId: resource.id, mode: input.mode,
      ...(version === undefined ? {} : { pinnedVersionId: version.id }), publicFilename: filename(resource.name),
      label: label(input.label ?? resource.name), disposition: input.disposition ?? (resource.mimeType?.startsWith("image/") || resource.mimeType?.startsWith("video/") ? "inline" : "attachment"),
      state: "active", createdAt: now, updatedAt: now };
    try { const created = await this.input.repository.createAsset(value); await this.#audit("laboratory.asset.created", created.id, { resourceId: resource.id, mode: created.mode }); return created; }
    catch (error) { if (error instanceof Error && /constraint|classification|active file|pinned version/i.test(error.message)) throw new LaboratoryServiceError("invalid"); throw error; }
  }
  async listAssets(offset = 0, limit = 100): Promise<readonly LaboratoryAsset[]> { this.#enabled(); page(offset, limit); return this.input.repository.listAssets(offset, limit); }
  async getAsset(id: string): Promise<LaboratoryAsset> { this.#enabled(); return this.#requiredAsset(id); }
  async updateAsset(id: string, input: { readonly mode?: LaboratoryAssetMode; readonly label?: string; readonly disposition?: "inline" | "attachment" }, now = new Date()): Promise<LaboratoryAsset> {
    this.#enabled(); const current = await this.#requiredAsset(id); if (current.state !== "active") throw new LaboratoryServiceError("conflict");
    const resource = await this.#resource(current.resourceId); const mode = input.mode ?? current.mode; this.#modeAllowed(mode, resource);
    let pinnedVersionId: string | null | undefined;
    if (mode !== "public_immutable") pinnedVersionId = null;
    else if (current.mode !== "public_immutable") pinnedVersionId = (await this.#currentVersion(resource)).id;
    const updated = await this.input.repository.updateAsset(id, { ...(input.mode === undefined ? {} : { mode }), ...(pinnedVersionId === undefined ? {} : { pinnedVersionId }), ...(input.label === undefined ? {} : { label: label(input.label) }), ...(input.disposition === undefined ? {} : { disposition: input.disposition }) }, now);
    await this.#audit("laboratory.asset.updated", id, { mode: updated.mode }); return updated;
  }
  async disableAsset(id: string, now = new Date()): Promise<LaboratoryAsset> { this.#enabled(); const value=await this.input.repository.disableAsset(id,now);await this.#audit("laboratory.asset.disabled",id,{});return value; }

  async fragment(id: string): Promise<{ readonly asset: LaboratoryAsset; readonly url: string; readonly fragment: string; readonly format: "markdown_image" | "markdown_link" | "html_video" }> {
    const asset = await this.#requiredAsset(id); if (asset.state !== "active") throw new LaboratoryServiceError("not_found");
    const resource = await this.#resource(asset.resourceId); this.#modeAllowed(asset.mode, resource);
    const url = `${this.input.options.publicOrigin}/a/${encodeURIComponent(asset.id)}/${encodeURIComponent(asset.publicFilename)}`;
    if (resource.mimeType?.startsWith("image/")) return { asset, url, fragment: `![${markdownText(asset.label)}](${url})`, format: "markdown_image" };
    if (resource.mimeType?.startsWith("video/")) return { asset, url, fragment: `<video controls src="${htmlText(url)}" aria-label="${htmlText(asset.label)}"></video>`, format: "html_video" };
    return { asset, url, fragment: `[${markdownText(asset.label)}](${url})`, format: "markdown_link" };
  }

  async deliver(input: { readonly assetId: string; readonly filename: string; readonly authorization?: string; readonly range?: string; readonly ifNoneMatch?: string; readonly head?: boolean }, now = new Date()): Promise<LaboratoryDelivery> {
    this.#enabled(); const asset = await this.#requiredAsset(input.assetId).catch(() => { throw new LaboratoryServiceError("not_found"); });
    if (asset.state !== "active" || input.filename !== asset.publicFilename) throw new LaboratoryServiceError("not_found");
    const resource = await this.#resource(asset.resourceId).catch(() => { throw new LaboratoryServiceError("not_found"); });
    let actor = { type: "laboratory_public", id: asset.id };
    if (asset.mode === "private") {
      const context = await this.#authenticate(input.authorization, now);
      actor = { type: "laboratory_client", id: context.client.id };
    } else if (!this.input.options.publicEnabled || resource.securityClassification !== "public") throw new LaboratoryServiceError("not_found");
    const version = asset.mode === "public_immutable" ? await this.#version(resource, asset.pinnedVersionId) : await this.#currentVersion(resource);
    const etag = `"sha256-${version.sha256}"`; const selectedRange = parseRange(input.range, version.sizeBytes);
    const notModified = input.ifNoneMatch === "*" || input.ifNoneMatch?.split(",").map((value) => value.trim()).includes(etag) === true;
    const cacheControl = asset.mode === "public_immutable" ? "public, max-age=31536000, immutable" : asset.mode === "public_alias" ? "public, max-age=0, must-revalidate" : "private, no-store";
    let release: () => void = () => undefined; let stream;
    if (!notModified && input.head !== true) {
      if (asset.mode !== "private") release = this.#acquirePublicStream();
      try {
        const length = selectedRange.partial ? selectedRange.length : undefined;
        const opened = asset.mode === "public_immutable"
          ? await this.input.files.openVersionDownload(resource.id, version.id, selectedRange.offset, length, actor)
          : await this.input.files.openDownload(resource.id, selectedRange.offset, length, actor);
        stream = opened.stream;
      } catch (error) { release(); throw error; }
    }
    await this.#audit("laboratory.asset.opened", asset.id, { resourceId: resource.id, mode: asset.mode, versionId: version.id, offset: selectedRange.offset, length: selectedRange.length, head: input.head === true, notModified }, actor.id, actor.type);
    return { asset, resource, versionId: version.id, sizeBytes: version.sizeBytes, sha256: version.sha256, mimeType: version.mimeType, etag, lastModified: version.createdAt, cacheControl,
      offset: selectedRange.offset, length: selectedRange.length, partial: selectedRange.partial, notModified, ...(stream === undefined ? {} : { stream }), release };
  }

  async #authenticate(authorization: string | undefined, now: Date) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
    if (token === undefined) throw new LaboratoryServiceError("not_found");
    const context = await this.input.repository.authenticateClient(this.#hmac(token), now);
    if (context === undefined) throw new LaboratoryServiceError("not_found");
    return context;
  }
  async #resource(id: string): Promise<Resource> {
    const resource = await this.input.files.getResource(id);
    if (resource.type !== "file" || resource.status !== "active" || isVolt(resource)) throw new LaboratoryServiceError("invalid");
    return resource;
  }
  #modeAllowed(mode: LaboratoryAssetMode, resource: Resource): void {
    if (mode !== "private" && (!this.input.options.publicEnabled || resource.securityClassification !== "public")) throw new LaboratoryServiceError("unauthorized");
  }
  async #currentVersion(resource: Resource): Promise<FileVersion> {
    if (resource.currentVersionId === undefined) throw new LaboratoryServiceError("not_found"); return this.#version(resource, resource.currentVersionId);
  }
  async #version(resource: Resource, id: string | undefined): Promise<FileVersion> {
    if (id === undefined) throw new LaboratoryServiceError("not_found");
    const version = await this.input.files.getVersion(resource.id, id).catch(() => { throw new LaboratoryServiceError("not_found"); });
    if (version.state !== "active" || !/^[a-f0-9]{64}$/.test(version.sha256)) throw new LaboratoryServiceError("not_found"); return version;
  }
  async #requiredAsset(id: string): Promise<LaboratoryAsset> {
    const value = await this.input.repository.getAsset(id); if (value === undefined) throw new LaboratoryServiceError("not_found"); return value;
  }
  #acquirePublicStream(): () => void {
    if (this.#activePublicStreams >= this.input.options.maxConcurrentPublicStreams) throw new LaboratoryServiceError("limit");
    this.#activePublicStreams += 1; let active = true;
    return () => { if (!active) return; active = false; this.#activePublicStreams -= 1; };
  }
  async #audit(action: string, subjectId: string, details: Readonly<Record<string, unknown>>, actorId = "owner", actorType = "owner_session"): Promise<void> {
    await this.input.audit?.write({ actorType, actorId, action, outcome: "success", correlationId: `${action}:${uuidv7()}`, details: { subjectId, ...details } });
  }
}
