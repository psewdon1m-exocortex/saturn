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
import type { NeptuneFleetService } from "./neptune-fleet.service.js";

it("rejects scope injection and central schedule/run authoring", async () => {
  expect(() => policyMutationSchema.parse({ kind: "schedule", pipeline: "archive", enabled: true, intervalHours: 24,
    expectedRevision: 1, requestId: randomUUID(), serviceId: "another-service" })).toThrow();
  const controller = new NeptuneFleetOwnerController({} as NeptuneFleetService);
  expect(() => controller.schedule()).toThrow("owning service");
  await expect(controller.command("irrelevant", { kind: "archive.run" })).rejects.toThrow("owning service");
});

it("binds every agent policy operation to the authenticated producer", async () => {
  const serviceId = randomUUID();
  const requestId = randomUUID();
  const policy = {
    read: vi.fn().mockResolvedValue({ schema: "exocortex.backup.policy.v1", revision: 4 }),
    mutate: vi.fn().mockResolvedValue({ revision: 5 }),
    run: vi.fn().mockResolvedValue({ id: requestId, state: "pending" }),
    jobs: vi.fn().mockResolvedValue([]),
  };
  const fleet = { authenticate: vi.fn().mockResolvedValue(serviceId), policy } as unknown as NeptuneFleetService;
  const controller = new NeptuneAgentController(fleet);
  const authorization = "Bearer producer-fixture";
  await controller.policy(authorization);
  await controller.changePolicy(authorization, { kind: "schedule", pipeline: "archive", enabled: true,
    intervalHours: 24, expectedRevision: 4, requestId });
  await controller.run(authorization, { pipeline: "archive", requestId });
  await controller.runs(authorization);
  expect(fleet.authenticate).toHaveBeenCalledTimes(4);
  expect(policy.read).toHaveBeenCalledWith(serviceId);
  expect(policy.mutate).toHaveBeenCalledWith(serviceId, expect.objectContaining({ requestId }));
  expect(policy.run).toHaveBeenCalledWith(serviceId, { pipeline: "archive", requestId });
  expect(policy.jobs).toHaveBeenCalledWith(serviceId);
});

describe.skipIf(!process.env.POLICY_TEST_DATABASE_URL)("service-owned policy on PostgreSQL", () => {
  let db: Database, policies: ServiceBackupPolicy;
  const serviceId = randomUUID(), otherId = randomUUID();
  beforeAll(async () => {
    const url = process.env.POLICY_TEST_DATABASE_URL!;
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
    if (!db) return;
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
    const committed = await policies.read(serviceId);
    expect(committed.revision).toBe(before.revision + 1);
    expect(committed.mirror?.intervalMinutes).toBe(5);
    expect(await policies.mutate(serviceId, requests[winner]!)).toMatchObject({ revision: committed.revision });
    await expect(policies.mutate(serviceId, { ...requests[winner]!, intervalHours: 10 })).rejects.toThrow("another policy change");
    expect((await policies.read(otherId)).revision).toBe(12);
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
    const config = loadEnvironment({ NODE_ENV: "test", PUBLIC_ORIGIN: "http://localhost:5173", DATABASE_URL: process.env.POLICY_TEST_DATABASE_URL!,
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
