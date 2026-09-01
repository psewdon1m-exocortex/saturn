import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "@saturn/storage";
import { BackupIngestService, BackupServiceError } from "./backup.service.js";
import { retentionCandidates } from "./retention.js";
import type { BackupReceipt, BackupRepository, BackupRestoreTestRecord, BackupRunRecord, BackupServiceRecord, BackupUsage } from "./types.js";

class MemoryRepository implements BackupRepository {
  services = new Map<string, BackupServiceRecord>(); runs = new Map<string, BackupRunRecord>(); restores: BackupRestoreTestRecord[] = [];
  async createService(value: BackupServiceRecord) { if ([...this.services.values()].some((item) => item.slug === value.slug)) throw new Error("exists"); this.services.set(value.id, value); }
  async getService(id: string) { return this.services.get(id); }
  async listServices(offset: number, limit: number) { return [...this.services.values()].slice(offset, offset + limit); }
  async updateService(id: string, input: Parameters<BackupRepository["updateService"]>[1], now: Date) { const current = this.services.get(id); if (!current) throw new Error("not found"); const value = { ...current, ...input, updatedAt: now }; this.services.set(id, value); return value; }
  async rotateToken(id: string, tokenHash: string, previousTokenExpiresAt: Date, now: Date) { const current = this.services.get(id); if (!current) throw new Error("not found"); const value = { ...current, previousTokenHash: current.tokenHash, previousTokenExpiresAt, tokenHash, updatedAt: now }; this.services.set(id, value); return value; }
  async revokeService(id: string, now: Date) { const current = this.services.get(id); if (!current) throw new Error("not found"); const value: BackupServiceRecord = { ...current, state: "revoked", revokedAt: now, updatedAt: now }; this.services.set(id, value); return value; }
  async authenticate(tokenHash: string, now: Date) { const found = [...this.services.values()].find((item) => item.state === "active" && (item.tokenHash === tokenHash || (item.previousTokenHash === tokenHash && (item.previousTokenExpiresAt?.getTime() ?? 0) > now.getTime()))); return found === undefined ? undefined : { service: found, usedPreviousToken: found.tokenHash !== tokenHash }; }
  async reserveRun(input: BackupRunRecord) { const existing = [...this.runs.values()].find((item) => item.serviceId === input.serviceId && item.clientKeyHash === input.clientKeyHash); if (existing) return { run: existing, created: false }; this.runs.set(input.id, input); return { run: input, created: true }; }
  async getRun(serviceId: string, runId: string) { const value = this.runs.get(runId); return value?.serviceId === serviceId ? value : undefined; }
  async getRunForOwner(runId: string) { return this.runs.get(runId); }
  async listRuns(serviceId: string, offset: number, limit: number) { return [...this.runs.values()].filter((item) => item.serviceId === serviceId).slice(offset, offset + limit); }
  async claimAppend(serviceId: string, runId: string, offset: number, length: number, now: Date) { const value = await this.getRun(serviceId, runId); if (!value) throw new Error("not found"); if (value.receivedSize !== offset || offset + length > value.expectedSize) throw new Error("offset mismatch"); const next: BackupRunRecord = { ...value, state: "appending", updatedAt: now }; this.runs.set(runId, next); return next; }
  async finishAppend(serviceId: string, runId: string, receivedSize: number, now: Date) { const value = await this.getRun(serviceId, runId); if (!value) throw new Error("not found"); const next: BackupRunRecord = { ...value, state: "uploading", receivedSize, updatedAt: now }; this.runs.set(runId, next); return next; }
  async releaseAppend(serviceId: string, runId: string, failureCode: string, terminal: boolean, now: Date) { const value = await this.getRun(serviceId, runId); if (value) this.runs.set(runId, { ...value, state: terminal ? "failed" : "uploading", failureCode, updatedAt: now }); }
  async claimComplete(serviceId: string, runId: string, now: Date) { const value = await this.getRun(serviceId, runId); if (!value || value.receivedSize !== value.expectedSize) throw new Error("incomplete"); const next: BackupRunRecord = { ...value, state: "verifying", updatedAt: now }; this.runs.set(runId, next); return next; }
  async completeRun(serviceId: string, runId: string, receipt: BackupReceipt, now: Date) { const value = await this.getRun(serviceId, runId); if (!value) throw new Error("not found"); const next: BackupRunRecord = { ...value, state: "complete", receipt, committedAt: now, updatedAt: now }; this.runs.set(runId, next); return next; }
  async failRun(serviceId: string, runId: string, failureCode: string, now: Date) { const value = await this.getRun(serviceId, runId); if (value) this.runs.set(runId, { ...value, state: "failed", failureCode, updatedAt: now }); }
  async usage(serviceId: string): Promise<BackupUsage> { const values = [...this.runs.values()].filter((item) => item.serviceId === serviceId); return { storedBytes: values.filter((item) => item.state === "complete").reduce((sum, item) => sum + item.expectedSize, 0), activeReservedBytes: 0, dailyReservedBytes: 0, activeRuns: 0, failedRuns: 0 }; }
  async recordRestoreTest(value: BackupRestoreTestRecord) { this.restores.push(value); }
  async latestRestoreTest(serviceId: string) { return this.restores.filter((item) => item.serviceId === serviceId).at(-1); }
}

const options = { enabled: true, trustClientCertificateHeader: true, tokenRotationGraceMs: 1000, uploadChunkMaxBytes: 1024, incompleteTtlMs: 60_000, defaults: { requireEncryption: true, maxBackupBytes: 4096, dailyQuotaBytes: 8192, storedQuotaBytes: 16384, maxConcurrentRuns: 1, freshnessSlaMs: 86_400_000, retention: { daily: 7, weekly: 4, monthly: 12, yearly: 3 } } } as const;
let root: string; let repository: MemoryRepository; let service: BackupIngestService;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-backup-test-")); const storage = new LocalStorageAdapter(root); await storage.initialize(); repository = new MemoryRepository(); service = new BackupIngestService({ repository, storage, pepper: "p".repeat(64), options }); });
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe("BackupIngestService", () => {
  it("discloses a token once, enforces mTLS binding, rotation overlap and revoke", async () => {
    const fingerprint = "a".repeat(64); const created = await service.createService({ slug: "service-a", name: "Service A", mtlsCertFingerprint: fingerprint });
    await expect(service.authenticate(`Bearer ${created.token}`, "b".repeat(64))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(service.authenticate(`Bearer ${created.token}`, fingerprint)).resolves.toMatchObject({ usedPreviousToken: false });
    const rotated = await service.rotateToken(created.service.id); await expect(service.authenticate(`Bearer ${created.token}`, fingerprint)).resolves.toMatchObject({ usedPreviousToken: true });
    await service.revokeService(created.service.id); await expect(service.authenticate(`Bearer ${rotated.token}`, fingerprint)).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("streams an exact resumable backup, rejects wrong offset and commits a receipt", async () => {
    const payload = Buffer.from("encrypted-backup-fixture"); const digest = createHash("sha256").update(payload).digest("hex"); const created = await service.createService({ slug: "service-a", name: "Service A" }); const context = await service.authenticate(`Bearer ${created.token}`);
    const run = await service.createRun(context, "service-a", { filename: "backup.age", createdAt: new Date("2026-08-26T01:00:00Z"), backupType: "full", expectedSize: payload.length, sha256: digest, sourceVersion: "1.0.0", encrypted: true, idempotencyKey: "backup-test-one" });
    await service.append(context, "service-a", run.id, 0, 8, Readable.from(payload.subarray(0, 8)));
    await expect(service.append(context, "service-a", run.id, 0, 1, Readable.from("x"))).rejects.toBeInstanceOf(BackupServiceError);
    await service.append(context, "service-a", run.id, 8, payload.length - 8, Readable.from(payload.subarray(8))); const completed = await service.complete(context, "service-a", run.id);
    expect(completed).toMatchObject({ state: "complete", receipt: { sha256: digest, sizeBytes: payload.length, serviceSlug: "service-a" } });
  });
  it("does not authorize a token or run under a neighboring service slug", async () => {
    const a = await service.createService({ slug: "service-a", name: "A" }); const b = await service.createService({ slug: "service-b", name: "B" }); const contextA = await service.authenticate(`Bearer ${a.token}`); const contextB = await service.authenticate(`Bearer ${b.token}`);
    await expect(service.createRun(contextA, "service-b", { filename: "x.age", createdAt: new Date(), backupType: "full", expectedSize: 1, sha256: "a".repeat(64), sourceVersion: "1", encrypted: true, idempotencyKey: "isolation-key" })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.inspectRun(contextB, "service-b", crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
  it("selects deterministic GFS retention candidates", () => {
    const base = Array.from({ length: 12 }, (_, index) => ({ id: String(index), state: "complete", committedAt: new Date(Date.UTC(2026, 7, 26 - index)) } as BackupRunRecord));
    const candidates = retentionCandidates(base, { daily: 2, weekly: 1, monthly: 1, yearly: 1 }); expect(candidates.length).toBeGreaterThan(0); expect(candidates.map((item) => item.id)).not.toContain("0");
  });
});
