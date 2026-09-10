import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Resource } from "@saturn/file-core";
import { ShareService } from "./share.service.js";
import type { SharePackage, ShareRecord, ShareRepository, ShareSession } from "./types.js";

function fixture(overrides: { readonly failureLimit?: number } = {}) {
  const shares = new Map<string, ShareRecord>();
  const sessions = new Map<string, ShareSession>();
  const attempts: Array<{ id: string; source: string; outcome: string; at: Date }> = [];
  const packages = new Map<string, SharePackage>();
  const repository = {
    createShare: (input: Omit<ShareRecord, "downloadCount" | "state" | "updatedAt">) => {
      const value: ShareRecord = { ...input, state: "active", downloadCount: 0, updatedAt: input.createdAt };
      shares.set(value.id, value); return Promise.resolve(value);
    },
    getShareById: (id: string) => Promise.resolve(shares.get(id)),
    getShareByTokenHash: (hash: string) => Promise.resolve([...shares.values()].find((value) => value.tokenHash === hash)),
    listShares: () => Promise.resolve([...shares.values()]),
    updateShare: (id: string, input: Record<string, unknown>, now: Date) => { const current = shares.get(id); if (current === undefined) return Promise.reject(new Error("missing")); const value = { ...current, ...input, updatedAt: now } as ShareRecord; shares.set(id, value); return Promise.resolve(value); },
    revokeShare: (id: string, now: Date) => { const current = shares.get(id); if (current === undefined) return Promise.reject(new Error("missing")); const value = { ...current, state: "revoked" as const, revokedAt: now, updatedAt: now }; shares.set(id, value); return Promise.resolve(value); },
    sourceAllowed: () => Promise.resolve(true),
    isDescendant: (root: string, candidate: string) => Promise.resolve(candidate === root || candidate === "child-folder"),
    createSession: (input: Omit<ShareSession, "state" | "downloadClaimed" | "lastSeenAt">) => { const value: ShareSession = { ...input, state: "active", downloadClaimed: false, lastSeenAt: input.createdAt }; sessions.set(value.tokenHash, value); return Promise.resolve(value); },
    touchSession: (input: { shareId: string; tokenHash: string; sourceIpHash: string; userAgentHash: string; now: Date }) => { const value = sessions.get(input.tokenHash); return Promise.resolve(value?.shareId === input.shareId && value.sourceIpHash === input.sourceIpHash && value.userAgentHash === input.userAgentHash && value.expiresAt > input.now && value.state === "active" ? value : undefined); },
    claimDownload: (shareId: string, sessionId: string) => { const current = shares.get(shareId); const currentSession = [...sessions.values()].find((value) => value.id === sessionId); if (current === undefined || currentSession === undefined || current.state !== "active") return Promise.reject(new Error("inactive")); const nextSession = { ...currentSession, downloadClaimed: true }; const nextShare = currentSession.downloadClaimed ? current : { ...current, downloadCount: current.downloadCount + 1 }; shares.set(shareId, nextShare); sessions.set(nextSession.tokenHash, nextSession); return Promise.resolve({ share: nextShare, session: nextSession }); },
    validateActive: (id: string) => Promise.resolve(["active", "exhausted"].includes(shares.get(id)?.state ?? "")),
    beginPasswordAttempt: (input: { sourceIpHash: string; since: Date; limit: number; occurredAt: Date }) => { const recent = attempts.filter((value) => value.source === input.sourceIpHash && ["pending", "failure"].includes(value.outcome) && value.at >= input.since); if (recent.length >= input.limit) return Promise.resolve(undefined); const id = String(attempts.length + 1); attempts.push({ id, source: input.sourceIpHash, outcome: "pending", at: input.occurredAt }); return Promise.resolve(id); },
    finishPasswordAttempt: (id: string, outcome: string, at: Date) => { const value = attempts.find((item) => item.id === id); if (value !== undefined) Object.assign(value, { outcome, at }); return Promise.resolve(); },
    writeAccessEvent: () => Promise.resolve(),
    createPackage: (input: Omit<SharePackage, "state" | "fileCount" | "sizeBytes">) => { const existing = [...packages.values()].find((value) => value.shareId === input.shareId && ["preparing", "ready"].includes(value.state)); if (existing !== undefined) return Promise.resolve({ value: existing, created: false }); const value: SharePackage = { ...input, state: "preparing", fileCount: 0, sizeBytes: 0 }; packages.set(value.id, value); return Promise.resolve({ value, created: true }); },
    getCurrentPackage: (shareId: string) => Promise.resolve([...packages.values()].find((value) => value.shareId === shareId)),
    setPackageReady: (id: string, input: { fileCount: number; sizeBytes: number; sha256: string; readyAt: Date }) => { const current = packages.get(id); if (current === undefined) return Promise.reject(new Error("missing")); const value = { ...current, ...input, state: "ready" as const }; packages.set(id, value); return Promise.resolve(value); },
    setPackageFailed: () => Promise.resolve(),
    claimExpiredPackages: () => Promise.resolve([]),
    markPackageExpired: () => Promise.resolve(),
  } as unknown as ShareRepository;
  const now = new Date();
  const resources = new Map<string, Resource>([
    ["file", { id: "file", parentId: "root", type: "file" as const, name: "file.txt", storagePath: "drive/file.txt", mimeType: "text/plain", sizeBytes: 6, sha256: "0".repeat(64), status: "active" as const, securityClassification: "internal" as const, createdAt: now, updatedAt: now }],
    ["root", { id: "root", type: "folder" as const, name: "Folder", storagePath: "drive/folder", sizeBytes: 0, status: "active" as const, securityClassification: "internal" as const, createdAt: now, updatedAt: now }],
    ["child-folder", { id: "child-folder", parentId: "root", type: "folder" as const, name: "Child", storagePath: "drive/folder/Child", sizeBytes: 0, status: "active" as const, securityClassification: "internal" as const, createdAt: now, updatedAt: now }],
    ["secret", { id: "secret", parentId: "root", type: "file" as const, name: "secret.txt", storagePath: "drive/folder/secret.txt", sizeBytes: 1, status: "active" as const, securityClassification: "secret" as const, createdAt: now, updatedAt: now }],
  ]);
  const bytes = new Map([["file", Buffer.from("abcdef")]]);
  const files = {
    getResource: (id: string) => { const value = resources.get(id); return value === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(value); },
    listChildren: (id: string) => Promise.resolve([...resources.values()].filter((value) => value.parentId === id)),
    openDownload: (id: string, offset = 0, length?: number) => { const resource = resources.get(id); const value = bytes.get(id); if (resource === undefined || value === undefined) return Promise.reject(new Error("missing")); return Promise.resolve({ resource, stream: Readable.from(value.subarray(offset, length === undefined ? undefined : offset + length)) }); },
    setSecurityClassification: (id: string, classification: "public" | "internal" | "confidential" | "secret") => { const value = resources.get(id); if (value === undefined) return Promise.reject(new Error("missing")); const updated = { ...value, securityClassification: classification }; resources.set(id, updated); return Promise.resolve(updated); },
  };
  const service = new ShareService({
    repository,
    files,
    storage: {} as never,
    pepper: "share-pepper-that-is-at-least-thirty-two-characters",
    options: { enabled: true, publicOrigin: "https://vault.test", defaultExpiryMs: 604_800_000, maxExpiryMs: 31_536_000_000, sessionTtlMs: 1_800_000, passwordFailureLimit: overrides.failureLimit ?? 5, passwordFailureWindowMs: 900_000, passwordFailureDelayMs: 0, packageMaxFiles: 100, packageMaxBytes: 1024, packageMaxDurationMs: 60_000, streamRevalidateBytes: 65_536 },
  });
  return { service, shares, resources };
}

describe("ShareService", () => {
  it("discloses a 256-bit capability once and stores only its domain-separated hash", async () => {
    const { service, shares } = fixture();
    const created = await service.createShare({ resourceId: "file", mode: "download" });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.url).toBe(`https://vault.test/s/${created.token}`);
    expect(JSON.stringify([...shares.values()])).not.toContain(created.token);
    expect((await service.listShares())[0]).not.toHaveProperty("token");
  });

  it("uses Argon2id, binds the short session and counts one download across ranges", async () => {
    const { service, shares } = fixture();
    const created = await service.createShare({ resourceId: "file", mode: "download", password: "correct-horse-battery" });
    const record = [...shares.values()][0];
    expect(record?.passwordHash).toMatch(/^argon2id\$/);
    const locked = await service.metadata(created.token, { sourceIp: "192.0.2.1", userAgent: "browser" });
    expect(locked.share.locked).toBe(true);
    await expect(service.unlock(created.token, "incorrect-password", { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toMatchObject({ code: "denied" });
    const unlocked = await service.unlock(created.token, "correct-horse-battery", { sourceIp: "192.0.2.1", userAgent: "browser" });
    const input = { sourceIp: "192.0.2.1", userAgent: "browser", sessionToken: unlocked.session.token };
    const first = await service.openContent(created.token, { offset: 0, length: 3 }, input);
    expect(Buffer.concat(await first.stream.toArray())).toEqual(Buffer.from("abc"));
    const second = await service.openContent(created.token, { offset: 3, length: 3 }, input);
    expect(Buffer.concat(await second.stream.toArray())).toEqual(Buffer.from("def"));
    expect(shares.get(created.share.id)?.downloadCount).toBe(1);
  });

  it("keeps folder browsing inside the stable root and hides stricter children", async () => {
    const { service } = fixture();
    const created = await service.createShare({ resourceId: "root", mode: "browse" });
    const opened = await service.metadata(created.token, { sourceIp: "192.0.2.1", userAgent: "browser" });
    const input = { sourceIp: "192.0.2.1", userAgent: "browser", ...(opened.session === undefined ? {} : { sessionToken: opened.session.token }) };
    const children = await service.listChildren(created.token, undefined, input);
    expect(children.map((value) => value.name)).toEqual(["file.txt", "Child"]);
    expect(children.find((value) => value.id === "file")?.sha256).toBe("0".repeat(64));
    await expect(service.listChildren(created.token, "file", input)).rejects.toMatchObject({ code: "not_found" });
  });
});
