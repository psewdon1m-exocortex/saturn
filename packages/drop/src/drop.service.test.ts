import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DropService, DropServiceError } from "./drop.service.js";
import type { DropRepository, DropSession, DropUpload, TelegramBinding, TelegramIdentity } from "./types.js";

class MemoryRepository implements DropRepository {
  link = new Map<string, { state: string; expiresAt: Date }>();
  drops = new Map<string, { id: string; state: string; identity?: TelegramIdentity; expiresAt: Date; maxFiles: number; maxBytes: number; reservedFiles: number; reservedBytes: number }>();
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
    for (const value of this.sessions.values()) if (value.state === "active" && value.telegramUserId !== undefined) { Object.assign(value, { state: "revoked" }); sessions += 1; }
    for (const value of this.drops.values()) if (value.state === "active" && value.identity !== undefined) { value.state = "revoked"; challenges += 1; }
    return Promise.resolve({ sessions, challenges });
  }
  createDropChallenge(input: { readonly id: string; readonly codeHash: string; readonly identity?: TelegramIdentity; readonly expiresAt: Date; readonly maxFiles: number; readonly maxBytes: number }): Promise<boolean> {
    if (input.identity !== undefined && (this.binding?.userId !== input.identity.userId || this.binding.chatId !== input.identity.chatId)) return Promise.resolve(false);
    for (const value of this.drops.values()) if (value.state === "active") value.state = "revoked";
    this.drops.set(input.codeHash, { id: input.id, state: "active", ...(input.identity === undefined ? {} : { identity: input.identity }), expiresAt: input.expiresAt, maxFiles: input.maxFiles, maxBytes: input.maxBytes, reservedFiles: 0, reservedBytes: 0 });
    return Promise.resolve(true);
  }
  redeemDropChallenge(input: { readonly codeHash: string; readonly tokenHash: string; readonly csrfHash: string; readonly userAgentHash: string; readonly sessionId: string; readonly now: Date; readonly expiresAt: Date; readonly maxFiles: number; readonly maxBytes: number }): Promise<DropSession | undefined> {
    const challenge = this.drops.get(input.codeHash);
    if (challenge === undefined || challenge.state !== "active" || challenge.expiresAt <= input.now) return Promise.resolve(undefined);
    if (challenge.expiresAt <= input.now) return Promise.resolve(undefined);
    const value: DropSession = {
      id: input.sessionId, channelId: challenge.id, tokenHash: input.tokenHash, csrfHash: input.csrfHash, userAgentHash: input.userAgentHash,
      ...(challenge.identity === undefined ? {} : { telegramUserId: challenge.identity.userId, telegramChatId: challenge.identity.chatId }), state: "active",
      createdAt: input.now, lastSeenAt: input.now, expiresAt: challenge.expiresAt,
      maxFiles: challenge.maxFiles, maxBytes: challenge.maxBytes, reservedFiles: challenge.reservedFiles, reservedBytes: challenge.reservedBytes,
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
    if (value !== undefined && value.expiresAt <= now) {
      for (const session of this.sessions.values()) if (session.channelId === value.channelId) Object.assign(session, { state: "expired" });
    }
    if (value === undefined || value.state !== "active" || value.userAgentHash !== userAgentHash || value.expiresAt <= now) return Promise.resolve(undefined);
    Object.assign(value, { lastSeenAt: now }); return Promise.resolve(value);
  }
  revokeDropSession(tokenHash: string): Promise<void> { const value = this.sessions.get(tokenHash); if (value !== undefined) Object.assign(value, { state: "revoked" }); return Promise.resolve(); }
  revokeDropAccess(identity: TelegramIdentity): Promise<{ readonly sessions: number; readonly challenges: number }> {
    if (identity.userId !== this.binding?.userId || identity.chatId !== this.binding.chatId) return Promise.reject(new Error("not bound"));
    let sessions = 0; let challenges = 0;
    for (const value of this.sessions.values()) if (value.state === "active" && value.telegramUserId === identity.userId && value.telegramChatId === identity.chatId) { Object.assign(value, { state: "revoked" }); sessions += 1; }
    for (const value of this.drops.values()) if (value.state === "active" && value.identity?.userId === identity.userId && value.identity.chatId === identity.chatId) { value.state = "revoked"; challenges += 1; }
    return Promise.resolve({ sessions, challenges });
  }
  reserveUpload(input: { readonly id: string; readonly sessionId: string; readonly channelId: string; readonly clientKeyHash: string; readonly filename: string; readonly expectedSize: number; readonly expectedSha256?: string; readonly now: Date }): Promise<{ readonly value: DropUpload; readonly created: boolean }> {
    const session = this.sessionById.get(input.sessionId);
    const challenge = [...this.drops.values()].find((value) => value.id === input.channelId);
    if (session === undefined || session.channelId !== input.channelId || session.state !== "active" || challenge === undefined) return Promise.reject(new Error("not active"));
    const existing = [...this.uploads.values()].find((value) => value.channelId === input.channelId && value.clientKeyHash === input.clientKeyHash);
    if (existing !== undefined) return Promise.resolve({ value: existing, created: false });
    if (challenge.reservedFiles + 1 > challenge.maxFiles || challenge.reservedBytes + input.expectedSize > challenge.maxBytes) return Promise.reject(new Error("quota exhausted"));
    challenge.reservedFiles += 1; challenge.reservedBytes += input.expectedSize;
    for (const item of this.sessions.values()) if (item.channelId === input.channelId) Object.assign(item, { reservedFiles: challenge.reservedFiles, reservedBytes: challenge.reservedBytes });
    const value: DropUpload = { id: input.id, sessionId: input.sessionId, channelId: input.channelId, clientKeyHash: input.clientKeyHash, filename: input.filename, expectedSize: input.expectedSize, ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }), state: "reserved", createdAt: input.now };
    this.uploads.set(value.id, value); return Promise.resolve({ value, created: true });
  }
  attachUpload(channelId: string, id: string, uploadId: string): Promise<DropUpload> {
    const value = this.uploads.get(id); if (value === undefined || value.channelId !== channelId) return Promise.reject(new Error("missing"));
    const next = { ...value, uploadId, state: "uploading" as const }; this.uploads.set(id, next); return Promise.resolve(next);
  }
  releaseUploadReservation(channelId: string, id: string): Promise<void> {
    const value = this.uploads.get(id); const challenge = [...this.drops.values()].find((item) => item.id === channelId);
    if (value !== undefined && value.channelId === channelId && value.uploadId === undefined && challenge !== undefined) {
      this.uploads.delete(id); challenge.reservedFiles -= 1; challenge.reservedBytes -= value.expectedSize;
      for (const item of this.sessions.values()) if (item.channelId === channelId) Object.assign(item, { reservedFiles: challenge.reservedFiles, reservedBytes: challenge.reservedBytes });
    }
    return Promise.resolve();
  }
  getDropUpload(channelId: string, id: string): Promise<DropUpload | undefined> { const value = this.uploads.get(id); return Promise.resolve(value?.channelId === channelId ? value : undefined); }
  listDropUploads(channelId: string): Promise<readonly DropUpload[]> { return Promise.resolve([...this.uploads.values()].filter((value) => value.channelId === channelId)); }
  completeDropUpload(channelId: string, id: string, resourceId: string, completedAt: Date): Promise<DropUpload> {
    const value = this.uploads.get(id); if (value === undefined || value.channelId !== channelId) return Promise.reject(new Error("missing"));
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
  const service = new DropService({ repository, files, pepper: "drop-pepper-that-is-at-least-thirty-two-characters", options: { publicOrigin: "https://vault.test", codeTtlMs: 1_800_000, linkCodeTtlMs: 300_000, sessionTtlMs: 1_800_000, maxFiles: options.maxFiles ?? 20, maxBytes: options.maxBytes ?? 1024, failureLimit: options.failureLimit ?? 5, globalFailureLimit: 100, failureWindowMs: 900_000, failureDelayMs: 0 } });
  return { repository, files, service };
}

async function boundDrop(service: DropService, identity = { userId: "12345", chatId: "12345" }) {
  const link = await service.createLinkChallenge(); await service.linkTelegram(link.code, identity);
  return { identity, challenge: await service.issueDropCodeForTelegram(identity) };
}

describe("DropService", () => {
  it("keeps link challenges single-use while one Drop code opens a shared multi-client channel", async () => {
    const { service } = fixture(); const identity = { userId: "12345", chatId: "12345" };
    const link = await service.createLinkChallenge();
    expect(link.code.replaceAll("-", "")).toHaveLength(12);
    await expect(service.redeem(link.code, "192.0.2.1", "browser")).rejects.toBeInstanceOf(DropServiceError);
    await service.linkTelegram(link.code, identity);
    await expect(service.linkTelegram(link.code, identity)).rejects.toMatchObject({ code: "invalid_code" });
    const drop = await service.issueDropCodeForTelegram(identity);
    expect(drop.code.replaceAll("-", "")).toHaveLength(8);
    const outcomes = await Promise.allSettled([service.redeem(drop.code, "192.0.2.2", "browser"), service.redeem(drop.code, "192.0.2.3", "browser")]);
    const sessions = outcomes.flatMap((value) => value.status === "fulfilled" ? [value.value.session] : []);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
    expect(new Set(sessions.map((session) => session.channelId)).size).toBe(1);
    expect(new Set(sessions.map((session) => session.expiresAt.getTime())).size).toBe(1);
  });

  it("anchors both admission and every client session to 30 minutes after code issue", async () => {
    const { service } = fixture();
    const issuedAt = new Date("2026-09-03T12:00:00.000Z");
    const absoluteExpiry = new Date("2026-09-03T12:30:00.000Z");
    const challenge = await service.issueDropCode(issuedAt);
    expect(challenge.expiresAt).toEqual(absoluteExpiry);

    const first = await service.redeem(challenge.code, "192.0.2.20", "browser-one", new Date("2026-09-03T12:20:00.000Z"));
    const latePeer = await service.redeem(challenge.code, "192.0.2.21", "browser-two", new Date("2026-09-03T12:29:59.000Z"));
    expect(first.session.expiresAt).toEqual(absoluteExpiry);
    expect(latePeer.session.expiresAt).toEqual(absoluteExpiry);
    await expect(service.redeem(challenge.code, "192.0.2.22", "browser-three", absoluteExpiry)).rejects.toMatchObject({ code: "invalid_code" });
  });

  it("issues owner Drop access without Telegram and keeps it active when Telegram is unlinked", async () => {
    const { service } = fixture();
    const challenge = await service.issueDropCode();
    const created = await service.redeem(challenge.code, "192.0.2.10", "owner-browser");
    expect(created.session.telegramUserId).toBeUndefined();
    expect(created.session.telegramChatId).toBeUndefined();
    await expect(service.unlink()).resolves.toEqual({ sessions: 0, challenges: 0 });
    await expect(service.validateSession({ token: created.token, userAgent: "owner-browser", isMutation: false })).resolves.toMatchObject({ id: created.session.id });
  });

  it("enforces origin-bound CSRF and immediate revocation", async () => {
    const { service } = fixture(); const { identity, challenge } = await boundDrop(service);
    const created = await service.redeem(challenge.code, "192.0.2.1", "browser");
    await expect(service.validateSession({ token: created.token, userAgent: "browser", isMutation: true, origin: "https://vault.test", csrfCookie: created.csrfToken, csrfHeader: created.csrfToken })).resolves.toMatchObject({ id: created.session.id });
    await expect(service.validateSession({ token: created.token, userAgent: "browser", isMutation: true, origin: "https://evil.test", csrfCookie: created.csrfToken, csrfHeader: created.csrfToken })).rejects.toMatchObject({ code: "csrf_rejected" });
    await service.revokeAccess(identity);
    await expect(service.validateSession({ token: created.token, userAgent: "browser", isMutation: false })).rejects.toMatchObject({ code: "invalid_session" });
  });

  it("shares upload state inside one channel, isolates another code, and commits its checksum", async () => {
    const { service } = fixture(); const { challenge } = await boundDrop(service);
    const created = await service.redeem(challenge.code, "192.0.2.1", "browser-one");
    const peer = await service.redeem(challenge.code, "192.0.2.2", "browser-two");
    const upload = await service.createUpload(created.session, { filename: "drop.txt", expectedSize: 6, idempotencyKey: "drop-test-0001" });
    await service.appendUpload(created.session, upload.id, 0, 3, Readable.from(Buffer.from("abc")));
    expect((await service.listUploads(peer.session)).map((item) => item.id)).toContain(upload.id);
    expect((await service.inspectUpload(peer.session, upload.id)).receivedSize).toBe(3);
    const isolatedCode = await service.issueDropCode();
    const isolated = await service.redeem(isolatedCode.code, "192.0.2.3", "browser-three");
    await expect(service.inspectUpload(isolated.session, upload.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await service.inspectUpload(created.session, upload.id)).receivedSize).toBe(3);
    await service.appendUpload(peer.session, upload.id, 3, 3, Readable.from(Buffer.from("def")));
    const completed = await service.completeUpload(peer.session, upload.id);
    expect(completed.sha256).toBe(createHash("sha256").update("abcdef").digest("hex"));
  });

  it("reserves file and byte quotas atomically", async () => {
    const { service } = fixture({ maxFiles: 1, maxBytes: 4 }); const { challenge } = await boundDrop(service);
    const created = await service.redeem(challenge.code, "192.0.2.1", "browser-one");
    const peer = await service.redeem(challenge.code, "192.0.2.2", "browser-two");
    const results = await Promise.allSettled([
      service.createUpload(created.session, { filename: "a.bin", expectedSize: 4, idempotencyKey: "quota-test-a" }),
      service.createUpload(peer.session, { filename: "b.bin", expectedSize: 4, idempotencyKey: "quota-test-b" }),
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
