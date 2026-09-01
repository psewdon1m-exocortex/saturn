import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { HealthService } from "./health.service.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get("live")
  liveness() {
    return this.health.liveness();
  }

  @Get("ready")
  async readiness(@Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.health.readiness();
    reply.status(result.status === "ok" ? 200 : 503);
    return result;
  }
}
