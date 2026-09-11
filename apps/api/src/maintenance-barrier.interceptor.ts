import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import type { Database } from "@saturn/database";
import type { FastifyRequest } from "fastify";
import { from, lastValueFrom, type Observable } from "rxjs";
import { DATABASE } from "./tokens.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "MKCOL", "MOVE", "COPY"]);

@Injectable()
export class MaintenanceBarrierInterceptor implements NestInterceptor {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!MUTATING_METHODS.has(request.method)
      || request.url.startsWith("/api/v1/operator/recovery")
      || request.url.startsWith("/api/v1/operator/updates")
      || request.url.split("?")[0] === "/api/v1/internal/neptune/backup"
      || request.url.startsWith("/api/v1/operator/storage")) return next.handle();
    return from(this.database.withSharedMaintenance(() => lastValueFrom(next.handle())));
  }
}
