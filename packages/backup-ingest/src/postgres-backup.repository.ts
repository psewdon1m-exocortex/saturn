import type { Database } from "@saturn/database";
import type {
  BackupReceipt,
  BackupEnrollmentRecord,
  BackupRepository,
  BackupRestoreTestRecord,
  BackupRunRecord,
  BackupServiceRecord,
  BackupUsage,
} from "./types.js";

interface ServiceRow {
  id: string; slug: string; namespace_slug: string; deployment_id: string; mirror_root: "volt" | "mastermind" | null; mirror_device_id: string | null; name: string; token_hash: string; previous_token_hash: string | null;
  previous_token_expires_at: Date | null; state: BackupServiceRecord["state"]; require_encryption: boolean;
  mtls_cert_fingerprint: string | null; max_backup_bytes: string; daily_quota_bytes: string; stored_quota_bytes: string;
  max_concurrent_runs: number; freshness_sla_ms: string; retention_daily: number; retention_weekly: number;
  retention_monthly: number; retention_yearly: number; last_used_at: Date | null; created_at: Date; updated_at: Date; revoked_at: Date | null;
}
interface RunRow {
  id: string; service_id: string; client_key_hash: string; filename: string; source_created_at: Date; backup_type: string;
  expected_size: string; expected_sha256: string; source_version: string; encrypted: boolean; state: BackupRunRecord["state"];
  received_size: string; temp_path: string; final_path: string; receipt: BackupReceipt | null; failure_code: string | null;
  created_at: Date; updated_at: Date; committed_at: Date | null;
}
interface RestoreRow {
  id: string; service_id: string; run_id: string; method: BackupRestoreTestRecord["method"]; outcome: BackupRestoreTestRecord["outcome"];
  notes: string | null; artifact_sha256: string | null; started_at: Date; completed_at: Date;
}

function service(row: ServiceRow): BackupServiceRecord {
  return {
    id: row.id, slug: row.slug, namespaceSlug: row.namespace_slug, deploymentId: row.deployment_id,
    ...(row.mirror_root === null ? {} : { mirrorRoot: row.mirror_root }), ...(row.mirror_device_id === null ? {} : { mirrorDeviceId: row.mirror_device_id }),
    name: row.name, tokenHash: row.token_hash,
    ...(row.previous_token_hash === null ? {} : { previousTokenHash: row.previous_token_hash }),
    ...(row.previous_token_expires_at === null ? {} : { previousTokenExpiresAt: row.previous_token_expires_at }),
    state: row.state, requireEncryption: row.require_encryption,
    ...(row.mtls_cert_fingerprint === null ? {} : { mtlsCertFingerprint: row.mtls_cert_fingerprint }),
    maxBackupBytes: Number(row.max_backup_bytes), dailyQuotaBytes: Number(row.daily_quota_bytes), storedQuotaBytes: Number(row.stored_quota_bytes),
    maxConcurrentRuns: row.max_concurrent_runs, freshnessSlaMs: Number(row.freshness_sla_ms),
    retention: { daily: row.retention_daily, weekly: row.retention_weekly, monthly: row.retention_monthly, yearly: row.retention_yearly },
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }), createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}
function run(row: RunRow): BackupRunRecord {
  return {
    id: row.id, serviceId: row.service_id, clientKeyHash: row.client_key_hash, filename: row.filename, sourceCreatedAt: row.source_created_at,
    backupType: row.backup_type, expectedSize: Number(row.expected_size), expectedSha256: row.expected_sha256, sourceVersion: row.source_version,
    encrypted: row.encrypted, state: row.state, receivedSize: Number(row.received_size), tempPath: row.temp_path, finalPath: row.final_path,
    ...(row.receipt === null ? {} : { receipt: row.receipt }), ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: row.created_at, updatedAt: row.updated_at, ...(row.committed_at === null ? {} : { committedAt: row.committed_at }),
  };
}
function restore(row: RestoreRow): BackupRestoreTestRecord {
  return { id: row.id, serviceId: row.service_id, runId: row.run_id, method: row.method, outcome: row.outcome,
    ...(row.notes === null ? {} : { notes: row.notes }), ...(row.artifact_sha256 === null ? {} : { artifactSha256: row.artifact_sha256 }),
    startedAt: row.started_at, completedAt: row.completed_at };
}

export class PostgresBackupRepository implements BackupRepository {
  constructor(private readonly database: Database) {}

  createService(value: BackupServiceRecord): Promise<void> {
    return this.database.withSql(async (sql) => { await sql`
      INSERT INTO backup_services (id, slug, namespace_slug, deployment_id, mirror_root, name, token_hash, state, require_encryption, mtls_cert_fingerprint,
        max_backup_bytes, daily_quota_bytes, stored_quota_bytes, max_concurrent_runs, freshness_sla_ms,
        retention_daily, retention_weekly, retention_monthly, retention_yearly, created_at, updated_at)
      VALUES (${value.id}, ${value.slug}, ${value.namespaceSlug}, ${value.deploymentId}, ${value.mirrorRoot ?? null}, ${value.name}, ${value.tokenHash}, ${value.state}, ${value.requireEncryption}, ${value.mtlsCertFingerprint ?? null},
        ${value.maxBackupBytes}, ${value.dailyQuotaBytes}, ${value.storedQuotaBytes}, ${value.maxConcurrentRuns}, ${value.freshnessSlaMs},
        ${value.retention.daily}, ${value.retention.weekly}, ${value.retention.monthly}, ${value.retention.yearly}, ${value.createdAt}, ${value.updatedAt})
    `; });
  }
  getService(id: string): Promise<BackupServiceRecord | undefined> { return this.database.withSql(async (sql) => {
    const rows = await sql<ServiceRow[]>`SELECT * FROM backup_services WHERE id = ${id} LIMIT 1`; return rows[0] === undefined ? undefined : service(rows[0]);
  }); }
  getActiveServiceByDeployment(namespaceSlug: string, deploymentId: string): Promise<BackupServiceRecord | undefined> { return this.database.withSql(async (sql) => {
    const rows = await sql<ServiceRow[]>`SELECT * FROM backup_services WHERE namespace_slug = ${namespaceSlug} AND deployment_id = ${deploymentId} AND state = 'active' LIMIT 1`;
    return rows[0] === undefined ? undefined : service(rows[0]);
  }); }
  listServices(offset: number, limit: number): Promise<readonly BackupServiceRecord[]> { return this.database.withSql(async (sql) =>
    (await sql<ServiceRow[]>`SELECT * FROM backup_services ORDER BY created_at DESC, id DESC OFFSET ${offset} LIMIT ${limit}`).map(service)); }
  updateService(id: string, input: Parameters<BackupRepository["updateService"]>[1], now: Date): Promise<BackupServiceRecord> {
    return this.database.transaction(async (sql) => {
      const rows = await sql<ServiceRow[]>`SELECT * FROM backup_services WHERE id = ${id} FOR UPDATE`;
      const currentRow = rows[0]; if (currentRow === undefined) throw new Error("Backup service not found");
      const current = service(currentRow); const retention = input.retention ?? current.retention;
      const updated = await sql<ServiceRow[]>`
        UPDATE backup_services SET name = ${input.name ?? current.name}, require_encryption = ${input.requireEncryption ?? current.requireEncryption},
          mtls_cert_fingerprint = ${input.mtlsCertFingerprint ?? current.mtlsCertFingerprint ?? null}, max_backup_bytes = ${input.maxBackupBytes ?? current.maxBackupBytes},
          daily_quota_bytes = ${input.dailyQuotaBytes ?? current.dailyQuotaBytes}, stored_quota_bytes = ${input.storedQuotaBytes ?? current.storedQuotaBytes},
          max_concurrent_runs = ${input.maxConcurrentRuns ?? current.maxConcurrentRuns}, freshness_sla_ms = ${input.freshnessSlaMs ?? current.freshnessSlaMs},
          retention_daily = ${retention.daily}, retention_weekly = ${retention.weekly}, retention_monthly = ${retention.monthly}, retention_yearly = ${retention.yearly}, updated_at = ${now}
        WHERE id = ${id} RETURNING *`;
      const row = updated[0]; if (row === undefined) throw new Error("Backup service update failed"); return service(row);
    });
  }
  rotateToken(id: string, tokenHash: string, previousTokenExpiresAt: Date, now: Date): Promise<BackupServiceRecord> { return this.database.withSql(async (sql) => {
    const rows = await sql<ServiceRow[]>`UPDATE backup_services SET previous_token_hash = token_hash, previous_token_expires_at = ${previousTokenExpiresAt}, token_hash = ${tokenHash}, updated_at = ${now} WHERE id = ${id} AND state = 'active' RETURNING *`;
    if (rows[0] === undefined) throw new Error("Backup service not found or not active"); return service(rows[0]);
  }); }
  revokeService(id: string, now: Date): Promise<BackupServiceRecord> { return this.database.withSql(async (sql) => {
    const rows = await sql<ServiceRow[]>`UPDATE backup_services SET state = 'revoked', previous_token_hash = NULL, previous_token_expires_at = NULL, revoked_at = ${now}, updated_at = ${now} WHERE id = ${id} RETURNING *`;
    if (rows[0] === undefined) throw new Error("Backup service not found"); return service(rows[0]);
  }); }
  authenticate(tokenHash: string, now: Date): Promise<{ readonly service: BackupServiceRecord; readonly usedPreviousToken: boolean } | undefined> { return this.database.transaction(async (sql) => {
    const rows = await sql<ServiceRow[]>`SELECT * FROM backup_services WHERE state = 'active' AND (token_hash = ${tokenHash} OR (previous_token_hash = ${tokenHash} AND previous_token_expires_at > ${now})) LIMIT 1 FOR UPDATE`;
    const row = rows[0]; if (row === undefined) return undefined; await sql`UPDATE backup_services SET last_used_at = ${now} WHERE id = ${row.id}`;
    return { service: service({ ...row, last_used_at: now }), usedPreviousToken: row.token_hash !== tokenHash };
  }); }
  reserveRun(input: BackupRunRecord, now: Date): Promise<{ readonly run: BackupRunRecord; readonly created: boolean }> { return this.database.transaction(async (sql) => {
    const services = await sql<ServiceRow[]>`SELECT * FROM backup_services WHERE id = ${input.serviceId} FOR UPDATE`;
    const selected = services[0]; if (selected === undefined || selected.state !== "active") throw new Error("Backup service is not active");
    const existing = await sql<RunRow[]>`SELECT * FROM service_backup_runs WHERE service_id = ${input.serviceId} AND client_key_hash = ${input.clientKeyHash} LIMIT 1`;
    if (existing[0] !== undefined) return { run: run(existing[0]), created: false };
    const totals = await sql<{ active_runs: string; active_bytes: string; stored_bytes: string; daily_bytes: string }[]>`
      SELECT count(*) FILTER (WHERE state IN ('pending','uploading','appending','verifying'))::text AS active_runs,
        coalesce(sum(expected_size) FILTER (WHERE state IN ('pending','uploading','appending','verifying')),0)::text AS active_bytes,
        coalesce(sum(expected_size) FILTER (WHERE state = 'complete'),0)::text AS stored_bytes,
        coalesce(sum(expected_size) FILTER (WHERE state <> 'failed' AND created_at >= date_trunc('day', ${now}::timestamptz)),0)::text AS daily_bytes
      FROM service_backup_runs WHERE service_id = ${input.serviceId}`;
    const total = totals[0]; if (total === undefined) throw new Error("Backup quota calculation failed");
    if (Number(total.active_runs) >= selected.max_concurrent_runs) throw new Error("Backup concurrent quota is exhausted");
    if (Number(total.daily_bytes) + input.expectedSize > Number(selected.daily_quota_bytes)) throw new Error("Backup daily quota is exhausted");
    if (Number(total.stored_bytes) + Number(total.active_bytes) + input.expectedSize > Number(selected.stored_quota_bytes)) throw new Error("Backup stored quota is exhausted");
    const rows = await sql<RunRow[]>`INSERT INTO service_backup_runs (id, service_id, client_key_hash, filename, source_created_at, backup_type,
      expected_size, expected_sha256, source_version, encrypted, state, received_size, temp_path, final_path, created_at, updated_at)
      VALUES (${input.id}, ${input.serviceId}, ${input.clientKeyHash}, ${input.filename}, ${input.sourceCreatedAt}, ${input.backupType},
      ${input.expectedSize}, ${input.expectedSha256}, ${input.sourceVersion}, ${input.encrypted}, 'pending', 0, ${input.tempPath}, ${input.finalPath}, ${now}, ${now}) RETURNING *`;
    const row = rows[0]; if (row === undefined) throw new Error("Backup run reservation failed"); return { run: run(row), created: true };
  }); }
  getRun(serviceId: string, runId: string): Promise<BackupRunRecord | undefined> { return this.database.withSql(async (sql) => { const rows = await sql<RunRow[]>`SELECT * FROM service_backup_runs WHERE id = ${runId} AND service_id = ${serviceId} LIMIT 1`; return rows[0] === undefined ? undefined : run(rows[0]); }); }
  getRunForOwner(runId: string): Promise<BackupRunRecord | undefined> { return this.database.withSql(async (sql) => { const rows = await sql<RunRow[]>`SELECT * FROM service_backup_runs WHERE id = ${runId} LIMIT 1`; return rows[0] === undefined ? undefined : run(rows[0]); }); }
  listRuns(serviceId: string, offset: number, limit: number): Promise<readonly BackupRunRecord[]> { return this.database.withSql(async (sql) => (await sql<RunRow[]>`SELECT * FROM service_backup_runs WHERE service_id = ${serviceId} ORDER BY created_at DESC, id DESC OFFSET ${offset} LIMIT ${limit}`).map(run)); }
  claimAppend(serviceId: string, runId: string, offset: number, length: number, now: Date): Promise<BackupRunRecord> { return this.database.transaction(async (sql) => {
    const rows = await sql<RunRow[]>`SELECT * FROM service_backup_runs WHERE id = ${runId} AND service_id = ${serviceId} FOR UPDATE`; const row = rows[0];
    if (row === undefined) throw new Error("Backup run not found"); if (!['pending','uploading'].includes(row.state)) throw new Error("Backup run is not writable");
    if (Number(row.received_size) !== offset || offset + length > Number(row.expected_size)) throw new Error("Backup upload offset mismatch");
    const claimed = await sql<RunRow[]>`UPDATE service_backup_runs SET state = 'appending', updated_at = ${now} WHERE id = ${runId} RETURNING *`;
    if (claimed[0] === undefined) throw new Error("Backup append claim failed"); return run(claimed[0]);
  }); }
  finishAppend(serviceId: string, runId: string, receivedSize: number, now: Date): Promise<BackupRunRecord> { return this.database.withSql(async (sql) => { const rows = await sql<RunRow[]>`UPDATE service_backup_runs SET state = 'uploading', received_size = ${receivedSize}, updated_at = ${now} WHERE id = ${runId} AND service_id = ${serviceId} AND state = 'appending' RETURNING *`; if (rows[0] === undefined) throw new Error("Backup append is not active"); return run(rows[0]); }); }
  releaseAppend(serviceId: string, runId: string, failureCode: string, terminal: boolean, now: Date): Promise<void> { return this.database.withSql(async (sql) => { await sql`UPDATE service_backup_runs SET state = ${terminal ? "failed" : "uploading"}, failure_code = ${failureCode}, updated_at = ${now} WHERE id = ${runId} AND service_id = ${serviceId} AND state = 'appending'`; }); }
  claimComplete(serviceId: string, runId: string, now: Date): Promise<BackupRunRecord> { return this.database.transaction(async (sql) => { const rows = await sql<RunRow[]>`SELECT * FROM service_backup_runs WHERE id = ${runId} AND service_id = ${serviceId} FOR UPDATE`; const row = rows[0]; if (row === undefined) throw new Error("Backup run not found"); if (row.state === "complete") return run(row); if (!['pending','uploading','verifying'].includes(row.state) || Number(row.received_size) !== Number(row.expected_size)) throw new Error("Backup run is incomplete"); const claimed = await sql<RunRow[]>`UPDATE service_backup_runs SET state = 'verifying', failure_code = NULL, updated_at = ${now} WHERE id = ${runId} RETURNING *`; if (claimed[0] === undefined) throw new Error("Backup completion claim failed"); return run(claimed[0]); }); }
  completeRun(serviceId: string, runId: string, receipt: BackupReceipt, now: Date): Promise<BackupRunRecord> { return this.database.withSql(async (sql) => { const rows = await sql<RunRow[]>`UPDATE service_backup_runs SET state = 'complete', receipt = ${sql.json(receipt as never)}, committed_at = ${now}, updated_at = ${now}, failure_code = NULL WHERE id = ${runId} AND service_id = ${serviceId} AND state = 'verifying' RETURNING *`; if (rows[0] === undefined) throw new Error("Backup completion is not active"); return run(rows[0]); }); }
  failRun(serviceId: string, runId: string, failureCode: string, now: Date): Promise<void> { return this.database.withSql(async (sql) => { await sql`UPDATE service_backup_runs SET state = 'failed', failure_code = ${failureCode}, updated_at = ${now} WHERE id = ${runId} AND service_id = ${serviceId} AND state <> 'complete'`; }); }
  usage(serviceId: string, since: Date): Promise<BackupUsage> { return this.database.withSql(async (sql) => { const rows = await sql<{ stored_bytes: string; active_bytes: string; daily_bytes: string; active_runs: string; last_completed_at: Date | null; failed_runs: string }[]>`SELECT coalesce(sum(expected_size) FILTER (WHERE state='complete'),0)::text AS stored_bytes, coalesce(sum(expected_size) FILTER (WHERE state IN ('pending','uploading','appending','verifying')),0)::text AS active_bytes, coalesce(sum(expected_size) FILTER (WHERE state <> 'failed' AND created_at >= ${since}),0)::text AS daily_bytes, count(*) FILTER (WHERE state IN ('pending','uploading','appending','verifying'))::text AS active_runs, max(committed_at) FILTER (WHERE state='complete') AS last_completed_at, count(*) FILTER (WHERE state='failed')::text AS failed_runs FROM service_backup_runs WHERE service_id=${serviceId}`; const row = rows[0]; if (row === undefined) throw new Error("Backup usage calculation failed"); return { storedBytes:Number(row.stored_bytes), activeReservedBytes:Number(row.active_bytes), dailyReservedBytes:Number(row.daily_bytes), activeRuns:Number(row.active_runs), ...(row.last_completed_at===null?{}:{lastCompletedAt:row.last_completed_at}), failedRuns:Number(row.failed_runs) }; }); }
  recordRestoreTest(value: BackupRestoreTestRecord): Promise<void> { return this.database.withSql(async (sql) => { await sql`INSERT INTO service_backup_restore_tests (id, service_id, run_id, method, outcome, notes, artifact_sha256, started_at, completed_at) VALUES (${value.id},${value.serviceId},${value.runId},${value.method},${value.outcome},${value.notes??null},${value.artifactSha256??null},${value.startedAt},${value.completedAt})`; }); }
  latestRestoreTest(serviceId: string): Promise<BackupRestoreTestRecord | undefined> { return this.database.withSql(async (sql) => { const rows = await sql<RestoreRow[]>`SELECT * FROM service_backup_restore_tests WHERE service_id=${serviceId} ORDER BY completed_at DESC,id DESC LIMIT 1`; return rows[0]===undefined?undefined:restore(rows[0]); }); }
  createEnrollment(value: BackupEnrollmentRecord): Promise<void> { return this.database.transaction(async (sql) => {
    await sql`SELECT id FROM backup_services WHERE id = ${value.serviceId} FOR UPDATE`;
    await sql`UPDATE backup_enrollments SET consumed_at = ${value.createdAt} WHERE service_id = ${value.serviceId} AND consumed_at IS NULL`;
    await sql`INSERT INTO backup_enrollments (id, service_id, code_hash, expires_at, created_at) VALUES (${value.id}, ${value.serviceId}, ${value.codeHash}, ${value.expiresAt}, ${value.createdAt})`;
  }); }
  consumeEnrollment(codeHash: string, now: Date): Promise<BackupServiceRecord | undefined> { return this.database.transaction(async (sql) => {
    const rows = await sql<{ service_id: string }[]>`UPDATE backup_enrollments SET consumed_at = ${now} WHERE code_hash = ${codeHash} AND consumed_at IS NULL AND expires_at > ${now} RETURNING service_id`;
    const id = rows[0]?.service_id; if (id === undefined) return undefined;
    const services = await sql<ServiceRow[]>`SELECT * FROM backup_services WHERE id = ${id} AND state = 'active' LIMIT 1`;
    return services[0] === undefined ? undefined : service(services[0]);
  }); }
  attachMirrorDevice(serviceId: string, deviceId: string, now: Date): Promise<BackupServiceRecord> { return this.database.withSql(async (sql) => {
    const rows = await sql<ServiceRow[]>`UPDATE backup_services SET mirror_device_id = ${deviceId}, updated_at = ${now} WHERE id = ${serviceId} AND state = 'active' AND mirror_root IS NOT NULL RETURNING *`;
    if (rows[0] === undefined) throw new Error("Backup mirror identity is unavailable");
    return service(rows[0]);
  }); }
}
