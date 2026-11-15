import fs from "node:fs/promises";
import path from "node:path";
import { Database } from "@saturn/database";
import { withRecoverySnapshot, type RecoverySnapshot } from "../../../packages/recovery/src/consistent-snapshot.js";
import { captureFixtureDocker } from "./stage3-chat-a.fault-snapshot.fixture.js";
import { fixtureManifest, sha } from "./stage3-chat-a.fixture.js";

interface Original {
  runId: string;
  relativePath: string;
  bytes: Buffer;
}

const projections = [
  ["_vault_migrations", "name"],
  ["backup_services", "id"],
  ["service_backup_runs", "id"],
  ["service_backup_restore_tests", "id"],
  ["resources", "id"],
  ["file_versions", "id"],
  ["audit_events", "sequence"],
] as const;

async function projection(snapshot: Pick<RecoverySnapshot, "query">) {
  return Object.fromEntries(await Promise.all(projections.map(async ([table, key]) => {
    const rows = await snapshot.query<{row: string}[]>(`SELECT to_jsonb(t)::text AS row FROM public.${table} t ORDER BY t.${key}`);
    return [table, { count: rows.length, sha256: sha(JSON.stringify(rows.map(row => row.row))) }] as const;
  })));
}

export async function recordBackupPreEffect(
  database: Database,
  databaseUrl: string,
  storage: string,
  scope: "backup-resume" | "backup-retention",
  originals: readonly Original[],
): Promise<void> {
  const evidence = process.env.SATURN_TEST_ISOLATION_EVIDENCE_DIR;
  if (evidence === undefined) return;
  const fixture = await fixtureManifest();
  const source = new URL(databaseUrl), adminUrl = new URL(fixture.databaseUrl);
  const name = source.pathname.slice(1);
  if (!/^saturn_test_[a-f0-9]{32}$/.test(name) || source.host !== adminUrl.host
    || source.username !== adminUrl.username || source.password !== adminUrl.password
    || originals.length !== (scope === "backup-resume" ? 1 : 2)) throw new Error("Backup test custody refused");
  const custody = JSON.parse(await fs.readFile(path.join(evidence, name + ".json"), "utf8")) as {name: string; storageRoot: string};
  const storageRoot = path.resolve(storage);
  if (custody.name !== name || custody.storageRoot !== storageRoot || await fs.realpath(storageRoot) !== storageRoot) {
    throw new Error("Backup test storage custody refused");
  }

  const root = path.join(evidence, name);
  await fs.mkdir(root, {mode: 0o700});
  const restoredName = name + "_proof";
  const fingerprints = await withRecoverySnapshot(database, 15_000, undefined, async snapshot => {
    const runs = await snapshot.query<{id: string; state: string; temp_path: string; final_path: string; size: string; hash: string}[]>(
      "SELECT id::text,state,temp_path,final_path,received_size::text AS size,expected_sha256 AS hash FROM public.service_backup_runs ORDER BY id");
    if (runs.length !== originals.length) throw new Error("Unexpected number of backup runs");
    const verifyBytes = async (copy: boolean) => {
      const pins = [];
      for (const [i, original] of originals.entries()) {
        const run = runs.find(row => row.id === original.runId);
        const pending = scope === "backup-resume";
        if (!run || run.state !== (pending ? "appending" : "complete") || original.relativePath !== (pending ? run.temp_path : run.final_path)
          || original.bytes.length !== Number(run.size) || (!pending && sha(original.bytes) !== run.hash)) {
          throw new Error("Backup run pre-effect state differs from the expected original");
        }
        const file = path.resolve(storageRoot, original.relativePath);
        if (!file.startsWith(storageRoot + path.sep) || await fs.realpath(file) !== file) throw new Error("Invalid backup original path");
        const raw = await fs.readFile(file);
        if (raw.length > 1024 || !raw.equals(original.bytes)) throw new Error("Backup original bytes changed");
        const destination = path.join(root, String(i) + ".original");
        if (copy) await fs.writeFile(destination, raw, {flag: "wx", mode: 0o600});
        if (!(await fs.readFile(destination)).equals(raw)) throw new Error("Backup original copy changed");
        pins.push({runId: run.id, state: run.state, relativePath: original.relativePath, copy: path.basename(destination), bytes: raw.length, sha256: sha(raw)});
      }
      return pins;
    };
    await verifyBytes(true);
    const projectionPins = await projection(snapshot);
    const dump = await captureFixtureDocker(root, ["exec", fixture.containerId, "pg_dump", "-U", "postgres", "-d", name, "--format=custom", "--snapshot=" + snapshot.snapshotId]);
    if (dump.length > 16 * 1024 ** 2 || dump.subarray(0, 5).toString() !== "PGDMP") throw new Error("Unexpected backup dump");
    await fs.writeFile(path.join(root, "before.dump"), dump, {flag: "wx", mode: 0o600});
    return { snapshotId: snapshot.snapshotId, dump, projectionPins, physical: await verifyBytes(false) };
  });
  const toc = await captureFixtureDocker(root, ["exec", "-i", fixture.containerId, "pg_restore", "--list"], fingerprints.dump);
  for (const table of ["backup_services", "service_backup_runs", "service_backup_restore_tests", "file_versions"]) {
    if (!toc.includes(Buffer.from(" TABLE DATA public " + table + " "))) throw new Error("Backup dump lacks " + table);
  }
  await fs.writeFile(path.join(root, "before.dump.toc"), toc, {flag: "wx", mode: 0o600});
  await fs.writeFile(path.join(root, "restore-ownership.json"), JSON.stringify({name: restoredName, source: name, containerId: fixture.containerId}), {flag: "wx", mode: 0o600});
  const admin = new Database(fixture.databaseUrl, {max: 1});
  try {
    await admin.withSql(sql => sql.unsafe("CREATE DATABASE " + restoredName));
  } finally {
    await admin.close();
  }
  await captureFixtureDocker(root, ["exec", "-i", fixture.containerId, "pg_restore", "-U", "postgres", "-d", restoredName, "--exit-on-error"], fingerprints.dump);
  const restoredUrl = new URL(source);
  restoredUrl.pathname = "/" + restoredName;
  const restored = new Database(restoredUrl.toString(), {max: 1});
  try {
    const actual = await withRecoverySnapshot(restored, 15_000, undefined, snapshot => projection(snapshot));
    if (JSON.stringify(actual) !== JSON.stringify(fingerprints.projectionPins)) throw new Error("Restored pre-effect rows changed");
  } finally {
    await restored.close();
  }
  await fs.writeFile(path.join(root, "pre-effect.json"), JSON.stringify({
    scope, name, restoredName, containerId: fixture.containerId, snapshotId: fingerprints.snapshotId, restoredBeforeEffect: true,
    physical: fingerprints.physical, projection: fingerprints.projectionPins,
    archive: { bytes: fingerprints.dump.length, sha256: sha(fingerprints.dump), tocSha256: sha(toc) },
  }), {flag: "wx", mode: 0o600});
}
