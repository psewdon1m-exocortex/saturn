import { argon2, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { AuditSink } from "@saturn/audit";
import type { Resource, SecurityClassification } from "@saturn/file-core";
import { v7 as uuidv7 } from "uuid";
import { ZipFile } from "yazl";
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
  if (password.length < 12 || password.length > 128 || bytes > 256 || /[\r\n]/.test(password)) throw new Error("Share password is invalid");
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

export class ShareService {
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
    const token = randomBytes(32).toString("base64url");
    const record = await this.#repository.createShare({
      id: uuidv7(),
      tokenHash: this.#tokenHash(token),
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
    return { token, url: new URL(`/s/${token}`, this.#options.publicOrigin).toString(), share: publicValue(record, resource, record.passwordHash !== undefined) };
  }

  async listShares(offset = 0, limit = 100): Promise<readonly PublicShare[]> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Share page is invalid");
    const records = await this.#repository.listShares(offset, limit);
    return Promise.all(records.map(async (record) => publicValue(record, await this.#files.getResource(record.resourceId), record.passwordHash !== undefined)));
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
    const access = await this.#authorize(token, input, now, false);
    if (access.locked || !["browse", "download_folder"].includes(access.share.mode)) throw new ShareServiceError(access.locked ? "locked" : "invalid_mode");
    const selectedParent = parentId ?? access.share.resourceId;
    if (!(await this.#repository.isDescendant(access.share.resourceId, selectedParent))) throw new ShareServiceError("not_found");
    const parent = await this.#files.getResource(selectedParent);
    if (parent.type !== "folder" || parent.status !== "active") throw new ShareServiceError("not_found");
    const children = await this.#allChildren(parent.id);
    const visible = children.filter((child) => child.status === "active" && classificationRank[child.securityClassification ?? "internal"] <= classificationRank[access.share.classificationCeiling]);
    await this.#access(access.share.id, input.sourceIp, "browse", "success", 200, now);
    return visible.map((child) => ({
      id: child.id,
      parentId: child.parentId,
      type: child.type,
      name: child.name,
      sizeBytes: child.sizeBytes,
      mimeType: child.mimeType,
      ...(child.sha256 === undefined ? {} : { sha256: child.sha256 }),
      updatedAt: child.updatedAt,
    }));
  }

  async childMetadata(token: string, resourceId: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    const resource = await this.#sharedChild(access.share, resourceId);
    return { share: access.share, resource, session: access.newSession };
  }

  async openChildContent(token: string, resourceId: string, range: { readonly offset: number; readonly length?: number }, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    const resource = await this.#sharedChild(access.share, resourceId);
    await this.#repository.claimDownload(access.share.id, access.session.id, now).catch(() => { throw new ShareServiceError("denied"); });
    const opened = await this.#files.openDownload(resource.id, range.offset, range.length);
    await this.#access(access.share.id, input.sourceIp, "content", "success", range.length === undefined && range.offset === 0 ? 200 : 206, now, range);
    return { share: access.share, resource: opened.resource, stream: this.#guardStream(access.share.id, opened.stream), session: access.session };
  }

  async openContent(token: string, range: { readonly offset: number; readonly length?: number }, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    if (access.locked) throw new ShareServiceError("locked");
    if (access.share.resourceType !== "file" || !["view", "download"].includes(access.share.mode)) throw new ShareServiceError("invalid_mode");
    if (access.share.mode === "view" && !inlineTypes.has(access.resource.mimeType ?? "application/octet-stream")) throw new ShareServiceError("invalid_mode");
    await this.#repository.claimDownload(access.share.id, access.session.id, now).catch(() => { throw new ShareServiceError("denied"); });
    const opened = await this.#files.openDownload(access.resource.id, range.offset, range.length);
    await this.#access(access.share.id, input.sourceIp, "content", "success", range.length === undefined && range.offset === 0 ? 200 : 206, now, range);
    return { share: access.share, resource: opened.resource, stream: this.#guardStream(access.share.id, opened.stream), session: access.session };
  }

  async preparePackage(token: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()): Promise<SharePackage> {
    const access = await this.#authorize(token, input, now, false);
    if (access.locked || access.share.mode !== "download_folder" || access.share.resourceType !== "folder") throw new ShareServiceError(access.locked ? "locked" : "invalid_mode");
    const id = uuidv7();
    const storagePath = `_system/packages/${access.share.id}/${id}.zip`;
    const expiry = access.share.expiresAt ?? new Date(now.getTime() + this.#options.defaultExpiryMs);
    const reservation = await this.#repository.createPackage({ id, shareId: access.share.id, storagePath, createdAt: now, expiresAt: expiry });
    if (!reservation.created) return reservation.value;
    try {
      const entries = await this.#packageEntries(access.share, access.resource, now);
      const directory = `_system/packages/${access.share.id}`;
      if (!(await this.#storage.exists(directory))) await this.#storage.mkdir(directory);
      const zip = new ZipFile();
      for (const entry of entries) {
        if (entry.resource.type === "folder") zip.addEmptyDirectory(entry.path, { mtime: entry.resource.updatedAt, mode: 0o700 });
        else zip.addReadStreamLazy(entry.path, { size: entry.resource.sizeBytes, mtime: entry.resource.updatedAt, mode: 0o600 }, (callback) => {
          void (async () => {
            try { callback(null, (await this.#files.openDownload(entry.resource.id)).stream); }
            catch (error) { callback(error, Readable.from([])); }
          })();
        });
      }
      const deadline = Date.now() + this.#options.packageMaxDurationMs;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          if (Date.now() > deadline) callback(new Error("Share package duration exceeded"));
          else callback(null, chunk);
        },
      });
      const source = Readable.from(zip.outputStream).pipe(limiter);
      const writing = this.#storage.write(storagePath, source, { offset: 0, create: true, exclusive: true, truncate: true });
      zip.end();
      await writing;
      const stat = await this.#storage.stat(storagePath);
      const digest = await streamHash(await this.#storage.openRead(storagePath));
      if (digest.bytes !== stat.size) throw new Error("Share package size verification failed");
      const ready = await this.#repository.setPackageReady(id, { fileCount: entries.filter((entry) => entry.resource.type === "file").length, sizeBytes: stat.size, sha256: digest.sha256, readyAt: new Date() });
      await this.#access(access.share.id, input.sourceIp, "package_create", "success", 201, now);
      return ready;
    } catch (error) {
      await this.#storage.delete(storagePath).catch(() => undefined);
      await this.#repository.setPackageFailed(id, error instanceof ShareServiceError ? error.code : "package_failed").catch(() => undefined);
      throw error;
    }
  }

  async openPackage(token: string, range: { readonly offset: number; readonly length?: number }, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    if (access.locked || access.share.mode !== "download_folder") throw new ShareServiceError(access.locked ? "locked" : "invalid_mode");
    const value = await this.#repository.getCurrentPackage(access.share.id);
    if (value === undefined || value.state !== "ready" || value.expiresAt <= now) throw new ShareServiceError("package_unavailable");
    await this.#repository.claimDownload(access.share.id, access.session.id, now).catch(() => { throw new ShareServiceError("denied"); });
    const stream = await this.#storage.openRead(value.storagePath, { offset: range.offset, ...(range.length === undefined ? {} : { length: range.length }) });
    await this.#access(access.share.id, input.sourceIp, "package_content", "success", range.length === undefined && range.offset === 0 ? 200 : 206, now, range);
    return { share: access.share, package: value, stream: this.#guardStream(access.share.id, stream), session: access.session };
  }

  async packageMetadata(token: string, input: { readonly sourceIp: string; readonly userAgent: string; readonly sessionToken?: string }, now = new Date()) {
    const access = await this.#authorize(token, input, now, false);
    if (access.locked || access.share.mode !== "download_folder") throw new ShareServiceError(access.locked ? "locked" : "invalid_mode");
    const value = await this.#repository.getCurrentPackage(access.share.id);
    if (value === undefined || value.state !== "ready" || value.expiresAt <= now) throw new ShareServiceError("package_unavailable");
    return { share: access.share, resource: access.resource, package: value, session: access.newSession };
  }

  async cleanupExpiredPackages(now = new Date(), limit = 100): Promise<number> {
    const values = await this.#repository.claimExpiredPackages(now, limit);
    let cleaned = 0;
    for (const value of values) {
      if (await this.#storage.exists(value.storagePath).catch(() => false)) await this.#storage.delete(value.storagePath).catch(() => undefined);
      await this.#repository.markPackageExpired(value.id);
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

  async #allChildren(parentId: string): Promise<readonly Resource[]> {
    const values: Resource[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.#files.listChildren(parentId, offset, 500);
      values.push(...page);
      if (page.length < 500) break;
    }
    return values;
  }

  async #sharedChild(share: ShareRecord, resourceId: string): Promise<Resource> {
    if (share.resourceType !== "folder" || !["browse", "download_folder"].includes(share.mode)) throw new ShareServiceError("invalid_mode");
    if (!(await this.#repository.isDescendant(share.resourceId, resourceId)) || resourceId === share.resourceId) throw new ShareServiceError("not_found");
    const resource = await this.#files.getResource(resourceId).catch(() => undefined);
    if (resource === undefined || resource.type !== "file" || resource.status !== "active"
      || classificationRank[resource.securityClassification ?? "internal"] > classificationRank[share.classificationCeiling]) throw new ShareServiceError("not_found");
    return resource;
  }

  async #packageEntries(share: ShareRecord, root: Resource, startedAt: Date): Promise<readonly { readonly resource: Resource; readonly path: string }[]> {
    const entries: Array<{ readonly resource: Resource; readonly path: string }> = [];
    let fileCount = 0;
    let totalBytes = 0;
    const visit = async (folder: Resource, prefix: string): Promise<void> => {
      if (Date.now() - startedAt.getTime() > this.#options.packageMaxDurationMs) throw new ShareServiceError("package_limit");
      for (const child of await this.#allChildren(folder.id)) {
        if (child.status !== "active" || classificationRank[child.securityClassification ?? "internal"] > classificationRank[share.classificationCeiling]) continue;
        const childPath = prefix ? `${prefix}/${child.name}` : child.name;
        entries.push({ resource: child, path: child.type === "folder" ? `${childPath}/` : childPath });
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

  #guardStream(shareId: string, source: Readable): Readable {
    let bytes = 0;
    let checking = false;
    const threshold = this.#options.streamRevalidateBytes;
    const guard = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length;
        if (bytes < threshold || checking) { callback(null, chunk); return; }
        bytes = 0;
        checking = true;
        void this.#repository.validateActive(shareId, new Date()).then((active) => {
          checking = false;
          if (!active) callback(new Error("Share was revoked during streaming"));
          else callback(null, chunk);
        }, callback);
      },
    });
    source.once("error", (error) => guard.destroy(error));
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
