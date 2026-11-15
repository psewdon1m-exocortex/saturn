import { createHash } from "node:crypto";
import type { Database } from "./index.js";

/** Explicit offline deployment identity, never supplied by a synchronization request. */
export interface CatalogDatabaseRolePolicy {
  readonly runtimeRole: string;
  readonly writerLogin: string;
  readonly writerOwner: string;
  readonly migratorRole: string;
  readonly connection: "runtime" | "writer";
  readonly approvedFunctions: readonly { readonly identity: string; readonly sourceSha256: string }[];
}
export class CatalogRoleQualificationError extends Error {
  constructor(readonly findings: readonly string[]) { super("catalog_database_role_unqualified: " + findings.join(",")); }
}
interface RoleRow {
  name: string; oid: string; login: boolean; superuser: boolean; create_role: boolean; create_db: boolean;
  replication: boolean; bypass_rls: boolean; privileged_membership: boolean; admin_option: boolean;
  schema_create: boolean; owns_catalogue: boolean; unsafe_table_privilege: boolean; table_mutation: boolean;
}
interface FunctionRow {
  identity: string; schema_name: string; owner: string; security_definer: boolean; language: string; configuration: string[] | null;
  source: string | null; public_execute: boolean; runtime_execute: boolean; writer_execute: boolean;
}
export interface CatalogDatabaseRoleQualification {
  readonly schema: "saturn.catalog-role-qualification.v1";
  readonly connection: "runtime" | "writer";
  readonly sessionRole: string;
  readonly runtimeRole: string;
  readonly writerLogin: string;
  readonly writerOwner: string;
  readonly migratorRole: string;
  readonly approvedFunctions: readonly { readonly identity: string; readonly sourceSha256: string }[];
  readonly scope: "readonly-point-in-time-preflight-no-root-activation";
}

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const MAX_OBJECTS = 2048;
function validatePolicy(policy: CatalogDatabaseRolePolicy): void {
  const names = [policy.runtimeRole, policy.writerLogin, policy.writerOwner, policy.migratorRole];
  if (names.some(name => !ROLE.test(name)) || new Set(names).size !== 4 || !["runtime", "writer"].includes(policy.connection)
    || policy.approvedFunctions.length > 16 || new Set(policy.approvedFunctions.map(item => item.identity)).size !== policy.approvedFunctions.length
    || policy.approvedFunctions.some(item => item.identity.length > 256 || !/^public\.[a-z_][a-z0-9_]*\([a-z0-9_, .[\]]*\)$/.test(item.identity)
      || !/^[a-f0-9]{64}$/.test(item.sourceSha256))) throw new CatalogRoleQualificationError(["invalid_policy"]);
}

/**
 * Readonly short SQL preflight. This does not install roles, grant a writer permit,
 * fence an offline administrator or make an unrestricted TS callback privileged.
 * A trusted deployment manifest pins every function owned by the privileged
 * NOLOGIN owner; the service must requalify after offline privilege changes.
 */
export async function qualifyCatalogDatabaseRoles(database: Database, input: CatalogDatabaseRolePolicy): Promise<CatalogDatabaseRoleQualification> {
  const policy = Object.freeze({ ...input, approvedFunctions: Object.freeze(input.approvedFunctions.map(item => Object.freeze({ ...item }))) });
  validatePolicy(policy);
  const expected = policy.connection === "runtime" ? policy.runtimeRole : policy.writerLogin;
  return database.transaction(async sql => {
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    await sql`SET LOCAL statement_timeout='2s'`;
    await sql`SET LOCAL lock_timeout='2s'`;
    await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
    const identity = (await sql<{ session_role: string; current_role: string; catalogue_exists: boolean; object_count: string; role_count: string }[]>`
      SELECT session_user::text AS session_role,current_user::text AS current_role,
        to_regclass('public.resources') IS NOT NULL AND to_regclass('public.operation_journal') IS NOT NULL
          AND to_regclass('public.sync_root_clock') IS NOT NULL AS catalogue_exists,
        ((SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')
         +(SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'))::text AS object_count,
        (SELECT count(*)::text FROM pg_catalog.pg_roles) AS role_count`)[0];
    if (!identity?.catalogue_exists) throw new CatalogRoleQualificationError(["catalogue_missing"]);
    if (BigInt(identity.object_count) > BigInt(MAX_OBJECTS) || BigInt(identity.role_count) > BigInt(MAX_OBJECTS))
      throw new CatalogRoleQualificationError(["inspection_bound_exceeded"]);
    const findings: string[] = [];
    if (identity.session_role !== expected || identity.current_role !== expected) findings.push("connection_identity");
    const names = [policy.runtimeRole, policy.writerLogin, policy.writerOwner, policy.migratorRole];
    const roles = await sql<RoleRow[]>`WITH catalogue_owners AS (
      SELECT c.relowner AS oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      UNION SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname='public'
      UNION SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname=current_database()
    ), privileged AS (
      SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
        OR r.rolname=ANY(${[policy.writerOwner, policy.migratorRole]}::text[]) OR r.oid IN (SELECT oid FROM catalogue_owners)
    ) SELECT r.rolname AS name,r.oid::text AS oid,r.rolcanlogin AS login,r.rolsuper AS superuser,r.rolcreaterole AS create_role,
      r.rolcreatedb AS create_db,r.rolreplication AS replication,r.rolbypassrls AS bypass_rls,
      EXISTS(SELECT 1 FROM privileged p WHERE p.oid<>r.oid AND pg_catalog.pg_has_role(r.oid,p.oid,'MEMBER')) AS privileged_membership,
      EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.admin_option AND
        (m.member=r.oid OR pg_catalog.pg_has_role(r.oid,m.member,'MEMBER'))) AS admin_option,
      pg_catalog.has_schema_privilege(r.oid,'public','CREATE') OR pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE') AS schema_create,
      r.oid IN (SELECT oid FROM catalogue_owners) AS owns_catalogue,
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND
        (pg_catalog.has_table_privilege(r.oid,c.oid,'TRUNCATE') OR pg_catalog.has_table_privilege(r.oid,c.oid,'TRIGGER'))) AS unsafe_table_privilege,
      EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p') AND
        (pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT') OR pg_catalog.has_table_privilege(r.oid,c.oid,'UPDATE')
          OR pg_catalog.has_table_privilege(r.oid,c.oid,'DELETE'))) AS table_mutation
    FROM pg_catalog.pg_roles r WHERE r.rolname=ANY(${names}::text[]) ORDER BY r.rolname`;
    for (const name of names) if (!roles.some(role => role.name === name)) findings.push("role_missing:" + name);
    if (roles.length !== names.length) throw new CatalogRoleQualificationError(Object.freeze(findings));
    for (const role of roles.filter(role => role.name !== policy.migratorRole)) {
      if (role.superuser || role.create_role || role.create_db || role.replication || role.bypass_rls) findings.push("unsafe_attributes:" + role.name);
      if (role.privileged_membership || role.admin_option) findings.push("privileged_membership:" + role.name);
      if (role.schema_create || role.owns_catalogue || role.unsafe_table_privilege) findings.push("unsafe_object_privilege:" + role.name);
      if (role.login !== (role.name !== policy.writerOwner)) findings.push("login_shape:" + role.name);
      if (role.name === policy.writerLogin && role.table_mutation) findings.push("writer_direct_dml");
    }
    const functions = await sql<FunctionRow[]>`SELECT p.oid::regprocedure::text AS identity,n.nspname AS schema_name,owner.rolname AS owner,
      p.prosecdef AS security_definer,language.lanname AS language,
      CASE WHEN octet_length(p.proconfig::text)<=4096 THEN p.proconfig ELSE NULL END AS configuration,
      CASE WHEN octet_length(p.prosrc)<=65536 THEN p.prosrc ELSE NULL END AS source,
      EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
      pg_catalog.has_function_privilege(${policy.runtimeRole},p.oid,'EXECUTE') AS runtime_execute,
      pg_catalog.has_function_privilege(${policy.writerLogin},p.oid,'EXECUTE') AS writer_execute
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid=p.proowner JOIN pg_catalog.pg_language language ON language.oid=p.prolang
      WHERE (n.nspname='public' AND owner.rolname=${policy.writerOwner})
        OR p.oid IN (SELECT pg_catalog.to_regprocedure(identity) FROM unnest(${policy.approvedFunctions.map(item => item.identity)}::text[]) identity)
        OR (p.prosecdef AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND
          ((pg_catalog.has_function_privilege(${policy.runtimeRole},p.oid,'EXECUTE') AND pg_catalog.has_schema_privilege(${policy.runtimeRole},n.oid,'USAGE'))
            OR (pg_catalog.has_function_privilege(${policy.writerLogin},p.oid,'EXECUTE') AND pg_catalog.has_schema_privilege(${policy.writerLogin},n.oid,'USAGE'))))
      ORDER BY p.oid LIMIT 17`;
    if (functions.length > 16) throw new CatalogRoleQualificationError(["function_inspection_bound"]);
    const approved: { identity: string; sourceSha256: string }[] = [];
    const qualifiedIdentity = (fn: FunctionRow) => fn.identity.slice(0, fn.identity.indexOf("(")).includes(".") ? fn.identity : fn.schema_name + "." + fn.identity;
    for (const item of policy.approvedFunctions) if (!functions.some(fn => qualifiedIdentity(fn) === item.identity)) findings.push("function_missing:" + item.identity);
    for (const fn of functions) {
      const name = qualifiedIdentity(fn);
      const expectedFunction = policy.approvedFunctions.find(item => item.identity === name);
      const sourceSha256 = fn.source === null ? "oversized" : createHash("sha256").update(fn.source).digest("hex");
      const searchPath = fn.configuration?.find(value => value.startsWith("search_path="))?.replaceAll(" ", "");
      if (!expectedFunction || fn.owner !== policy.writerOwner || !fn.security_definer || !["sql", "plpgsql"].includes(fn.language)
        || searchPath !== "search_path=pg_catalog,pg_temp" || sourceSha256 !== expectedFunction.sourceSha256)
        findings.push("unapproved_function:" + name);
      if (fn.public_execute || fn.runtime_execute || !fn.writer_execute) findings.push("function_privilege:" + name);
      approved.push({ identity: name, sourceSha256 });
    }
    if (findings.length > 0) throw new CatalogRoleQualificationError(Object.freeze(findings));
    return Object.freeze({ schema: "saturn.catalog-role-qualification.v1", connection: policy.connection,
      sessionRole: identity.session_role, runtimeRole: policy.runtimeRole, writerLogin: policy.writerLogin, writerOwner: policy.writerOwner,
      migratorRole: policy.migratorRole, approvedFunctions: Object.freeze(approved), scope: "readonly-point-in-time-preflight-no-root-activation" });
  });
}
