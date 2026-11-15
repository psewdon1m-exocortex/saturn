import { argon2, createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AuditSink } from "@saturn/audit";
import type { Resource, SecurityClassification } from "@saturn/file-core";
import { ensureStorageDirectory } from "@saturn/storage";
import { v7 as uuidv7 } from "uuid";
import { ZipFile } from "yazl";
import { performance } from "node:perf_hooks";
import { PackageCustodyCapacityError, type PackageWriterClaim } from "./package-lifecycle.js";
import { createLeasedPackageStream } from "./package-read-lease.js";
import { packageArchiveReservation, PackageByteReservation } from "./package-reservation.js";
import type {
  PublicShare,
  ShareFileGateway,
  ShareMode,
  ShareOptions,
  SharePackage,
  ShareRecord,
  ShareRepository,
  ShareSession,
  ShareStorageGateway,
  ShareDownloadRange,
  ShareRangeSelection,
} from "./types.js";

const classificationRank: Readonly<Record<SecurityClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};
const inlineTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/markdown", "audio/mpeg", "audio/ogg", "audio/wav", "video/mp4", "video/webm"]);

export class ShareServiceError extends Error {
  readonly code: "not_found" | "locked" | "denied" | "rate_limited" | "invalid_mode" | "package_limit" | "package_unavailable";

  constructor(code: ShareServiceError["code"]) {
    super(code === "not_found" ? "Share not found" : code === "rate_limited" ? "Share access is temporarily unavailable" : "Share access was denied");
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tokenValid(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function hashPassword(password: string, nonce = randomBytes(16)): Promise<string> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: Buffer.from(password, "utf8"), nonce, parallelism: 1, tagLength: 32, memory: 19_456, passes: 2 }, (error, key) => {
      if (error !== null) reject(error);
      else resolve(`argon2id$v=19$m=19456,t=2,p=1$${nonce.toString("base64url")}$${key.toString("base64url")}`);
    });
  });
}

async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== "argon2id" || parts[1] !== "v=19" || parts[2] !== "m=19456,t=2,p=1") return false;
  const nonce = Buffer.from(parts[3] ?? "", "base64url");
  const expected = Buffer.from(parts[4] ?? "", "base64url");
  if (nonce.length !== 16 || expected.length !== 32) return false;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    argon2("argon2id", { message: Buffer.from(password, "utf8"), nonce, parallelism: 1, tagLength: 32, memory: 19_456, passes: 2 }, (error, key) => error === null ? resolve(key) : reject(error));
  });
  return timingSafeEqual(actual, expected);
}

function validatePassword(password: string): string {
  const bytes = Buffer.byteLength(password, "utf8");
  if (password.length < 1 || password.length > 128 || bytes > 256 || /[\r\n]/.test(password)) throw new Error("Share password is invalid");
  return password;
}

function publicValue(share: ShareRecord, resource: Resource, locked: boolean): PublicShare {
  return {
    id: share.id,
    resourceId: share.resourceId,
    resourceType: share.resourceType,
    resourceName: resource.name,
    resourceSize: resource.sizeBytes,
    ...(resource.mimeType === undefined ? {} : { resourceMimeType: resource.mimeType }),
    mode: share.mode,
    state: share.state,
    locked,
    ...(share.expiresAt === undefined ? {} : { expiresAt: share.expiresAt }),
    ...(share.maxDownloads === undefined ? {} : { maxDownloads: share.maxDownloads }),
    downloadCount: share.downloadCount,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
  };
}

async function streamHash(source: Readable): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of source) {
    const value = Buffer.from(chunk as Uint8Array);
    bytes += value.length;
    hash.update(value);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function waitForPhysicalClose(closed: Promise<void> | undefined, deadline: number): Promise<void> {
  if (!closed) throw new Error("Package backend read closure is unsupported");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Package physical read closure timed out")), Math.max(1, deadline - performance.now()));
      timer.unref();
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export class ShareService {
  #nextPackageCleanupAt = 0;
  readonly #repository: ShareRepository;
  readonly #files: ShareFileGateway;
  readonly #storage: ShareStorageGateway;
  readonly #pepper: Buffer;
  readonly #options: ShareOptions;
  readonly #audit: AuditSink | undefined;

  constructor(input: { readonly repository: ShareRepository; readonly files: ShareFileGateway; readonly storage: ShareStorageGateway; readonly pepper: string; readonly options: ShareOptions; readonly audit?: AuditSink }) {
    if (input.pepper.length < 32 || /[\r\n]/.test(input.pepper)) throw new Error("Share pepper is invalid");
    this.#repository = input.repository;
    this.#files = input.files;
    this.#storage = input.storage;
    this.#pepper = Buffer.from(input.pepper, "utf8");
    this.#options = input.options;
    this.#audit = input.audit;
  }

  #hmac(label: string, value: string): string {
    return createHmac("sha256", this.#pepper).update(label).update("\0").update(value).digest("hex");
  }

  #sourceHash(sourceIp: string): string { return this.#hmac("share-source-ip", sourceIp.slice(0, 128)); }
  #userAgentHash(userAgent: string): string { return this.#hmac("share-user-agent", userAgent.slice(0, 1024)); }
  #tokenHash(token: string): string { return this.#hmac("share-capability-token", token); }

  #capabilityKey(): Buffer {
    return createHmac("sha256", this.#pepper).update("share-capability-encryption-key").digest();
  }

  #encryptCapability(id: string, token: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#capabilityKey(), nonce);
    cipher.setAAD(Buffer.from(`saturn-share-capability\0${id}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return `v1.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  #decryptCapability(share: ShareRecord): string {
    const parts = share.tokenCiphertext?.split(".") ?? [];
    if (parts.length !== 4 || parts[0] !== "v1") throw new ShareServiceError("denied");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#capabilityKey(), Buffer.from(parts[1] ?? "", "base64url"));
      decipher.setAAD(Buffer.from(`saturn-share-capability\0${share.id}`, "utf8"));
      decipher.setAuthTag(Buffer.from(parts[3] ?? "", "base64url"));
      const token = Buffer.concat([decipher.update(Buffer.from(parts[2] ?? "", "base64url")), decipher.final()]).toString("utf8");
      if (!tokenValid(token) || this.#tokenHash(token) !== share.tokenHash) throw new Error("Capability integrity mismatch");
      return token;
    } catch {
      throw new ShareServiceError("denied");
    }
  }

  async createShare(input: { readonly resourceId: string; readonly mode: ShareMode; readonly expiresAt?: Date; readonly password?: string; readonly maxDownloads?: number; readonly allowedCidr?: string }, now = new Date()): Promise<{ readonly token: string; readonly url: string; readonly share: PublicShare }> {
    if (!this.#options.enabled) throw new ShareServiceError("denied");
    const resource = await this.#files.getResource(input.resourceId);
    const classification = resource.securityClassification ?? "internal";
    if (resource.status !== "active" || classificationRank[classification] > classificationRank.internal) throw new ShareServiceError("denied");
    const classificationCeiling: "public" | "internal" = classification === "public" ? "public" : "internal";
    this.#validateMode(resource, input.mode);
    const expiresAt = input.expiresAt;
    if (expiresAt !== undefined && (expiresAt <= now || expiresAt.getTime() - now.getTime() > this.#options.maxExpiryMs)) throw new Error("Share expiry is invalid");
    if (input.maxDownloads !== undefined && (!Number.isSafeInteger(input.maxDownloads) || input.maxDownloads < 1 || input.maxDownloads > 1_000_000)) throw new Error("Share download limit is invalid");
    const id = uuidv7();
    const token = randomBytes(32).toString("base64url");
    const publicOrigin = await this.#options.resolvePublicOrigin?.() ?? this.#options.publicOrigin;
    const record = await this.#repository.createShare({
      id,
      tokenHash: this.#tokenHash(token),
      tokenCiphertext: this.#encryptCapability(id, token),
      resourceId: resource.id,
      resourceType: resource.type,
      mode: input.mode,
      ...(input.password === undefined ? {} : { passwordHash: await hashPassword(validatePassword(input.password)) }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(input.maxDownloads === undefined ? {} : { maxDownloads: input.maxDownloads }),
      ...(input.allowedCidr === undefined || input.allowedCidr === "" ? {} : { allowedCidr: input.allowedCidr }),
      classificationCeiling,
      createdAt: now,
    });
    await this.#auditOwner("share.created", record.id, { resourceId: resource.id, mode: record.mode, passwordProtected: record.passwordHash !== undefined });
    return { token, url: new URL(`/s/${token}`, publicOrigin).toString(), share: publicValue(record, resource, record.passwordHash !== undefined) };
  }

  async listShares(offset = 0, limit = 100): Promise<readonly PublicShare[]> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Share page is invalid");
    const records = await this.#repository.listShares(offset, limit);
    return Promise.all(records.map(async (record) => publicValue(record, await this.#files.getResource(record.resourceId), record.passwordHash !== undefined)));
  }

  async getShareCapability(id: string, now = new Date()): Promise<{ readonly url: string; readonly replaced: boolean }> {
    let record = await this.#repository.getShareById(id);
    if (record === undefined) throw new ShareServiceError("not_found");
    if (record.state !== "active" || (record.expiresAt !== undefined && record.expiresAt <= now) || (record.maxDownloads !== undefined && record.downloadCount >= record.maxDownloads)) throw new ShareServiceError("denied");
    let replaced = false;
    let token: string;
    if (record.tokenCiphertext === undefined) {
      token = randomBytes(32).toString("base64url");
      const rotation = await this.#repository.rotateShareCapability(id, { tokenHash: this.#tokenHash(token), tokenCiphertext: this.#encryptCapability(id, token) }, now);
      record = rotation.share;
      replaced = rotation.rotated;
      if (!rotation.rotated) token = this.#decryptCapability(record);
    } else {
      token = this.#decryptCapability(record);
    }
    const publicOrigin = await this.#options.resolvePublicOrigin?.() ?? this.#options.publicOrigin;
    await this.#auditOwner(replaced ? "share.capability_replaced" : "share.capability_retrieved", record.id, { resourceId: record.resourceId });
    return { url: new URL(`/s/${token}`, publicOrigin).toString(), replaced };
  }

  async updateShare(id: string, input: { readonly mode?: ShareMode; readonly expiresAt?: Date | null; readonly password?: string | null; readonly maxDownloads?: number | null; readonly allowedCidr?: string | null }, now = new Date()): Promise<PublicShare> {
    const existing = await this.#repository.getShareById(id);
    if (existing === undefined) throw new ShareServiceError("not_found");
    const resource = await this.#files.getResource(existing.resourceId);
    if (input.mode !== undefined) this.#validateMode(resource, input.mode);
    if (input.expiresAt !== undefined && input.expiresAt !== null && (input.expiresAt <= now || input.expiresAt.getTime() - now.getTime() > this.#options.maxExpiryMs)) throw new Error("Share expiry is invalid");
    if (input.maxDownloads !== undefined && input.maxDownloads !== null && (!Number.isSafeInteger(input.maxDownloads) || input.maxDownloads < Math.max(1, existing.downloadCount))) throw new Error("Share download limit is invalid");
    const updated = await this.#repository.updateShare(id, {
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.password === undefined ? {} : { passwordHash: input.password === null ? null : await hashPassword(validatePassword(input.password)) }),
      ...(input.maxDownloads === undefined ? {} : { maxDownloads: input.maxDownloads }),
      ...(input.allowedCidr === undefined ? {} : { allowedCidr: input.allowedCidr }),
    }, now);
    await this.#auditOwner("share.updated", updated.id, { resourceId: updated.resourceId, mode: updated.mode });
    return publicValue(updated, resource, updated.passwordHash !== undefined);
  }

  async revokeShare(id: string, now = new Date()): Promise<PublicShare> {
    const record = await this.#repository.revokeShare(id, now);
    const resource = await this.#files.getResource(record.resourceId);
    await this.#auditOwner("share.revoked", record.id, { resourceId: record.resourceId });
    return publicValue(record, resource, record.passwordHash !== undefined);
  }

  async classifyResource(id: string, classification: SecurityClassification): Promise<Resource> {
    return this.#files.setSecurityClassification(id, classification);
  }

  async metadata(token: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, true);
    await this.#access(access.share.id, input.sourceIp, "metadata", "success", 200, now);
    return { share: publicValue(access.share, access.resource, access.locked), ...(access.newSession === undefined ? {} : { session: access.newSession }) };
  }

  async unlock(token: string, password: string, input: { readonly sourceIp: string; readonly userAgent: string }, now = new Date()) {
    const sourceIpHash = this.#sourceHash(input.sourceIp);
    const attempt = await this.#repository.beginPasswordAttempt({ sourceIpHash, since: new Date(now.getTime() - this.#options.passwordFailureWindowMs), limit: this.#options.passwordFailureLimit, occurredAt: now });
    if (attempt === undefined) {
      await this.#access(undefined, input.sourceIp, "unlock", "denied", 429, now);
      await this.#failureDelay();
      throw new ShareServiceError("rate_limited");
    }
    try {
      const share = await this.#resolveShare(token);
      const resource = await this.#validateShare(share, input.sourceIp, now, false);
      if (share.passwordHash === undefined || !(await verifyPassword(share.passwordHash, password.slice(0, 256)))) throw new ShareServiceError("denied");
      await this.#repository.finishPasswordAttempt(attempt, "success", now);
      const session = await this.#newSession(share.id, input.sourceIp, input.userAgent, now);
      await this.#access(share.id, input.sourceIp, "unlock", "success", 200, now);
      return { share: publicValue(share, resource, false), session };
    } catch {
      await this.#repository.finishPasswordAttempt(attempt, "failure", now).catch(() => undefined);
      await this.#access(undefined, input.sourceIp, "unlock", "denied", 401, now);
      await this.#failureDelay();
      throw new ShareServiceError("denied");
    }
  }

  async listChildren(token: string, parentId: string | undefined, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    return (await this.#listChildren(token, parentId, input, undefined, now)).items;
  }

  async listChildrenPage(token: string, parentId: string | undefined, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, page: { readonly offset: number; readonly limit: number }, now = new Date()) {
    if (!Number.isSafeInteger(page.offset) || page.offset < 0 || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 500) throw new Error("Share listing page is invalid");
    return this.#listChildren(token, parentId, input, page, now);
  }

  async #listChildren(token: string, parentId: string | undefined, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, page: { readonly offset: number; readonly limit: number } | undefined, now: Date) {
    const access = await this.#authorize(token, input, now, false);
    if (access.locked || !["browse", "download_folder"].includes(access.share.mode)) throw new ShareServiceError(access.locked ? "locked" : "invalid_mode");
    const selectedParent = parentId ?? access.share.resourceId;
    if (!(await this.#repository.isDescendant(access.share.resourceId, selectedParent, access.share.classificationCeiling))) throw new ShareServiceError("not_found");
    const parent = await this.#files.getResource(selectedParent);
    if (parent.type !== "folder" || parent.status !== "active" || classificationRank[parent.securityClassification ?? "internal"] > classificationRank[access.share.classificationCeiling]) throw new ShareServiceError("not_found");
    // Retain the legacy endpoint contract; the current browser opts into the bounded page endpoint.
    const children = page === undefined ? await this.#allChildren(parent.id, Number.MAX_SAFE_INTEGER) : await this.#files.listChildren(parent.id, page.offset, page.limit);
    const visible = children.filter((child) => child.status === "active" && classificationRank[child.securityClassification ?? "internal"] <= classificationRank[access.share.classificationCeiling]);
    await this.#access(access.share.id, input.sourceIp, "browse", "success", 200, now);
    return { nextOffset: page !== undefined && children.length === page.limit ? page.offset + children.length : null, items: visible.map((child) => ({
      id: child.id,
      parentId: child.parentId,
      type: child.type,
      name: child.name,
      sizeBytes: child.sizeBytes,
      mimeType: child.mimeType,
      ...(child.sha256 === undefined ? {} : { sha256: child.sha256 }),
      updatedAt: child.updatedAt,
    })) };
  }

  async childMetadata(token: string, resourceId: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    const resource = await this.#sharedChild(access.share, resourceId);
    return { share: access.share, resource, session: access.newSession };
  }

  async openChildContent(token: string, resourceId: string, range: ShareRangeSelection, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string; readonly transferId?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    if (access.share.mode !== "download_folder") throw new ShareServiceError("invalid_mode");
    const resource = await this.#sharedChild(access.share, resourceId);
    const opened = await this.#openContentResource(access.share, resource, range);
    await this.#repository.claimDownload(access.share.id, access.session.id, now, input.transferId === undefined ? undefined : { id: input.transferId, resourceId, kind: "content" })
      .catch(() => { opened.stream.destroy(); throw new ShareServiceError("denied"); });
    await this.#access(access.share.id, input.sourceIp, "content", "success", opened.range.length === undefined && opened.range.offset === 0 ? 200 : 206, now, opened.range);
    return { share: access.share, resource: opened.resource, stream: this.#guardStream(access.share.id, opened.stream, async () => { await this.#sharedChild(access.share, resourceId); }, access.session.id), session: access.session };
  }

  async thumbnailSource(token: string, resourceId: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    const resource = access.share.resourceType === "file"
      ? access.share.resourceId === resourceId && ["view", "download"].includes(access.share.mode)
        ? access.resource
        : undefined
      : await this.#sharedChild(access.share, resourceId);
    if (resource === undefined || resource.type !== "file") throw new ShareServiceError("not_found");
    await this.#access(access.share.id, input.sourceIp, "thumbnail", "success", 200, now);
    return {
      resource,
      open: async () => this.#guardStream(access.share.id, (await this.#openContentResource(access.share, resource, { offset: 0 })).stream,
        access.share.resourceType === "folder" ? async () => { await this.#sharedChild(access.share, resource.id); } : undefined, access.session.id),
      ...(access.newSession === undefined ? {} : { session: access.newSession }),
    };
  }

  async contentMetadata(token: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    if (access.locked) throw new ShareServiceError("locked");
    if (access.share.resourceType !== "file" || !["view", "download"].includes(access.share.mode)) throw new ShareServiceError("invalid_mode");
    if (access.share.mode === "view" && !inlineTypes.has(access.resource.mimeType ?? "application/octet-stream")) throw new ShareServiceError("invalid_mode");
    return access;
  }

  async openContent(token: string, range: ShareRangeSelection, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string; readonly transferId?: string }, now = new Date()) {
    const access = await this.contentMetadata(token, input, now);
    const opened = await this.#openContentResource(access.share, access.resource, range);
    if (access.share.mode !== "view") await this.#repository.claimDownload(access.share.id, access.session.id, now, input.transferId === undefined ? undefined : { id: input.transferId, resourceId: access.resource.id, kind: "content" })
      .catch(() => { opened.stream.destroy(); throw new ShareServiceError("denied"); });
    await this.#access(access.share.id, input.sourceIp, "content", "success", opened.range.length === undefined && opened.range.offset === 0 ? 200 : 206, now, opened.range);
    return { share: access.share, resource: opened.resource, stream: this.#guardStream(access.share.id, opened.stream, undefined, access.session.id), session: access.session };
  }

  async preparePackage(token: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()): Promise<SharePackage> {
    const access = await this.#authorize(token, input, now, false);
    if (access.locked || access.share.mode !== "download_folder" || access.share.resourceType !== "folder") throw new ShareServiceError(access.locked ? "locked" : "invalid_mode");
    const id = uuidv7();
    const storagePath = `_system/packages/${access.share.id}/${id}.zip`;
    const expiry = access.share.expiresAt ?? new Date(now.getTime() + this.#options.defaultExpiryMs);
    const reservation = await this.#repository.createPackage({ id, shareId: access.share.id, storagePath, createdAt: now, expiresAt: expiry });
    if (!reservation.created) {
      if (reservation.value.state === "ready") {
        try { await this.#validatePackage(access.share, access.resource, reservation.value); }
        catch (error) { if (error instanceof ShareServiceError && error.code === "package_unavailable") return this.preparePackage(token, input, now); throw error; }
      }
      return reservation.value;
    }
    if (this.#repository.claimPendingPackage !== undefined) return reservation.value;
    const ready = await this.#buildPackage(access.share, access.resource, reservation.value, now);
    await this.#access(access.share.id, input.sourceIp, "package_create", "success", 201, now);
    return ready;
  }

  async runNextPackage(): Promise<boolean> {
    if (Date.now() >= this.#nextPackageCleanupAt) {
      await this.cleanupExpiredPackages(new Date(), 10);
      this.#nextPackageCleanupAt = Date.now() + 60_000;
    }
    const item = await this.#repository.claimPendingPackage?.(new Date());
    if (item === undefined) return false;
    const share = await this.#repository.getShareById(item.shareId);
    try {
      if (share === undefined || !(await this.#repository.validateActive(share.id, new Date()))) throw new ShareServiceError("denied");
      const root = await this.#files.getResource(share.resourceId);
      await this.#buildPackage(share, root, item, new Date());
    } catch (error) {
      await this.#repository.setPackageFailed(item.id, error instanceof ShareServiceError || error instanceof PackageCustodyCapacityError ? error.code : "package_failed", item.generationId);
    }
    return true;
  }

  async #buildPackage(share: ShareRecord, resource: Resource, value: SharePackage, now: Date): Promise<SharePackage> {
    const access = { share, resource };
    const { id } = value;
    let storagePath = value.storagePath;
    const lifecycle = this.#repository.packageLifecycle;
    let claim: PackageWriterClaim | undefined, writeStarted = false, writeSucceeded = false, verificationStarted = false, verificationClosed = false;
    const writerCustodyClosed = () => (!writeStarted || writeSucceeded) && (!verificationStarted || verificationClosed);
    const deadline = Date.now() + this.#options.packageMaxDurationMs;
    const monotonicDeadline = performance.now() + this.#options.packageMaxDurationMs;
    let zipOutput: Readable | undefined, limiter: Transform | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let writing: Promise<number> | undefined, flowing: Promise<void> | undefined;
    const members = new Set<Readable>();
    try {
      const entries = await this.#packageEntries(access.share, access.resource, now);
      const sourceFingerprint = this.#entryFingerprint(entries);
      const reservedBytes = packageArchiveReservation(entries), byteReservation = new PackageByteReservation(reservedBytes);
      if (lifecycle) { claim = await lifecycle.begin(id, reservedBytes, Math.min(3_600_000, this.#options.packageMaxDurationMs + 5_000)); storagePath = claim.storagePath; }
      const directory = `_system/packages/${access.share.id}`;
      await ensureStorageDirectory(this.#storage, "_system/packages");
      await ensureStorageDirectory(this.#storage, directory);
      if (!lifecycle && await this.#storage.exists(storagePath)) await this.#storage.delete(storagePath);
      if (Date.now() >= deadline) throw new ShareServiceError("package_limit");
      const zip = new ZipFile();
      // yazl exposes a Node PassThrough; its declarations use the older ReadableStream interface.
      const output = zip.outputStream as Readable;
      zipOutput = output;
      zip.on("error", (error: Error) => output.destroy(error));
      const files = entries.filter(entry => entry.resource.type === "file");
      const pending = new Map<(typeof files)[number], Promise<Readable | undefined>>();
      let next = 0;
      const prepare = () => {
        // A later physical reader must not wait idle while a large member progresses.
        while (!output.destroyed && pending.size < 1 && next < files.length) {
          const entry = files[next++];
          if (entry === undefined) throw new ShareServiceError("package_unavailable");
          pending.set(entry, this.#files.openDownload(entry.resource.id, current => {
            if (current.status !== "active" || current.type !== "file" || current.parentId !== entry.resource.parentId || current.storagePath !== entry.resource.storagePath
              || this.#entryFingerprint([{ resource: current, path: entry.path }]) !== this.#entryFingerprint([entry])) throw new ShareServiceError("package_unavailable");
            return { offset: 0 };
          }).then(opened => {
            if (output.destroyed) { opened.stream.destroy(); return undefined; }
            members.add(opened.stream);
            opened.stream.once("error", error => output.destroy(error));
            opened.stream.once("close", () => {
              members.delete(opened.stream);
              if (!opened.stream.readableEnded && !output.destroyed) output.destroy(new Error("Package source closed before completion"));
            });
            return opened.stream;
          }).catch((error: unknown) => { output.destroy(error instanceof Error ? error : new Error("Package source open failed")); return undefined; }));
        }
      };
      output.once("close", () => { for (const member of members) member.destroy(); });
      for (const entry of entries) {
        if (entry.resource.type === "folder") zip.addEmptyDirectory(entry.path, { mtime: entry.resource.updatedAt, mode: 0o700 });
        else zip.addReadStreamLazy(entry.path, { size: entry.resource.sizeBytes, mtime: entry.resource.updatedAt, mode: 0o600 }, (callback) => {
          void (async () => {
            try {
              prepare();
              const source = await pending.get(entry);
              if (source === undefined || output.destroyed) { source?.destroy(); throw new ShareServiceError("package_unavailable"); }
              const hash = createHash("sha256"); let bytes = 0;
              const member = new Transform({
                transform(chunk: Buffer, _encoding, done) {
                  bytes += chunk.length; hash.update(chunk);
                  if (bytes > entry.resource.sizeBytes) done(new Error("Package source size changed")); else done(null, chunk);
                },
                flush(done) {
                  if (bytes !== entry.resource.sizeBytes || entry.resource.sha256 !== undefined && hash.digest("hex") !== entry.resource.sha256) done(new Error("Package source content changed")); else done();
                },
              });
              members.add(member);
              source.once("error", error => member.destroy(error));
              member.once("error", error => output.destroy(error));
              member.once("end", () => { pending.delete(entry); });
              member.once("close", () => { members.delete(member); source.destroy(); });
              callback(null, source.pipe(member));
            }
            catch (error) { callback(error, Readable.from([])); }
          })();
        });
      }
      let revalidateBytes = 0;
      limiter = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          try { byteReservation.accept(chunk.length); } catch (error) { callback(error as Error); return; }
          if (Date.now() > deadline || performance.now() >= monotonicDeadline) callback(new Error("Share package duration exceeded"));
          else {
            revalidateBytes += chunk.length;
            if (revalidateBytes < this.#options.streamRevalidateBytes) { callback(null, chunk); return; }
            revalidateBytes = 0;
            void this.#repository.validateActive(share.id, new Date()).then(active => {
              if (active) callback(null, chunk); else callback(new ShareServiceError("denied"));
            }).catch(callback);
          }
        },
      });
      const destination = limiter;
      timer = setTimeout(() => {
        const error = new Error("Share package duration exceeded");
        destination.destroy(error); output.destroy(error);
        for (const member of members) member.destroy(error);
      }, Math.max(1, monotonicDeadline - performance.now()));
      timer.unref();
      flowing = pipeline(output, destination);
      writeStarted = true;
      writing = this.#storage.write(storagePath, destination, { offset: 0, create: true, exclusive: true, truncate: true }).then(bytes => { writeSucceeded = true; return bytes; });
      zip.end();
      await Promise.all([writing, flowing]);
      const stat = await this.#storage.stat(storagePath);
      verificationStarted = true;
      const verification = await this.#storage.openRead(storagePath);
      const physicalClosed = (verification as Readable & { readonly storageClosed?: Promise<void> }).storageClosed;
      void physicalClosed?.then(() => { verificationClosed = true; }, () => undefined);
      if (Date.now() >= deadline) { verification.destroy(); throw new ShareServiceError("package_limit"); }
      members.add(verification);
      const digest = await streamHash(verification);
      if (lifecycle) await waitForPhysicalClose(physicalClosed, monotonicDeadline);
      members.delete(verification);
      if (digest.bytes !== stat.size) throw new Error("Share package size verification failed");
      if (this.#entryFingerprint(await this.#packageEntries(access.share, access.resource, new Date(deadline - this.#options.packageMaxDurationMs))) !== sourceFingerprint) throw new ShareServiceError("package_unavailable");
      if (Date.now() >= deadline || performance.now() >= monotonicDeadline) throw new ShareServiceError("package_limit");
      if (!(await this.#repository.validateActive(share.id, new Date()))) throw new ShareServiceError("denied");
      if (lifecycle && claim) {
        await lifecycle.confirmWriterClosed(claim);
        if (!await lifecycle.publish(claim, { fileCount: entries.filter(entry => entry.resource.type === "file").length, sizeBytes: stat.size, sha256: digest.sha256, sourceFingerprint })) throw new ShareServiceError("package_unavailable");
        const ready = await this.#repository.getCurrentPackage(share.id);
        if (!ready || ready.id !== id || ready.generationId !== claim.id || ready.state !== "ready") throw new ShareServiceError("package_unavailable");
        return ready;
      }
      const ready = await this.#repository.setPackageReady(id, { fileCount: entries.filter((entry) => entry.resource.type === "file").length, sizeBytes: stat.size, sha256: digest.sha256, readyAt: new Date(), sourceFingerprint });
      return ready;
    } catch (error) {
      limiter?.destroy(); zipOutput?.destroy();
      for (const member of members) member.destroy();
      await Promise.allSettled([writing, flowing]);
      if (lifecycle) {
        if (claim) {
          // The build's readback handle shares this generation's custody too.
          if (writerCustodyClosed()) await lifecycle.confirmWriterClosed(claim).catch(() => undefined);
          await lifecycle.fail(claim, error instanceof ShareServiceError ? error.code : "package_failed").catch(() => undefined);
        }
      } else {
        await this.#storage.delete(storagePath).catch(() => undefined);
        await this.#repository.setPackageFailed(id, error instanceof ShareServiceError ? error.code : "package_failed").catch(() => undefined);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      limiter?.destroy(); zipOutput?.destroy();
      for (const member of members) member.destroy();
    }
  }

  async openPackage(token: string, range: { readonly offset: number; readonly length?: number; readonly packageId?: string }, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string; readonly transferId?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    if (access.locked || access.share.mode !== "download_folder") throw new ShareServiceError(access.locked ? "locked" : "invalid_mode");
    const value = await this.#repository.getCurrentPackage(access.share.id);
    if (value === undefined || value.state !== "ready" || value.expiresAt <= now) throw new ShareServiceError("package_unavailable");
    if (range.packageId !== undefined && range.packageId !== value.id) throw new ShareServiceError("package_unavailable");
    await this.#validatePackage(access.share, access.resource, value);
    const lifecycle = this.#repository.packageLifecycle, startedAt = performance.now(), durationMs = 30_000;
    const generationId = value.generationId;
    if (lifecycle && !generationId) throw new ShareServiceError("package_unavailable");
    const readerId = lifecycle && generationId ? await lifecycle.acquireReader(value.id, generationId, durationMs) : undefined;
    let source: Readable | undefined, guarded: Readable | undefined;
    try {
      source = await this.#storage.openRead(value.storagePath, { offset: range.offset, ...(range.length === undefined ? {} : { length: range.length }) });
      const raw = source;
      // A wrapper's close event is not a physical handle acknowledgement.
      // Optional during adapter rollout: unsupported/uncertain reads retain custody.
      const physicalClosed = (raw as Readable & { readonly storageClosed?: Promise<void> }).storageClosed;
      void physicalClosed?.catch(() => undefined);
      guarded = this.#guardStream(access.share.id, raw, () => this.#validatePackage(access.share, access.resource, value), access.session.id);
      if (lifecycle && readerId && generationId) guarded = createLeasedPackageStream(guarded, { startedAt, durationMs,
        renew: () => lifecycle.renewReader(readerId, generationId, durationMs),
        release: async () => {
          if (!physicalClosed) return;
          await physicalClosed;
          await lifecycle.releaseReader(readerId, generationId);
        },
      });
      await this.#repository.claimDownload(access.share.id, access.session.id, now, input.transferId === undefined ? undefined : { id: input.transferId, resourceId: access.resource.id, kind: "package" }).catch(() => { throw new ShareServiceError("denied"); });
      await this.#access(access.share.id, input.sourceIp, "package_content", "success", range.length === undefined && range.offset === 0 ? 200 : 206, now, range);
      return { share: access.share, package: value, stream: guarded, session: access.session };
    } catch (error) {
      guarded?.destroy(); source?.destroy();
      // A successful open is released by the source-close path above. Failed
      // opens are retained conservatively: no remote-handle closure was proved.
      throw error;
    }
  }

  async packageMetadata(token: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    if (access.locked || access.share.mode !== "download_folder") throw new ShareServiceError(access.locked ? "locked" : "invalid_mode");
    const value = await this.#repository.getCurrentPackage(access.share.id);
    if (value === undefined || !["preparing", "ready"].includes(value.state) || value.expiresAt <= now) throw new ShareServiceError("package_unavailable");
    if (value.state === "preparing") return { share: access.share, resource: access.resource, package: value, session: access.newSession };
    await this.#validatePackage(access.share, access.resource, value);
    return { share: access.share, resource: access.resource, package: value, session: access.newSession };
  }

  async cleanupExpiredPackages(now = new Date(), limit = 100): Promise<number> {
    await this.#repository.cleanupExpiredDownloadClaims?.(now, 1000);
    const lifecycle = this.#repository.packageLifecycle;
    if (lifecycle) {
      let cleaned = 0;
      for (const claim of await lifecycle.claimCleanup(limit)) {
        // Failure leaves the exact durable token/path for a later bounded retry.
        try {
          if (await this.#storage.exists(claim.storagePath)) await this.#storage.delete(claim.storagePath);
          if (await lifecycle.completeCleanup(claim)) cleaned += 1;
        } catch { /* Durable custody remains; continue the other claimed objects. */ }
      }
      return cleaned;
    }
    const values = await this.#repository.claimExpiredPackages(now, limit);
    let cleaned = 0;
    for (const value of values) {
      // Backend failure retains the durable row so the next bounded cleanup can retry.
      if (await this.#storage.exists(value.storagePath)) await this.#storage.delete(value.storagePath);
      await this.#repository.markPackageExpired(value.id);
      await this.#repository.deleteExpiredPackage?.(value.id);
      cleaned += 1;
    }
    return cleaned;
  }

  async #authorize(token: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now: Date, allowLocked: boolean) {
    const share = await this.#resolveShare(token);
    const resource = await this.#validateShare(share, input.sourceIp, now, true);
    let session = input.sessionToken === undefined || !tokenValid(input.sessionToken) ? undefined : await this.#repository.touchSession({
      shareId: share.id,
      tokenHash: sha256(input.sessionToken),
      sourceIpHash: this.#sourceHash(input.sourceIp),
      userAgentHash: this.#userAgentHash(input.userAgent),
      now,
    });
    if (share.state === "exhausted" && session?.downloadClaimed !== true) throw new ShareServiceError("denied");
    const locked = share.passwordHash !== undefined && session === undefined;
    let newSession: { readonly token: string; readonly session: ShareSession } | undefined;
    if (!locked && session === undefined) {
      newSession = await this.#newSession(share.id, input.sourceIp, input.userAgent, now);
      session = newSession.session;
    }
    if (locked && !allowLocked) throw new ShareServiceError("locked");
    if (session === undefined && !allowLocked) throw new ShareServiceError("denied");
    return { share, resource, locked, session: session as ShareSession, newSession };
  }

  async #resolveShare(token: string): Promise<ShareRecord> {
    if (!this.#options.enabled || !tokenValid(token)) throw new ShareServiceError("not_found");
    const value = await this.#repository.getShareByTokenHash(this.#tokenHash(token));
    if (value === undefined) throw new ShareServiceError("not_found");
    return value;
  }

  async #validateShare(share: ShareRecord, sourceIp: string, now: Date, allowExhausted: boolean): Promise<Resource> {
    if (share.state !== "active" && !(allowExhausted && share.state === "exhausted")) throw new ShareServiceError("not_found");
    if (share.expiresAt !== undefined && share.expiresAt <= now) throw new ShareServiceError("not_found");
    if (share.allowedCidr !== undefined && !(await this.#repository.sourceAllowed(sourceIp, share.allowedCidr))) throw new ShareServiceError("not_found");
    const resource = await this.#files.getResource(share.resourceId).catch(() => undefined);
    if (resource === undefined || resource.status !== "active"
      || classificationRank[resource.securityClassification ?? "internal"] > classificationRank[share.classificationCeiling]) throw new ShareServiceError("not_found");
    return resource;
  }

  async #newSession(shareId: string, sourceIp: string, userAgent: string, now: Date) {
    const token = randomBytes(32).toString("base64url");
    const value = await this.#repository.createSession({
      id: uuidv7(),
      shareId,
      tokenHash: sha256(token),
      sourceIpHash: this.#sourceHash(sourceIp),
      userAgentHash: this.#userAgentHash(userAgent),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#options.sessionTtlMs),
    });
    return { token, session: value };
  }

  #validateMode(resource: Resource, mode: ShareMode): void {
    if ((resource.type === "file" && !["view", "download"].includes(mode)) || (resource.type === "folder" && !["browse", "download_folder"].includes(mode))) {
      throw new Error("Share mode does not match resource type");
    }
  }

  async #openContentResource(share: ShareRecord, expected: Resource, selection: ShareRangeSelection) {
    let range: ShareDownloadRange | undefined;
    const opened = await this.#files.openDownload(expected.id, current => {
      if (current.status !== "active" || current.type !== "file"
        || current.parentId !== expected.parentId || current.storagePath !== expected.storagePath
        || classificationRank[current.securityClassification ?? "internal"] > classificationRank[share.classificationCeiling]
        || share.mode === "view" && !inlineTypes.has(current.mimeType ?? "application/octet-stream")) throw new ShareServiceError("not_found");
      range = typeof selection === "function" ? selection(current) : selection;
      return range;
    });
    if (range === undefined) { opened.stream.destroy(); throw new Error("Download gateway did not validate the representation"); }
    return { ...opened, range };
  }

  async #allChildren(parentId: string, maximum: number): Promise<readonly Resource[]> {
    const values: Resource[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.#files.listChildren(parentId, offset, 500);
      values.push(...page);
      if (values.length > maximum) throw new ShareServiceError("package_limit");
      if (page.length < 500) break;
    }
    return values;
  }

  async #sharedChild(share: ShareRecord, resourceId: string): Promise<Resource> {
    if (share.resourceType !== "folder" || !["browse", "download_folder"].includes(share.mode)) throw new ShareServiceError("invalid_mode");
    if (!(await this.#repository.isDescendant(share.resourceId, resourceId, share.classificationCeiling)) || resourceId === share.resourceId) throw new ShareServiceError("not_found");
    const resource = await this.#files.getResource(resourceId).catch(() => undefined);
    if (resource === undefined || resource.type !== "file" || resource.status !== "active"
      || classificationRank[resource.securityClassification ?? "internal"] > classificationRank[share.classificationCeiling]) throw new ShareServiceError("not_found");
    return resource;
  }

  async #packageEntries(share: ShareRecord, root: Resource, startedAt: Date): Promise<readonly { readonly resource: Resource; readonly path: string }[]> {
    const entries: Array<{ readonly resource: Resource; readonly path: string }> = [];
    let fileCount = 0;
    let totalBytes = 0;
    if (this.#repository.readPackageTree !== undefined) {
      const snapshot = await this.#repository.readPackageTree(root.id, share.classificationCeiling, this.#options.packageMaxFiles);
      for (const entry of snapshot) if (entry.resource.type === "file") { fileCount++; totalBytes += entry.resource.sizeBytes; }
      if (Date.now() - startedAt.getTime() > this.#options.packageMaxDurationMs || fileCount > this.#options.packageMaxFiles || totalBytes > this.#options.packageMaxBytes) throw new ShareServiceError("package_limit");
      return snapshot;
    }
    const visit = async (folder: Resource, prefix: string): Promise<void> => {
      if (Date.now() - startedAt.getTime() > this.#options.packageMaxDurationMs) throw new ShareServiceError("package_limit");
      for (const child of await this.#allChildren(folder.id, this.#options.packageMaxFiles - entries.length)) {
        if (child.status !== "active" || classificationRank[child.securityClassification ?? "internal"] > classificationRank[share.classificationCeiling]) continue;
        const childPath = prefix ? `${prefix}/${child.name}` : child.name;
        entries.push({ resource: child, path: child.type === "folder" ? `${childPath}/` : childPath });
        if (entries.length > this.#options.packageMaxFiles) throw new ShareServiceError("package_limit");
        if (child.type === "folder") await visit(child, childPath);
        else {
          fileCount += 1;
          totalBytes += child.sizeBytes;
          if (fileCount > this.#options.packageMaxFiles || totalBytes > this.#options.packageMaxBytes) throw new ShareServiceError("package_limit");
        }
      }
    };
    await visit(root, "");
    return entries;
  }

  #entryFingerprint(entries: readonly { readonly resource: Resource; readonly path: string }[]): string {
    return createHash("sha256").update(JSON.stringify(entries.map(({ resource: r, path: p }) => [r.id, p, r.currentVersionId, r.sha256, r.sizeBytes, r.securityClassification ?? "internal"]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))).digest("hex");
  }

  async #validatePackage(share: ShareRecord, root: Resource, value: SharePackage): Promise<void> {
    const entries = await this.#packageEntries(share, root, new Date());
    if (value.sourceFingerprint === undefined || value.sourceFingerprint !== this.#entryFingerprint(entries)) {
      await this.#repository.markPackageExpired(value.id);
      throw new ShareServiceError("package_unavailable");
    }
  }

  #guardStream(shareId: string, source: Readable, validate?: () => Promise<void>, sessionId?: string): Readable {
    let bytes = 0;
    let pending: Buffer | undefined;
    const threshold = this.#options.streamRevalidateBytes;
    const check = async () => {
      if (!(await this.#repository.validateActive(shareId, new Date(), sessionId))) throw new Error("Share or session was revoked during streaming");
      await validate?.();
    };
    const guard = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length;
        const previous = pending;
        pending = chunk;
        if (bytes < threshold) { callback(null, previous); return; }
        bytes = 0;
        void check().then(() => callback(null, previous)).catch(callback);
      },
      // Keep one bounded source chunk until the final authority check, including files below the threshold.
      flush: callback => { void check().then(() => { const last = pending; pending = undefined; callback(null, last); }).catch(callback); },
    });
    source.once("error", (error) => guard.destroy(error));
    // The public controller may still be recording access before attaching HTTP.
    guard.on("error", () => undefined);
    source.once("close", () => {
      if (!source.readableEnded && !guard.destroyed) guard.destroy(new Error("Share source closed before completion"));
    });
    guard.once("close", () => { if (!source.destroyed) source.destroy(); });
    return source.pipe(guard);
  }

  async #access(shareId: string | undefined, sourceIp: string, action: Parameters<ShareRepository["writeAccessEvent"]>[0]["action"], outcome: "success" | "denied" | "failure", statusCode: number, occurredAt: Date, range?: { readonly offset: number; readonly length?: number }): Promise<void> {
    await this.#repository.writeAccessEvent({
      id: uuidv7(),
      ...(shareId === undefined ? {} : { shareId }),
      sourceIpHash: this.#sourceHash(sourceIp),
      action,
      outcome,
      statusCode,
      ...(range === undefined ? {} : { rangeStart: range.offset, ...(range.length === undefined ? {} : { rangeLength: range.length }) }),
      occurredAt,
    }).catch(() => undefined);
  }

  async #auditOwner(action: string, shareId: string, details: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#audit?.write({ actorType: "owner_session", actorId: "owner", action, outcome: "success", correlationId: `${action}:${uuidv7()}`, details: { shareId, ...details } });
  }

  async #failureDelay(): Promise<void> {
    const delay = this.#options.passwordFailureDelayMs ?? 250;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
