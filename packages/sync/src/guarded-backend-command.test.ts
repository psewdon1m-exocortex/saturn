import { expect, it, vi } from "vitest";
import { createGuardedBackendCommand } from "./guarded-backend-command.js";
import { BackendExecutorError, type BackendExecutorIdentity } from "../../storage/src/durable-backend-executor.js";

const identity: BackendExecutorIdentity = { backendIdentity: "fixture", generation: "generation", ownerId: "owner", fencingToken: "fence" };
const payload = { id: "task", body: { payloadRef: "fresh" } };
it("retains raw origin through wrapping and only verifies the exact invocation once", async () => {
  const raw = Error("operation_reused"); let captured: object | undefined;
  const writer = { backendCommand: vi.fn(async (_command: string, _identity: unknown, _payload: unknown, witness?: object) => { captured = witness; throw raw; }),
    confirmsBackendRollback: vi.fn((error: unknown, command: string, i: unknown, p: unknown, witness: object) => error === raw && command === "submit-once" && i === identity && p === payload && witness === captured) };
  const command = createGuardedBackendCommand(writer), failure = await command("submit-once", identity, payload).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(BackendExecutorError); if (!(failure instanceof Error)) throw Error("Expected wrapped error");
  expect(failure.cause).toBe(raw); expect(Object.isFrozen(captured)).toBe(true);
  expect(command.confirmedRollback?.(failure, "submit", identity, payload)).toBe(false);
  expect(command.confirmedRollback?.(failure, "submit-once", identity, payload)).toBe(true);
  expect(command.confirmedRollback?.(failure, "submit-once", identity, payload)).toBe(false);
});
it("does not inspect caller-controlled code/cause/SQLSTATE properties", async () => {
  const raw = Error("operation_reused"), writer = { backendCommand: async () => { throw raw; }, confirmsBackendRollback: vi.fn(() => true) };
  const command = createGuardedBackendCommand(writer), actual = await command("submit", identity, payload).catch((error: unknown) => error);
  const forged = Object.assign(Error("operation_reused"), { code: "operation_reused", sqlState: "P0001", cause: raw });
  for (const error of [forged, "operation_reused", { code: "operation_reused", cause: raw }]) expect(command.confirmedRollback?.(error, "submit", identity, payload)).toBe(false);
  expect(writer.confirmsBackendRollback).not.toHaveBeenCalled(); expect(actual).not.toBe(forged);
});
it("retains a failed statement without DB provenance and passes success unchanged", async () => {
  const raw = Object.assign(Error("operation_reused"), { code: "P0001" });
  const writer = { backendCommand: vi.fn(async () => { throw raw; }), confirmsBackendRollback: vi.fn(() => false) };
  const command = createGuardedBackendCommand(writer), failure = await command("submit", identity, payload).catch((error: unknown) => error);
  expect(command.confirmedRollback?.(failure, "submit", identity, payload)).toBe(false);
  const value = { state: "DONE", result: 22 }, success = createGuardedBackendCommand({ backendCommand: async () => value, confirmsBackendRollback: () => false });
  expect(await success("submit", identity, payload)).toBe(value);
});
