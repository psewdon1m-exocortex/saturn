import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Database, migrate } from "@saturn/database";
import { qualifyCatalogDatabaseRoles, CatalogRoleQualificationError, type CatalogDatabaseRolePolicy } from "../../../packages/database/src/catalog-role-qualification.js";
import { expect, it } from "vitest";

const fixturePath = process.env.SYNC_CATALOG_G1_FIXTURE, exec = promisify(execFile);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
it.skipIf(!fixturePath)("qualifies isolated catalogue role privileges and rejects escalation/definer changes on actual PostgreSQL", async () => {
  if (!fixturePath) throw new Error("An explicitly owned guard fixture is required");
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as { containerId: string; runId: string; databaseUrl: string; fixtureDirectory: string; retainEvidence?: boolean };
  const inspected = JSON.parse((await exec("docker", ["inspect", fixture.containerId], { windowsHide: true })).stdout) as {
    Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean }; HostConfig: { NanoCpus: number; Memory: number };
  }[];
  expect(inspected[0]?.Id).toBe(fixture.containerId); expect(inspected[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);
  expect(inspected[0]?.State.Running).toBe(true); expect(inspected[0]?.HostConfig.NanoCpus).toBeLessThanOrEqual(1e9);
  expect(inspected[0]?.HostConfig.Memory).toBeLessThanOrEqual(512 * 1024 * 1024);
  const suffix = randomUUID().replaceAll("-", ""), name = "guardrole_" + suffix;
  const runtimeRole = "g1_runtime_" + suffix, writerLogin = "g1_writer_" + suffix, writerOwner = "g1_owner_" + suffix, bridge = "g1_bridge_" + suffix;
  const password = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
  const directory = path.join(fixture.fixtureDirectory, suffix); await fs.mkdir(directory);
  const admin = new Database(fixture.databaseUrl, { max: 2 });
  let db: Database | undefined, runtime: Database | undefined, writer: Database | undefined;
  let passed = false; const checks: string[] = [], rejections: { phase: string; findings: readonly string[] }[] = [];
  const roles = [runtimeRole, writerLogin, writerOwner, bridge];
  await fs.writeFile(path.join(directory,"ownership.json"),JSON.stringify({name,roles,containerId:fixture.containerId,runId:fixture.runId}),{flag:"wx"});
  try {
    await admin.withSql(sql => sql.unsafe(`CREATE DATABASE ${name}`));
    const url = new URL(fixture.databaseUrl); url.pathname = "/" + name;
    await migrate(url.toString(), fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url)));
    db = new Database(url.toString(), { max: 2 });
    for (const role of roles) await admin.withSql(sql => sql.unsafe(`CREATE ROLE ${role} ${role === writerOwner || role === bridge ? "NOLOGIN" : "LOGIN"}
      NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT ${role === writerOwner || role === bridge ? "" : `PASSWORD '${password}'`}`));
    await db.withSql(sql => sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${roles.join(",")}`));
    await db.withSql(sql => sql.unsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`));
    const runtimeUrl = new URL(url); runtimeUrl.username = runtimeRole; runtimeUrl.password = password;
    const writerUrl = new URL(url); writerUrl.username = writerLogin; writerUrl.password = password;
    runtime = new Database(runtimeUrl.toString(), { max: 1 }); writer = new Database(writerUrl.toString(), { max: 1 });
    const policy: CatalogDatabaseRolePolicy = { runtimeRole, writerLogin, writerOwner, migratorRole: "postgres", connection: "runtime", approvedFunctions: [] };
    const qualify = () => qualifyCatalogDatabaseRoles(runtime as Database, policy);
    const reject = async (phase: string, action: () => Promise<unknown>, expected?: string) => {
      try { await action(); throw new Error("Expected role rejection: " + phase); }
      catch (error) {
        if (!(error instanceof CatalogRoleQualificationError)) throw error;
        if (expected) expect(error.findings.some(finding => finding.startsWith(expected)), error.message).toBe(true);
        rejections.push({ phase, findings: error.findings });
      }
    };
    expect((await qualify()).scope).toBe("readonly-point-in-time-preflight-no-root-activation");
    expect((await qualifyCatalogDatabaseRoles(writer, { ...policy, connection: "writer" })).sessionRole).toBe(writerLogin);
    await reject("migrator connection is not runtime", () => qualifyCatalogDatabaseRoles(db as Database, policy), "connection_identity");
    for (const attribute of ["SUPERUSER", "CREATEROLE", "CREATEDB", "REPLICATION", "BYPASSRLS"]) {
      await admin.withSql(sql => sql.unsafe(`ALTER ROLE ${runtimeRole} ${attribute}`));
      try {
        await reject(attribute, qualify, "unsafe_attributes");
      } finally {
        await admin.withSql(sql => sql.unsafe(`ALTER ROLE ${runtimeRole} NO${attribute}`));
      }
    }
    checks.push("actual runtime/writer login/no-login owner separation; unsafe role attributes and migrator-as-runtime denied");
    await admin.withSql(sql => sql.unsafe(`GRANT ${writerOwner} TO ${runtimeRole} WITH INHERIT FALSE, SET FALSE, ADMIN FALSE`));
    await reject("non-inheritable non-settable owner membership", qualify, "privileged_membership");
    await admin.withSql(sql => sql.unsafe(`REVOKE ${writerOwner} FROM ${runtimeRole}`));
    await admin.withSql(sql => sql.unsafe(`GRANT ${writerOwner} TO ${bridge}; GRANT ${bridge} TO ${runtimeRole}`));
    await reject("transitive writer owner membership", qualify, "privileged_membership");
    await admin.withSql(sql => sql.unsafe(`REVOKE ${bridge} FROM ${runtimeRole}; REVOKE ${writerOwner} FROM ${bridge}`));
    await admin.withSql(sql => sql.unsafe(`GRANT ${bridge} TO ${runtimeRole} WITH ADMIN TRUE`));
    await reject("ordinary role ADMIN option", qualify, "privileged_membership");
    await admin.withSql(sql => sql.unsafe(`REVOKE ${bridge} FROM ${runtimeRole}`));
    await expect(runtime.withSql(sql => sql.unsafe(`SET ROLE ${writerOwner}`))).rejects.toThrow("permission denied");
    await expect(runtime.withSql(sql => sql.unsafe(`GRANT ${writerOwner} TO ${runtimeRole}`))).rejects.toThrow("permission denied");
    await admin.withSql(sql => sql.unsafe(`GRANT ${bridge} TO ${runtimeRole} WITH SET TRUE, INHERIT FALSE`));
    await runtime.withSql(sql => sql.unsafe(`SET ROLE ${bridge}`));
    await reject("changed current role on intended login", qualify, "connection_identity");
    await runtime.withSql(sql => sql.unsafe("RESET ROLE"));
    await admin.withSql(sql => sql.unsafe(`REVOKE ${bridge} FROM ${runtimeRole}`));
    await admin.withSql(sql => sql.unsafe(`ALTER ROLE ${writerOwner} LOGIN`));
    await reject("function owner can login", qualify, "login_shape");
    await admin.withSql(sql => sql.unsafe(`ALTER ROLE ${writerOwner} NOLOGIN`));
    checks.push("actual SET ROLE/GRANT denied; transitive MEMBER and ADMIN paths detected even when SET/INHERIT=false");
    for (const privilege of ["TRUNCATE", "TRIGGER"]) {
      await db.withSql(sql => sql.unsafe(`GRANT ${privilege} ON resources TO ${runtimeRole}`));
      await reject(privilege + " privilege", qualify, "unsafe_object_privilege");
      await db.withSql(sql => sql.unsafe(`REVOKE ${privilege} ON resources FROM ${runtimeRole}`));
    }
    await db.withSql(sql => sql.unsafe(`GRANT CREATE ON SCHEMA public TO ${runtimeRole}`));
    await reject("schema CREATE", qualify, "unsafe_object_privilege");
    await db.withSql(sql => sql.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${runtimeRole}`));
    await db.withSql(sql => sql.unsafe(`GRANT CREATE ON DATABASE ${name} TO ${runtimeRole}`));
    await reject("database CREATE", qualify, "unsafe_object_privilege");
    await db.withSql(sql => sql.unsafe(`REVOKE CREATE ON DATABASE ${name} FROM ${runtimeRole}`));
    await db.withSql(sql => sql.unsafe(`CREATE TABLE public.qualification_owner_probe(id integer); ALTER TABLE public.qualification_owner_probe OWNER TO ${runtimeRole}`));
    await reject("owns catalogue relation", qualify, "unsafe_object_privilege");
    await db.withSql(sql => sql.unsafe("DROP TABLE public.qualification_owner_probe"));
    await db.withSql(sql => sql.unsafe(`GRANT INSERT ON resources TO ${writerLogin}`));
    await reject("writer direct DML", () => qualifyCatalogDatabaseRoles(writer as Database, { ...policy, connection: "writer" }), "writer_direct_dml");
    await db.withSql(sql => sql.unsafe(`REVOKE INSERT ON resources FROM ${writerLogin}`));
    await expect(runtime.withSql(sql => sql.unsafe("ALTER TABLE resources DISABLE TRIGGER ALL"))).rejects.toThrow("must be owner");
    await expect(runtime.withSql(sql => sql.unsafe("TRUNCATE resources CASCADE"))).rejects.toThrow("permission denied");
    await expect(runtime.withSql(sql => sql.unsafe("CREATE TABLE public.forged_catalogue(id integer)"))).rejects.toThrow("permission denied");
    checks.push("object/schema/database ownership and CREATE/TRIGGER/TRUNCATE permissions denied; restricted writer has no direct table DML");
    const body = "SELECT $1", signature = "public.catalog_qualification_probe(integer)";
    await db.withSql(sql => sql.unsafe(`CREATE FUNCTION public.catalog_qualification_probe(integer) RETURNS integer LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,pg_temp AS '${body}'; ALTER FUNCTION ${signature} OWNER TO ${writerOwner}`));
    const fixed: CatalogDatabaseRolePolicy = { ...policy, approvedFunctions: [{ identity: signature, sourceSha256: digest(body) }] };
    await reject("default PUBLIC function execute", () => qualifyCatalogDatabaseRoles(runtime as Database, fixed), "function_privilege");
    await db.withSql(sql => sql.unsafe(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${signature} TO ${writerLogin}`));
    expect((await qualifyCatalogDatabaseRoles(runtime, fixed)).approvedFunctions).toEqual(fixed.approvedFunctions);
    expect((await qualifyCatalogDatabaseRoles(writer, { ...fixed, connection: "writer" })).approvedFunctions).toEqual(fixed.approvedFunctions);
    await expect(runtime.withSql(sql => sql.unsafe("SELECT public.catalog_qualification_probe(7)"))).rejects.toThrow("permission denied");
    expect(await writer.withSql(sql => sql`SELECT public.catalog_qualification_probe(7) AS value`)).toMatchObject([{ value: 7 }]);
    await db.withSql(sql => sql.unsafe(`ALTER FUNCTION ${signature} SET search_path=public,pg_temp`));
    await reject("unsafe function search_path", () => qualifyCatalogDatabaseRoles(runtime as Database, fixed), "unapproved_function");
    await db.withSql(sql => sql.unsafe(`ALTER FUNCTION ${signature} SET search_path=pg_catalog,pg_temp`));
    await reject("function source hash changed", () => qualifyCatalogDatabaseRoles(runtime as Database, { ...fixed,
      approvedFunctions: [{ identity: signature, sourceSha256: digest("other body") }] }), "unapproved_function");
    await db.withSql(sql => sql.unsafe(`CREATE FUNCTION public.catalog_unapproved_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,pg_temp AS 'SELECT 1'; ALTER FUNCTION public.catalog_unapproved_probe() OWNER TO ${writerOwner}`));
    await reject("extra function owned by writer owner", () => qualifyCatalogDatabaseRoles(runtime as Database, fixed), "unapproved_function");
    await db.withSql(sql => sql.unsafe("DROP FUNCTION public.catalog_unapproved_probe()"));
    await db.withSql(sql => sql.unsafe("CREATE FUNCTION public.catalog_admin_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'SELECT 1'"));
    await reject("callable migrator-owned definer backdoor", () => qualifyCatalogDatabaseRoles(runtime as Database, fixed), "unapproved_function");
    await db.withSql(sql => sql.unsafe("REVOKE ALL ON FUNCTION public.catalog_admin_probe() FROM PUBLIC"));
    expect((await qualifyCatalogDatabaseRoles(runtime, fixed)).sessionRole).toBe(runtimeRole);
    await db.withSql(sql => sql.unsafe("DROP FUNCTION public.catalog_admin_probe()"));
    const oversizedBody = "SELECT 1 /*" + "x".repeat(70000) + "*/";
    await db.withSql(sql => sql.unsafe(`CREATE FUNCTION public.catalog_oversized_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER
      SET search_path=pg_catalog,pg_temp AS $body$${oversizedBody}$body$; ALTER FUNCTION public.catalog_oversized_probe() OWNER TO ${writerOwner};
      REVOKE ALL ON FUNCTION public.catalog_oversized_probe() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.catalog_oversized_probe() TO ${writerLogin}`));
    await reject("oversized definition withheld in SQL projection", () => qualifyCatalogDatabaseRoles(runtime as Database, { ...fixed,
      approvedFunctions: [...fixed.approvedFunctions, { identity: "public.catalog_oversized_probe()", sourceSha256: digest(oversizedBody) }] }), "unapproved_function");
    await db.withSql(sql => sql.unsafe("DROP FUNCTION public.catalog_oversized_probe()"));
    for (let index = 0; index < 17; index++) await db.withSql(sql => sql.unsafe(`CREATE FUNCTION public.catalog_bound_probe_${String(index)}() RETURNS integer
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'SELECT 1'; ALTER FUNCTION public.catalog_bound_probe_${String(index)}() OWNER TO ${writerOwner}`));
    await reject("bounded17-row function inspection rejects excess owner objects", () => qualifyCatalogDatabaseRoles(runtime as Database, fixed), "function_inspection_bound");
    for (let index = 0; index < 17; index++) await db.withSql(sql => sql.unsafe(`DROP FUNCTION public.catalog_bound_probe_${String(index)}()`));
    checks.push("fixed NOLOGIN-owner definer exact source/signature/path pinned; no default PUBLIC/runtime execute or unapproved privileged procedure");
    await reject("invalid manifest before SQL", () => qualifyCatalogDatabaseRoles(runtime as Database, { ...fixed, runtimeRole: "bad;role" }), "invalid_policy");
    await reject("missing explicit role", () => qualifyCatalogDatabaseRoles(runtime as Database, { ...fixed, writerLogin: "missing_fixture_role" }), "role_missing");
    expect((await qualifyCatalogDatabaseRoles(runtime, fixed)).sessionRole).toBe(runtimeRole);
    passed = true;
  } finally {
    await runtime?.close(); await writer?.close(); await db?.close();
    try {
      if (!fixture.retainEvidence) {
        await admin.withSql(sql => sql.unsafe(`DROP DATABASE IF EXISTS ${name}`));
        for (const role of roles) await admin.withSql(sql => sql.unsafe(`DROP ROLE IF EXISTS ${role}`));
      }
    } finally {
      await admin.close();
    }
    await fs.writeFile(path.join(directory, "role-results.json"), JSON.stringify({ passed, checks, rejections,
      scope: "readonly-role-qualification-only; no guarded admission, publication procedure or root/capability activation" }, null, 2) + "\n");
  }
}, 90000);
