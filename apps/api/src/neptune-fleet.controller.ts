import { Body, Controller, Get, Headers, Param, Post, Put, UseFilters, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { BackupApiExceptionFilter } from "./backup-api-exception.filter.js";
import { NeptuneFleetService, type NeptuneFleetCheckIn } from "./neptune-fleet.service.js";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { updater } from "./neptune.controller.js";

const status = z.record(z.string(), z.unknown());
const checkInSchema = z.object({
  clientInstanceId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  appliedRevision: z.number().int().min(0),
  archive: status,
  mirror: status.nullable().optional(),
  latestError: z.string().max(2000).nullable().optional(),
  commandResults: z.array(z.object({
    id: z.uuid(),
    state: z.enum(["succeeded", "failed"]),
    error: z.string().max(2000).nullable().optional(),
  }).strict()).max(100),
}).strict();
const desiredSchema = z.object({
  archiveEnabled: z.boolean(),
  archiveIntervalHours: z.number().int().min(1).max(8760),
  mirrorEnabled: z.boolean().optional(),
  mirrorIntervalMinutes: z.number().int().min(1).max(10_080).optional(),
}).strict();
const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("archive.run") }).strict(),
  z.object({ kind: z.literal("mirror.run") }).strict(),
  z.object({ kind: z.literal("agent.update"), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) }).strict(),
]);

@Controller("neptune/agent")
@UseFilters(BackupApiExceptionFilter)
export class NeptuneAgentController {
  constructor(private readonly fleet: NeptuneFleetService) {}

  @Post("check-in")
  async checkIn(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const serviceId = await this.fleet.authenticate(authorization);
    return this.fleet.checkIn(serviceId, checkInSchema.parse(body) as NeptuneFleetCheckIn);
  }
}

@Controller("operator/neptune/agents")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class NeptuneFleetOwnerController {
  constructor(private readonly fleet: NeptuneFleetService) {}

  @Get() list() { return this.fleet.list(); }
  @Get(":serviceId") get(@Param("serviceId") serviceId: string) { return this.fleet.get(serviceId); }

  @Post(":serviceId/update/check")
  async checkUpdate(@Param("serviceId") serviceId: string) {
    const agent = await this.fleet.get(serviceId);
    const currentVersion = agent.observed.version;
    if (currentVersion === undefined) throw new Error("Neptune has not reported its installed version yet");
    return updater("/v1/components/neptune-linux/check", {
      head_id: process.env.UPDATER_HEAD_ID?.trim() || "saturn",
      current_version: currentVersion,
    });
  }

  @Put(":serviceId/schedule")
  schedule(@Param("serviceId") serviceId: string, @Body() body: unknown) {
    const input = desiredSchema.parse(body);
    return this.fleet.updateDesired(serviceId, {
      archiveEnabled: input.archiveEnabled,
      archiveIntervalHours: input.archiveIntervalHours,
      ...(input.mirrorEnabled === undefined ? {} : { mirrorEnabled: input.mirrorEnabled }),
      ...(input.mirrorIntervalMinutes === undefined ? {} : { mirrorIntervalMinutes: input.mirrorIntervalMinutes }),
    });
  }

  @Post(":serviceId/commands")
  async command(@Param("serviceId") serviceId: string, @Body() body: unknown) {
    const input = commandSchema.parse(body);
    if (input.kind === "agent.update") {
      const checked = await this.checkUpdate(serviceId);
      if (checked.update_available !== true || checked.available_version !== input.version)
        throw new Error("Requested Neptune version is not the current upgrade candidate");
    }
    return this.fleet.enqueue(serviceId, input.kind,
      input.kind === "agent.update" ? { version: input.version } : {});
  }
}
