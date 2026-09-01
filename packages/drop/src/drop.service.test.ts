import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DropService, DropServiceError } from "./drop.service.js";
import type { DropRepository, DropSession, DropUpload, TelegramBinding, TelegramIdentity } from "./types.js";

class MemoryRepository implements DropRepository {
  link = new Map<string, { state: string; expiresAt: Date }>();
  drops = new Map<string, { state: string; identity: TelegramIdentity; expiresAt: Date }>();
  binding: TelegramBinding | undefined;
  sessions = new Map<string, DropSession>();
  sessionById = new Map<string, DropSession>();
  attempts: Array<{ sequence: string; source: string; outcome: "pending" | "success" | "failure" | "rate_limited"; at: Date }> = [];
  uploads = new Map<string, DropUpload>();
  updates = new Map<string, "processing" | "completed" | "failed">();

  createLinkChallenge(input: { readonly codeHash: string; readonly expiresAt: Date }): Promise<void> {
    for (const value of this.link.values()) if (value.state === "active") value.state = "revoked";
    this.link.set(input.codeHash, { state: "active", expiresAt: input.expiresAt });
    return Promise.resolve();
  }
  consumeLinkChallenge(codeHash: string, identity: TelegramIdentity, now: Date): Promise<TelegramBinding | undefined> {
    const value = this.link.get(codeHash);
    if (value === undefined || value.state !== "active" || value.expiresAt <= now) return Promise.resolve(undefined);
    value.state = "consumed";
    this.binding = { ...identity, boundAt: now, updatedAt: now };
    return Promise.resolve(this.binding);
  }
  getBinding(): Promise<TelegramBinding | undefined> { return Promise.resolve(this.binding); }
  unlink(): Promise<{ readonly sessions: number; readonly challenges: number }> {
    this.binding = undefined;
    let sessions = 0; let challenges = 0;
    for (const value of this.sessions.values()) if (value.state === "active") { Object.assign(value, { state: "revoked" }); sessions += 1; }
    for (const value of this.drops.values()) if (value.state === "active") { value.state = "revoked"; challenges += 1; }
    return Promise.resolve({ sessions, challenges });
  }
  createDropChallenge(input: { readonly codeHash: string; readonly identity: TelegramIdentity; readonly expiresAt: Date }): Promise<boolean> {
    if (this.binding?.userId !== input.identity.userId || this.binding.chatId !== input.identity.chatId) return Promise.resolve(false);
    for (const value of this.drops.values()) if (value.state === "active") value.state = "revoked";
    this.drops.set(input.codeHash, { state: "active", identity: input.identity, expiresAt: input.expiresAt });
    return Promise.resolve(true);
  }
  redeemDropChallenge(input: { readonly codeHash: string; readonly tokenHash: string; readonly csrfHash: string; readonly userAgentHash: string; readonly sessionId: string; readonly now: Date; readonly expiresAt: Date; readonly maxFiles: number; readonly maxBytes: number }): Promise<DropSession | undefined> {
    const challenge = this.drops.get(input.codeHash);
    if (challenge === undefined || challenge.state !== "active" || challenge.expiresAt <= input.now) return Promise.resolve(undefined);
    challenge.state = "consumed";
    const value: DropSession = {
      id: input.sessionId, tokenHash: input.tokenHash, csrfHash: input.csrfHash, userAgentHash: input.userAgentHash,
      telegramUserId: challenge.identity.userId, telegramChatId: challenge.identity.chatId, state: "active",
      createdAt: input.now, lastSeenAt: input.now, expiresAt: input.expiresAt,
      maxFiles: input.maxFiles, maxBytes: input.maxBytes, reservedFiles: 0, reservedBytes: 0,
    };
    this.sessions.set(input.tokenHash, value); this.sessionById.set(value.id, value);
    return Promise.resolve(value);
  }
  beginDropAttempt(input: { readonly sourceIpHash: string; readonly since: Date; readonly sourceLimit: number; readonly globalLimit: number; readonly occurredAt: Date }): Promise<string | undefined> {
    const recent = this.attempts.filter((item) => ["pending", "failure"].includes(item.outcome) && item.at >= input.since);
    if (recent.filter((item) => item.source === input.sourceIpHash).length >= input.sourceLimit || recent.length >= input.globalLimit) {
      this.attempts.push({ sequence: String(this.attempts.length + 1), source: input.sourceIpHash, outcome: "rate_limited", at: input.occurredAt });
      return Promise.resolve(undefined);
    }
    const sequence = String(this.attempts.length + 1);
    this.attempts.push({ sequence, source: input.sourceIpHash, outcome: "pending", at: input.occurredAt });
    return Promise.resolve(sequence);
  }
  finishDropAttempt(sequence: string, outcome: "success" | "failure", at: Date): Promise<void> {
    const value = this.attempts.find((attempt) => attempt.sequence === sequence && attempt.outcome === "pending");
    if (value === undefined) return Promise.reject(new Error("attempt missing"));
    Object.assign(value, { outcome, at });
    return Promise.resolve();
  }
  touchDropSession(tokenHash: string, userAgentHash: string, now: Date): Promise<DropSession | undefined> {
    const value = this.sessions.get(tokenHash);
    if (value === undefined || value.state !== "active" || value.userAgentHash !== userAgentHash || value.expiresAt <= now) return Promise.resolve(undefined);
    Object.assign(value, { lastSeenAt: now }); return Promise.resolve(value);
  }
  revokeDropSession(tokenHash: string): Promise<void> { const value = this.sessions.get(tokenHash); if (value !== undefined) Object.assign(value, { state: "revoked" }); return Promise.resolve(); }
  revokeDropAccess(identity: TelegramIdentity): Promise<{ readonly sessions: number; readonly challenges: number }> {
    if (identity.userId !== this.binding?.userId || identity.chatId !== this.binding.chatId) return Promise.reject(new Error("not bound"));
    let sessions = 0; let challenges = 0;
    for (const value of this.sessions.values()) if (value.state === "active") { Object.assign(value, { state: "revoked" }); sessions += 1; }
    for (const value of this.drops.values()) if (value.state === "active") { value.state = "revoked"; challenges += 1; }
    return Promise.resolve({ sessions, challenges });
  }
  reserveUpload(input: { readonly id: string; readonly sessionId: string; readonly clientKeyHash: string; readonly filename: string; readonly expectedSize: number; readonly expectedSha256?: string; readonly now: Date }): Promise<{ readonly value: DropUpload; readonly created: boolean }> {
    const session = this.sessionById.get(input.sessionId);
    if (session === undefined || session.state !== "active") return Promise.reject(new Error("not active"));
    const existing = [...this.uploads.values()].find((value) => value.sessionId === input.sessionId && value.clientKeyHash === input.clientKeyHash);
    if (existing !== undefined) return Promise.resolve({ value: existing, created: false });
    if (session.reservedFiles + 1 > session.maxFiles || session.reservedBytes + input.expectedSize > session.maxBytes) return Promise.reject(new Error("quota exhausted"));
    Object.assign(session, { reservedFiles: session.reservedFiles + 1, reservedBytes: session.reservedBytes + input.expectedSize });
    const value: DropUpload = { id: input.id, sessionId: input.sessionId, clientKeyHash: input.clientKeyHash, filename: input.filename, expectedSize: input.expectedSize, ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }), state: "reserved", createdAt: input.now };
    this.uploads.set(value.id, value); return Promise.resolve({ value, created: true });
  }
  attachUpload(sessionId: string, id: string, uploadId: string): Promise<DropUpload> {
    const value = this.uploads.get(id); if (value === undefined || value.sessionId !== sessionId) return Promise.reject(new Error("missing"));
    const next = { ...value, uploadId, state: "uploading" as const }; this.uploads.set(id, next); return Promise.resolve(next);
  }
  releaseUploadReservation(sessionId: string, id: string): Promise<void> {
    const value = this.uploads.get(id); const session = this.sessionById.get(sessionId);
    if (value !== undefined && value.uploadId === undefined && session !== undefined) {
      this.uploads.delete(id); Object.assign(session, { reservedFiles: session.reservedFiles - 1, reservedBytes: session.reservedBytes - value.expectedSize });
    }
    return Promise.resolve();
  }
  getDropUpload(sessionId: string, id: string): Promise<DropUpload | undefined> { const value = this.uploads.get(id); return Promise.resolve(value?.sessionId === sessionId ? value : undefined); }
  completeDropUpload(sessionId: string, id: string, resourceId: string, completedAt: Date): Promise<DropUpload> {
    const value = this.uploads.get(id); if (value === undefined || value.sessionId !== sessionId) return Promise.reject(new Error("missing"));
    const next = { ...value, resourceId, state: "completed" as const, completedAt }; this.uploads.set(id, next); return Promise.resolve(next);
  }
  claimTelegramUpdate(updateId: string): Promise<"claimed" | "retry" | "duplicate" | "busy"> { const state = this.updates.get(updateId); if (state === undefined) { this.updates.set(updateId, "processing"); return Promise.resolve("claimed"); } return Promise.resolve(state === "completed" ? "duplicate" : state === "failed" ? "retry" : "busy"); }
  completeTelegramUpdate(updateId: string): Promise<void> { this.updates.set(updateId, "completed"); return Promise.resolve(); }
  failTelegramUpdate(updateId: string): Promise<void> { this.updates.set(updateId, "failed"); return Promise.resolve(); }
}

class MemoryFiles {
  folders: Array<{ id: string; type: "folder"; name: string }> = [];
  uploads = new Map<string, { expectedSize: number; receivedSize: number; expiresAt: Date; status: string; filename: string; chunks: Buffer[] }>();
  listChildren(): Promise<readonly { readonly id: string; readonly type: "file" | "folder"; readonly name: string }[]> { return Promise.resolve(this.folders); }
  createFolder(_parentId: string, name: string): Promise<{ readonly id: string; readonly type: "folder"; readonly name: string }> { const value = { id: `folder-${name}`, type: "folder" as const, name }; this.folders.push(value); return Promise.resolve(value); }
  createUpload(input: { readonly filename: string; readonly expectedSize: number; readonly idempotencyKey: string }): Promise<{ readonly id: string }> {
    const id = input.idempotencyKey; if (!this.uploads.has(id)) this.uploads.set(id, { expectedSize: input.expectedSize, receivedSize: 0, expiresAt: new Date(Date.now() + 60_000), status: "created", filename: input.filename, chunks: [] }); return Promise.resolve({ id });
  }
  getUpload(id: string) { const value = this.uploads.get(id); if (value === undefined) return Promise.reject(new Error("missing")); return Promise.resolve(value); }
  async appendUpload(id: string, offset: number, contentLength: number, source: Readable) { const value = this.uploads.get(id); if (value === undefined || value.receivedSize !== offset) throw new Error("offset"); const chunks: Buffer[] = []; for await (const chunk of source) chunks.push(Buffer.from(chunk as Uint8Array)); const bytes = Buffer.concat(chunks); if (bytes.length !== contentLength) throw new Error("length"); value.chunks.push(bytes); value.receivedSize += bytes.length; value.status = "uploading"; return value; }
  async completeUpload(id: string) { const value = this.uploads.get(id); if (value === undefined || value.receivedSize !== value.expectedSize) throw new Error("incomplete"); value.status = "active"; const bytes = Buffer.concat(value.chunks); return { upload: value, resource: { id: `resource-${id}`, name: value.filename, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }; }
}

function fixture(options: { maxFiles?: number; maxBytes?: number; failureLimit?: number } = {}) {
  const repository = new MemoryRepository(); const files = new MemoryFiles();
  const service = new DropService({ repository, files, pepper: "drop-pepper-that-is-at-least-thirty-two-characters", options: { publicOrigin: "https://vault.test", codeTtlMs: 300_000, linkCodeTtlMs: 300_000, sessionTtlMs: 900_000, maxFiles: options.maxFiles ?? 20, maxBytes: options.maxBytes ?? 1024, failureLimit: options.failureLimit ?? 5, globalFailureLimit: 100, failureWindowMs: 900_000, failureDelayMs: 0 } });
  return { repository, files, service };
}

async function boundDrop(service: DropService, identity = { userId: "12345", chatId: "12345" }) {
  const link = await service.createLinkChallenge(); await service.linkTelegram(link.code, identity);
  return { identity, challenge: await service.issueDropCode(identity) };
}

describe("DropService", () => {
  it("keeps link and Drop challenges purpose-distinct and single-use under concurrency", async () => {
    const { service } = fixture(); const identity = { userId: "12345", chatId: "12345" };
    const link = await service.createLinkChallenge();
    expect(link.code.replaceAll("-", "")).toHaveLength(12);
    await expect(service.redeem(link.code, "192.0.2.1", "browser")).rejects.toBeInstanceOf(DropServiceError);
    await service.linkTelegram(link.code, identity);
    await expect(service.linkTelegram(link.code, identity)).rejects.toMatchObject({ code: "invalid_code" });
    const drop = await service.issueDropCode(identity);
    expect(drop.code.replaceAll("-", "")).toHaveLength(8);
    const outcomes = await Promise.allSettled([service.redeem(drop.code, "192.0.2.2", "browser"), service.redeem(drop.code, "192.0.2.3", "browser")]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
  });

  it("enforces origin-bound CSRF and immediate revocation", async () => {
    const { service } = fixture(); const { identity, challenge } = await boundDrop(service);
    const created = await service.redeem(challenge.code, "192.0.2.1", "browser");
    await expect(service.validateSession({ token: created.token, userAgent: "browser", isMutation: true, origin: "https://vault.test", csrfCookie: created.csrfToken, csrfHeader: created.csrfToken })).resolves.toMatchObject({ id: created.session.id });
    await expect(service.validateSession({ token: created.token, userAgent: "browser", isMutation: true, origin: "https://evil.test", csrfCookie: created.csrfToken, csrfHeader: created.csrfToken })).rejects.toMatchObject({ code: "csrf_rejected" });
    await service.revokeAccess(identity);
    await expect(service.validateSession({ token: created.token, userAgent: "browser", isMutation: false })).rejects.toMatchObject({ code: "invalid_session" });
  });

  it("resumes only a mapped upload and commits its checksum", async () => {
    const { service } = fixture(); const { challenge } = await boundDrop(service); const created = await service.redeem(challenge.code, "192.0.2.1", "browser");
    const upload = await service.createUpload(created.session, { filename: "drop.txt", expectedSize: 6, idempotencyKey: "drop-test-0001" });
    await service.appendUpload(created.session, upload.id, 0, 3, Readable.from(Buffer.from("abc")));
    await expect(service.inspectUpload({ ...created.session, id: "other" }, upload.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await service.inspectUpload(created.session, upload.id)).receivedSize).toBe(3);
    await service.appendUpload(created.session, upload.id, 3, 3, Readable.from(Buffer.from("def")));
    const completed = await service.completeUpload(created.session, upload.id);
    expect(completed.sha256).toBe(createHash("sha256").update("abcdef").digest("hex"));
  });

  it("reserves file and byte quotas atomically", async () => {
    const { service } = fixture({ maxFiles: 1, maxBytes: 4 }); const { challenge } = await boundDrop(service); const created = await service.redeem(challenge.code, "192.0.2.1", "browser");
    const results = await Promise.allSettled([
      service.createUpload(created.session, { filename: "a.bin", expectedSize: 4, idempotencyKey: "quota-test-a" }),
      service.createUpload(created.session, { filename: "b.bin", expectedSize: 4, idempotencyKey: "quota-test-b" }),
    ]);
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
  });

  it("applies the configured brute-force boundary without retaining submitted codes", async () => {
    const { service, repository } = fixture({ failureLimit: 2 });
    await expect(service.redeem("0000-0000", "192.0.2.1", "browser")).rejects.toMatchObject({ code: "invalid_code" });
    await expect(service.redeem("1111-1111", "192.0.2.1", "browser")).rejects.toMatchObject({ code: "invalid_code" });
    await expect(service.redeem("2222-2222", "192.0.2.1", "browser")).rejects.toMatchObject({ code: "rate_limited" });
    expect(JSON.stringify(repository)).not.toContain("1111-1111");
  });
});
