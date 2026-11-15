import { beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { Database } from "./index.js";

interface Call { readonly query: string; readonly values: readonly unknown[] }
const transport = vi.hoisted(() => {
  const state: { calls: Call[]; respond: (call: Call) => unknown } = { calls: [], respond: () => [] };
  return state;
});
vi.mock("postgres", async importOriginal => {
  const actual = await importOriginal<{ default: typeof postgres }>();
  const factory = () => {
    const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { query: strings.join("?"), values }; transport.calls.push(call);
      return Promise.resolve().then(() => transport.respond(call));
    };
    return Object.assign(query, { reserve: async () => Object.assign(query, { release: () => undefined }), end: async () => undefined });
  };
  return { ...actual, default: Object.assign(factory, { PostgresError: actual.default.PostgresError }) };
});
const identity = { backendIdentity: "fixture", generation: "generation", ownerId: "owner", fencingToken: "fence" };
const payload = { id: "task", command: "write", body: { payloadRef: { id: "fresh", size: "15", sha256: "a".repeat(64) } }, reservedBytes: "15" };
const refusal = (message = "operation_reused", severity = "ERROR", code = "P0001") => {
  // The driver's implementation takes parsed ErrorResponse fields; its public
  // declaration inherits Error's string constructor instead.
  const error: unknown = Reflect.construct(postgres.PostgresError, [{ message, severity, code }]);
  if (!(error instanceof postgres.PostgresError)) throw Error("Expected actual driver error class");
  return error;
};
// A transport rejection is untrusted, including a non-Error external value.
const rejectTransport = (failure: unknown): never => { throw failure; };
beforeEach(() => { transport.calls.length = 0; transport.respond = () => [{ value: {} }]; });

it.each(["operation_reused", "capacity", "backend_draining", "invalid_input"])("attests only direct fixed SQL rollback %s with exact request/witness/Database", async reason => {
  const db = new Database("postgres://fixture.invalid/unit"), other = new Database("postgres://fixture.invalid/unit"), witness = {}, error = refusal(reason);
  transport.respond = () => { throw error; };
  await expect(db.backendCommand("submit-once", identity, payload, witness)).rejects.toBe(error);
  expect(db.confirmsBackendRollback(error, "submit-once", identity, payload, witness)).toBe(true);
  expect(db.confirmsBackendRollback(error, "submit", identity, payload, witness)).toBe(false);
  expect(db.confirmsBackendRollback(error, "submit-once", { ...identity, generation: "other" }, payload, witness)).toBe(false);
  expect(db.confirmsBackendRollback(error, "submit-once", identity, { ...payload, reservedBytes: "16" }, witness)).toBe(false);
  expect(db.confirmsBackendRollback(error, "submit-once", identity, payload, {})).toBe(false);
  expect(other.confirmsBackendRollback(error, "submit-once", identity, payload, witness)).toBe(false);
  expect(transport.calls).toHaveLength(1); expect(transport.calls[0]?.query).toContain("public.sync_backend_command");
  await db.close(); await other.close();
});
it.each([
  Object.assign(Error("operation_reused"), { code: "P0001", severity: "ERROR" }),
  refusal("operation_reused", "FATAL"), refusal("operation_reused", "ERROR", "08006"), refusal("reconciliation_required"), "operation_reused",
])("refuses unsealed, fatal, transport and unknown errors %#", async error => {
  const db = new Database("postgres://fixture.invalid/unit"), witness = {}; transport.respond = () => rejectTransport(error);
  await expect(db.backendCommand("submit", identity, payload, witness)).rejects.toBe(error);
  expect(db.confirmsBackendRollback(error, "submit", identity, payload, witness)).toBe(false); await db.close();
});
it("does not attest a capability probe error or a non-submission command", async () => {
  const db = new Database("postgres://fixture.invalid/unit", { maintenanceBarrier: true }), witness = {}, error = refusal();
  transport.respond = () => { throw error; };
  await expect(db.backendCommand("submit", identity, payload, witness)).rejects.toBe(error);
  expect(db.confirmsBackendRollback(error, "submit", identity, payload, witness)).toBe(false);
  const direct = new Database("postgres://fixture.invalid/unit");
  await expect(direct.backendCommand("status", identity, payload, witness)).rejects.toBe(error);
  expect(direct.confirmsBackendRollback(error, "status", identity, payload, witness)).toBe(false); await db.close(); await direct.close();
});
it("attests the actual atomic-maintenance backend statement rather than its probe", async () => {
  const db = new Database("postgres://fixture.invalid/unit", { maintenanceBarrier: true }), witness = {}, error = refusal();
  transport.respond = call => { if (call.query.includes("to_regprocedure")) return [{ available: true }]; throw error; };
  await expect(db.backendCommand("submit", identity, payload, witness)).rejects.toBe(error);
  expect(db.confirmsBackendRollback(error, "submit", identity, payload, witness)).toBe(true);
  expect(transport.calls.at(-1)?.query).toContain("public.sync_maintenance_command"); await db.close();
});
it("never converts a successful statement followed by unlock failure into rollback, even reusing an old driver error", async () => {
  const db = new Database("postgres://fixture.invalid/unit", { maintenanceBarrier: true }), oldWitness = {}, newWitness = {}, error = refusal();
  let failStatement = true;
  transport.respond = call => {
    if (call.query.includes("to_regprocedure")) return [{ available: false }];
    if (call.query.includes("to_regnamespace")) return [{ pending: false }];
    if (call.query.includes("public.sync_backend_command")) { if (failStatement) throw error; return [{ value: { state: "DONE" } }]; }
    if (call.query.includes("pg_advisory_unlock_shared") && !failStatement) throw error;
    return [];
  };
  await expect(db.backendCommand("submit", identity, payload, oldWitness)).rejects.toBe(error);
  expect(db.confirmsBackendRollback(error, "submit", identity, payload, oldWitness)).toBe(true); failStatement = false;
  await expect(db.backendCommand("submit", identity, payload, newWitness)).rejects.toBe(error);
  expect(db.confirmsBackendRollback(error, "submit", identity, payload, newWitness)).toBe(false); await db.close();
});
