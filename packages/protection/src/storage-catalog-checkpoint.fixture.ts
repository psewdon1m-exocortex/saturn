import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "@saturn/database";
import { captureFixtureDocker } from "../../../apps/api/src/stage3-chat-a.fault-snapshot.fixture.js";
import { fixtureManifest } from "../../../apps/api/src/stage3-chat-a.fixture.js";

type CatalogPhase = "before-stale-file" | "before-write-failure" | "before-migration" | "before-lease-expiry";
type ReconciliationPhase = "before-disconnect" | "before-rename" | "before-recovery" | "before-missing";
type UploadPhase = "before-cancellation" | "before-cleanup" | "before-expiry" | "before-startup" | "before-dav-recovery";
type LayoutPhase = "before-layout-up" | "before-layout-down";
type CutoffPhase = "before-cutoff-migrate" | "before-cutoff-validators";
type GuardedLegacyPhase = "before-legacy-aging" | "before-legacy-recovery";
type JournalPhase = "before-journal-up" | "before-journal-down" | "before-journal-reup" | "before-journal-cleanup"
  | "before-journal-fault" | "before-journal-trigger" | "before-journal-timeout" | "before-journal-refusal";
type MetadataPhase = "before-metadata-shapes" | "before-metadata-revoke";
type HostHttpPhase = "before-host-client" | "before-host-create-ack" | "before-host-chunk-ack" | "before-host-complete-ack";
type Sql = Parameters<Parameters<Database["transaction"]>[0]>[0];
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const catalogTables = [
  ["_vault_migrations", "name"], ["resources", "id"], ["file_versions", "id"], ["shares", "id"],
  ["storage_catalog_jobs", "id"], ["operation_journal", "id"], ["audit_events", "sequence"],
] as const;
const reconciliationTables = [
  ...catalogTables, ["upload_sessions", "id"], ["operation_locks", "lock_key"],
  ["reconciliation_runs", "id"], ["reconciliation_issues", "id"],
] as const;
const uploadTables = [...reconciliationTables, ["drop_channels", "id"], ["drop_sessions", "id"], ["drop_uploads", "id"]] as const;
const layoutTables = [
  ["_vault_migrations", "name"], ["resources", "id"], ["file_versions", "id"], ["upload_sessions", "id"],
  ["devices", "id"], ["backup_services", "id"], ["service_backup_runs", "id"], ["system_metadata", "key"],
] as const;
const cutoffTables = [
  ["_vault_migrations", "name"], ["resources", "id"], ["file_versions", "id"], ["upload_sessions", "id"],
  ["devices", "id"], ["operation_journal", "id"], ["system_metadata", "key"],
] as const;
const guardedLegacyTables = [
  ...uploadTables, ["devices", "id"], ["catalog_guard_roots", "root_id"], ["sync_root_clock", "root_id"],
  ["sync_backend_executor", "backend_identity"], ["sync_backend_tasks", "id"],
] as const;
const journalTables = [...cutoffTables, ["sync_root_clock", "root_id"], ["sync_root_changes", "root_id, t.epoch, t.seq"]] as const;
type Tables = readonly (readonly [string, string])[];

async function readOnly<T>(database: Database, read: (sql: Sql) => Promise<T>): Promise<T> {
  return database.transaction(async sql => {
    await sql.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await sql.unsafe("SET LOCAL statement_timeout='10s'");
    return read(sql);
  });
}

async function projection(sql: Sql, tables: Tables) {
  const entries = [];
  for (const [table, key] of tables) {
    const rows = await sql.unsafe<{ row: string }[]>(`SELECT to_jsonb(t)::text AS row FROM public.${table} t ORDER BY t.${key}`);
    entries.push([table, { rows: rows.length, sha256: digest(JSON.stringify(rows.map(row => row.row))) }] as const);
  }
  return Object.fromEntries(entries);
}

async function copyTrees(directory: string, output: string, roots: readonly string[], copy: boolean) {
  const pins: { relative: string; kind: "file" | "directory"; bytes?: number; sha256?: string }[] = [];
  let totalBytes = 0;
  async function walk(relative: string) {
    const source = path.join(directory, relative), target = path.join(output, relative);
    const stat = await fs.lstat(source);
    if (pins.length >= 256 || stat.isSymbolicLink()) throw new Error("Catalog checkpoint tree bound or symlink");
    if (stat.isDirectory()) {
      if (copy) await fs.mkdir(target, { mode: 0o700 });
      pins.push({ relative, kind: "directory" });
      for (const entry of (await fs.readdir(source)).sort()) await walk(path.join(relative, entry));
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1 || (totalBytes += stat.size) > 8 * 1024 ** 2) {
      throw new Error("Catalog checkpoint physical byte bound");
    }
    const raw = await fs.readFile(source);
    if (raw.length !== stat.size) throw new Error("Catalog checkpoint file changed");
    if (copy) await fs.writeFile(target, raw, { flag: "wx", mode: 0o600 });
    if (!(await fs.readFile(target)).equals(raw)) throw new Error("Catalog checkpoint copy changed");
    pins.push({ relative, kind: "file", bytes: raw.length, sha256: digest(raw) });
  }
  for (const root of roots) await walk(root);
  return pins;
}

export function checkpointCatalog(
  phase: CatalogPhase, database: Database, databaseUrl: string, directory: string,
  evidence = process.env.SATURN_CATALOG_EVIDENCE_DIR,
): Promise<void> {
  return checkpoint(phase, database, databaseUrl, directory, evidence, "catalog");
}

export function checkpointReconciliation(
  phase: ReconciliationPhase, database: Database, databaseUrl: string, directory: string, evidence: string | undefined,
): Promise<void> {
  return checkpoint(phase, database, databaseUrl, directory, evidence, "reconciliation");
}

export function checkpointUploadRecovery(
  phase: UploadPhase, database: Database, databaseUrl: string, directory: string, evidence: string | undefined,
): Promise<void> {
  return checkpoint(phase, database, databaseUrl, directory, evidence, "upload");
}

export async function checkpointStorageLayout(
  phase: LayoutPhase, databaseUrl: string, directory: string, evidence: string,
): Promise<void> {
  const database = new Database(databaseUrl, { max: 1 });
  try {
    await checkpoint(phase, database, databaseUrl, directory, evidence, "layout");
  } finally {
    await database.close();
  }
}

export function checkpointMigrationCutoff(
  phase: CutoffPhase, database: Database, databaseUrl: string, directory: string, evidence: string,
): Promise<void> {
  return checkpoint(phase, database, databaseUrl, directory, evidence, "cutoff");
}

export function checkpointGuardedLegacyRecovery(
  phase: GuardedLegacyPhase, database: Database, databaseUrl: string, directory: string, evidence: string,
): Promise<void> {
  return checkpoint(phase, database, databaseUrl, directory, evidence, "guardedLegacy");
}

export function checkpointRootJournal(
  phase: JournalPhase, database: Database, databaseUrl: string, directory: string, evidence: string,
): Promise<void> {
  return checkpoint(phase, database, databaseUrl, directory, evidence, "journal");
}

export function checkpointMetadata(
  phase: MetadataPhase, database: Database, databaseUrl: string, directory: string, evidence: string,
): Promise<void> {
  return checkpoint(phase, database, databaseUrl, directory, evidence, "metadata");
}

export function checkpointHostHttp(
  phase: HostHttpPhase, database: Database, databaseUrl: string, directory: string, evidence: string,
): Promise<void> {
  return checkpoint(phase, database, databaseUrl, directory, evidence, "hostHttp");
}

async function checkpoint(
  phase: CatalogPhase | ReconciliationPhase | UploadPhase | LayoutPhase | CutoffPhase | GuardedLegacyPhase | JournalPhase | MetadataPhase | HostHttpPhase,
  database: Database, databaseUrl: string, directory: string,
  evidence: string | undefined, kind: "catalog" | "reconciliation" | "upload" | "layout" | "cutoff" | "guardedLegacy" | "journal" | "metadata" | "hostHttp",
): Promise<void> {
  if (evidence === undefined) return;
  const temp = await fs.realpath(os.tmpdir()), owned = path.resolve(directory), root = path.resolve(evidence);
  if (path.dirname(owned) !== temp || path.dirname(root) !== temp || owned === root
    || await fs.realpath(owned) !== owned || await fs.realpath(root) !== root) throw new Error("Catalog checkpoint path custody refused");
  const fixture = await fixtureManifest();
  const dbUrl = new URL(databaseUrl), base = new URL(fixture.databaseUrl), name = dbUrl.pathname.slice(1);
  const ownership = JSON.parse(await fs.readFile(path.join(root, "ownership.json"), "utf8")) as { name: string; directory: string };
  const expectedName = {
    catalog: /^catalog_test_[a-f0-9]{32}$/,
    cutoff: /^cutoff_[a-f0-9]{32}$/,
    guardedLegacy: /^stage3_[a-f0-9]{32}$/,
    journal: /^sync_journal_[a-f0-9]{32}$/,
    metadata: /^sync_metadata_[a-f0-9]{32}$/,
    hostHttp: /^host_http_qa_[a-f0-9]{32}$/,
    layout: /^saturn_test_[a-f0-9]{32}$/,
    reconciliation: /^audit_[a-f0-9]{32}$/,
    upload: /^audit_[a-f0-9]{32}$/,
  }[kind];
  if (!expectedName.test(name) || ownership.name !== name || path.resolve(ownership.directory) !== owned
    || dbUrl.host !== base.host || dbUrl.username !== base.username || dbUrl.password !== base.password) throw new Error("Catalog checkpoint database custody refused");
  const tables = {
    catalog: catalogTables, cutoff: cutoffTables, guardedLegacy: guardedLegacyTables,
    journal: phase === "before-journal-up" || phase === "before-journal-reup" ? cutoffTables : journalTables,
    metadata: cutoffTables,
    hostHttp: layoutTables,
    layout: layoutTables, reconciliation: reconciliationTables, upload: uploadTables,
  }[kind];
  const trees = {
    catalog: ["runtime", "storage"], cutoff: ["runtime", "storage"], guardedLegacy: ["runtime", "storage", "payloads"], journal: ["runtime", "storage"],
    metadata: ["runtime", "storage"],
    hostHttp: ["runtime", "storage"],
    layout: ["runtime", "storage"], reconciliation: ["storage"], upload: ["storage"],
  }[kind];
  const roleNames = kind === "guardedLegacy" ? ["rt_", "wr_", "ow_"].map(prefix => prefix + name.slice(7)) : [];
  const output = path.join(root, phase);
  await fs.mkdir(output, { mode: 0o700 });
  const physical = path.join(output, "physical");
  await fs.mkdir(physical, { mode: 0o700 });
  const backup = await readOnly(database, async sql => {
    const [cut] = await sql.unsafe<{ name: string; snapshot: string }[]>("SELECT current_database() AS name, pg_export_snapshot() AS snapshot");
    if (cut?.name !== name || !/^[A-Fa-f0-9]+-[A-Fa-f0-9]+-[0-9]+$/.test(cut.snapshot)) throw new Error("Catalog snapshot identity refused");
    const originals = await copyTrees(owned, physical, trees, true);
    const rows = await projection(sql, tables);
    let roleAuthoritySha256: string | undefined;
    if (roleNames.length) {
      const roles = await sql<{ role: string }[]>`SELECT (to_jsonb(r) - 'oid')::text AS role FROM pg_authid r WHERE rolname=ANY(${roleNames}::name[]) ORDER BY rolname`;
      const memberships = await sql`SELECT roleid,member,admin_option,inherit_option,set_option FROM pg_auth_members
        WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname=ANY(${roleNames}::name[]))
           OR member IN (SELECT oid FROM pg_roles WHERE rolname=ANY(${roleNames}::name[])) ORDER BY roleid,member`;
      if (roles.length !== 3 || memberships.length) throw new Error("Guarded checkpoint role authority refused");
      const authority = JSON.stringify({ roles: roles.map(row => row.role), memberships });
      await fs.writeFile(path.join(output, "role-authority.private.json"), authority, { flag: "wx", mode: 0o600 });
      roleAuthoritySha256 = digest(authority);
    }
    const dump = await captureFixtureDocker(output, ["exec", fixture.containerId, "pg_dump", "-U", "postgres", "-d", name, "--format=custom", "--snapshot=" + cut.snapshot]);
    if (dump.length > 16 * 1024 ** 2 || dump.subarray(0, 5).toString() !== "PGDMP") throw new Error("Invalid catalog archive");
    await fs.writeFile(path.join(output, "before.dump"), dump, { flag: "wx", mode: 0o600 });
    if (JSON.stringify(originals) !== JSON.stringify(await copyTrees(owned, physical, trees, false))) throw new Error("Catalog physical cut changed");
    return { snapshot: cut.snapshot, originals, rows, dump, roleAuthoritySha256 };
  });
  const toc = await captureFixtureDocker(output, ["exec", "-i", fixture.containerId, "pg_restore", "--list"], backup.dump);
  for (const [table] of tables) if (!toc.includes(Buffer.from(" TABLE DATA public " + table + " "))) throw new Error("Missing catalog archive table " + table);
  await fs.writeFile(path.join(output, "before.dump.toc"), toc, { flag: "wx", mode: 0o600 });
  const restored = name + "_" + phase.replace("before-", "").replaceAll("-", "_");
  const validRestore = /^(catalog_test|audit|saturn_test|cutoff|stage3)_[a-f0-9]{32}_(stale_file|write_failure|migration|lease_expiry|disconnect|rename|recovery|missing|cancellation|cleanup|expiry|startup|dav_recovery|layout_up|layout_down|cutoff_migrate|cutoff_validators|legacy_aging|legacy_recovery)$/.test(restored)
    || /^sync_journal_[a-f0-9]{32}_journal_(up|down|reup|cleanup|fault|trigger|timeout|refusal)$/.test(restored)
    || /^sync_metadata_[a-f0-9]{32}_metadata_(shapes|revoke)$/.test(restored)
    || /^host_http_qa_[a-f0-9]{32}_host_(client|create_ack|chunk_ack|complete_ack)$/.test(restored);
  if (!validRestore || restored.length > 63) {
    throw new Error("Invalid restore database identity");
  }
  await fs.writeFile(path.join(output, "restore-ownership.json"), JSON.stringify({ name, restored, container: fixture.containerId }), { flag: "wx", mode: 0o600 });
  const admin = new Database(fixture.databaseUrl, { max: 1 });
  try {
    await admin.withSql(sql => sql.unsafe("CREATE DATABASE " + restored));
  } finally {
    await admin.close();
  }
  await captureFixtureDocker(output, ["exec", "-i", fixture.containerId, "pg_restore", "-U", "postgres", "-d", restored, "--exit-on-error"], backup.dump);
  const restoredUrl = new URL(base);
  restoredUrl.pathname = "/" + restored;
  const proof = new Database(restoredUrl.toString(), { max: 1 });
  try {
    const rows = await readOnly(proof, sql => projection(sql, tables));
    if (JSON.stringify(rows) !== JSON.stringify(backup.rows)) throw new Error("Restored catalog rows changed");
  } finally {
    await proof.close();
  }
  if (JSON.stringify(backup.originals) !== JSON.stringify(await copyTrees(owned, physical, trees, false))) throw new Error("Catalog physical source changed before admission");
  await fs.writeFile(path.join(output, "pre-effect.json"), JSON.stringify({
    phase, name, restored, snapshot: backup.snapshot, database: backup.rows, physical: backup.originals,
    roleAuthoritySha256: backup.roleAuthoritySha256,
    archive: { bytes: backup.dump.length, sha256: digest(backup.dump), tocSha256: digest(toc) },
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
