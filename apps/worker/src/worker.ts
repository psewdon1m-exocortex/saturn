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
  withAdvisoryLock?<T>(key: string, action: () => Promise<T>, waitMs?: number): Promise<T>;
  close(): Promise<void>;
}

export interface WorkerStorageHealthPort {
  check(): Promise<HealthCheckResult>;
}

export interface WorkerJobsPort {
  reconcile(): Promise<void>;
  scrub?(): Promise<void>;
  purge?(): Promise<void>;
  backup?(): Promise<void>;
  maintain?(): Promise<void>;
  drain?(): Promise<unknown>;
  archive?(): Promise<unknown>;
  sharePackage?(): Promise<unknown>;
  storageCatalog?(): Promise<void>;
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
  let storageCatalogTimer: NodeJS.Timeout | undefined;
  let storageCatalogRunning = false;
  let reconciliationRunning = false;
  let backupRunning = false;
  let closing = false;
  const activeJobs = new Set<Promise<unknown>>();
  const track = <T>(pending: Promise<T>): Promise<T> => {
    activeJobs.add(pending);
    void pending.then(() => activeJobs.delete(pending), () => activeJobs.delete(pending));
    return pending;
  };
  const runJob = <T>(key: string, action: () => Promise<T>, maintenance = true): Promise<T> => {
    const run = () => maintenance ? runMutation(action) : action();
    return track(database.withAdvisoryLock?.(`saturn-worker:${key}`, run, 1000) ?? run());
  };

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
    closing = true;
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer);
    if (backupTimer !== undefined) clearInterval(backupTimer);
    if (dropDrainTimer !== undefined) clearInterval(dropDrainTimer);
    if (storageCatalogTimer !== undefined) clearInterval(storageCatalogTimer);
    await Promise.allSettled([...activeJobs]);
    await jobs?.close?.();
    await database.close();
  });

  return {
    app,
    startHeartbeat: async () => {
      await heartbeat();
      heartbeatTimer = setInterval(() => {
        void track(heartbeat()).catch((error: unknown) => {
          app.log.error({ error }, "worker heartbeat failed");
        });
      }, config.worker.heartbeatIntervalMs);
      heartbeatTimer.unref();
    },
    startBackgroundJobs: () => {
      if (jobs === undefined) return;
      if (jobs.storageCatalog !== undefined) {
        const analyze = () => {
          if (closing || storageCatalogRunning) return;
          storageCatalogRunning = true;
          void runJob("storage-catalog", async () => jobs.storageCatalog?.(), false).catch((error: unknown) => {
            app.log.error({ error }, "Storage catalog analysis failed");
          }).finally(() => { storageCatalogRunning = false; });
        };
        analyze();
        storageCatalogTimer = setInterval(analyze, 2_000);
        storageCatalogTimer.unref();
      }
      reconciliationTimer = setInterval(() => {
        if (closing || reconciliationRunning) return;
        reconciliationRunning = true;
        void runJob("reconciliation", async () => { await jobs.reconcile(); await jobs.scrub?.(); await jobs.purge?.(); await jobs.maintain?.(); }).catch((error: unknown) => {
          app.log.error({ error }, "scheduled reconciliation failed");
        }).finally(() => { reconciliationRunning = false; });
      }, config.worker.reconciliationIntervalMs);
      reconciliationTimer.unref();
      if (jobs.backup !== undefined) {
        backupTimer = setInterval(() => {
          if (closing || backupRunning) return;
          backupRunning = true;
          void runJob("backup", async () => jobs.backup?.()).catch((error: unknown) => {
            app.log.error({ error }, "scheduled Saturn backup failed");
          }).finally(() => { backupRunning = false; });
        }, config.recovery.backupIntervalMs);
        backupTimer.unref();
      }
      if (jobs.drain !== undefined || jobs.archive !== undefined || jobs.sharePackage !== undefined) {
        const drain = () => {
          if (closing || dropDrainRunning) return;
          dropDrainRunning = true;
          void runJob("transfers", async () => { await jobs.drain?.(); await jobs.archive?.(); await jobs.sharePackage?.(); }).catch((error: unknown) => {
            app.log.error({ error }, "Background transfer worker failed");
          }).finally(() => { dropDrainRunning = false; });
        };
        drain();
        dropDrainTimer = setInterval(drain, config.drop.drainIntervalMs);
        dropDrainTimer.unref();
      }
    },
  };
}
