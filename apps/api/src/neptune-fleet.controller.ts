import { Body, Controller, Get, GoneException, Headers, Inject, NotFoundException, Param, Post, Put, UseFilters, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { BackupApiExceptionFilter } from "./backup-api-exception.filter.js";
import { NeptuneFleetService, type NeptuneFleetCheckIn } from "./neptune-fleet.service.js";
import { OwnerTokenGuard } from "./owner-token.guard.js";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { updater } from "./neptune.controller.js";
import { policyMutationSchema, policyRunSchema } from "./service-backup-policy.js";

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
const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("archive.run") }).strict(),
  z.object({ kind: z.literal("mirror.run") }).strict(),
  z.object({ kind: z.literal("agent.update"), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) }).strict(),
]);

@Controller("neptune/agent")
@UseFilters(BackupApiExceptionFilter)
export class NeptuneAgentController {
  constructor(@Inject(NeptuneFleetService) private readonly fleet: NeptuneFleetService) {}

  @Post("check-in")
  async checkIn(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    const serviceId = await this.fleet.authenticate(authorization);
    return this.fleet.checkIn(serviceId, checkInSchema.parse(body) as NeptuneFleetCheckIn);
  }

  @Get("policy")
  async policy(@Headers("authorization") authorization: string | undefined) {
    return this.fleet.policy.read(await this.fleet.authenticate(authorization));
  }

  @Put("policy")
  async changePolicy(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    return this.fleet.policy.mutate(await this.fleet.authenticate(authorization), policyMutationSchema.parse(body));
  }

  @Post("policy/runs")
  async run(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    return this.fleet.policy.run(await this.fleet.authenticate(authorization), policyRunSchema.parse(body));
  }

  @Get("policy/runs")
  async runs(@Headers("authorization") authorization: string | undefined) {
    return this.fleet.policy.jobs(await this.fleet.authenticate(authorization));
  }
}

@Controller("operator/neptune/agents")
@UseGuards(OwnerTokenGuard)
@UseFilters(SaturnApiExceptionFilter)
export class NeptuneFleetOwnerController {
  constructor(@Inject(NeptuneFleetService) private readonly fleet: NeptuneFleetService) {}

  @Get() list() { return this.fleet.list(); }
  @Get(":serviceId") get(@Param("serviceId") serviceId: string) { return this.fleet.get(serviceId); }

  @Post(":serviceId/update/flow/check")
  async flowCheck(@Param("serviceId") serviceId: string) {
    const release = await this.checkUpdate(serviceId);
    return { ...release, component: "neptune", updater_label: "Remote host · version not reported", protocol: 2, backup_required: false };
  }

  @Get(":serviceId/update/flow/jobs")
  jobs(@Param("serviceId") serviceId: string) { return this.fleet.updateJobs(serviceId); }

  @Get(":serviceId/update/flow/jobs/:jobId")
  async job(@Param("serviceId") serviceId: string, @Param("jobId") jobId: string) {
    const result = (await this.fleet.updateJobs(serviceId)).jobs.find(job => job.id === jobId);
    if (!result) throw new NotFoundException("Remote Neptune update not found");
    return result;
  }

  @Post(":serviceId/update/flow/install/neptune")
  async install(@Param("serviceId") serviceId: string, @Body() body: unknown) {
    const input = z.object({ version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/), request_id: z.uuid() }).strict().parse(body);
    const existing = (await this.fleet.updateJobs(serviceId)).jobs.find(job => job.id === input.request_id);
    if (existing) { if (existing.version !== input.version) throw new Error("Request ID belongs to another version"); return existing; }
    const checked = await this.checkUpdate(serviceId);
    if (checked.update_available !== true || checked.available_version !== input.version) throw new Error("Requested Neptune version is not the current upgrade candidate");
    await this.fleet.enqueue(serviceId, "agent.update", { version: input.version }, input.request_id);
    return this.job(serviceId, input.request_id);
  }

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
  schedule() {
    throw new GoneException("Open Backup in the owning service to change its schedule");
  }

  @Post(":serviceId/commands")
  async command(@Param("serviceId") serviceId: string, @Body() body: unknown) {
    const input = commandSchema.parse(body);
    if (input.kind !== "agent.update") throw new GoneException("Open Backup in the owning service to start its backup");
    const checked = await this.checkUpdate(serviceId);
    if (checked.update_available !== true || checked.available_version !== input.version)
      throw new Error("Requested Neptune version is not the current upgrade candidate");
    return this.fleet.enqueue(serviceId, input.kind, { version: input.version });
  }
}
