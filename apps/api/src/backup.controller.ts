import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { Body, Controller, Delete, Get, Head, Headers, Inject, Param, Patch, Post, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { BackupContext, BackupIngestService, BackupServiceCreateInput } from "@saturn/backup-ingest";
import type { SaturnConfig } from "@saturn/config";
import { MASTERMIND_RESOURCE_ID, VOLT_RESOURCE_ID, type DeviceService } from "@saturn/sync";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BackupApiExceptionFilter } from "./backup-api-exception.filter.js";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { APP_CONFIG, BACKUP_INGEST_SERVICE, DEVICE_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";
import { awaitTransferRunnable } from "./transfer-request.js";

const retention = z.object({ daily: z.number().int().min(0).max(366).optional(), weekly: z.number().int().min(0).max(260).optional(), monthly: z.number().int().min(0).max(1200).optional(), yearly: z.number().int().min(0).max(100).optional() }).strict();
const serviceFields = {
  name: z.string().min(1).max(100), requireEncryption: z.boolean().optional(), mtlsCertFingerprint: z.string().regex(/^(?:sha256:)?[a-fA-F0-9]{64}$/).optional(),
  maxBackupBytes: z.number().int().positive().optional(), dailyQuotaBytes: z.number().int().positive().optional(), storedQuotaBytes: z.number().int().positive().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(32).optional(), freshnessSlaMs: z.number().int().min(60_000).optional(), retention: retention.optional(),
};
const storageSlug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const createServiceSchema = z.object({ slug: z.string().min(1).max(63), namespaceSlug: z.string().min(1).max(63).optional(), deploymentId: z.string().min(1).max(63).optional(), ...serviceFields }).strict();
const createEnrollmentSchema = z.object({ namespaceSlug: storageSlug, deploymentId: storageSlug.refine((value) => value !== "default"), mirrorRoot: z.enum(["volt", "mastermind"]).optional(), ...serviceFields }).strict();
const updateServiceSchema = z.object({ ...serviceFields, name: serviceFields.name.optional() }).strict();
const redeemEnrollmentSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{32}$/) }).strict();
const runSchema = z.object({ filename: z.string().min(1).max(255), createdAt: z.iso.datetime({ offset: true }), backupType: z.string().min(1).max(32), expectedSize: z.number().int().positive(), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/), sourceVersion: z.string().min(1).max(200), encrypted: z.boolean() }).strict();
const restoreSchema = z.object({ method: z.literal("isolated_restore"), outcome: z.enum(["success", "failure"]), notes: z.string().max(2000).optional(), artifactSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }).strict();

function nonnegative(value: string | undefined, name: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`); return parsed; }
function bodyStream(request: FastifyRequest): Readable { if (request.body instanceof Readable) return request.body; if (Buffer.isBuffer(request.body)) return Readable.from(request.body); throw new Error("Backup request body is invalid"); }
function enrollmentSlug(namespaceSlug: string, deploymentId: string): string {
  const identity = `${namespaceSlug.trim().toLowerCase()}\0${deploymentId.trim().toLowerCase()}`;
  const prefix = `${namespaceSlug}-${deploymentId}`.toLowerCase().slice(0, 49).replace(/-+$/, "");
  return `${prefix}-${createHash("sha256").update(identity).digest("hex").slice(0, 13)}`;
}

@Controller("backup-services")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class BackupOwnerController {
  constructor(@Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService) {}
  @Post() @RequireRecentReauthentication() create(@Body() body: unknown) { return this.backups.createService(createServiceSchema.parse(body) as BackupServiceCreateInput); }
  @Post("enrollments") @RequireRecentReauthentication() createEnrollment(@Body() body: unknown) { const input = createEnrollmentSchema.parse(body); return this.backups.createEnrollment({ ...input, slug: enrollmentSlug(input.namespaceSlug, input.deploymentId) } as BackupServiceCreateInput); }
  @Get() list(@Query("offset") offset?: string, @Query("limit") limit?: string) { return this.backups.listServices(offset === undefined ? 0 : Number(offset), limit === undefined ? 100 : Number(limit)); }
  @Patch(":id") @RequireRecentReauthentication() update(@Param("id") id: string, @Body() body: unknown) { return this.backups.updateService(id, updateServiceSchema.parse(body) as Partial<Omit<BackupServiceCreateInput, "slug">>); }
  @Post(":id/rotate-token") @RequireRecentReauthentication() rotate(@Param("id") id: string) { return this.backups.rotateToken(id); }
  @Post(":id/enrollment") @RequireRecentReauthentication() enrollment(@Param("id") id: string) { return this.backups.createEnrollmentForService(id); }
  @Delete(":id") @RequireRecentReauthentication() revoke(@Param("id") id: string) { return this.backups.revokeService(id); }
  @Get(":id/runs") runs(@Param("id") id: string, @Query("offset") offset?: string, @Query("limit") limit?: string) { return this.backups.listRunsForOwner(id, offset === undefined ? 0 : Number(offset), limit === undefined ? 100 : Number(limit)); }
  @Get(":id/retention-preview") retentionPreview(@Param("id") id: string) { return this.backups.retentionPreview(id); }
}

@Controller("backup-enrollments")
@UseFilters(BackupApiExceptionFilter)
export class BackupEnrollmentController {
  constructor(
    @Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService,
    @Inject(DEVICE_SERVICE) private readonly devices: DeviceService,
  ) {}
  @Post("redeem") async redeem(@Body() body: unknown) {
    const redeemed = await this.backups.redeemEnrollment(redeemEnrollmentSchema.parse(body).code);
    if (redeemed.mirrorRoot === undefined) return redeemed;
    const device = await this.devices.createDevice({
      name: `Neptune ${redeemed.namespaceSlug}/${redeemed.deploymentId} mirror`,
      scopeIds: [redeemed.mirrorRoot === "volt" ? VOLT_RESOURCE_ID : MASTERMIND_RESOURCE_ID],
      rights: { read: true, write: true, move: true, delete: true },
    });
    try { await this.backups.attachMirrorDevice(redeemed.serviceId, device.device.id); }
    catch (error) { await this.devices.revokeDevice(device.device.id).catch(() => undefined); throw error; }
    return {
      ...redeemed,
      mirrorToken: device.token,
      mirrorMode: redeemed.mirrorRoot === "volt" ? "single-file" : "zip-tree",
      ...(redeemed.mirrorRoot === "volt" ? { mirrorTargetFilename: "personal.volt" } : {}),
    };
  }
}

@Controller("backup-runs")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class BackupRestoreController {
  constructor(@Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService) {}
  @Post(":id/integrity-test") @RequireRecentReauthentication() integrity(@Param("id") id: string) { return this.backups.runIntegrityTest(id); }
  @Post(":id/restore-tests") @RequireRecentReauthentication() restore(@Param("id") id: string, @Body() body: unknown) { return this.backups.recordRestoreTest(id, restoreSchema.parse(body) as { readonly method: "isolated_restore"; readonly outcome: "success" | "failure"; readonly notes?: string; readonly artifactSha256?: string }); }
}

@Controller("backups")
@UseFilters(BackupApiExceptionFilter)
export class BackupCapabilitiesController {
  constructor(@Inject(APP_CONFIG) private readonly config: SaturnConfig) {}
  @Get("capabilities") capabilities() {
    return {
      schema: "saturn.backup-ingest.capabilities.v1",
      protocolVersion: 1,
      resumable: true,
      checksum: "sha256",
      maxChunkBytes: this.config.limits.uploadChunkMaxBytes,
      archiveEncryptionDeclaredPerRun: true,
    };
  }
}

@Controller("backups/:serviceSlug")
@UseFilters(BackupApiExceptionFilter)
export class BackupProducerController {
  constructor(@Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService, @Inject(TransferMonitorService) private readonly transfers: TransferMonitorService) {}
  authenticate(authorization: string | undefined, fingerprint: string | undefined): Promise<BackupContext> { return this.backups.authenticate(authorization, fingerprint); }
  @Post("runs") async create(@Param("serviceSlug") serviceSlug: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    if (idempotencyKey === undefined) throw new Error("Idempotency-Key is invalid"); const input = runSchema.parse(body); const context = await this.authenticate(authorization, fingerprint);
    const created = await this.backups.createRun(context, serviceSlug, { ...input, createdAt: new Date(input.createdAt), idempotencyKey }); reply.header("Location", `/api/v1/backups/${serviceSlug}/runs/${created.id}`); return created;
  }
  @Get("runs/:runId") async status(@Param("serviceSlug") serviceSlug: string, @Param("runId") runId: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined) { return this.backups.inspectRun(await this.authenticate(authorization, fingerprint), serviceSlug, runId); }
  @Post("runs/:runId/complete") async complete(@Param("serviceSlug") serviceSlug: string, @Param("runId") runId: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) { const context = await this.authenticate(authorization, fingerprint); await awaitTransferRunnable(this.transfers, `backup:${runId}`, request, reply); return this.backups.complete(context, serviceSlug, runId); }
  @Head("runs/:runId/upload") async uploadHead(@Param("serviceSlug") serviceSlug: string, @Param("runId") runId: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined, @Res() reply: FastifyReply): Promise<void> { const offset = await this.backups.uploadOffset(await this.authenticate(authorization, fingerprint), serviceSlug, runId); reply.header("Upload-Offset", offset).header("Cache-Control", "no-store").status(204).send(); }
  @Patch("runs/:runId/upload") async append(@Param("serviceSlug") serviceSlug: string, @Param("runId") runId: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined, @Headers("upload-offset") offset: string | undefined, @Headers("content-length") length: string | undefined, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> { const context = await this.authenticate(authorization, fingerprint); await awaitTransferRunnable(this.transfers, `backup:${runId}`, request, reply); const received = await this.backups.append(context, serviceSlug, runId, nonnegative(offset, "Upload-Offset"), nonnegative(length, "Content-Length"), bodyStream(request)); reply.header("Upload-Offset", received).status(204).send(); }
}
