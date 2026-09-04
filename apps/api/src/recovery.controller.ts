import { Readable } from "node:stream";
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { RecoveryWorkflowService } from "./recovery-workflow.service.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";

const beginSchema = z.object({
  filename: z.string().min(1).max(255),
  expectedBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
const applySchema = z.object({ confirmation: z.literal("RESTORE") }).strict();

function integerHeader(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "saturn-snapshot.zip";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

@Controller("operator/recovery")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class RecoveryController {
  constructor(@Inject(RecoveryWorkflowService) private readonly recovery: RecoveryWorkflowService) {}

  @Get()
  status() { return this.recovery.status(); }

  @Post("snapshots")
  async snapshot(@Res() reply: FastifyReply): Promise<void> {
    const result = await this.recovery.createSnapshot();
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Length", result.created.archiveBytes)
      .header("Content-Disposition", contentDisposition(result.filename))
      .header("X-Saturn-Backup-Id", result.created.manifest.backupId)
      .header("X-Saturn-Created-At", result.created.manifest.createdAt)
      .header("X-Content-SHA256", result.created.archiveSha256)
      .send(result.stream);
  }

  @Post("restores")
  begin(@Body() body: unknown) {
    const input = beginSchema.parse(body);
    return this.recovery.beginRestore(input.filename, input.expectedBytes);
  }

  @Patch("restores/:id")
  @HttpCode(204)
  async append(
    @Param("id") id: string,
    @Headers("upload-offset") rawOffset: string | undefined,
    @Headers("content-length") rawLength: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!(request.body instanceof Readable)) throw new Error("Recovery upload body is invalid");
    const received = await this.recovery.appendRestore(
      id,
      integerHeader(rawOffset, "Upload-Offset"),
      integerHeader(rawLength, "Content-Length"),
      request.body,
    );
    reply.header("Upload-Offset", received).status(204).send();
  }

  @Post("restores/:id/validate")
  validate(@Param("id") id: string) { return this.recovery.validateRestore(id); }

  @Post("restores/:id/apply")
  apply(@Param("id") id: string, @Body() body: unknown) {
    applySchema.parse(body);
    return this.recovery.applyRestore(id);
  }

  @Delete("restores/:id")
  @HttpCode(204)
  async cancel(@Param("id") id: string, @Res() reply: FastifyReply): Promise<void> {
    await this.recovery.cancelRestore(id);
    reply.status(204).send();
  }
}
