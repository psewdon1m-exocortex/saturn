import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UseFilters, UseGuards } from "@nestjs/common";
import type { ArchiveService } from "@saturn/archive";
import { z } from "zod";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { ARCHIVE_SERVICE } from "./tokens.js";

const createSchema = z.object({
  destinationParentId: z.uuid(),
  sourceResourceIds: z.array(z.uuid()).min(1).max(1_000),
  outputName: z.string().min(1).max(255),
}).strict();
const actionSchema = z.object({ action: z.enum(["pause", "resume", "cancel"]) }).strict();
const listSchema = z.object({ parentId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

@Controller("archives")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class ArchiveController {
  constructor(@Inject(ARCHIVE_SERVICE) private readonly archives: ArchiveService) {}

  @Post("jobs")
  @HttpCode(202)
  create(@Body() body: unknown) {
    return this.archives.createArchive(createSchema.parse(body));
  }

  @Post("resources/:id/extract")
  @HttpCode(202)
  extract(@Param("id") id: string) {
    return this.archives.extractArchive({ sourceResourceId: z.uuid().parse(id) });
  }

  @Get("jobs")
  list(@Query() query: unknown) {
    const parsed = listSchema.parse(query);
    return this.archives.listJobs(parsed.parentId, parsed.limit);
  }

  @Get("jobs/:id")
  get(@Param("id") id: string) {
    return this.archives.getJob(z.uuid().parse(id));
  }

  @Patch("jobs/:id")
  control(@Param("id") id: string, @Body() body: unknown) {
    return this.archives.control(z.uuid().parse(id), actionSchema.parse(body).action);
  }
}
