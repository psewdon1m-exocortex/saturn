import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import type { AuditSink } from "@saturn/audit";
import { joinStoragePath, normalizeStorageName } from "@saturn/storage";
import { v7 as uuidv7 } from "uuid";
import { retentionCandidates } from "./retention.js";
import type {
  BackupContext,
  BackupOptions,
  BackupReceipt,
  BackupRepository,
  BackupRestoreTestRecord,
  BackupRunCreateInput,
  BackupRunRecord,
  BackupServiceCreateInput,
  BackupServiceRecord,
  BackupStorage,
  PublicBackupService,
} from "./types.js";

export class BackupServiceError extends Error {
  constructor(readonly code: "disabled" | "unauthorized" | "not_found" | "invalid" | "quota" | "conflict") {
    super(code === "quota" ? "Backup quota is exhausted" : code === "conflict" ? "Backup operation conflicts with current state" : "Backup request was not accepted");
  }
}

function equal(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest(); const b = createHash("sha256").update(right).digest(); return timingSafeEqual(a, b);
}
function validatePage(offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new BackupServiceError("invalid");
}
function startOfUtcDay(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())); }
function publicRun(value: BackupRunRecord) {
  return {
    id: value.id, serviceId: value.serviceId, filename: value.filename, createdAt: value.sourceCreatedAt, backupType: value.backupType,
    expectedSize: value.expectedSize, sha256: value.expectedSha256, sourceVersion: value.sourceVersion, encrypted: value.encrypted,
    state: value.state, receivedSize: value.receivedSize, ...(value.receipt === undefined ? {} : { receipt: value.receipt }),
    ...(value.failureCode === undefined ? {} : { failureCode: value.failureCode }), updatedAt: value.updatedAt,
  };
}

export class BackupIngestService {
  readonly pepper: Buffer;
  constructor(private readonly input: { readonly repository: BackupRepository; readonly storage: BackupStorage; readonly pepper: string; readonly options: BackupOptions; readonly audit?: AuditSink }) {
    if (input.pepper.length < 32 || /[\r\n]/.test(input.pepper)) throw new Error("Backup pepper is invalid"); this.pepper = Buffer.from(input.pepper, "utf8");
  }
  hmac(label: string, value: string): string { return createHmac("sha256", this.pepper).update(label).update("\0").update(value).digest("hex"); }
  token(): string { return randomBytes(32).toString("base64url"); }

  async createService(value: BackupServiceCreateInput, now = new Date()): Promise<{ readonly service: PublicBackupService; readonly token: string }> {
    const slug = value.slug.trim().toLowerCase(); const name = value.name.trim();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) || name.length < 1 || name.length > 100 || /[\r\n]/.test(name)) throw new BackupServiceError("invalid");
    const defaults = this.input.options.defaults; const retention = { ...defaults.retention, ...value.retention };
    const record: BackupServiceRecord = {
      id: uuidv7(), slug, name, tokenHash: "", state: "active", requireEncryption: value.requireEncryption ?? defaults.requireEncryption,
      ...(value.mtlsCertFingerprint === undefined ? {} : { mtlsCertFingerprint: this.fingerprint(value.mtlsCertFingerprint) }),
      maxBackupBytes: value.maxBackupBytes ?? defaults.maxBackupBytes, dailyQuotaBytes: value.dailyQuotaBytes ?? defaults.dailyQuotaBytes,
      storedQuotaBytes: value.storedQuotaBytes ?? defaults.storedQuotaBytes, maxConcurrentRuns: value.maxConcurrentRuns ?? defaults.maxConcurrentRuns,
      freshnessSlaMs: value.freshnessSlaMs ?? defaults.freshnessSlaMs, retention, createdAt: now, updatedAt: now,
    };
    this.validatePolicy(record); const token = this.token(); const withHash = { ...record, tokenHash: this.hmac("backup-service-token", token) };
    await this.input.repository.createService(withHash); await this.audit("backup.service.created", record.id, { slug });
    return { service: await this.publicService(withHash, now), token };
  }

  async listServices(offset = 0, limit = 100, now = new Date()): Promise<readonly PublicBackupService[]> {
    validatePage(offset, limit); return Promise.all((await this.input.repository.listServices(offset, limit)).map((item) => this.publicService(item, now)));
  }
  async updateService(id: string, value: Partial<Omit<BackupServiceCreateInput, "slug">>, now = new Date()): Promise<PublicBackupService> {
    const current = await this.requiredService(id); const retention = value.retention === undefined ? current.retention : { ...current.retention, ...value.retention };
    const candidate: BackupServiceRecord = { ...current,
      ...(value.name === undefined ? {} : { name: value.name.trim() }), ...(value.requireEncryption === undefined ? {} : { requireEncryption: value.requireEncryption }),
      ...(value.mtlsCertFingerprint === undefined ? {} : { mtlsCertFingerprint: this.fingerprint(value.mtlsCertFingerprint) }),
      ...(value.maxBackupBytes === undefined ? {} : { maxBackupBytes: value.maxBackupBytes }), ...(value.dailyQuotaBytes === undefined ? {} : { dailyQuotaBytes: value.dailyQuotaBytes }),
      ...(value.storedQuotaBytes === undefined ? {} : { storedQuotaBytes: value.storedQuotaBytes }), ...(value.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: value.maxConcurrentRuns }),
      ...(value.freshnessSlaMs === undefined ? {} : { freshnessSlaMs: value.freshnessSlaMs }), retention, updatedAt: now };
    this.validatePolicy(candidate); const updated = await this.input.repository.updateService(id, {
      name: candidate.name, requireEncryption: candidate.requireEncryption, ...(candidate.mtlsCertFingerprint === undefined ? {} : { mtlsCertFingerprint: candidate.mtlsCertFingerprint }),
      maxBackupBytes: candidate.maxBackupBytes, dailyQuotaBytes: candidate.dailyQuotaBytes, storedQuotaBytes: candidate.storedQuotaBytes,
      maxConcurrentRuns: candidate.maxConcurrentRuns, freshnessSlaMs: candidate.freshnessSlaMs, retention: candidate.retention,
    }, now); await this.audit("backup.service.updated", id, {}); return this.publicService(updated, now);
  }
  async rotateToken(id: string, now = new Date()): Promise<{ readonly service: PublicBackupService; readonly token: string }> {
    const token = this.token(); const updated = await this.input.repository.rotateToken(id, this.hmac("backup-service-token", token), new Date(now.getTime() + this.input.options.tokenRotationGraceMs), now);
    await this.audit("backup.service.token.rotated", id, { overlapMs: this.input.options.tokenRotationGraceMs }); return { service: await this.publicService(updated, now), token };
  }
  async revokeService(id: string, now = new Date()): Promise<PublicBackupService> { const updated = await this.input.repository.revokeService(id, now); await this.audit("backup.service.revoked", id, {}); return this.publicService(updated, now); }

  async authenticate(authorization: string | undefined, presentedCertificateFingerprint?: string, now = new Date()): Promise<BackupContext> {
    if (!this.input.options.enabled) throw new BackupServiceError("disabled");
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? ""); if (match?.[1] === undefined) throw new BackupServiceError("unauthorized");
    const authenticated = await this.input.repository.authenticate(this.hmac("backup-service-token", match[1]), now); if (authenticated === undefined) throw new BackupServiceError("unauthorized");
    const expected = authenticated.service.mtlsCertFingerprint;
    if (expected !== undefined && (!this.input.options.trustClientCertificateHeader || presentedCertificateFingerprint === undefined || !equal(expected, this.fingerprint(presentedCertificateFingerprint)))) throw new BackupServiceError("unauthorized");
    return authenticated;
  }
  assertSlug(context: BackupContext, slug: string): void { if (context.service.slug !== slug) throw new BackupServiceError("not_found"); }

  async createRun(context: BackupContext, slug: string, value: BackupRunCreateInput, now = new Date()) {
    this.assertSlug(context, slug); const filename = normalizeStorageName(value.filename); const sha256 = value.sha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256) || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.backupType) || !/^[A-Za-z0-9._:-]{8,128}$/.test(value.idempotencyKey)
      || value.sourceVersion.length < 1 || value.sourceVersion.length > 200 || /[\r\n]/.test(value.sourceVersion) || !Number.isSafeInteger(value.expectedSize) || value.expectedSize < 1 || value.expectedSize > context.service.maxBackupBytes
      || !Number.isFinite(value.createdAt.getTime()) || value.createdAt.getTime() > now.getTime() + 86_400_000 || value.createdAt.getUTCFullYear() < 2000 || (context.service.requireEncryption && !value.encrypted)) throw new BackupServiceError("invalid");
    const id = uuidv7(); const date = value.createdAt.toISOString(); const parts = date.slice(0, 10).split("-"); const stamp = date.replace(/[:.]/g, "-");
    const run: BackupRunRecord = { id, serviceId: context.service.id, clientKeyHash: this.hmac("backup-run-idempotency", value.idempotencyKey), filename,
      sourceCreatedAt: value.createdAt, backupType: value.backupType, expectedSize: value.expectedSize, expectedSha256: sha256, sourceVersion: value.sourceVersion,
      encrypted: value.encrypted, state: "pending", receivedSize: 0, tempPath: joinStoragePath("_system", "incoming", "backups", context.service.id, `${id}.part`),
      finalPath: joinStoragePath("backups", context.service.slug, ...(parts as [string, string, string]), `${stamp}_${value.backupType}_${id}_${filename}`), createdAt: now, updatedAt: now };
    try { const result = await this.input.repository.reserveRun(run, now); if (!result.created && (result.run.expectedSize !== run.expectedSize || result.run.expectedSha256 !== run.expectedSha256 || result.run.filename !== run.filename)) throw new BackupServiceError("conflict"); await this.audit("backup.run.created", result.run.id, { serviceId: context.service.id, created: result.created, expectedSize: result.run.expectedSize }, context.service.id); return publicRun(result.run); }
    catch (error) { if (error instanceof Error && /quota/i.test(error.message)) throw new BackupServiceError("quota"); throw error; }
  }
  async inspectRun(context: BackupContext, slug: string, runId: string) { this.assertSlug(context, slug); return publicRun(await this.requiredRun(context.service.id, runId)); }
  async uploadOffset(context: BackupContext, slug: string, runId: string): Promise<number> { this.assertSlug(context, slug); return (await this.requiredRun(context.service.id, runId)).receivedSize; }
  async append(context: BackupContext, slug: string, runId: string, offset: number, length: number, source: Readable, now = new Date()): Promise<number> {
    this.assertSlug(context, slug); if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > this.input.options.uploadChunkMaxBytes) throw new BackupServiceError("invalid");
    let claimed: BackupRunRecord; try { claimed = await this.input.repository.claimAppend(context.service.id, runId, offset, length, now); } catch (error) { if (error instanceof Error && /offset|writable/i.test(error.message)) throw new BackupServiceError("conflict"); throw error; }
    try {
      await this.ensureParents(claimed.tempPath); const written = await this.input.storage.write(claimed.tempPath, source, { offset, create: offset === 0, exclusive: offset === 0, truncate: offset === 0 });
      if (written !== length) throw new Error("Backup chunk length differs from Content-Length"); const updated = await this.input.repository.finishAppend(context.service.id, runId, offset + written, new Date());
      await this.audit("backup.run.appended", runId, { serviceId: context.service.id, offset, length }, context.service.id); return updated.receivedSize;
    } catch (error) {
      if (offset === 0) await this.input.storage.delete(claimed.tempPath).catch(() => undefined); else await this.input.storage.truncate(claimed.tempPath, offset).catch(() => undefined);
      await this.input.repository.releaseAppend(context.service.id, runId, "append_failed", false, new Date()).catch(() => undefined); throw error;
    }
  }
  async complete(context: BackupContext, slug: string, runId: string, now = new Date()) {
    this.assertSlug(context, slug); let selected: BackupRunRecord;
    try { selected = await this.input.repository.claimComplete(context.service.id, runId, now); } catch (error) { if (error instanceof Error && /incomplete/i.test(error.message)) throw new BackupServiceError("conflict"); throw error; }
    if (selected.state === "complete") return publicRun(selected);
    try {
      const sourcePath = await this.input.storage.exists(selected.tempPath) ? selected.tempPath : selected.finalPath;
      if (!(await this.input.storage.exists(sourcePath))) throw new Error("Backup upload is missing"); const digest = await this.digest(sourcePath);
      if (digest.bytes !== selected.expectedSize || digest.sha256 !== selected.expectedSha256) { await this.input.storage.delete(sourcePath).catch(() => undefined); await this.input.repository.failRun(context.service.id, runId, "checksum_mismatch", new Date()); throw new Error("Backup checksum or size differs"); }
      if (sourcePath === selected.tempPath) { await this.ensureParents(selected.finalPath); if (await this.input.storage.exists(selected.finalPath)) throw new Error("Backup final object already exists"); await this.input.storage.rename(selected.tempPath, selected.finalPath); }
      const committedAt = new Date(); const receipt: BackupReceipt = { schema: "vault.service-backup-receipt.v1", runId, serviceId: context.service.id, serviceSlug: context.service.slug, logicalPath: `/${selected.finalPath}`, sizeBytes: digest.bytes, sha256: digest.sha256, committedAt: committedAt.toISOString() };
      const completed = await this.input.repository.completeRun(context.service.id, runId, receipt, committedAt); await this.audit("backup.run.completed", runId, { serviceId: context.service.id, sizeBytes: digest.bytes, sha256: digest.sha256 }, context.service.id); return publicRun(completed);
    } catch (error) { if (error instanceof BackupServiceError) throw error; if (error instanceof Error && /checksum|size differs/i.test(error.message)) throw new BackupServiceError("invalid"); await this.input.repository.failRun(context.service.id, runId, "completion_failed", new Date()).catch(() => undefined); throw error; }
  }

  async listRunsForOwner(serviceId: string, offset = 0, limit = 100) { validatePage(offset, limit); await this.requiredService(serviceId); return (await this.input.repository.listRuns(serviceId, offset, limit)).map(publicRun); }
  async retentionPreview(serviceId: string, limit = 500) { const selected = await this.requiredService(serviceId); const runs = await this.input.repository.listRuns(serviceId, 0, Math.min(500, limit)); return retentionCandidates(runs, selected.retention).map((item) => item.id); }
  async recordRestoreTest(runId: string, value: { readonly method: BackupRestoreTestRecord["method"]; readonly outcome: BackupRestoreTestRecord["outcome"]; readonly notes?: string; readonly artifactSha256?: string }, now = new Date()): Promise<BackupRestoreTestRecord> {
    const run = await this.input.repository.getRunForOwner(runId); if (run === undefined || run.state !== "complete") throw new BackupServiceError("not_found");
    if (value.notes !== undefined && (value.notes.length > 2000 || /\0/.test(value.notes))) throw new BackupServiceError("invalid"); const artifact = value.artifactSha256?.toLowerCase(); if (artifact !== undefined && !/^[a-f0-9]{64}$/.test(artifact)) throw new BackupServiceError("invalid");
    const record: BackupRestoreTestRecord = { id: uuidv7(), serviceId: run.serviceId, runId, method: value.method, outcome: value.outcome, ...(value.notes === undefined ? {} : { notes: value.notes }), ...(artifact === undefined ? {} : { artifactSha256: artifact }), startedAt: now, completedAt: now };
    await this.input.repository.recordRestoreTest(record); await this.audit("backup.restore_test.recorded", record.id, { serviceId: run.serviceId, runId, method: value.method, outcome: value.outcome }); return record;
  }
  async runIntegrityTest(runId: string, now = new Date()): Promise<BackupRestoreTestRecord> {
    const run = await this.input.repository.getRunForOwner(runId); if (run === undefined || run.state !== "complete") throw new BackupServiceError("not_found"); let outcome: "success" | "failure" = "failure"; let digest: string | undefined;
    try { const value = await this.digest(run.finalPath); digest = value.sha256; outcome = value.bytes === run.expectedSize && value.sha256 === run.expectedSha256 ? "success" : "failure"; } catch { outcome = "failure"; }
    return this.recordRestoreTest(runId, { method: "integrity_check", outcome, ...(digest === undefined ? {} : { artifactSha256: digest }) }, now);
  }

  async requiredService(id: string): Promise<BackupServiceRecord> { const value = await this.input.repository.getService(id); if (value === undefined) throw new BackupServiceError("not_found"); return value; }
  async requiredRun(serviceId: string, id: string): Promise<BackupRunRecord> { const value = await this.input.repository.getRun(serviceId, id); if (value === undefined) throw new BackupServiceError("not_found"); return value; }
  async publicService(value: BackupServiceRecord, now: Date): Promise<PublicBackupService> { const [usage, lastRestoreTest] = await Promise.all([this.input.repository.usage(value.id, startOfUtcDay(now)), this.input.repository.latestRestoreTest(value.id)]); const fresh = usage.lastCompletedAt !== undefined && now.getTime() - usage.lastCompletedAt.getTime() <= value.freshnessSlaMs; const { tokenHash, previousTokenHash, ...safe } = value; void tokenHash; void previousTokenHash; return { ...safe, usage, ...(lastRestoreTest === undefined ? {} : { lastRestoreTest }), fresh }; }
  validatePolicy(value: BackupServiceRecord): void { if (value.name.length < 1 || value.name.length > 100 || !Number.isSafeInteger(value.maxBackupBytes) || value.maxBackupBytes < 1 || value.maxBackupBytes > this.input.options.defaults.maxBackupBytes || !Number.isSafeInteger(value.dailyQuotaBytes) || value.dailyQuotaBytes < value.maxBackupBytes || !Number.isSafeInteger(value.storedQuotaBytes) || value.storedQuotaBytes < value.maxBackupBytes || !Number.isSafeInteger(value.maxConcurrentRuns) || value.maxConcurrentRuns < 1 || value.maxConcurrentRuns > 32 || !Number.isSafeInteger(value.freshnessSlaMs) || value.freshnessSlaMs < 60_000 || Object.values(value.retention).some((item) => !Number.isSafeInteger(item) || item < 0)) throw new BackupServiceError("invalid"); }
  fingerprint(value: string): string { const normalized = value.trim().toLowerCase().replace(/^sha256:/, ""); if (!/^[a-f0-9]{64}$/.test(normalized)) throw new BackupServiceError("invalid"); return normalized; }
  async ensureParents(filePath: string): Promise<void> { const parts = filePath.split("/").slice(0, -1); let current = ""; for (const part of parts) { current = joinStoragePath(current, part); if (!(await this.input.storage.exists(current))) await this.input.storage.mkdir(current); } }
  async digest(path: string): Promise<{ readonly bytes: number; readonly sha256: string }> { const hash = createHash("sha256"); let bytes = 0; for await (const raw of await this.input.storage.openRead(path)) { const chunk = Buffer.from(raw as Uint8Array); bytes += chunk.length; hash.update(chunk); } return { bytes, sha256: hash.digest("hex") }; }
  async audit(action: string, subjectId: string, details: Readonly<Record<string, unknown>>, actorId = "owner"): Promise<void> { await this.input.audit?.write({ actorType: actorId === "owner" ? "owner_session" : "service_token", actorId, action, outcome: "success", correlationId: `${action}:${uuidv7()}`, details: { subjectId, ...details } }); }
}
