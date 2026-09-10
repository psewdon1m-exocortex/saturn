import { Controller, Get, Headers, Inject, Res, UnauthorizedException, UseFilters } from "@nestjs/common";
import type { OwnerAuthService } from "@saturn/auth";
import type { DeviceService } from "@saturn/sync";
import type { FastifyReply } from "fastify";
import { SaturnApiExceptionFilter } from "./saturn-api-exception.filter.js";
import { AUTH_SERVICE, DEVICE_SERVICE } from "./tokens.js";

@Controller("sync")
@UseFilters(SaturnApiExceptionFilter)
export class SyncClientController {
  constructor(
    @Inject(DEVICE_SERVICE) private readonly devices: DeviceService,
    @Inject(AUTH_SERVICE) private readonly owner: OwnerAuthService,
  ) {}

  @Get("preferences")
  async preferences(@Headers("authorization") authorization: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    try { await this.devices.authenticate(authorization); }
    catch { throw new UnauthorizedException({ code: "device_authentication_required" }); }
    const preferences = await this.owner.getPreferences();
    reply.header("Cache-Control", "no-store");
    return { accentColor: preferences.accentColor, updatedAt: preferences.updatedAt };
  }
}
