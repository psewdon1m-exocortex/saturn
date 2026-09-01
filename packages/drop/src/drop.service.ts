import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import type { AuditSink } from "@saturn/audit";
import { DROP_POINT_RESOURCE_ID } from "@saturn/file-core";
import { normalizeStorageName } from "@saturn/storage";
import { v7 as uuidv7 } from "uuid";
import type {
  DropCompletion,
  DropFileGateway,
  DropNotificationSink,
  DropOptions,
  DropRepository,
  DropSession,
  DropSessionValidationInput,
  DropUploadCreateInput,
  DropUploadStatus,
  NewDropSession,
  TelegramBinding,
  TelegramIdentity,
} from "./types.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export class DropServiceError extends Error {
  readonly code: "invalid_code" | "rate_limited" | "invalid_session" | "csrf_rejected" | "not_bound" | "not_found" | "quota_exhausted";

  constructor(code: DropServiceError["code"]) {
    super(code === "rate_limited"
      ? "Drop access is temporarily unavailable"
      : code === "not_found" ? "Drop upload not found" : "Drop request was not accepted");
    this.code = code;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function opaqueToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function code(length: number): string {
  const bytes = randomBytes(length);
  let value = "";
  for (const byte of bytes) {
    const symbol = CROCKFORD[byte & 31];
    if (symbol === undefined) throw new Error("Drop code alphabet is invalid");
    value += symbol;
  }
  return value;
}

function displayCode(value: string): string {
  return value.match(/.{1,4}/g)?.join("-") ?? value;
}

function normalizeCode(value: string, length: number): string | undefined {
  const normalized = value.toUpperCase().replace(/[\s-]/g, "");
  return normalized.length === length && new RegExp(`^[${CROCKFORD}]+$`).test(normalized) ? normalized : undefined;
}

function validateIdentity(identity: TelegramIdentity): void {
  if (!/^[1-9]\d{0,18}$/.test(identity.userId) || !/^-?[1-9]\d{0,18}$/.test(identity.chatId)) {
    throw new Error("Telegram identity is invalid");
  }
  if (identity.displayName !== undefined && (identity.displayName.length > 256 || /[\r\n]/.test(identity.displayName))) {
    throw new Error("Telegram display name is invalid");
  }
}

function validateIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) throw new Error("Drop idempotency key is invalid");
  return value;
}

export class DropService {
  readonly #repository: DropRepository;
  readonly #files: DropFileGateway;
  readonly #pepper: Buffer;
  readonly #options: DropOptions;
  readonly #audit: AuditSink | undefined;
  #notifications: DropNotificationSink | undefined;

  constructor(input: {
    readonly repository: DropRepository;
    readonly files: DropFileGateway;
    readonly pepper: string;
    readonly options: DropOptions;
    readonly audit?: AuditSink;
    readonly notifications?: DropNotificationSink;
  }) {
    if (input.pepper.length < 32 || /[\r\n]/.test(input.pepper)) throw new Error("Drop pepper is invalid");
    this.#repository = input.repository;
    this.#files = input.files;
    this.#pepper = Buffer.from(input.pepper, "utf8");
    this.#options = input.options;
    this.#audit = input.audit;
    this.#notifications = input.notifications;
  }

  setNotificationSink(value: DropNotificationSink): void {
    this.#notifications = value;
  }

  #hmac(label: string, value: string): string {
    return createHmac("sha256", this.#pepper).update(label).update("\0").update(value).digest("hex");
  }

  #sourceHash(sourceIp: string): string {
    return this.#hmac("drop-source-ip", sourceIp.slice(0, 128));
  }

  #userAgentHash(userAgent: string): string {
    return this.#hmac("drop-user-agent", userAgent.slice(0, 1024));
  }

  async createLinkChallenge(now = new Date()): Promise<{ readonly code: string; readonly expiresAt: Date }> {
    const raw = code(12);
    const expiresAt = new Date(now.getTime() + this.#options.linkCodeTtlMs);
    await this.#repository.createLinkChallenge({ id: uuidv7(), codeHash: this.#hmac("telegram-link-code", raw), createdAt: now, expiresAt });
    await this.#auditEvent("telegram.link.challenge.created", "success", `telegram-link:${uuidv7()}`, {});
    return { code: displayCode(raw), expiresAt };
  }

  async linkTelegram(rawCode: string, identity: TelegramIdentity, now = new Date()): Promise<TelegramBinding> {
    validateIdentity(identity);
    const normalized = normalizeCode(rawCode, 12);
    if (normalized === undefined) throw new DropServiceError("invalid_code");
    const value = await this.#repository.consumeLinkChallenge(this.#hmac("telegram-link-code", normalized), identity, now);
    if (value === undefined) throw new DropServiceError("invalid_code");
    await this.#auditEvent("telegram.bound", "success", `telegram-bound:${uuidv7()}`, { telegramUserId: identity.userId });
    return value;
  }

  getBinding(): Promise<TelegramBinding | undefined> {
    return this.#repository.getBinding();
  }

  async unlink(now = new Date()): Promise<{ readonly sessions: number; readonly challenges: number }> {
    const result = await this.#repository.unlink(now);
    await this.#auditEvent("telegram.unlinked", "success", `telegram-unlink:${uuidv7()}`, result);
    return result;
  }

  async issueDropCode(identity: TelegramIdentity, now = new Date()): Promise<{ readonly code: string; readonly expiresAt: Date }> {
    validateIdentity(identity);
    const raw = code(8);
    const expiresAt = new Date(now.getTime() + this.#options.codeTtlMs);
    const created = await this.#repository.createDropChallenge({
      id: uuidv7(),
      codeHash: this.#hmac("drop-code", raw),
      identity,
      createdAt: now,
      expiresAt,
    });
    if (!created) throw new DropServiceError("not_bound");
    await this.#auditEvent("drop.challenge.created", "success", `drop-code:${uuidv7()}`, { telegramUserId: identity.userId });
    return { code: displayCode(raw), expiresAt };
  }

  async redeem(rawCode: string, sourceIp: string, userAgent: string, now = new Date()): Promise<NewDropSession> {
    const sourceIpHash = this.#sourceHash(sourceIp);
    const attempt = await this.#repository.beginDropAttempt({
      sourceIpHash,
      since: new Date(now.getTime() - this.#options.failureWindowMs),
      sourceLimit: this.#options.failureLimit,
      globalLimit: this.#options.globalFailureLimit,
      occurredAt: now,
    });
    if (attempt === undefined) {
      await this.#notifications?.securityAlert().catch(() => undefined);
      await this.#auditEvent("drop.redeem", "denied", `drop-rate:${uuidv7()}`, { reason: "rate_limited" });
      await this.#failureDelay();
      throw new DropServiceError("rate_limited");
    }
    const normalized = normalizeCode(rawCode, 8);
    if (normalized === undefined) {
      await this.#failedRedeem(attempt, now);
      throw new DropServiceError("invalid_code");
    }
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const value = await this.#repository.redeemDropChallenge({
      codeHash: this.#hmac("drop-code", normalized),
      tokenHash: sha256(token),
      csrfHash: sha256(csrfToken),
      userAgentHash: this.#userAgentHash(userAgent),
      sessionId: uuidv7(),
      now,
      expiresAt: new Date(now.getTime() + this.#options.sessionTtlMs),
      maxFiles: this.#options.maxFiles,
      maxBytes: this.#options.maxBytes,
    });
    if (value === undefined) {
      await this.#failedRedeem(attempt, now);
      throw new DropServiceError("invalid_code");
    }
    await this.#repository.finishDropAttempt(attempt, "success", now);
    await this.#auditEvent("drop.redeem", "success", `drop-session:${value.id}`, { sessionId: value.id });
    return { token, csrfToken, session: value };
  }

  async #failedRedeem(attempt: string, now: Date): Promise<void> {
    await this.#repository.finishDropAttempt(attempt, "failure", now);
    await this.#auditEvent("drop.redeem", "denied", `drop-failure:${uuidv7()}`, { reason: "invalid_code" });
    await this.#failureDelay();
  }

  async #failureDelay(): Promise<void> {
    const delayMs = this.#options.failureDelayMs ?? 250;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  async validateSession(input: DropSessionValidationInput): Promise<DropSession> {
    if (!opaqueToken(input.token)) throw new DropServiceError("invalid_session");
    const value = await this.#repository.touchDropSession(
      sha256(input.token),
      this.#userAgentHash(input.userAgent),
      input.now ?? new Date(),
    );
    if (value === undefined) throw new DropServiceError("invalid_session");
    if (input.isMutation) {
      let origin: string;
      try {
        origin = input.origin === undefined ? "" : new URL(input.origin).origin;
      } catch {
        throw new DropServiceError("csrf_rejected");
      }
      if (origin !== new URL(this.#options.publicOrigin).origin
        || input.csrfCookie === undefined
        || input.csrfHeader === undefined
        || !opaqueToken(input.csrfCookie)
        || !secureEqual(input.csrfCookie, input.csrfHeader)
        || !secureEqual(sha256(input.csrfCookie), value.csrfHash)) {
        throw new DropServiceError("csrf_rejected");
      }
    }
    return value;
  }

  revokeSession(token: string, now = new Date()): Promise<void> {
    return opaqueToken(token) ? this.#repository.revokeDropSession(sha256(token), now) : Promise.resolve();
  }

  async revokeAccess(identity: TelegramIdentity, now = new Date()): Promise<{ readonly sessions: number; readonly challenges: number }> {
    validateIdentity(identity);
    const result = await this.#repository.revokeDropAccess(identity, now);
    await this.#auditEvent("drop.access.revoked", "success", `drop-revoke:${uuidv7()}`, { telegramUserId: identity.userId, ...result });
    return result;
  }

  async createUpload(session: DropSession, input: DropUploadCreateInput): Promise<DropUploadStatus> {
    const filename = normalizeStorageName(input.filename);
    const expectedSha256 = input.expectedSha256?.toLowerCase();
    if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0 || input.expectedSize > this.#options.maxBytes) {
      throw new Error("Drop upload size is invalid");
    }
    if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Drop upload checksum is invalid");
    const now = input.now ?? new Date();
    const reservation = await this.#repository.reserveUpload({
      id: uuidv7(),
      sessionId: session.id,
      clientKeyHash: this.#hmac("drop-upload-idempotency", validateIdempotencyKey(input.idempotencyKey)),
      filename,
      expectedSize: input.expectedSize,
      ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      now,
    }).catch((error: unknown) => {
      if (error instanceof Error && /quota/i.test(error.message)) throw new DropServiceError("quota_exhausted");
      throw error;
    });
    let mapping = reservation.value;
    try {
      const parentId = await this.#dateFolder(now, session.id);
      const core = await this.#files.createUpload({
        parentId,
        filename,
        expectedSize: input.expectedSize,
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
        idempotencyKey: `drop:${mapping.id}`,
        auditActor: { type: "drop_session", id: session.id },
      });
      mapping = await this.#repository.attachUpload(session.id, mapping.id, core.id);
      return await this.#status(mapping);
    } catch (error) {
      if (reservation.created && mapping.uploadId === undefined) await this.#repository.releaseUploadReservation(session.id, mapping.id).catch(() => undefined);
      throw error;
    }
  }

  async inspectUpload(session: DropSession, id: string): Promise<DropUploadStatus> {
    const mapping = await this.#mapped(session.id, id);
    return this.#status(mapping);
  }

  async appendUpload(session: DropSession, id: string, offset: number, contentLength: number, source: Readable): Promise<DropUploadStatus> {
    const mapping = await this.#mapped(session.id, id);
    if (mapping.uploadId === undefined || mapping.state === "completed") throw new Error("Drop upload is not writable");
    await this.#files.appendUpload(mapping.uploadId, offset, contentLength, source);
    return this.#status(mapping);
  }

  async completeUpload(session: DropSession, id: string, now = new Date()): Promise<DropCompletion> {
    const mapping = await this.#mapped(session.id, id);
    if (mapping.uploadId === undefined) throw new Error("Drop upload is incomplete");
    const completed = await this.#files.completeUpload(mapping.uploadId);
    await this.#repository.completeDropUpload(session.id, mapping.id, completed.resource.id, now);
    const identity = { userId: session.telegramUserId, chatId: session.telegramChatId };
    await this.#notifications?.uploadCompleted(identity, completed.resource.name, completed.resource.sizeBytes).catch(() => undefined);
    await this.#auditEvent("drop.upload.completed", "success", `drop-upload:${mapping.id}`, {
      sessionId: session.id,
      uploadId: mapping.id,
      resourceId: completed.resource.id,
      sizeBytes: completed.resource.sizeBytes,
    });
    return {
      upload: await this.#status(await this.#mapped(session.id, id)),
      filename: completed.resource.name,
      sizeBytes: completed.resource.sizeBytes,
      sha256: completed.resource.sha256 ?? "",
    };
  }

  async #mapped(sessionId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DropServiceError("not_found");
    const mapping = await this.#repository.getDropUpload(sessionId, id);
    if (mapping === undefined) throw new DropServiceError("not_found");
    return mapping;
  }

  async #status(mapping: Awaited<ReturnType<DropRepository["getDropUpload"]>> & {}) : Promise<DropUploadStatus> {
    if (mapping.uploadId === undefined) throw new Error("Drop upload has no core session");
    const core = await this.#files.getUpload(mapping.uploadId);
    return {
      id: mapping.id,
      state: mapping.state,
      expectedSize: core.expectedSize,
      receivedSize: core.receivedSize,
      expiresAt: core.expiresAt,
      completed: mapping.state === "completed" || core.status === "active",
    };
  }

  async #dateFolder(now: Date, sessionId: string): Promise<string> {
    const name = `${String(now.getUTCFullYear()).padStart(4, "0")}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
    for (let offset = 0; ; offset += 500) {
      const children = await this.#files.listChildren(DROP_POINT_RESOURCE_ID, offset, 500);
      const found = children.find((item) => item.type === "folder" && item.name === name);
      if (found !== undefined) return found.id;
      if (children.length < 500) break;
    }
    try {
      return (await this.#files.createFolder(DROP_POINT_RESOURCE_ID, name, { type: "drop_session", id: sessionId })).id;
    } catch (error) {
      for (let offset = 0; ; offset += 500) {
        const children = await this.#files.listChildren(DROP_POINT_RESOURCE_ID, offset, 500);
        const found = children.find((item) => item.type === "folder" && item.name === name);
        if (found !== undefined) return found.id;
        if (children.length < 500) throw error;
      }
    }
  }

  async #auditEvent(action: string, outcome: "success" | "denied" | "failure", correlationId: string, details: Readonly<Record<string, unknown>>): Promise<void> {
    await this.#audit?.write({ actorType: "drop", actorId: "drop", action, outcome, correlationId, details }).catch(() => undefined);
  }
}
