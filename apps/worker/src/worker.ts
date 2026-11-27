import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
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
  ready?(): Promise<void>;
  reconcile(signal?: AbortSignal): Promise<void>;
  scrub?(): Promise<void>;
  purge?(): Promise<void>;
  backup?(): Promise<void>;
  maintain?(): Promise<void>;
  retention?(): Promise<void>;
  snapshots?(): Promise<void>;
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
  let retentionTimer: NodeJS.Timeout | undefined;
  let retentionRunning = false;
  let snapshotTimer: NodeJS.Timeout | undefined;
  let snapshotRunning = false;
  let reconciliationRunning = false;
  let backupRunning = false;
  let closing = false;
  const reconciliationStop = new AbortController();
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
  const runSteps = async (steps: readonly (readonly [string, () => Promise<unknown>])[]): Promise<void> => {
    for (const [job, action] of steps) {
      if (closing) break;
      try { await action(); }
      catch (error) {
        if (reconciliationStop.signal.aborted && error === reconciliationStop.signal.reason) app.log.info({ job }, "Background worker scan cancelled for shutdown");
        else app.log.error({ err: error, job }, "Background worker step failed");
      }
    }
  };

  const runTransfers = async (): Promise<void> => {
    await runSteps([["drop-drain", async () => jobs?.drain?.()]]);
    if (closing) return;

    // Keep one distributed transfers owner and one heavy job at a time, while
    // allowing newly buffered Drop work to advance during a long archive/ZIP.
    let heavyFinished = false;
    let wake: (() => void) | undefined;
    const canDrain = () => !closing && !heavyFinished;
    const drain = jobs?.drain?.bind(jobs);
    const heavy = runSteps([
      ["archive", async () => jobs?.archive?.()],
      ["share-package", async () => jobs?.sharePackage?.()],
    ]).finally(() => { heavyFinished = true;wake?.(); });
    try {
      if (drain !== undefined) {
        while (canDrain()) {
          await new Promise<void>(resolve => {
            let timer: NodeJS.Timeout | undefined;
            const finish = () => {
              if (timer !== undefined) clearTimeout(timer);
              reconciliationStop.signal.removeEventListener("abort", finish);
              wake = undefined;
              resolve();
            };
            wake = finish;
            reconciliationStop.signal.addEventListener("abort", finish, { once: true });
            if (!canDrain()) finish();
            else { timer = setTimeout(finish, config.drop.drainIntervalMs);timer.unref(); }
          });
          if (!canDrain()) break;
          await runSteps([["drop-drain", drain]]);
        }
      }
    } finally {
      // Shutdown wakes the wait and prevents new admissions; both accepted
      // tasks still finish before the maintenance/advisory locks are released.
      await heavy;
    }
  };

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
    const backendReady = jobs?.ready?.bind(jobs);
    const [databaseCheck, storageCheck, backendCheck] = await Promise.all([
      within(config.readinessTimeoutMs, async () => ({ state: "pass", latencyMs: await database.ping() } as const))
        .catch(() => ({ state: "fail", detail: "database_unavailable" } as const)),
      config.readinessRequireStorage
        ? within(config.readinessTimeoutMs, async () => storage.check())
          .catch(() => ({ state: "fail", detail: "storage_unavailable" } as const))
        : Promise.resolve({ state: "disabled", detail: "disabled_by_configuration" } as const),
      backendReady
        ? within(config.readinessTimeoutMs, backendReady)
          .then(() => ({ state: "pass" } as const))
          .catch(() => ({ state: "fail", detail: "backend_owner_unavailable" } as const))
        : Promise.resolve(undefined),
    ]);
    const checks: Record<string, HealthCheckResult> = { database: databaseCheck, storage: storageCheck };
    if (backendCheck !== undefined) checks["backend"] = backendCheck;
    const status = Object.values(checks).some((check) => check.state === "fail") ? "degraded" : "ok";
    reply.status(status === "ok" ? 200 : 503);
    return { status, service: "worker", timestamp: new Date().toISOString(), checks };
  });

  app.addHook("onClose", async () => {
    closing = true;
    reconciliationStop.abort(new Error("Worker shutdown requested"));
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer);
    if (backupTimer !== undefined) clearInterval(backupTimer);
    if (dropDrainTimer !== undefined) clearInterval(dropDrainTimer);
    if (storageCatalogTimer !== undefined) clearInterval(storageCatalogTimer);
    if (retentionTimer !== undefined) clearInterval(retentionTimer);
    if (snapshotTimer !== undefined) clearInterval(snapshotTimer);
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
      if (jobs.snapshots !== undefined && snapshotTimer === undefined) {
        const collect = () => {
          if (closing || snapshotRunning) return;
          snapshotRunning = true;
          void runJob("snapshots", async () => jobs.snapshots?.()).catch((error: unknown) => {
            app.log.error({ error }, "Expired snapshot collection deferred");
          }).finally(() => { snapshotRunning = false; });
        };
        collect(); snapshotTimer = setInterval(collect, 2_000); snapshotTimer.unref();
      }
      if (jobs.retention !== undefined) {
        const retain = () => {
          if (closing || retentionRunning) return;
          retentionRunning = true;
          void runJob("retention", () => { const retention = jobs.retention?.bind(jobs); return requireDefined(retention)(); }).catch((error: unknown) => {
            app.log.error({ error }, "Guarded retention deferred");
          }).finally(() => { retentionRunning = false; });
        };
        retain(); retentionTimer = setInterval(retain, 2_000); retentionTimer.unref();
      }
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
        void runJob("reconciliation", () => runSteps([
          ["reconciliation", () => jobs.reconcile(reconciliationStop.signal)], ["scrub", async () => jobs.scrub?.()],
          ["purge", async () => jobs.purge?.()], ["maintenance", async () => jobs.maintain?.()],
        ])).catch((error: unknown) => {
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
          void runJob("transfers", runTransfers).catch((error: unknown) => {
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
