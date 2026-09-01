import { Readable } from "node:stream";
import { Controller, Get, Headers, Inject, Query, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { AuditService } from "@saturn/audit";
import type { FastifyReply } from "fastify";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { AUDIT_SERVICE } from "./tokens.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

function optionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Audit cursor is invalid");
  return parsed;
}

@Controller("activity")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class ActivityController {
  constructor(@Inject(AUDIT_SERVICE) private readonly audit: AuditService) {}

  @Get()
  list(@Query("before") before?: string, @Query("limit") limit?: string) {
    return this.audit.list(optionalInteger(before), optionalInteger(limit) ?? 100);
  }

  @Get("export")
  export(
    @Query("limit") limit: string | undefined,
    @Headers("accept") accept: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    if (accept !== undefined && !accept.includes("application/x-ndjson") && !accept.includes("*/*")) {
      throw new Error("Audit export Accept header is invalid");
    }
    reply
      .header("Content-Type", "application/x-ndjson")
      .header("Content-Disposition", "attachment; filename=activity.jsonl")
      .send(Readable.from(this.audit.exportJsonl(optionalInteger(limit) ?? 10_000)));
  }
}
