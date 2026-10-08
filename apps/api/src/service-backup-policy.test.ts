import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnvironment } from "@saturn/config";
import type { AuditService } from "@saturn/audit";
import type { RuntimeStorageManager } from "@saturn/storage";
import { RecoveryWorkflowService } from "./recovery-workflow.service.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database, migrate } from "@saturn/database";
import { policyMutationSchema, ServiceBackupPolicy } from "./service-backup-policy.js";
import { NeptuneAgentController, NeptuneFleetOwnerController } from "./neptune-fleet.controller.js";
import { NeptuneOwnerController } from "./neptune.controller.js";
import { NeptuneFleetService } from "./neptune-fleet.service.js";

it("rejects scope injection and central schedule/run authoring", async () => {
  expect(() => policyMutationSchema.parse({ kind: "schedule", pipeline: "archive", enabled: true, intervalHours: 24,
    expectedRevision: 1, requestId: randomUUID(), serviceId: "another-service" })).toThrow();
  const controller = new NeptuneFleetOwnerController({} as NeptuneFleetService);
  expect(() => controller.schedule()).toThrow("owning service");
  expect(() => controller.command({ kind: "archive.run" })).toThrow("owning service");
  expect(() => controller.command({ kind: "agent.update", version: "1.2.3" })).toThrow("updater tui");
  expect(() => controller.flowCheck()).toThrow("updater tui");
  expect(() => controller.install()).toThrow("updater tui");
  expect(policyMutationSchema.parse({ kind: "schedule-all", enabled: true, intervalHours: 24,
    expectedRevision: 1, requestId: randomUUID() })).toMatchObject({ kind: "schedule-all", intervalHours: 24 });
  expect(() => policyMutationSchema.parse({ kind: "schedule-all", enabled: true, intervalHours: 169,
    expectedRevision: 1, requestId: randomUUID() })).toThrow();
  const local = new NeptuneOwnerController();
  expect(() => local.schedule()).toThrow("Saturn Settings");
  expect(() => local.mirrorSchedule()).toThrow("Saturn Settings");
  expect(() => local.policyRun()).toThrow("Manual Neptune runs");
});

it("binds every agent policy operation to the authenticated producer", async () => {
  const serviceId = randomUUID();
  const requestId = randomUUID();
  const policy = {
    read: vi.fn().mockResolvedValue({ schema: "exocortex.backup.policy.v1", revision: 4 }),
    mutate: vi.fn().mockResolvedValue({ revision: 5 }),
    jobs: vi.fn().mockResolvedValue([]),
  };
  const authenticate = vi.fn().mockResolvedValue(serviceId);
  const fleet = { authenticate, policy } as unknown as NeptuneFleetService;
  const controller = new NeptuneAgentController(fleet);
  const authorization = "Bearer producer-fixture";
  await controller.policy(authorization);
  await controller.changePolicy(authorization, { kind: "schedule", pipeline: "archive", enabled: true,
    intervalHours: 24, expectedRevision: 4, requestId });
  await expect(controller.run(authorization)).rejects.toThrow("Manual Neptune runs");
  await controller.runs(authorization);
  expect(authenticate).toHaveBeenCalledTimes(4);
  expect(policy.read).toHaveBeenCalledWith(serviceId);
  expect(policy.mutate).toHaveBeenCalledWith(serviceId, expect.objectContaining({ requestId }));
  expect(policy.jobs).toHaveBeenCalledWith(serviceId);
});

it("disconnects only with the producer credential", async () => {
  const disconnect = vi.fn().mockResolvedValue({ state: "disconnected" });
  const controller = new NeptuneAgentController({ disconnect } as unknown as NeptuneFleetService);
  await expect(controller.disconnect("Bearer scoped-producer")).resolves.toEqual({ state: "disconnected" });
  expect(disconnect).toHaveBeenCalledWith("Bearer scoped-producer");
});

it("confirms an already revoked producer without restoring its access", async () => {
  const serviceId = randomUUID();
  const authorization = `Bearer ${"A".repeat(43)}`;
  const statements: string[] = [];
  const sql = async (parts: TemplateStringsArray) => {
    const statement = parts.join("?");
    statements.push(statement);
    if (statement.includes("SELECT id FROM backup_services")) return [{ id: serviceId }];
    if (statement.includes("SELECT service_id FROM neptune_agents")) return [{ service_id: serviceId }];
    return [];
  };
  const database = { transaction: (work: (tag: typeof sql) => Promise<unknown>) => work(sql),
    withSql: (work: (tag: typeof sql) => Promise<unknown>) => work(sql) } as unknown as Database;
  let revoked = false;
  const backups = { authenticate: vi.fn(async () => {
    if (revoked) throw new Error("Producer credential revoked");
    return { service: { id: serviceId } };
  }), hmac: vi.fn(() => "a".repeat(64)) };
  const fleet = new NeptuneFleetService(database, backups as never);
  await expect(fleet.disconnect(authorization)).resolves.toEqual({ state: "disconnected" });
  expect(statements.some(statement => statement.includes("disconnect_token_hash = ?"))).toBe(true);
  expect(statements.some(statement => statement.includes("UPDATE backup_enrollments SET consumed_at"))).toBe(true);
  const firstCallStatements = statements.length;
  revoked = true;
  await expect(fleet.disconnect(authorization)).resolves.toEqual({ state: "disconnected" });
  expect(statements.slice(firstCallStatements)).toHaveLength(1);
  expect(statements.at(-1)).toContain("SELECT service_id FROM neptune_agents WHERE disconnect_token_hash");
});

describe.skipIf(!process.env.POLICY_TEST_DATABASE_URL)("service-owned policy on PostgreSQL", () => {
  let db: Database, policies: ServiceBackupPolicy;
  const serviceId = randomUUID(), otherId = randomUUID();
  const databaseUrl = () => {
    const url = process.env.POLICY_TEST_DATABASE_URL;
    if (!url) throw new Error("POLICY_TEST_DATABASE_URL is required for PostgreSQL policy tests");
    return url;
  };
  beforeAll(async () => {
    const url = databaseUrl();
    await migrate(url, fileURLToPath(new URL("../../../packages/database/migrations", import.meta.url)));
    db = new Database(url);
    policies = new ServiceBackupPolicy(db);
    for (const [id, name] of [[serviceId, "volt"], [otherId, "chronos"]] as const) {
      await db.withSql(async sql => {
        await sql`INSERT INTO backup_services(id,slug,name,token_hash,state,require_encryption,max_backup_bytes,daily_quota_bytes,
          stored_quota_bytes,max_concurrent_runs,freshness_sla_ms,retention_daily,retention_weekly,retention_monthly,retention_yearly,
          created_at,updated_at,namespace_slug,deployment_id,mirror_root)
          VALUES(${id},${name + "-" + id.slice(0,8)},${name},${id.replaceAll("-","").repeat(2)},'active',false,1000000,1000000,
            1000000,1,60000,1,1,1,1,now(),now(),${name},${id},${name === "volt" ? "volt" : null})`;
        await sql`INSERT INTO neptune_agents(service_id,desired_revision,archive_enabled,archive_interval_hours,mirror_enabled,
          mirror_interval_minutes,applied_revision,last_seen_at)
          VALUES(${id},12,true,7,${name === "volt"},5,12,now())`;
      });
    }
  });
  afterAll(async () => {
    await db.withSql(sql => sql`DELETE FROM backup_services WHERE id IN (${serviceId},${otherId})`);
    await db.close();
  });

  it("preserves imported short intervals, commits one concurrent revision and replays exactly", async () => {
    const before = await policies.read(serviceId);
    expect(before.mirror?.intervalMinutes).toBe(5);
    const requests = [8,9].map(intervalHours => ({ kind: "schedule" as const, pipeline: "archive" as const,
      enabled: true, intervalHours, expectedRevision: before.revision, requestId: randomUUID() }));
    const results = await Promise.allSettled(requests.map(request => policies.mutate(serviceId, request)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const winner = results.findIndex(result => result.status === "fulfilled");
    const winningRequest = requests[winner];
    if (!winningRequest) throw new Error("Exactly one policy mutation must succeed");
    const committed = await policies.read(serviceId);
    expect(committed.revision).toBe(before.revision + 1);
    expect(committed.mirror?.intervalMinutes).toBe(5);
    expect(await policies.mutate(serviceId, winningRequest)).toMatchObject({ revision: committed.revision });
    await expect(policies.mutate(serviceId, { ...winningRequest, intervalHours: 10 })).rejects.toThrow("another policy change");
    expect((await policies.read(otherId)).revision).toBe(12);
  });

  it("enforces a mirror-only enrollment in persisted policy and rejects archive scheduling, restore and runs", async () => {
    const id = randomUUID();
    await db.withSql(async sql => {
      await sql`INSERT INTO backup_services(id,slug,name,token_hash,state,require_encryption,max_backup_bytes,daily_quota_bytes,
        stored_quota_bytes,max_concurrent_runs,freshness_sla_ms,retention_daily,retention_weekly,retention_monthly,retention_yearly,
        created_at,updated_at,namespace_slug,deployment_id,pipeline_kind,mirror_root,archive_pipeline)
        SELECT ${id},${"volt-" + id},name,${id.replaceAll("-", "").repeat(2)},state,require_encryption,max_backup_bytes,daily_quota_bytes,
          stored_quota_bytes,max_concurrent_runs,freshness_sla_ms,retention_daily,retention_weekly,retention_monthly,retention_yearly,
          now(),now(),'mastermind',${id},'mastermind','mastermind',false FROM backup_services WHERE id=${serviceId}`;
      await sql`INSERT INTO neptune_agents(service_id) VALUES(${id})`;
    });
    try {
      const before = await policies.read(id);
      expect(before.archive).toMatchObject({ available: false, enabled: false });
      const schedule = { kind: "schedule" as const, pipeline: "archive" as const, enabled: true, intervalHours: 24, expectedRevision: before.revision, requestId: randomUUID() };
      await expect(policies.mutate(id, schedule)).rejects.toThrow("no archive pipeline");
      await expect(policies.mutate(id, { kind: "schedule-all", enabled: true, intervalHours: 24, expectedRevision: before.revision, requestId: randomUUID() })).rejects.toThrow("no combined backup pipeline");
      await expect(policies.mutate(id, { kind: "restore", archive: { enabled: true, intervalHours: 24 }, mirror: { enabled: true, intervalMinutes: 1440 }, expectedRevision: before.revision, requestId: randomUUID() })).rejects.toThrow("no archive pipeline");
      await expect(policies.run(id, { pipeline: "archive", requestId: randomUUID() })).rejects.toThrow("no archive pipeline");
      const result = await policies.mutate(id, { ...schedule, pipeline: "mirror", requestId: randomUUID() });
      expect(result.archive).toMatchObject({ available: false, enabled: false });
      expect(result.mirror).toEqual({ enabled: true, intervalMinutes: 1440 });
      expect((await policies.read(id)).mirror).toEqual(result.mirror);
    } finally { await db.withSql(sql => sql`DELETE FROM backup_services WHERE id=${id}`); }
  });

  it("atomically applies one switch and hourly interval to both advanced pipelines", async () => {
    const before = await policies.read(serviceId);
    const request = { kind: "schedule-all" as const, enabled: false, intervalHours: 24,
      expectedRevision: before.revision, requestId: randomUUID() };
    const result = await policies.mutate(serviceId, request);
    expect(result.revision).toBe(before.revision + 1);
    expect(result.archive).toEqual({ enabled: false, intervalHours: 24 });
    expect(result.mirror).toEqual({ enabled: false, intervalMinutes: 1440 });
    expect(await policies.mutate(serviceId, request)).toEqual(result);
    await expect(policies.mutate(otherId, { ...request, requestId: randomUUID(),
      expectedRevision: (await policies.read(otherId)).revision })).rejects.toThrow("no combined backup pipeline");
  });

  it("keeps restored intent paused and deduplicates manual commands without changing schedule", async () => {
    const before = await policies.read(serviceId);
    const restored = await policies.mutate(serviceId, { kind: "restore", expectedRevision: before.revision, requestId: randomUUID(),
      archive: { enabled: true, intervalHours: 11 }, mirror: { enabled: true, intervalMinutes: 5 } });
    expect(restored.paused).toBe(true);
    expect(restored.archive).toEqual({ enabled: true, intervalHours: 11 });
    await expect(policies.run(serviceId, { requestId: randomUUID(), pipeline: "archive" })).rejects.toThrow("awaits verification");
    await policies.mutate(serviceId, { kind: "resume", expectedRevision: restored.revision, requestId: randomUUID() });
    const resumed = await policies.read(serviceId);
    const request = { requestId: randomUUID(), pipeline: "archive" as const };
    expect(await policies.run(serviceId, request)).toMatchObject({ id: request.requestId, state: "pending" });
    expect(await policies.run(serviceId, request)).toMatchObject({ id: request.requestId, state: "pending" });
    await expect(policies.run(otherId, request)).rejects.toThrow("another run");
    expect((await policies.jobs(serviceId)).filter(job => job.id === request.requestId)).toHaveLength(1);
    expect(await policies.read(serviceId)).toEqual(resumed);
  });

  it("holds recovered schedules before startup and never replays stale manual commands", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-policy-startup-"));
    const secret = path.join(directory, "synthetic.token");
    await fs.writeFile(secret, "synthetic-fixture-only");
    const config = loadEnvironment({ NODE_ENV: "test", PUBLIC_ORIGIN: "http://localhost:5173", DATABASE_URL: databaseUrl(),
      OWNER_BOOTSTRAP_TOKEN_FILE: secret, AUTH_PEPPER_FILE: secret, DROP_PEPPER_FILE: secret, SHARE_PEPPER_FILE: secret,
      DEVICE_PEPPER_FILE: secret, BACKUP_PEPPER_FILE: secret, LABORATORY_PEPPER_FILE: secret,
      STORAGE_HOST: "localhost", STORAGE_USER: "vault", STORAGE_ROOT: "gateway", STORAGE_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`,
      STORAGE_AUTH_MODE: "password_file", STORAGE_PASSWORD_FILE: secret,
      RECOVERY_SPOOL_DIR: path.join(directory, "spool"), RECOVERY_ARCHIVE_DIR: path.join(directory, "archives") }, directory, false);
    // Use the parsed private directories, keeping the test independent of production paths.
    await fs.mkdir(config.recovery.spoolDirectory, { recursive: true });
    const journal = path.join(config.recovery.spoolDirectory, `web-restore-${randomUUID()}.json`);
    await fs.writeFile(journal, JSON.stringify({ state: "applying" }));
    const before = await policies.read(serviceId);
    const workflow = new RecoveryWorkflowService(config, db, {} as AuditService, {} as RuntimeStorageManager);
    try {
      await workflow.onModuleInit();
      const held = await policies.read(serviceId);
      expect(held.paused).toBe(true);
      expect(held.revision).toBeGreaterThan(before.revision);
      expect(held.archive).toEqual(before.archive);
      expect(held.mirror).toEqual(before.mirror);
      expect((await policies.jobs(serviceId)).every(job => job.state !== "pending")).toBe(true);
      await expect(fs.access(journal)).rejects.toThrow();
    } finally {
      await workflow.onApplicationShutdown();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
