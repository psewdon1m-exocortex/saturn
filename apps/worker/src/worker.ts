import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { SaturnConfig } from "@saturn/config";
import type { HealthCheckResult, HealthResponse } from "@saturn/contracts";

export interface WorkerDatabasePort {
  ping(): Promise<number>;
  upsertWorkerHeartbeat(input: {
    readonly role: string;
    readonly instanceId: string;
    readonly startedAt: Date;
    readonly seenAt?: Date;
  }): Promise<void>;
  withSharedMaintenance?<T>(action: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface WorkerStorageHealthPort {
  check(): Promise<HealthCheckResult>;
}

export interface WorkerJobsPort {
  reconcile(): Promise<void>;
  purge?(): Promise<void>;
  backup?(): Promise<void>;
  maintain?(): Promise<void>;
  drain?(): Promise<unknown>;
  close?(): Promise<void>;
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

export function buildWorker(
  config: SaturnConfig,
  database: WorkerDatabasePort,
  storage: WorkerStorageHealthPort,
  jobs?: WorkerJobsPort,
): {
  readonly app: FastifyInstance;
  readonly startHeartbeat: () => Promise<void>;
  readonly startBackgroundJobs: () => void;
} {
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    bodyLimit: 64 * 1024,
  });
  const instanceId = randomUUID();
  const startedAt = new Date();
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let reconciliationTimer: NodeJS.Timeout | undefined;
  let backupTimer: NodeJS.Timeout | undefined;
  let dropDrainTimer: NodeJS.Timeout | undefined;
  let dropDrainRunning = false;

  const runMutation = <T>(action: () => Promise<T>): Promise<T> => database.withSharedMaintenance?.(action) ?? action();

  const heartbeat = async (): Promise<void> => {
    await database.upsertWorkerHeartbeat({ role: "primary", instanceId, startedAt });
  };

  app.get("/health/live", (): HealthResponse => ({
    status: "ok",
    service: "worker",
    timestamp: new Date().toISOString(),
    checks: { process: { state: "pass" } },
  }));

  app.get("/health/ready", async (_request, reply): Promise<HealthResponse> => {
    const [databaseCheck, storageCheck] = await Promise.all([
      within(config.readinessTimeoutMs, async () => ({ state: "pass", latencyMs: await database.ping() } as const))
        .catch(() => ({ state: "fail", detail: "database_unavailable" } as const)),
      config.readinessRequireStorage
        ? within(config.readinessTimeoutMs, async () => storage.check())
          .catch(() => ({ state: "fail", detail: "storage_unavailable" } as const))
        : Promise.resolve({ state: "disabled", detail: "disabled_by_configuration" } as const),
    ]);
    const checks: Record<string, HealthCheckResult> = { database: databaseCheck, storage: storageCheck };
    const status = Object.values(checks).some((check) => check.state === "fail") ? "degraded" : "ok";
    reply.status(status === "ok" ? 200 : 503);
    return { status, service: "worker", timestamp: new Date().toISOString(), checks };
  });

  app.addHook("onClose", async () => {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer);
    if (backupTimer !== undefined) clearInterval(backupTimer);
    if (dropDrainTimer !== undefined) clearInterval(dropDrainTimer);
    await jobs?.close?.();
    await database.close();
  });

  return {
    app,
    startHeartbeat: async () => {
      await heartbeat();
      heartbeatTimer = setInterval(() => {
        void heartbeat().catch((error: unknown) => {
          app.log.error({ error }, "worker heartbeat failed");
        });
      }, config.worker.heartbeatIntervalMs);
      heartbeatTimer.unref();
    },
    startBackgroundJobs: () => {
      if (jobs === undefined) return;
      reconciliationTimer = setInterval(() => {
        void runMutation(async () => { await jobs.reconcile(); await jobs.purge?.(); await jobs.maintain?.(); }).catch((error: unknown) => {
          app.log.error({ error }, "scheduled reconciliation failed");
        });
      }, config.worker.reconciliationIntervalMs);
      reconciliationTimer.unref();
      if (jobs.backup !== undefined) {
        backupTimer = setInterval(() => {
          void runMutation(async () => jobs.backup?.()).catch((error: unknown) => {
            app.log.error({ error }, "scheduled Saturn backup failed");
          });
        }, config.recovery.backupIntervalMs);
        backupTimer.unref();
      }
      if (jobs.drain !== undefined) {
        const drain = () => {
          if (dropDrainRunning) return;
          dropDrainRunning = true;
          void runMutation(async () => jobs.drain?.()).catch((error: unknown) => {
            app.log.error({ error }, "Drop buffer drain failed");
          }).finally(() => { dropDrainRunning = false; });
        };
        drain();
        dropDrainTimer = setInterval(drain, config.drop.drainIntervalMs);
        dropDrainTimer.unref();
      }
    },
  };
}
