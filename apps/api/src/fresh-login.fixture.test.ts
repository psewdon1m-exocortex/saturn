import { expect, it } from "vitest";
import { freshFixtureLogin } from "./fresh-login.fixture.js";

const suffix = "0123456789abcdef0123456789abcdef", role = "wr_" + suffix;
const administrator = `postgres://postgres:dummy%40admin%3Apassword@127.0.0.1:55431/stage3_${suffix}?application_name=owned-fixture`;

it("creates a unique 256-bit LOGIN password independent of administrator credentials", () => {
  const first = freshFixtureLogin(administrator, role), second = freshFixtureLogin(administrator, role);
  const password = new URL(first.url).password;
  expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(password, "base64url")).toHaveLength(32);
  expect(password).not.toBe(new URL(administrator).password);
  expect(password).not.toBe(new URL(second.url).password);
  expect(first.createRoleSql).toBe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
});

it("preserves the exact fresh endpoint and query while replacing only LOGIN identity and password", () => {
  const login = freshFixtureLogin(administrator, role), url = new URL(login.url), before = new URL(administrator);
  expect(url.username).toBe(role);
  expect([url.protocol, url.hostname, url.port, url.pathname, url.search]).toEqual([before.protocol, before.hostname, before.port, before.pathname, before.search]);
  expect(before.password).toBe("dummy%40admin%3Apassword");
  expect(url.password).not.toContain("'");
});

it.each(["wr_" + suffix + "; DROP ROLE postgres", "wr_" + suffix.toUpperCase(), "postgres"])("refuses an unowned or injectable role %s", invalid => {
  expect(() => freshFixtureLogin(administrator, invalid)).toThrow("fresh_fixture_login_scope_invalid");
});

it.each([
  administrator.replace("127.0.0.1", "fixture.example"),
  administrator.replace("/stage3_" + suffix, "/postgres"),
  administrator.replace("postgres:", "https:"),
])("refuses an endpoint outside the fresh fixture scope", invalid => {
  expect(() => freshFixtureLogin(invalid, role)).toThrow("fresh_fixture_login_scope_invalid");
});
