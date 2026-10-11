/* eslint-disable @typescript-eslint/require-await -- In-memory test repository keeps the asynchronous production interface. */
import type { BackupEnrollmentRecord, BackupReceipt, BackupRepository, BackupRestoreTestRecord, BackupRunRecord, BackupServiceRecord, BackupUsage } from "../types.js";

export class MemoryRepository implements BackupRepository {
  services = new Map<string, BackupServiceRecord>(); runs = new Map<string, BackupRunRecord>(); restores: BackupRestoreTestRecord[] = []; enrollments = new Map<string, BackupEnrollmentRecord>();
  async createService(value: BackupServiceRecord) { if ([...this.services.values()].some((item) => item.slug === value.slug)) throw new Error("exists"); this.services.set(value.id, value); }
  async getService(id: string) { return this.services.get(id); }
  async getActiveServiceByDeployment(namespaceSlug: string, deploymentId: string) { return [...this.services.values()].find((item) => item.namespaceSlug === namespaceSlug && item.deploymentId === deploymentId && item.state === "active"); }
  async listServices(offset: number, limit: number) { return [...this.services.values()].slice(offset, offset + limit); }
  async updateService(id: string, input: Parameters<BackupRepository["updateService"]>[1], now: Date) { const current = this.services.get(id); if (!current) throw new Error("not found"); const value = { ...current, ...input, updatedAt: now }; this.services.set(id, value); return value; }
  async rotateToken(id: string, tokenHash: string, previousTokenExpiresAt: Date, now: Date) { const current = this.services.get(id); if (!current) throw new Error("not found"); const value = { ...current, previousTokenHash: current.tokenHash, previousTokenExpiresAt, tokenHash, updatedAt: now }; this.services.set(id, value); return value; }
  async revokeService(id: string, now: Date) { const current = this.services.get(id); if (!current) throw new Error("not found"); const value: BackupServiceRecord = { ...current, state: "revoked", revokedAt: now, updatedAt: now }; this.services.set(id, value); return value; }
  async authenticate(tokenHash: string, now: Date) { const found = [...this.services.values()].find((item) => item.state === "active" && (item.tokenHash === tokenHash || (item.previousTokenHash === tokenHash && (item.previousTokenExpiresAt?.getTime() ?? 0) > now.getTime()))); return found === undefined ? undefined : { service: found, usedPreviousToken: found.tokenHash !== tokenHash }; }
  async reserveRun(input: BackupRunRecord) { const existing = [...this.runs.values()].find((item) => item.serviceId === input.serviceId && item.clientKeyHash === input.clientKeyHash); if (existing) return { run: existing, created: false }; this.runs.set(input.id, input); return { run: input, created: true }; }
  async getRun(serviceId: string, runId: string) { const value = this.runs.get(runId); return value?.serviceId === serviceId ? value : undefined; }
  async getRunForOwner(runId: string) { return this.runs.get(runId); }
  async listRuns(serviceId: string, offset: number, limit: number) { return [...this.runs.values()].filter((item) => item.serviceId === serviceId).slice(offset, offset + limit); }
  async listIncompleteRuns(before: Date, afterId: string | undefined, limit: number) { return [...this.runs.values()].filter(item => ["pending", "uploading", "appending", "verifying"].includes(item.state) && item.updatedAt <= before && (afterId === undefined || item.id > afterId)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit); }
  async touchRun(serviceId: string, runId: string, now: Date) { const value = await this.getRun(serviceId, runId); if (value && ["pending", "uploading"].includes(value.state)) this.runs.set(runId, { ...value, updatedAt: now }); }
  async claimAppend(serviceId: string, runId: string, offset: number, length: number, now: Date) { const value = await this.getRun(serviceId, runId); if (!value) throw new Error("not found"); if (!["pending", "uploading"].includes(value.state)) throw new Error("not writable"); if (value.receivedSize !== offset || offset + length > value.expectedSize) throw new Error("offset mismatch"); const next: BackupRunRecord = { ...value, state: "appending", updatedAt: now }; this.runs.set(runId, next); return next; }
  async finishAppend(serviceId: string, runId: string, receivedSize: number, now: Date) { const value = await this.getRun(serviceId, runId); if (!value) throw new Error("not found"); const next: BackupRunRecord = { ...value, state: "uploading", receivedSize, updatedAt: now }; this.runs.set(runId, next); return next; }
  async releaseAppend(serviceId: string, runId: string, failureCode: string, terminal: boolean, now: Date) { const value = await this.getRun(serviceId, runId); if (value) this.runs.set(runId, { ...value, state: terminal ? "failed" : "uploading", failureCode, updatedAt: now }); }
  async claimComplete(serviceId: string, runId: string, now: Date) { const value = await this.getRun(serviceId, runId); if (value?.state === "complete") return value; if (!value || !["pending", "uploading", "verifying"].includes(value.state) || value.receivedSize !== value.expectedSize) throw new Error("incomplete"); const next: BackupRunRecord = { ...value, state: "verifying", updatedAt: now }; this.runs.set(runId, next); return next; }
  async completeRun(serviceId: string, runId: string, receipt: BackupReceipt, now: Date) { const value = await this.getRun(serviceId, runId); if (!value) throw new Error("not found"); const next: BackupRunRecord = { ...value, state: "complete", receipt, committedAt: now, updatedAt: now }; this.runs.set(runId, next); return next; }
  async failRun(serviceId: string, runId: string, failureCode: string, now: Date) { const value = await this.getRun(serviceId, runId); if (value) this.runs.set(runId, { ...value, state: "failed", failureCode, updatedAt: now }); }
  async usage(serviceId: string, since = new Date(0)): Promise<BackupUsage> {
    const values = [...this.runs.values()].filter(item => item.serviceId === serviceId);
    const active = values.filter(item => ["pending", "uploading", "appending", "verifying"].includes(item.state));
    const completed = values.filter(item => item.state === "complete");
    const lastCompletedAt = completed.map(item => item.committedAt).filter((value): value is Date => value !== undefined).sort((a, b) => b.getTime() - a.getTime())[0];
    return { storedBytes: completed.reduce((sum, item) => sum + item.expectedSize, 0),
      activeReservedBytes: active.reduce((sum, item) => sum + item.expectedSize, 0), activeRuns: active.length,
      dailyReservedBytes: values.filter(item => item.state !== "failed" && item.createdAt >= since).reduce((sum, item) => sum + item.expectedSize, 0),
      failedRuns: values.filter(item => item.state === "failed").length, ...(lastCompletedAt === undefined ? {} : { lastCompletedAt }) };
  }
  async recordRestoreTest(value: BackupRestoreTestRecord) { this.restores.push(value); }
  async latestRestoreTest(serviceId: string) { return this.restores.filter((item) => item.serviceId === serviceId).at(-1); }
  async createEnrollment(value: BackupEnrollmentRecord) { for (const [key, current] of this.enrollments) if (current.serviceId === value.serviceId && current.consumedAt === undefined) this.enrollments.set(key, { ...current, consumedAt: value.createdAt }); this.enrollments.set(value.codeHash, value); }
  async consumeEnrollment(codeHash: string, now: Date) { const value = this.enrollments.get(codeHash); if (value === undefined || value.consumedAt !== undefined || value.expiresAt <= now) return undefined; this.enrollments.set(codeHash, { ...value, consumedAt: now }); return this.services.get(value.serviceId); }
  async attachMirrorDevice(serviceId: string, deviceId: string, now: Date) { const current = this.services.get(serviceId); if (!current) throw new Error("not found"); const value = { ...current, mirrorDeviceId: deviceId, updatedAt: now }; this.services.set(serviceId, value); return value; }
  async purgeRun(serviceId: string, runId: string) { const current = await this.getRun(serviceId, runId); if (!current || current.state !== "complete") throw new Error("not found"); this.runs.delete(runId); }
}
