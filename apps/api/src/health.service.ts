import { Inject, Injectable } from "@nestjs/common";
import type { SaturnConfig } from "@saturn/config";
import type { HealthCheckResult, HealthResponse, WorkerHeartbeat } from "@saturn/contracts";
import { APP_CONFIG, DATABASE, STORAGE_HEALTH } from "./tokens.js";

export interface HealthDatabasePort {
  ping(): Promise<number>;
  getWorkerHeartbeat(role: string): Promise<WorkerHeartbeat | undefined>;
}

export interface StorageHealthPort {
  check(): Promise<HealthCheckResult>;
}

async function within<T>(timeoutMs: number, action: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("health_check_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: SaturnConfig,
    @Inject(DATABASE) private readonly database: HealthDatabasePort,
    @Inject(STORAGE_HEALTH) private readonly storage: StorageHealthPort,
  ) {}

  liveness(): HealthResponse {
    return {
      status: "ok",
      service: "api",
      timestamp: new Date().toISOString(),
      checks: { process: { state: "pass" } },
    };
  }

  async readiness(): Promise<HealthResponse> {
    const timeoutMs = this.config.readinessTimeoutMs;
    const [database, storage, worker] = await Promise.all([
      within(timeoutMs, async () => ({ state: "pass", latencyMs: await this.database.ping() } as const))
        .catch(() => ({ state: "fail", detail: "database_unavailable" } as const)),
      this.config.readinessRequireStorage
        ? within(timeoutMs, async () => this.storage.check())
          .catch(() => ({ state: "fail", detail: "storage_unavailable" } as const))
        : Promise.resolve({ state: "disabled", detail: "disabled_by_configuration" } as const),
      within(timeoutMs, async () => {
        const heartbeat = await this.database.getWorkerHeartbeat("primary");
        const ageMs = heartbeat === undefined ? Number.POSITIVE_INFINITY : Date.now() - heartbeat.lastSeenAt.getTime();
        return heartbeat !== undefined && ageMs <= this.config.worker.staleAfterMs
          ? { state: "pass" } as const
          : { state: "fail", detail: heartbeat === undefined ? "worker_missing" : "worker_stale" } as const;
      }).catch(() => ({ state: "fail", detail: "worker_status_unavailable" } as const)),
    ]);
    const checks: Record<string, HealthCheckResult> = { database, storage, worker };

    const status = Object.values(checks).some((check) => check.state === "fail") ? "degraded" : "ok";
    return { status, service: "api", timestamp: new Date().toISOString(), checks };
  }
}
