import { randomBytes } from "node:crypto";

/** A new source-CI LOGIN owns its credential; the administrator URI is only an endpoint. */
export function freshFixtureLogin(databaseUrl: string, role: string): { url: string; createRoleSql: string } {
  const suffix = /^wr_([a-f0-9]{32})$/.exec(role)?.[1];
  const url = new URL(databaseUrl);
  if (!suffix || !["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
    || !url.port || url.pathname !== "/stage3_" + suffix) throw new Error("fresh_fixture_login_scope_invalid");
  // This generated alphabet cannot terminate the SQL password literal.
  const password = randomBytes(32).toString("base64url");
  url.username = role;
  url.password = password;
  return { url: url.toString(), createRoleSql: `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT` };
}
