import { requireTestValue } from "../../contracts/src/test-support.js";
import { ZipFile } from "yazl";
import { PassThrough, Readable } from "node:stream";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Resource } from "@saturn/file-core";
import { ShareService } from "./share.service.js";
import type { SharePackage, ShareRecord, ShareRepository, ShareSession } from "./types.js";
import * as reservation from "./package-reservation.js";

function fixture(overrides: { readonly failureLimit?: number; readonly downloadSource?: (id: string) => Readable | Promise<Readable>; readonly beforeOpen?: (resource: Resource) => Resource; readonly deleteError?: () => Error | undefined; readonly packageDurationMs?: number; readonly lifecycle?: (packages: Map<string, SharePackage>) => ShareRepository["packageLifecycle"]; readonly packageReadSource?: () => Readable | undefined; readonly readClosure?: (source: Readable) => Promise<void> | undefined } = {}) {
  const shares = new Map<string, ShareRecord>();
  const sessions = new Map<string, ShareSession>();
  const attempts: Array<{ id: string; source: string; outcome: string; at: Date }> = [];
  const packages = new Map<string, SharePackage>();
  const storedPackages = new Map<string, Buffer>();
  const writtenChunks: number[] = [];
  const directories = new Set<string>();
  const repository = {
    ...(overrides.lifecycle ? { packageLifecycle: overrides.lifecycle(packages) } : {}),
    createShare: (input: Omit<ShareRecord, "downloadCount" | "state" | "updatedAt">) => {
      const value: ShareRecord = { ...input, state: "active", downloadCount: 0, updatedAt: input.createdAt };
      shares.set(value.id, value); return Promise.resolve(value);
    },
    getShareById: (id: string) => Promise.resolve(shares.get(id)),
    getShareByTokenHash: (hash: string) => Promise.resolve([...shares.values()].find((value) => value.tokenHash === hash)),
    listShares: () => Promise.resolve([...shares.values()]),
    rotateShareCapability: (id: string, input: { tokenHash: string; tokenCiphertext: string }, now: Date) => { const current = shares.get(id); if (current === undefined || current.state !== "active") return Promise.reject(new Error("missing")); if (current.tokenCiphertext !== undefined) return Promise.resolve({ share: current, rotated: false }); const value = { ...current, ...input, updatedAt: now }; shares.set(id, value); return Promise.resolve({ share: value, rotated: true }); },
    updateShare: (id: string, input: Record<string, unknown>, now: Date) => { const current = shares.get(id); if (current === undefined) return Promise.reject(new Error("missing")); const value = { ...current, ...input, updatedAt: now } as ShareRecord; shares.set(id, value); return Promise.resolve(value); },
    revokeShare: (id: string, now: Date) => { const current = shares.get(id); if (current === undefined) return Promise.reject(new Error("missing")); const value = { ...current, state: "revoked" as const, revokedAt: now, updatedAt: now }; shares.set(id, value); return Promise.resolve(value); },
    sourceAllowed: () => Promise.resolve(true),
    isDescendant: (root: string, candidate: string) => Promise.resolve(candidate === root || candidate === "child-folder" || candidate === "file"),
    createSession: (input: Omit<ShareSession, "state" | "downloadClaimed" | "lastSeenAt">) => { const value: ShareSession = { ...input, state: "active", downloadClaimed: false, lastSeenAt: input.createdAt }; sessions.set(value.tokenHash, value); return Promise.resolve(value); },
    touchSession: (input: { shareId: string; tokenHash: string; sourceIpHash: string; userAgentHash: string; now: Date }) => { const value = sessions.get(input.tokenHash); return Promise.resolve(value?.shareId === input.shareId && value.sourceIpHash === input.sourceIpHash && value.userAgentHash === input.userAgentHash && value.expiresAt > input.now && value.state === "active" ? value : undefined); },
    claimDownload: (shareId: string, sessionId: string) => { const current = shares.get(shareId); const currentSession = [...sessions.values()].find((value) => value.id === sessionId); if (current === undefined || currentSession === undefined || current.state !== "active") return Promise.reject(new Error("inactive")); const nextSession = { ...currentSession, downloadClaimed: true }; const nextShare = currentSession.downloadClaimed ? current : { ...current, downloadCount: current.downloadCount + 1 }; shares.set(shareId, nextShare); sessions.set(nextSession.tokenHash, nextSession); return Promise.resolve({ share: nextShare, session: nextSession }); },
    validateActive: (id: string, now: Date, sessionId?: string) => Promise.resolve(["active", "exhausted"].includes(shares.get(id)?.state ?? "") && (sessionId === undefined || [...sessions.values()].some(value => value.id === sessionId && value.shareId === id && value.state === "active" && value.expiresAt > now))),
    beginPasswordAttempt: (input: { sourceIpHash: string; since: Date; limit: number; occurredAt: Date }) => { const recent = attempts.filter((value) => value.source === input.sourceIpHash && ["pending", "failure"].includes(value.outcome) && value.at >= input.since); if (recent.length >= input.limit) return Promise.resolve(undefined); const id = String(attempts.length + 1); attempts.push({ id, source: input.sourceIpHash, outcome: "pending", at: input.occurredAt }); return Promise.resolve(id); },
    finishPasswordAttempt: (id: string, outcome: string, at: Date) => { const value = attempts.find((item) => item.id === id); if (value !== undefined) Object.assign(value, { outcome, at }); return Promise.resolve(); },
    writeAccessEvent: () => Promise.resolve(),
    createPackage: (input: Omit<SharePackage, "state" | "fileCount" | "sizeBytes">) => { const existing = [...packages.values()].find((value) => value.shareId === input.shareId && ["preparing", "ready"].includes(value.state)); if (existing !== undefined) return Promise.resolve({ value: existing, created: false }); const value: SharePackage = { ...input, state: "preparing", fileCount: 0, sizeBytes: 0 }; packages.set(value.id, value); return Promise.resolve({ value, created: true }); },
    getCurrentPackage: (shareId: string) => Promise.resolve([...packages.values()].find((value) => value.shareId === shareId && ["preparing", "ready"].includes(value.state))),
    setPackageReady: (id: string, input: { fileCount: number; sizeBytes: number; sha256: string; readyAt: Date }) => { const current = packages.get(id); if (current === undefined) return Promise.reject(new Error("missing")); const value = { ...current, ...input, state: "ready" as const }; packages.set(id, value); return Promise.resolve(value); },
    setPackageFailed: async (id: string) => { const value = packages.get(id); if (value) packages.set(id, { ...value, state: "failed" }); },
    claimExpiredPackages: async (now: Date, limit: number) => [...packages.values()].filter(value => ["failed", "expired"].includes(value.state) || value.state === "ready" && value.expiresAt <= now).slice(0, limit),
    markPackageExpired: async (id: string) => { const value = packages.get(id); if (value) packages.set(id, { ...value, state: "expired" }); },
    deleteExpiredPackage: async (id: string) => { if (packages.get(id)?.state === "expired") packages.delete(id); },
  } as unknown as ShareRepository;
  const now = new Date();
  const resources = new Map<string, Resource>([
    ["file", { id: "file", parentId: "root", type: "file" as const, name: "file.txt", storagePath: "drive/file.txt", mimeType: "text/plain", sizeBytes: 6, sha256: createHash("sha256").update("abcdef").digest("hex"), status: "active" as const, securityClassification: "internal" as const, createdAt: now, updatedAt: now }],
    ["root", { id: "root", type: "folder" as const, name: "Folder", storagePath: "drive/folder", sizeBytes: 0, status: "active" as const, securityClassification: "internal" as const, createdAt: now, updatedAt: now }],
    ["child-folder", { id: "child-folder", parentId: "root", type: "folder" as const, name: "Child", storagePath: "drive/folder/Child", sizeBytes: 0, status: "active" as const, securityClassification: "internal" as const, createdAt: now, updatedAt: now }],
    ["secret", { id: "secret", parentId: "root", type: "file" as const, name: "secret.txt", storagePath: "drive/folder/secret.txt", sizeBytes: 1, status: "active" as const, securityClassification: "secret" as const, createdAt: now, updatedAt: now }],
  ]);
  const bytes = new Map([["file", Buffer.from("abcdef")]]);
  const files = {
    getResource: (id: string) => { const value = resources.get(id); return value === undefined ? Promise.reject(new Error("missing")) : Promise.resolve(value); },
    listChildren: (id: string, offset = 0, limit = 500) => Promise.resolve([...resources.values()].filter((value) => value.parentId === id).slice(offset, offset + limit)),
    openDownload: async (id: string, offset: number | ((resource: Resource) => { offset: number; length?: number }) = 0, length?: number) => { const stored = resources.get(id); const value = bytes.get(id); if (stored === undefined || value === undefined) throw new Error("missing"); const resource = overrides.beforeOpen?.(stored) ?? stored; if (typeof offset === "function") { const selected = offset(resource); offset = selected.offset; length = selected.length; } return { resource, stream: await overrides.downloadSource?.(id) ?? Readable.from(value.subarray(offset, length === undefined ? undefined : offset + length)) }; },
    setSecurityClassification: (id: string, classification: "public" | "internal" | "confidential" | "secret") => { const value = resources.get(id); if (value === undefined) return Promise.reject(new Error("missing")); const updated = { ...value, securityClassification: classification }; resources.set(id, updated); return Promise.resolve(updated); },
  };
  const service = new ShareService({
    repository,
    files,
    storage: {
      mkdir: async path => { directories.add(path); }, exists: async path => directories.has(path) || storedPackages.has(path),
      write: async (path, stream) => { const chunks = []; for await (const chunk of stream) { const bytes = Buffer.from(chunk as Uint8Array); writtenChunks.push(bytes.length); chunks.push(bytes); } const bytes = Buffer.concat(chunks); storedPackages.set(path, bytes); return bytes.length; },
      stat: async path => ({ size: storedPackages.get(path)?.length ?? 0 }),
      openRead: async (path, range) => {
        const source = overrides.packageReadSource?.() ?? Readable.from([(storedPackages.get(path) ?? Buffer.alloc(0)).subarray(range?.offset ?? 0, range?.length === undefined ? undefined : (range.offset ?? 0) + range.length)]);
        if (!('storageClosed' in source)) {
          const closure = overrides.readClosure ? overrides.readClosure(source) : new Promise<void>(resolve => source.once('close', resolve));
          if (closure) { void closure.catch(() => undefined); Object.assign(source, { storageClosed: closure }); }
        }
        return source;
      },
      delete: async path => { const error = overrides.deleteError?.(); if (error) throw error; storedPackages.delete(path); },
    },
    pepper: "share-pepper-that-is-at-least-thirty-two-characters",
    options: { enabled: true, publicOrigin: "https://vault.test", defaultExpiryMs: 604_800_000, maxExpiryMs: 31_536_000_000, sessionTtlMs: 1_800_000, passwordFailureLimit: overrides.failureLimit ?? 5, passwordFailureWindowMs: 900_000, passwordFailureDelayMs: 0, packageMaxFiles: 100, packageMaxBytes: 1024, packageMaxDurationMs: overrides.packageDurationMs ?? 60_000, streamRevalidateBytes: 65_536 },
  });
  return { service, shares, sessions, resources, bytes, packages, storedPackages, writtenChunks };
}

function lifecycleFixture() {
  const readers = new Map<string, string>(), closed = new Set<string>(), events: string[] = []; let sequence = 0;
  const factory = (packages: Map<string, SharePackage>): NonNullable<ShareRepository["packageLifecycle"]> => ({
    begin: async (packageId, bytes) => { events.push(`reserve:${String(bytes)}`); const value = requireTestValue(packages.get(packageId)); const id = `${packageId}-generation`, storagePath = `${value.storagePath}.generation`; packages.set(packageId, { ...value, generationId: id, storagePath }); return { id, packageId, storagePath, token: "writer" }; },
    renewWriter: async () => true,
    confirmWriterClosed: async claim => { events.push("writer-closed"); closed.add(claim.id); },
    publish: async (claim, input) => { if (!closed.has(claim.id)) return false; events.push("publish"); packages.set(claim.packageId, { ...requireTestValue(packages.get(claim.packageId)), ...input, state: "ready", readyAt: new Date() }); return true; },
    fail: async claim => { events.push("fail"); packages.set(claim.packageId, { ...requireTestValue(packages.get(claim.packageId)), state: "failed" }); },
    acquireReader: async (_id, generationId) => { const id = String(++sequence); readers.set(id, generationId); return id; },
    renewReader: async id => readers.has(id),
    releaseReader: async id => { readers.delete(id); },
    claimCleanup: async limit => [...packages.values()].filter(value => closed.has(requireTestValue(value.generationId)) && ![...readers.values()].includes(requireTestValue(value.generationId)) && ["failed", "expired"].includes(value.state)).slice(0, limit).map(value => ({ id: requireTestValue(value.generationId), packageId: value.id, storagePath: value.storagePath, token: "cleanup" })),
    completeCleanup: async claim => packages.delete(claim.packageId),
  });
  return { factory, readers, closed, events };
}

afterEach(() => vi.restoreAllMocks());

describe("ShareService", () => {
  it("reserves the produced ZIP before writing and publishes only after write closure", async () => {
    const lifecycle = lifecycleFixture(), { service, storedPackages } = fixture({ lifecycle: lifecycle.factory });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    const ready = await service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" });
    expect(ready.generationId).toBeDefined(); expect(ready.storagePath).toMatch(/\.generation$/);
    expect([...storedPackages.keys()]).toEqual([ready.storagePath]);
    expect(lifecycle.events).toEqual([expect.stringMatching(/^reserve:/), "writer-closed", "publish"]);
    expect(requireTestValue(storedPackages.get(ready.storagePath)).length).toBeLessThanOrEqual(Number(requireTestValue(lifecycle.events[0]).split(":")[1]));
  });

  it("does not deliver a ZIP chunk exceeding its reserved storage budget", async () => {
    vi.spyOn(reservation, "packageArchiveReservation").mockReturnValue(1);
    const lifecycle = lifecycleFixture(), { service, writtenChunks, storedPackages } = fixture({ lifecycle: lifecycle.factory });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    await expect(service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow("reservation exceeded");
    expect(writtenChunks.reduce((sum, bytes) => sum + bytes, 0)).toBe(0); expect(storedPackages.size).toBe(0);
    expect(lifecycle.events).not.toContain("publish"); expect(lifecycle.closed.size).toBe(0);
  });

  it("retains a package until both opened receivers have closed", async () => {
    let stalled = false; const sources: PassThrough[] = [], lifecycle = lifecycleFixture();
    const { service, packages, storedPackages } = fixture({ lifecycle: lifecycle.factory, packageReadSource: () => { if (!stalled) return; const stream = new PassThrough(); sources.push(stream); return stream; } });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" }), input = { sourceIp: "192.0.2.1", userAgent: "browser" };
    const ready = await service.preparePackage(share.token, input), bytes = requireTestValue(storedPackages.get(ready.storagePath)); stalled = true;
    const first = await service.openPackage(share.token, { offset: 0 }, input), second = await service.openPackage(share.token, { offset: 0 }, input);
    expect(lifecycle.readers.size).toBe(2); packages.set(ready.id, { ...ready, state: "expired" });
    first.stream.destroy(); await vi.waitFor(() => expect(lifecycle.readers.size).toBe(1));
    expect(await service.cleanupExpiredPackages()).toBe(0); expect(requireTestValue(sources[1]).destroyed).toBe(false);
    const received = second.stream.toArray(); requireTestValue(sources[1]).end(bytes); expect(Buffer.concat(await received)).toEqual(bytes);
    await vi.waitFor(() => expect(lifecycle.readers.size).toBe(0));
    expect(await service.cleanupExpiredPackages()).toBe(1); expect(storedPackages.size).toBe(0);
  });

  it("retains custody after the exposed stream closes until physical closure is confirmed", async () => {
    let reading = false, confirm!: () => void;
    const physicalClosed = new Promise<void>(resolve => { confirm = resolve; });
    const raw = Object.assign(new PassThrough(), { storageClosed: physicalClosed }), lifecycle = lifecycleFixture();
    const { service, packages, storedPackages } = fixture({ lifecycle: lifecycle.factory, packageReadSource: () => reading ? raw : undefined });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" }), input = { sourceIp: "192.0.2.1", userAgent: "browser" };
    const ready = await service.preparePackage(share.token, input); reading = true;
    const opened = await service.openPackage(share.token, { offset: 0 }, input);
    packages.set(ready.id, { ...ready, state: "expired" }); opened.stream.destroy();
    await vi.waitFor(() => expect(raw.closed).toBe(true));
    expect(lifecycle.readers.size).toBe(1); expect(await service.cleanupExpiredPackages()).toBe(0); expect(storedPackages.has(ready.storagePath)).toBe(true);
    confirm(); await vi.waitFor(() => expect(lifecycle.readers.size).toBe(0)); expect(await service.cleanupExpiredPackages()).toBe(1);
  });

  it.each(["unsupported", "unconfirmed"])("retains %s physical read custody", async kind => {
    const lifecycle = lifecycleFixture(); let reading = false;
    const { service, packages, storedPackages } = fixture({ lifecycle: lifecycle.factory,
      readClosure: source => !reading ? new Promise<void>(resolve => source.once('close', resolve)) : kind === "unsupported" ? undefined : Promise.reject(new Error("Remote closure unconfirmed")),
    });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" }), input = { sourceIp: "192.0.2.1", userAgent: "browser" };
    const ready = await service.preparePackage(share.token, input); reading = true;
    const opened = await service.openPackage(share.token, { offset: 0 }, input);
    await opened.stream.toArray(); await new Promise<void>(resolve => setImmediate(resolve));
    packages.set(ready.id, { ...ready, state: "expired" });
    expect(lifecycle.readers.size).toBe(1); expect(await service.cleanupExpiredPackages()).toBe(0); expect(storedPackages.has(ready.storagePath)).toBe(true);
  });

  it.each(["unsupported", "unconfirmed", "stalled"])("does not publish or reclaim a generation with %s readback closure", async kind => {
    const lifecycle = lifecycleFixture();
    const { service, packages, storedPackages } = fixture({ lifecycle: lifecycle.factory, packageDurationMs: 100,
      readClosure: () => kind === "unsupported" ? undefined : kind === "unconfirmed" ? Promise.reject(new Error("Readback closure unconfirmed")) : new Promise<void>(() => undefined),
    });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    await expect(service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow(/closure/);
    expect([...packages.values()][0]?.state).toBe("failed"); expect(lifecycle.closed.size).toBe(0); expect(lifecycle.events).not.toContain("publish");
    expect(await service.cleanupExpiredPackages()).toBe(0); expect(storedPackages.size).toBe(1);
  });

  it("keeps later package readers unopened while the first source is stalled", async () => {
    const first = new PassThrough(), opened: string[] = [], live = new Set<Readable>(); let peak = 0;
    const { service, resources, bytes } = fixture({ downloadSource: id => {
      opened.push(id); const stream = id === "file" ? first : Readable.from([Buffer.from("abcdef")]);
      live.add(stream); peak = Math.max(peak, live.size); stream.once("end", () => live.delete(stream)); stream.once("close", () => live.delete(stream)); return stream;
    } });
    for (const id of ["second", "third"]) { resources.set(id, { ...requireTestValue(resources.get("file")), id, name: `${id}.txt`, storagePath: `drive/${id}.txt` }); bytes.set(id, Buffer.from("abcdef")); }
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    const completion = service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" }).then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      await expect.poll(() => opened.length, { timeout: 200, interval: 5 }).toBe(1);
      expect(opened).toEqual(["file"]); expect(first.readableEnded).toBe(false);
      first.end("abcdef"); const result = await completion;
      expect(result).toHaveProperty("value.fileCount", 3); expect(peak).toBeLessThanOrEqual(2);
    } finally { if (!first.writableEnded) first.end("abcdef"); await completion; }
  });

  it("closes a first physical open that resolves after its package deadline", async () => {
    const first = new PassThrough(), late = new PassThrough(); const opened: string[] = [];
    let release: ((stream: Readable) => void) | undefined;
    const { service, resources, bytes, packages } = fixture({ packageDurationMs: 60, downloadSource: id => {
      opened.push(id); return new Promise<Readable>(resolve => { release = resolve; });
    } });
    resources.set("second", { ...requireTestValue(resources.get("file")), id: "second", name: "second.txt" }); bytes.set("second", Buffer.from("abcdef"));
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    await expect(service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow("duration exceeded");
    try { expect(opened).toHaveLength(1); release?.(late); await expect.poll(() => late.destroyed).toBe(true); expect([...packages.values()][0]?.state).toBe("failed"); }
    finally { release?.(late); first.destroy(); late.destroy(); }
  });

  it("fails the package when a later member cannot be opened", async () => {
    const first = new PassThrough();
    const { service, resources, bytes, storedPackages } = fixture({ downloadSource: id => id === "file" ? first : Promise.reject(new Error("prepared source unavailable")) });
    resources.set("second", { ...requireTestValue(resources.get("file")), id: "second", name: "second.txt" }); bytes.set("second", Buffer.from("abcdef"));
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    first.end("abcdef");
    await expect(service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow("prepared source unavailable");
    expect(first.destroyed).toBe(true); expect(storedPackages.size).toBe(0);
  });

  it("fails promptly when a package source closes without an end or error", async () => {
    const source = new PassThrough(); const { service } = fixture({ downloadSource: () => source });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    const result = expect(service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow("closed before completion");
    await new Promise(resolve => setTimeout(resolve, 10)); source.destroy(); await result;
  });

  it("closes a stalled package source at its deadline and retains cleanup metadata", async () => {
    const source = new PassThrough(), { service, storedPackages, packages } = fixture({ downloadSource: () => source, packageDurationMs: 25 });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    await expect(service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow("duration exceeded");
    expect(source.destroyed).toBe(true); expect(storedPackages.size).toBe(0);
    expect([...packages.values()][0]?.state).toBe("failed");
    expect(await service.cleanupExpiredPackages()).toBe(1); expect(packages.size).toBe(0);
  });

  it("keeps shared listing pages bounded and advances past hidden rows", async () => {
    const { service, resources } = fixture();
    const share = await service.createShare({ resourceId: "root", mode: "browse" });
    const sample = requireTestValue(resources.get("file"));
    resources.clear(); resources.set("root", { ...sample, id: "root", type: "folder", parentId: undefined } as unknown as Resource);
    for (let index = 0; index < 1002; index++) resources.set(String(index), { ...sample, id: String(index), securityClassification: index < 500 ? "secret" : "internal" });
    const input = { sourceIp: "192.0.2.1", userAgent: "browser" };
    const first = await service.listChildrenPage(share.token, undefined, input, { offset: 0, limit: 500 });
    expect(first.items).toHaveLength(0); expect(first.nextOffset).toBe(500);
    const next = await service.listChildrenPage(share.token, undefined, input, { offset: requireTestValue(first.nextOffset), limit: 500 });
    expect(next.items).toHaveLength(500); expect(next.nextOffset).toBe(1000);
    const last = await service.listChildrenPage(share.token, undefined, input, { offset: requireTestValue(next.nextOffset), limit: 500 });
    expect(last.items).toHaveLength(2); expect(last.nextOffset).toBeNull();
    expect(await service.listChildren(share.token, undefined, input)).toHaveLength(502);
    await expect(service.listChildrenPage(share.token, undefined, input, { offset: 0, limit: 501 })).rejects.toThrow();
  });

  it.each(["revoked", "expired"])("stops an already opened download when its session becomes %s", async state => {
    const source = new PassThrough(), { service, sessions } = fixture({ downloadSource: () => source });
    const share = await service.createShare({ resourceId: "file", mode: "download" });
    const opened = await service.openContent(share.token, { offset: 0 }, { sourceIp: "192.0.2.1", userAgent: "browser" });
    for (const [key, session] of sessions) sessions.set(key, state === "revoked" ? { ...session, state: "revoked" } : { ...session, expiresAt: new Date(0) });
    const result = expect(opened.stream.toArray()).rejects.toThrow("revoked");
    source.end(Buffer.alloc(65_536)); await result; expect(source.destroyed).toBe(true);
  });

  it("rechecks a short download before its last chunk is released", async () => {
    const source = new PassThrough(), { service, shares } = fixture({ downloadSource: () => source });
    const share = await service.createShare({ resourceId: "file", mode: "download" });
    const opened = await service.openContent(share.token, { offset: 0 }, { sourceIp: "192.0.2.1", userAgent: "browser" });
    const received: Buffer[] = []; opened.stream.on("data", chunk => received.push(chunk as Buffer));
    shares.set(share.share.id, { ...requireTestValue(shares.get(share.share.id)), state: "revoked" });
    const result = expect(opened.stream.toArray()).rejects.toThrow("revoked");
    source.end(Buffer.from("abcdef")); await result; expect(received).toHaveLength(0);
  });

  it("cleans invalidated package bytes and metadata before the original expiry", async () => {
    const { service, resources, storedPackages, packages } = fixture();
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    const input = { sourceIp: "192.0.2.1", userAgent: "browser" };
    await service.preparePackage(share.token, input);
    resources.set("file", { ...requireTestValue(resources.get("file")), currentVersionId: "new-version" });
    await expect(service.packageMetadata(share.token, input)).rejects.toMatchObject({ code: "package_unavailable" });
    expect(await service.cleanupExpiredPackages()).toBe(1);
    expect(storedPackages.size).toBe(0); expect(packages.size).toBe(0);
  });

  it("retains cleanup ownership after a backend failure and retries later", async () => {
    let fail = true;
    const { service, storedPackages, packages } = fixture({ deleteError: () => fail ? new Error("backend unavailable") : undefined });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    const ready = await service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" });
    packages.set(ready.id, { ...ready, state: "expired" });
    await expect(service.cleanupExpiredPackages()).rejects.toThrow("backend unavailable");
    expect(packages.size).toBe(1); expect(storedPackages.size).toBe(1);
    fail = false;
    expect(await service.cleanupExpiredPackages()).toBe(1);
    expect(packages.size).toBe(0); expect(storedPackages.size).toBe(0);
  });

  it("refuses a package member whose version changed between enumeration and open", async () => {
    const { service, storedPackages } = fixture({ beforeOpen: resource => ({ ...resource, currentVersionId: "changed" }) });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    await expect(service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow();
    expect(storedPackages.size).toBe(0);
  });

  it("does not publish a package with corrupt member bytes and unchanged metadata", async () => {
    const { service, storedPackages } = fixture({ downloadSource: () => Readable.from([Buffer.from("wrong!")]) });
    const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
    await expect(service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow();
    expect(storedPackages.size).toBe(0);
  });

  it("does not claim a download for a view/preview request", async () => {
    const { service, shares } = fixture();
    const share = await service.createShare({ resourceId: "file", mode: "view", maxDownloads: 1 });
    const opened = await service.openContent(share.token, { offset: 0 }, { sourceIp: "192.0.2.1", userAgent: "browser" });
    await opened.stream.toArray();
    expect(shares.get(share.share.id)?.downloadCount).toBe(0);
  });

  it("does not claim an invalid range selected under the file lock", async () => {
    const { service, shares } = fixture();
    const share = await service.createShare({ resourceId: "file", mode: "download", maxDownloads: 1 });
    await expect(service.openContent(share.token, () => { throw new Error("invalid range"); }, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow("invalid range");
    expect(shares.get(share.share.id)?.downloadCount).toBe(0);
  });

  it.each(["classification", "parent"])("revalidates changed %s before opening shared bytes", async change => {
    const { service, shares } = fixture({ beforeOpen: resource => change === "classification" ? { ...resource, securityClassification: "secret" } : { ...resource, parentId: "outside", storagePath: "outside/file.txt" } });
    const share = await service.createShare({ resourceId: "file", mode: "download" });
    await expect(service.openContent(share.token, { offset: 0 }, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toThrow();
    expect(shares.get(share.share.id)?.downloadCount).toBe(0);
  });

  it("closes the underlying file when a public download is cancelled", async () => {
    const source = new PassThrough(), { service } = fixture({ downloadSource: () => source });
    const share = await service.createShare({ resourceId: "file", mode: "download" });
    const opened = await service.openContent(share.token, { offset: 0 }, { sourceIp: "192.0.2.1", userAgent: "browser" });
    opened.stream.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(source.destroyed).toBe(true);
  });
  it("fails a public download when its file closes before EOF", async () => {
    const source = new PassThrough(), { service } = fixture({ downloadSource: () => source });
    const share = await service.createShare({ resourceId: "file", mode: "download" });
    const opened = await service.openContent(share.token, { offset: 0 }, { sourceIp: "192.0.2.1", userAgent: "browser" });
    const result = expect(opened.stream.toArray()).rejects.toThrow("closed before completion");
    source.destroy(); await result;
  });
  it("inspects protected content without claiming the limited download", async () => {
    const { service, shares } = fixture();
    const created = await service.createShare({ resourceId: "file", mode: "download", maxDownloads: 1 });
    const input = { sourceIp: "192.0.2.1", userAgent: "link-checker" };
    const metadata = await service.contentMetadata(created.token, input);
    if (metadata.newSession === undefined) throw new Error("Expected a new read-only share session");
    expect(metadata.resource.sizeBytes).toBe(6);
    expect(shares.get(created.share.id)?.downloadCount).toBe(0);
    const opened = await service.openContent(created.token, { offset: 0 }, { ...input, sessionToken: metadata.newSession.token });
    opened.stream.destroy();
    expect(shares.get(created.share.id)?.downloadCount).toBe(1);
    const locked = await service.createShare({ resourceId: "file", mode: "download", password: "protected" });
    await expect(service.contentMetadata(locked.token, input)).rejects.toMatchObject({ code: "locked" });
  });

  it("protects a 256-bit capability at rest and can copy it again later", async () => {
    const { service, shares } = fixture();
    const created = await service.createShare({ resourceId: "file", mode: "download" });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.url).toBe(`https://vault.test/s/${created.token}`);
    expect(JSON.stringify([...shares.values()])).not.toContain(created.token);
    expect((await service.listShares())[0]).not.toHaveProperty("token");
    expect(shares.get(created.share.id)?.tokenCiphertext).toMatch(/^v1\./);
    await expect(service.getShareCapability(created.share.id)).resolves.toEqual({ url: created.url, replaced: false });
  });

  it("replaces a legacy hash-only capability once so its link becomes copyable", async () => {
    const { service, shares } = fixture();
    const created = await service.createShare({ resourceId: "file", mode: "download" });
    const record = shares.get(created.share.id);
    if (record === undefined) throw new Error("share fixture missing");
    const { tokenCiphertext: _omitted, ...legacyRecord } = record;
    void _omitted;
    shares.set(record.id, legacyRecord);

    const recovered = await service.getShareCapability(record.id);
    expect(recovered.replaced).toBe(true);
    expect(recovered.url).not.toBe(created.url);
    await expect(service.metadata(created.token, { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toMatchObject({ code: "not_found" });
    const replacementToken = recovered.url.slice(recovered.url.lastIndexOf("/") + 1);
    await expect(service.metadata(replacementToken, { sourceIp: "192.0.2.1", userAgent: "browser" })).resolves.toHaveProperty("share.id", record.id);
  });

  it("uses Argon2id, binds the short session and counts one download across ranges", async () => {
    const { service, shares } = fixture();
    const created = await service.createShare({ resourceId: "file", mode: "download", password: "x" });
    const record = [...shares.values()][0];
    expect(record?.passwordHash).toMatch(/^argon2id\$/);
    const locked = await service.metadata(created.token, { sourceIp: "192.0.2.1", userAgent: "browser" });
    expect(locked.share.locked).toBe(true);
    await expect(service.unlock(created.token, "incorrect-password", { sourceIp: "192.0.2.1", userAgent: "browser" })).rejects.toMatchObject({ code: "denied" });
    const unlocked = await service.unlock(created.token, "x", { sourceIp: "192.0.2.1", userAgent: "browser" });
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
    expect(children.find((value) => value.id === "file")?.sha256).toBe(createHash("sha256").update("abcdef").digest("hex"));
    await expect(service.listChildren(created.token, "file", input)).rejects.toMatchObject({ code: "not_found" });
  });

  it("serves a protected derivative source in browse mode without exposing original content or claiming a download", async () => {
    const { service, shares } = fixture();
    const created = await service.createShare({ resourceId: "root", mode: "browse" });
    const opened = await service.metadata(created.token, { sourceIp: "192.0.2.1", userAgent: "browser" });
    const input = { sourceIp: "192.0.2.1", userAgent: "browser", ...(opened.session === undefined ? {} : { sessionToken: opened.session.token }) };
    const thumbnail = await service.thumbnailSource(created.token, "file", input);
    expect(Buffer.concat(await (await thumbnail.open()).toArray()).toString()).toBe("abcdef");
    expect(shares.get(created.share.id)?.downloadCount).toBe(0);
    await expect(service.openChildContent(created.token, "file", { offset: 0 }, input)).rejects.toMatchObject({ code: "invalid_mode" });
    expect(shares.get(created.share.id)?.downloadCount).toBe(0);
  });
});

it("D-R17 progressing first package member must not expire an unused later reader", async () => {
  const first = new PassThrough();
  const { service, resources, bytes } = fixture({ downloadSource: id => {
    if (id === "file") return first;
    const source = Readable.from([Buffer.from("abcdef")]); const timer = setTimeout(() => source.destroy(new Error("physical reader idle before its member was consumed")), 100); source.once("close", () => clearTimeout(timer)); source.once("end", () => clearTimeout(timer)); return source;
  } });
  resources.set("second", { ...requireTestValue(resources.get("file")), id: "second", name: "second.txt", storagePath: "drive/second.txt" }); bytes.set("second", Buffer.from("abcdef"));
  const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
  const pump = (async () => { for (const byte of Buffer.from("abcdef")) { await new Promise<void>(resolve => setTimeout(resolve, 30)); if (first.destroyed) break; first.write(Buffer.from([byte])); } if (!first.destroyed) first.end(); })();
  try { const ready = await service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" }); expect(ready.state).toBe("ready"); expect(ready.fileCount).toBe(2); }
  finally { first.destroy(); await pump; }
});

it("D-R17 a paused lazy package member must not acquire its physical reader early", async () => {
  const actual = Reflect.get(ZipFile.prototype, "addReadStreamLazy"); let release: (() => void) | undefined;
  vi.spyOn(ZipFile.prototype, "addReadStreamLazy").mockImplementation(function(this: ZipFile, name, options, getStream) {
    return actual.call(this, name, options, name === "second.txt" ? callback => { release = () => getStream(callback); } : getStream);
  });
  const { service, resources, bytes } = fixture({ downloadSource: () => { const source = Readable.from([Buffer.from("abcdef")]); const timer = setTimeout(() => source.destroy(new Error("physical reader idle between lazy member callbacks")), 100); source.once("end", () => clearTimeout(timer)); source.once("close", () => clearTimeout(timer)); return source; } });
  resources.set("second", { ...requireTestValue(resources.get("file")), id: "second", name: "second.txt", storagePath: "drive/second.txt" }); bytes.set("second", Buffer.from("abcdef"));
  const share = await service.createShare({ resourceId: "root", mode: "download_folder" });
  const completion = service.preparePackage(share.token, { sourceIp: "192.0.2.1", userAgent: "browser" }).then(value => ({ value }), (error: unknown) => ({ error }));
  try { await expect.poll(() => release !== undefined).toBe(true); await new Promise<void>(resolve => setTimeout(resolve, 200)); requireTestValue(release)(); const result = await completion; expect(result).toHaveProperty("value.state", "ready"); expect(result).toHaveProperty("value.fileCount", 2); }
  finally { release?.(); await completion; }
});
