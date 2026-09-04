import { Readable } from "node:stream";
import { Controller, Get, Inject, Query, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { AuditService } from "@saturn/audit";
import archiver from "archiver";
import type { FastifyReply } from "fastify";
import { v7 as uuidv7 } from "uuid";
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
  async export(
    @Query("limit") limit: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const maximum = optionalInteger(limit) ?? 10_000;
    const createdAt = new Date();
    await this.audit.write({ actorType: "owner", actorId: "owner", action: "logs.export", outcome: "success", correlationId: `logs-export:${uuidv7()}`, details: { maximumEvents: maximum } });
    const archive = archiver("zip", { zlib: { level: 6 } });
    const timestamp = createdAt.toISOString().replaceAll(":", "-");
    reply
      .header("Content-Type", "application/zip")
      .header("Cache-Control", "no-store, private")
      .header("Pragma", "no-cache")
      .header("Content-Disposition", `attachment; filename=saturn-logs-${timestamp}.zip`)
      .send(archive);
    archive.append(JSON.stringify({ schema: "saturn.logs.v1", service: "saturn-gateway", createdAt: createdAt.toISOString(), maximumEvents: maximum, members: ["events.jsonl", "errors.json", "README.txt"] }, null, 2), { name: "manifest.json" });
    archive.append(Readable.from(this.audit.exportJsonl(maximum)), { name: "events.jsonl" });
    archive.append("[]\n", { name: "errors.json" });
    archive.append("Saturn retained structured audit export. Secrets are recursively redacted before storage. Timestamps are UTC ISO-8601; correlate records by correlationId.\n", { name: "README.txt" });
    await archive.finalize();
  }
}
