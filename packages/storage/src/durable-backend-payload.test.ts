import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { BackendPayloadStore, type BackendPayloadReference } from "./backend-payload-store.js";
import { LocalStorageAdapter } from "./local-storage.adapter.js";
import { BackendExecutorError, DurableBackendExecutor, type BackendCommand, type BackendExecutorIdentity } from "./durable-backend-executor.js";

const roots: string[] = [], executors: DurableBackendExecutor[] = [];
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.close();
  for (const root of roots.splice(0)) {
    if (!path.isAbsolute(root) || path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("saturn-payload-rollback-")) throw Error("Invalid own fixture cleanup root");
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const requestKey = (command: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>) => JSON.stringify([command, identity, payload]);
function payloadReference(payload: Readonly<Record<string, unknown>>): BackendPayloadReference {
  const body = payload.body;
  if (!body || typeof body !== "object" || !("payloadRef" in body)) throw Error("Missing staged ref");
  const ref = body.payloadRef;
  if (!ref || typeof ref !== "object" || !("id" in ref) || typeof ref.id !== "string" || !("size" in ref) || typeof ref.size !== "string" || !("sha256" in ref) || typeof ref.sha256 !== "string") throw Error("Invalid staged ref");
  return { id: ref.id, size: ref.size, sha256: ref.sha256 };
}
type Submit = (command: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>) => Promise<unknown>;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-payload-rollback-")); roots.push(root);
  const generation = randomUUID(), backend = "fixture-" + randomUUID(), raw = new LocalStorageAdapter(path.join(root, "raw")); await raw.initialize();
  const original = Buffer.from("exact durable transfer"), options = { offset: 0, create: true, exclusive: true, truncate: false };
  await raw.write("original.bin", Readable.from(original), options);
  const store = new BackendPayloadStore(path.join(root, "payloads"), backend, generation), originalRef = await store.put(original), taskId = randomUUID();
  const originalTask = Object.freeze({ id: taskId, state: "DONE", result: original.length, payloadRef: originalRef });
  const submissions: { command: string; identity: BackendExecutorIdentity; payload: Readonly<Record<string, unknown>>; ref: BackendPayloadReference }[] = [];
  const proofs = new WeakMap<object, string>();
  const state: { submit: Submit } = { submit: async () => { throw Error("Set fixture submission outcome"); } };
  const command: BackendCommand = Object.assign(async (kind: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>) => {
    if (kind === "acquire") return { owned: false, writeOnce: true, writeVerifiedOnce: true };
    if (kind === "read-close") return {};
    if (kind !== "submit" && kind !== "submit-once") throw Error("Unexpected fixture command " + kind);
    submissions.push({ command: kind, identity, payload, ref: payloadReference(payload) }); return state.submit(kind, identity, payload);
  }, {
    confirmedRollback(error: unknown, kind: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>): boolean {
      if (!error || typeof error !== "object" || proofs.get(error) !== requestKey(kind, identity, payload)) return false;
      proofs.delete(error); return true;
    },
  });
  const refuse = (kind: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>) => {
    const error = new BackendExecutorError("operation_reused"); proofs.set(error, requestKey(kind, identity, payload)); return error;
  };
  const make = () => { const executor = new DurableBackendExecutor(raw, command, backend, generation, 0, undefined, { payloads: store }); executors.push(executor); return executor; };
  const unchanged = async () => {
    expect(await fs.readFile(path.join(root, "raw/original.bin"))).toEqual(original);
    expect(digest(await store.read(originalRef))).toBe(digest(original)); expect(originalTask).toEqual({ id: taskId, state: "DONE", result: original.length, payloadRef: originalRef });
  };
  return { root, raw, store, original, originalRef, originalTask, taskId, options, submissions, state, refuse, make, unchanged };
}
type Mode = "once" | "verified" | "ordinary";
function write(mode: Mode, executor: DurableBackendExecutor, taskId: string, bytes: Buffer, options: { offset: number; create: boolean; exclusive: boolean; truncate: boolean }) {
  if (mode === "once") return executor.writeOnce(taskId, "original.bin", bytes, options);
  if (mode === "verified") return executor.writeVerifiedOnce(taskId, "original.bin", bytes);
  return executor.write("original.bin", Readable.from(bytes), options);
}
it.each(["once", "verified", "ordinary"] as const)("cleans only the fresh %s candidate after first attested refusal and preserves original bytes/ref/task", async mode => {
  const f = await fixture(), executor = f.make(), rawWrites = vi.spyOn(f.raw, "write"), bytes = Buffer.from("different bytes");
  let refusal: unknown; f.state.submit = async (kind, identity, payload) => { refusal = f.refuse(kind, identity, payload); throw refusal; };
  const failure = await write(mode, executor, f.taskId, bytes, f.options).catch((error: unknown) => error); expect(failure).toBe(refusal);
  expect(f.submissions).toHaveLength(1); expect(await fs.readdir(f.store.directory)).toEqual([f.originalRef.id + ".payload"]);
  expect(rawWrites).not.toHaveBeenCalled(); await f.unchanged();
});
it.each(["once", "verified", "ordinary"] as const)("retains %s payload after ambiguous first failure despite attested refusal on retry", async mode => {
  const f = await fixture(), executor = f.make(), lost = Error("lost submit ACK"), bytes = Buffer.from("different bytes");
  f.state.submit = async (kind, identity, payload) => { if (f.submissions.length === 1) throw lost; throw f.refuse(kind, identity, payload); };
  await expect(write(mode, executor, f.taskId, bytes, f.options)).rejects.toBe(lost); expect(f.submissions).toHaveLength(2);
  const ref = f.submissions[0]?.ref; if (!ref) throw Error("Missing candidate");
  expect(f.submissions[1]?.ref).toEqual(ref); expect(await f.store.read(ref)).toEqual(bytes); await f.unchanged();
});
it.each(["once", "verified", "ordinary"] as const)("retains both original and %s candidate on UNKNOWN", async mode => {
  const f = await fixture(), executor = f.make(), bytes = Buffer.from("different bytes");
  f.state.submit = async () => ({ id: f.taskId, state: "UNKNOWN" });
  await expect(write(mode, executor, f.taskId, bytes, f.options)).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.submissions).toHaveLength(1); const ref = f.submissions[0]?.ref; if (!ref) throw Error("Missing candidate");
  expect(await f.store.read(ref)).toEqual(bytes); await f.unchanged();
});
it.each(["plain", "properties", "string", "forged-cause"])("does not trust an unsealed refusal claim: %s", async kind => {
  const f = await fixture(), executor = f.make(), bytes = Buffer.from("different bytes"); let failure: unknown;
  f.state.submit = async (command, identity, payload) => {
    failure ??= kind === "string" ? "operation_reused" : Object.assign(Error("operation_reused"), kind === "plain" ? {} : { code: "operation_reused", sqlState: "P0001", confirmedRollback: true,
      ...(kind === "forged-cause" ? { cause: f.refuse(command, identity, payload) } : {}) });
    throw failure;
  };
  const observed = await executor.writeOnce(f.taskId, "original.bin", bytes, f.options).catch((error: unknown) => error); expect(observed).toBe(failure);
  expect(f.submissions).toHaveLength(2); const ref = f.submissions[0]?.ref; if (!ref) throw Error("Missing candidate");
  expect(await f.store.read(ref)).toEqual(bytes); await f.unchanged();
});
it("joins matching concurrent refs chosen by the second submit without replacing its task or repeating physical bytes", async () => {
  const f = await fixture(), first = f.make(), second = f.make(), bytes = Buffer.from("one effect"), taskId = randomUUID(), rawWrites = vi.spyOn(f.raw, "write");
  let firstEntered: (() => void) | undefined, finish: (() => void) | undefined;
  const entered = new Promise<void>(resolve => { firstEntered = resolve; }), done = new Promise<void>(resolve => { finish = resolve; });
  let chosen: BackendPayloadReference | undefined;
  f.state.submit = async (_kind, _identity, payload) => {
    if (f.submissions.length === 1) { firstEntered?.(); await done; }
    else {
      chosen = payloadReference(payload);
      expect((await fs.readdir(f.store.directory)).length).toBe(3);
      await f.raw.write("new.bin", Readable.from(await f.store.read(chosen)), f.options); finish?.();
    }
    return { id: taskId, state: "DONE", result: bytes.length };
  };
  const a = first.writeOnce(taskId, "new.bin", bytes, f.options); await entered;
  const b = second.writeOnce(taskId, "new.bin", bytes, f.options); expect(await Promise.all([a, b])).toEqual([bytes.length, bytes.length]);
  expect(chosen).toEqual(f.submissions[1]?.ref); expect(chosen).not.toEqual(f.submissions[0]?.ref);
  expect(rawWrites).toHaveBeenCalledExactlyOnceWith("new.bin", expect.any(Readable), f.options);
  expect(await fs.readFile(path.join(f.root, "raw/new.bin"))).toEqual(bytes);
  expect(await fs.readdir(f.store.directory)).toEqual([f.originalRef.id + ".payload"]); await f.unchanged();
});
it("preserves both failures and candidate when refusal cleanup fails, then closes new puts only", async () => {
  const f = await fixture(), executor = f.make(), removeFailure = Error("fixture file is busy"), bytes = Buffer.from("different bytes"), put = vi.spyOn(f.store, "put");
  vi.spyOn(f.store, "remove").mockRejectedValueOnce(removeFailure); let originalFailure: unknown;
  f.state.submit = async (kind, identity, payload) => { originalFailure = f.refuse(kind, identity, payload); throw originalFailure; };
  const failure = await executor.writeOnce(f.taskId, "original.bin", bytes, f.options).catch((error: unknown) => error);
  if (!(failure instanceof BackendExecutorError) || !(failure.cause instanceof AggregateError)) throw Error("Expected preserved aggregate cleanup failure");
  expect(failure.code).toBe("payload_cleanup_failed"); expect(failure.cause.errors).toEqual([originalFailure, removeFailure]);
  const ref = f.submissions[0]?.ref; if (!ref) throw Error("Missing candidate"); expect(await f.store.read(ref)).toEqual(bytes);
  for (const mode of ["once", "verified", "ordinary"] as const) await expect(write(mode, executor, f.taskId, bytes, f.options)).rejects.toBe(failure);
  expect(put).toHaveBeenCalledTimes(1); expect(f.submissions).toHaveLength(1); await f.unchanged();
});

it.each(["once", "verified", "ordinary"] as const)("does not stage fresh %s payloads after a known owner failure or close", async mode => {
  const f = await fixture(), failure = Error("owned claim failed"), calls: string[] = [];
  const command: BackendCommand = async kind => {
    calls.push(kind);
    if (kind === "acquire") return { owned: true, writeOnce: true, writeVerifiedOnce: true };
    if (kind === "claim") throw failure;
    if (kind === "drain") return {};
    throw Error("Unexpected failed-owner command " + kind);
  };
  // This failed executor owns its explicit close below; the shared afterEach
  // list is reserved for fixtures whose close can confirm STOPPED successfully.
  const executor = new DurableBackendExecutor(f.raw, command, "failed-owner", randomUUID(), 0, undefined, { payloads: f.store });
  const put = vi.spyOn(f.store, "put"), rawWrites = vi.spyOn(f.raw, "write"), rawClose = vi.spyOn(f.raw, "close");
  let closeFailure: unknown;
  try {
    await executor.start(); await new Promise<void>(resolve => setImmediate(resolve));
    await expect(executor.mkdir("known-failure-sentinel")).rejects.toBe(failure);
    const before = [...calls];
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(write(mode, executor, f.taskId, Buffer.from("fresh rejected payload"), f.options)).rejects.toBe(failure);
    }
    expect(calls).toEqual(before); expect(put).not.toHaveBeenCalled(); expect(rawWrites).not.toHaveBeenCalled();
    expect(await fs.readdir(f.store.directory)).toEqual([f.originalRef.id + ".payload"]); await f.unchanged();
  } finally {
    try { await executor.close(); } catch (error) { closeFailure = error; }
  }
  expect(closeFailure).toBeInstanceOf(AggregateError);
  expect((closeFailure as AggregateError).errors).toContain(failure); expect(rawClose).toHaveBeenCalledTimes(1);
  await expect(write(mode, executor, f.taskId, Buffer.from("fresh closed payload"), f.options)).rejects.toMatchObject({ code: "backend_draining" });
  expect(put).not.toHaveBeenCalled(); expect(rawWrites).not.toHaveBeenCalled();
  expect(await fs.readdir(f.store.directory)).toEqual([f.originalRef.id + ".payload"]); await f.unchanged();
});

it.each((["claim-failure", "closing", "acquire-failure"] as const).flatMap(fault =>
  (["once", "verified", "ordinary"] as const).map(mode => ({ fault, mode }))))("discards only the fresh $mode ref when $fault prevents the first submit after put", async ({ fault, mode }) => {
  const f = await fixture(), failure = Error("failure before first submit"), calls: string[] = [];
  let injected = false, release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const command: BackendCommand = async kind => {
    calls.push(kind);
    if (kind === "acquire") {
      if (injected && fault === "acquire-failure") throw failure;
      return { owned: fault !== "acquire-failure", writeOnce: true, writeVerifiedOnce: true };
    }
    if (kind === "claim") { await gate; if (fault === "claim-failure") throw failure; return null; }
    if (["drain", "read-close", "stopped"].includes(kind)) return {};
    throw Error("Unexpected pre-submit command " + kind);
  };
  const executor = new DurableBackendExecutor(f.raw, command, "pre-submit", randomUUID(), 0, undefined, { payloads: f.store });
  const put = f.store.put.bind(f.store), remove = vi.spyOn(f.store, "remove"), rawWrites = vi.spyOn(f.raw, "write");
  let closeFailure: unknown;
  vi.spyOn(f.store, "put").mockImplementation(async bytes => {
    const ref = await put(bytes); injected = true;
    if (fault === "claim-failure") {
      release(); await new Promise<void>(resolve => setImmediate(resolve));
      await expect(executor.mkdir("known-failure-during-put")).rejects.toBe(failure);
    } else if (fault === "closing") { const closing = executor.close(); release(); await closing; }
    return ref;
  });
  try {
    await executor.start();
    const rejected = write(mode, executor, f.taskId, Buffer.from("fresh unadmitted payload"), f.options);
    if (fault === "closing") await expect(rejected).rejects.toMatchObject({ code: "backend_draining" });
    else await expect(rejected).rejects.toBe(failure);
    expect(calls.filter(kind => kind === "submit" || kind === "submit-once")).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(1); expect(remove.mock.calls[0]?.[0]).not.toEqual(f.originalRef);
    expect(rawWrites).not.toHaveBeenCalled();
    expect(await fs.readdir(f.store.directory)).toEqual([f.originalRef.id + ".payload"]); await f.unchanged();
  } finally {
    release(); try { await executor.close(); } catch (error) { closeFailure = error; }
  }
  if (fault === "claim-failure") { expect(closeFailure).toBeInstanceOf(AggregateError); expect((closeFailure as AggregateError).errors).toContain(failure); }
  else expect(closeFailure).toBeUndefined();
});
