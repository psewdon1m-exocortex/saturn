import { Body, Controller, Get, Inject, Param, Post, Query, UseFilters, UseGuards } from "@nestjs/common";
import type { PurgeService, ReconciliationService } from "@saturn/protection";
import { z } from "zod";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { PURGE_SERVICE, RECONCILIATION_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const runSchema = z.object({ mode: z.enum(["metadata", "full_hash"]).default("metadata") }).strict();

@Controller("diagnostics/reconciliation")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class ProtectionController {
  constructor(
    @Inject(RECONCILIATION_SERVICE) private readonly reconciliation: ReconciliationService,
    @Inject(PURGE_SERVICE) private readonly purge: PurgeService,
  ) {}

  @Post()
  run(@Body() body: unknown) {
    return this.reconciliation.run(runSchema.parse(body).mode);
  }

  @Get()
  listRuns(@Query("limit") rawLimit?: string) {
    return this.reconciliation.listRuns(rawLimit === undefined ? 20 : Number(rawLimit));
  }

  @Get(":runId/issues")
  listIssues(@Param("runId") runId: string, @Query("limit") rawLimit?: string) {
    return this.reconciliation.listIssues(runId, rawLimit === undefined ? 500 : Number(rawLimit));
  }

  @Post("purge")
  @RequireRecentReauthentication()
  runPurge(@Body() body: unknown) {
    const parsed = z.object({ limit: z.number().int().min(1).max(1_000).default(100) }).strict().parse(body);
    return this.purge.run(new Date(), parsed.limit);
  }
}
