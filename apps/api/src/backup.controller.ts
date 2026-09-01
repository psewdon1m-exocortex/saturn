import { Readable } from "node:stream";
import { Body, Controller, Delete, Get, Head, Headers, Inject, Param, Patch, Post, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { BackupContext, BackupIngestService, BackupServiceCreateInput } from "@saturn/backup-ingest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BackupApiExceptionFilter } from "./backup-api-exception.filter.js";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { BACKUP_INGEST_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const retention = z.object({ daily: z.number().int().min(0).max(366).optional(), weekly: z.number().int().min(0).max(260).optional(), monthly: z.number().int().min(0).max(1200).optional(), yearly: z.number().int().min(0).max(100).optional() }).strict();
const serviceFields = {
  name: z.string().min(1).max(100), requireEncryption: z.boolean().optional(), mtlsCertFingerprint: z.string().regex(/^(?:sha256:)?[a-fA-F0-9]{64}$/).optional(),
  maxBackupBytes: z.number().int().positive().optional(), dailyQuotaBytes: z.number().int().positive().optional(), storedQuotaBytes: z.number().int().positive().optional(),
  maxConcurrentRuns: z.number().int().min(1).max(32).optional(), freshnessSlaMs: z.number().int().min(60_000).optional(), retention: retention.optional(),
};
const createServiceSchema = z.object({ slug: z.string().min(1).max(63), ...serviceFields }).strict();
const updateServiceSchema = z.object({ ...serviceFields, name: serviceFields.name.optional() }).strict();
const runSchema = z.object({ filename: z.string().min(1).max(255), createdAt: z.iso.datetime({ offset: true }), backupType: z.string().min(1).max(32), expectedSize: z.number().int().positive(), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/), sourceVersion: z.string().min(1).max(200), encrypted: z.boolean() }).strict();
const restoreSchema = z.object({ method: z.literal("isolated_restore"), outcome: z.enum(["success", "failure"]), notes: z.string().max(2000).optional(), artifactSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }).strict();

function nonnegative(value: string | undefined, name: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`); return parsed; }
function bodyStream(request: FastifyRequest): Readable { if (request.body instanceof Readable) return request.body; if (Buffer.isBuffer(request.body)) return Readable.from(request.body); throw new Error("Backup request body is invalid"); }

@Controller("backup-services")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class BackupOwnerController {
  constructor(@Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService) {}
  @Post() @RequireRecentReauthentication() create(@Body() body: unknown) { return this.backups.createService(createServiceSchema.parse(body) as BackupServiceCreateInput); }
  @Get() list(@Query("offset") offset?: string, @Query("limit") limit?: string) { return this.backups.listServices(offset === undefined ? 0 : Number(offset), limit === undefined ? 100 : Number(limit)); }
  @Patch(":id") @RequireRecentReauthentication() update(@Param("id") id: string, @Body() body: unknown) { return this.backups.updateService(id, updateServiceSchema.parse(body) as Partial<Omit<BackupServiceCreateInput, "slug">>); }
  @Post(":id/rotate-token") @RequireRecentReauthentication() rotate(@Param("id") id: string) { return this.backups.rotateToken(id); }
  @Delete(":id") @RequireRecentReauthentication() revoke(@Param("id") id: string) { return this.backups.revokeService(id); }
  @Get(":id/runs") runs(@Param("id") id: string, @Query("offset") offset?: string, @Query("limit") limit?: string) { return this.backups.listRunsForOwner(id, offset === undefined ? 0 : Number(offset), limit === undefined ? 100 : Number(limit)); }
  @Get(":id/retention-preview") retentionPreview(@Param("id") id: string) { return this.backups.retentionPreview(id); }
}

@Controller("backup-runs")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class BackupRestoreController {
  constructor(@Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService) {}
  @Post(":id/integrity-test") @RequireRecentReauthentication() integrity(@Param("id") id: string) { return this.backups.runIntegrityTest(id); }
  @Post(":id/restore-tests") @RequireRecentReauthentication() restore(@Param("id") id: string, @Body() body: unknown) { return this.backups.recordRestoreTest(id, restoreSchema.parse(body) as { readonly method: "isolated_restore"; readonly outcome: "success" | "failure"; readonly notes?: string; readonly artifactSha256?: string }); }
}

@Controller("backups/:serviceId")
@UseFilters(BackupApiExceptionFilter)
export class BackupProducerController {
  constructor(@Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService) {}
  authenticate(authorization: string | undefined, fingerprint: string | undefined): Promise<BackupContext> { return this.backups.authenticate(authorization, fingerprint); }
  @Post("runs") async create(@Param("serviceId") serviceId: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined, @Headers("idempotency-key") idempotencyKey: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    if (idempotencyKey === undefined) throw new Error("Idempotency-Key is invalid"); const input = runSchema.parse(body); const context = await this.authenticate(authorization, fingerprint);
    const created = await this.backups.createRun(context, serviceId, { ...input, createdAt: new Date(input.createdAt), idempotencyKey }); reply.header("Location", `/api/v1/backups/${serviceId}/runs/${created.id}`); return created;
  }
  @Get("runs/:runId") async status(@Param("serviceId") serviceId: string, @Param("runId") runId: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined) { return this.backups.inspectRun(await this.authenticate(authorization, fingerprint), serviceId, runId); }
  @Post("runs/:runId/complete") async complete(@Param("serviceId") serviceId: string, @Param("runId") runId: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined) { return this.backups.complete(await this.authenticate(authorization, fingerprint), serviceId, runId); }
  @Head("runs/:runId/upload") async uploadHead(@Param("serviceId") serviceId: string, @Param("runId") runId: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined, @Res() reply: FastifyReply): Promise<void> { const offset = await this.backups.uploadOffset(await this.authenticate(authorization, fingerprint), serviceId, runId); reply.header("Upload-Offset", offset).header("Cache-Control", "no-store").status(204).send(); }
  @Patch("runs/:runId/upload") async append(@Param("serviceId") serviceId: string, @Param("runId") runId: string, @Headers("authorization") authorization: string | undefined, @Headers("x-vault-client-cert-sha256") fingerprint: string | undefined, @Headers("upload-offset") offset: string | undefined, @Headers("content-length") length: string | undefined, @Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> { const received = await this.backups.append(await this.authenticate(authorization, fingerprint), serviceId, runId, nonnegative(offset, "Upload-Offset"), nonnegative(length, "Content-Length"), bodyStream(request)); reply.header("Upload-Offset", received).status(204).send(); }
}
