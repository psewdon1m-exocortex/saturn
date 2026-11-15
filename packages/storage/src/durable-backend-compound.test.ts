import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { BackendPayloadStore, type BackendPayloadReference } from "./backend-payload-store.js";
import { LocalStorageAdapter } from "./local-storage.adapter.js";
import { BackendExecutorError, DurableBackendExecutor, type BackendCommand, type BackendExecutorIdentity, type BackendSubmitAndClaim } from "./durable-backend-executor.js";

type Payload = Readonly<Record<string, unknown>>;
type Task = { id: string; state: string; command: string; body: Record<string, unknown>; reservedBytes: string; result?: unknown; errorCode?: string };
const fixtures: { root: string; marker: string; executor: DurableBackendExecutor }[] = [];
const options = { offset: 0, create: true, exclusive: true, truncate: false };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() >= end) throw Error("Expected fixture boundary not reached"); await delay(2); }
}
function ref(payload: Payload): BackendPayloadReference {
  return (payload.body as { payloadRef: BackendPayloadReference }).payloadRef;
}
async function fixture(workers = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saturn-compound-dispatch-")), marker = randomUUID();
  await fs.writeFile(path.join(root, "OWNED-FIXTURE"), marker, { flag: "wx" });
  const backend = "unit-" + randomUUID(), generation = randomUUID(), raw = new LocalStorageAdapter(path.join(root, "raw"));
  await raw.initialize();
  const store = new BackendPayloadStore(path.join(root, "payloads"), backend, generation);
  const tasks = new Map<string, Task>(), calls: { kind: string; payload: Payload }[] = [];
  const proofs = new WeakMap<object, { identity: BackendExecutorIdentity; payload: Payload; cleanup: boolean }>();
  let identity: BackendExecutorIdentity | undefined, compoundInFlight = 0, compoundPeak = 0;
  const claim = () => {
    const task = [...tasks.values()].find(x => x.state === "QUEUED");
    if (!task) return null; task.state = "RUNNING";
    return { id: task.id, command: task.command, body: task.body, reservedBytes: task.reservedBytes };
  };
  const submit = (payload: Payload) => {
    const id = String(payload.id), previous = tasks.get(id);
    if (previous) return { id, state: previous.state, result: previous.result };
    tasks.set(id, { id, state: "QUEUED", command: String(payload.command), body: payload.body as Record<string, unknown>, reservedBytes: String(payload.reservedBytes) });
    return { id, state: "QUEUED" };
  };
  const applyCompound = (payload: Payload) => {
    const submitted = submit(payload);
    return { submitted, task: submitted.state === "QUEUED" ? claim() : null };
  };
  const state = {
    compound: async (_kind: string, _identity: BackendExecutorIdentity, payload: Payload): Promise<unknown> => applyCompound(payload),
    beforeOrdinarySubmit: (async (): Promise<void> => undefined) as (payload: Payload) => Promise<void>,
    claim: async (): Promise<unknown> => claim(),
  };
  const ordinary: BackendCommand = async (kind, current, payload) => {
    calls.push({ kind, payload }); identity = current;
    if (kind === "acquire") return { owned: true, writeOnce: true };
    if (kind === "claim") return state.claim();
    if (kind === "submit" || kind === "submit-once") { await state.beforeOrdinarySubmit(payload); return submit(payload); }
    if (kind === "status") { const t = tasks.get(String(payload.id)); if (!t) throw Error("Unknown original"); return { id: t.id, state: t.state, result: t.result, errorCode: t.errorCode }; }
    if (kind === "complete") { const t = tasks.get(String(payload.id)); if (!t) throw Error("Unknown claim"); t.state = "DONE"; t.result = payload.result; return { id: t.id, state: t.state, result: t.result }; }
    if (kind === "reject" || kind === "unknown") { const t = tasks.get(String(payload.id)); if (!t) throw Error("Unknown refusal"); t.state = kind === "reject" ? "REJECTED" : "UNKNOWN"; t.errorCode = String(payload.errorCode); return {}; }
    if (kind === "inspect") return { state: "RUNNING", generation, ownerId: current.ownerId, fencingToken: current.fencingToken, queued: [...tasks.values()].filter(t => t.state === "QUEUED").length, unknown: [...tasks.values()].filter(t => t.state === "UNKNOWN").length };
    if (["drain", "read-close", "stopped"].includes(kind)) return {};
    throw Error("Unexpected ordinary command " + kind);
  };
  const compound = Object.assign(async (kind: string, current: BackendExecutorIdentity, payload: Payload): Promise<unknown> => {
    calls.push({ kind: "compound", payload }); compoundInFlight++; compoundPeak = Math.max(compoundPeak, compoundInFlight);
    try { return await state.compound(kind, current, payload); } finally { compoundInFlight--; }
  }, { confirmsNoCommit(error: unknown, _kind: string, current: BackendExecutorIdentity, payload: Payload): boolean { return typeof error === "object" && error !== null && proofs.get(error)?.identity === current && proofs.get(error)?.payload === payload; } }) satisfies BackendSubmitAndClaim;
  const command = Object.assign(ordinary, { submitAndClaim: compound, confirmedRollback(error: unknown, _kind: string, current: BackendExecutorIdentity, payload: Payload) {
    if (!error || typeof error !== "object") return false; const proof = proofs.get(error);
    if (!proof?.cleanup || proof.identity !== current || proof.payload !== payload) return false;
    proofs.delete(error); return true;
  } });
  const executor = new DurableBackendExecutor(raw, command, backend, generation, 0, undefined, { payloads: store, workers });
  const f = { root, marker, raw, store, tasks, calls, state, command, executor, claim, submit, applyCompound,
    get identity() { return identity; }, get compoundPeak() { return compoundPeak; },
    prove(error: object, current: BackendExecutorIdentity, payload: Payload, cleanup: boolean) { proofs.set(error, { identity: current, payload, cleanup }); },
    async ready() { await executor.start(); await until(() => calls.some(x => x.kind === "claim")); await delay(2); },
  };
  fixtures.push(f); return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.executor.close().catch(() => undefined);
    const resolved = path.resolve(f.root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("saturn-compound-dispatch-")
      || (await fs.lstat(resolved)).isSymbolicLink() || await fs.readFile(path.join(resolved, "OWNED-FIXTURE"), "utf8") !== f.marker) throw Error("Not an owned fixture");
    await fs.rm(resolved, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
it("starts physical I/O only after the exact compound claim reply and replays the original without another write", async () => {
  const f = await fixture(), entered = deferred(), ack = deferred(), id = randomUUID(), bytes = Buffer.from("same original");
  const rawWrites = vi.spyOn(f.raw, "write"); await f.ready();
  f.state.compound = async (_kind, _identity, payload) => { const result = f.applyCompound(payload); entered.resolve(); await ack.promise; return result; };
  const write = f.executor.writeOnce(id, "original.bin", bytes, options); await entered.promise;
  try { expect(f.tasks.get(id)?.state).toBe("RUNNING"); expect(rawWrites).not.toHaveBeenCalled(); }
  finally { ack.resolve(); }
  expect(await write).toBe(bytes.length); expect(await fs.readFile(path.join(f.root, "raw/original.bin"))).toEqual(bytes);
  expect(await f.executor.writeOnce(id, "original.bin", bytes, options)).toBe(bytes.length);
  expect(rawWrites).toHaveBeenCalledTimes(1); expect(f.tasks.size).toBe(1);
});
it("executes a peer original returned by the compound claim and then drains the local original", async () => {
  const f = await fixture(), peer = randomUUID(), id = randomUUID(), peerBytes = Buffer.from("peer original"), local = Buffer.from("local original");
  let returnedPeer: string | undefined; await f.ready();
  f.state.compound = async (_kind, _identity, payload) => {
    f.tasks.set(peer, { id: peer, state: "QUEUED", command: "write", reservedBytes: String(peerBytes.length), body: { path: "peer.bin", bytes: peerBytes.toString("base64"), options } });
    const result = f.applyCompound(payload); returnedPeer = result.task?.id; return result;
  };
  expect(await f.executor.writeOnce(id, "local.bin", local, options)).toBe(local.length);
  expect(returnedPeer).toBe(peer); expect(f.tasks.get(peer)?.state).toBe("DONE"); expect(f.tasks.get(id)?.state).toBe("DONE");
  expect(await fs.readFile(path.join(f.root, "raw/peer.bin"))).toEqual(peerBytes);
  expect(await fs.readFile(path.join(f.root, "raw/local.bin"))).toEqual(local);
});
it("keeps one claim observer and at most four physical workers under twelve concurrent originals", async () => {
  const f = await fixture(4), release = deferred(); let active = 0, peak = 0, entered = 0;
  const rawWrite = f.raw.write.bind(f.raw); await f.ready();
  vi.spyOn(f.raw, "write").mockImplementation(async (...args) => {
    active++; entered++; peak = Math.max(peak, active);
    try { await release.promise; return await rawWrite(...args); } finally { active--; }
  });
  const writes = Array.from({ length: 12 }, (_, n) => f.executor.writeOnce(randomUUID(), String(n) + ".bin", Buffer.from("body-" + String(n)), options));
  try { await until(() => entered === 4); expect(peak).toBe(4); expect(entered).toBe(4); }
  finally { release.resolve(); }
  await Promise.all(writes); expect(peak).toBe(4); expect(f.compoundPeak).toBe(1);
  expect(f.calls.some(x => x.kind === "submit-once")).toBe(true);
  expect([...f.tasks.values()].every(x => x.state === "DONE")).toBe(true);
});
it("retains staged bytes through an attested 55P03 and retries only ordinary idempotent submission", async () => {
  const f = await fixture(), id = randomUUID(), bytes = Buffer.from("do not discard"); let compoundCalls = 0, retained = false;
  await f.ready();
  f.state.compound = async (_kind, identity, payload) => {
    compoundCalls++; const error = Object.assign(Error("lock unavailable"), { code: "55P03" }); f.prove(error, identity, payload, false); throw error;
  };
  f.state.beforeOrdinarySubmit = async payload => { retained = (await f.store.read(ref(payload))).equals(bytes); };
  expect(await f.executor.writeOnce(id, "fallback.bin", bytes, options)).toBe(bytes.length);
  expect(retained).toBe(true); expect(compoundCalls).toBe(1); expect(f.calls.filter(x => x.kind === "submit-once")).toHaveLength(1);
});
it("deletes only a first attested refused candidate and keeps the owner usable", async () => {
  const f = await fixture(), refusal = new BackendExecutorError("capacity"); await f.ready();
  f.state.compound = async (_kind, identity, payload) => { f.prove(refusal, identity, payload, true); throw refusal; };
  await expect(f.executor.writeOnce(randomUUID(), "refused.bin", Buffer.from("fresh"), options)).rejects.toBe(refusal);
  expect(await fs.readdir(f.store.directory)).toEqual([]); expect(f.calls.filter(x => x.kind === "submit-once")).toHaveLength(0);
  f.state.compound = async (_kind, _identity, payload) => f.applyCompound(payload);
  expect(await f.executor.writeOnce(randomUUID(), "accepted.bin", Buffer.from("accepted"), options)).toBe(8);
});
it.each(["lost-reply", "malformed-reply"])("retains originals and closes without STOPPED after a unit-simulated %s", async mode => {
  const f = await fixture(), id = randomUUID(), bytes = Buffer.from("retain original"), rawWrites = vi.spyOn(f.raw, "write");
  await f.ready(); let original: Payload | undefined;
  f.state.compound = async (_kind, _identity, payload) => {
    original = payload; const committed = f.applyCompound(payload);
    if (mode === "malformed-reply") return { ...committed, unexpected: true };
    throw Object.assign(Error("unit simulated lost reply"), { code: "ECONNRESET" });
  };
  await expect(f.executor.writeOnce(id, "ambiguous.bin", bytes, options)).rejects.toBeInstanceOf(Error);
  if (!original) throw Error("No compound was sent"); expect(await f.store.read(ref(original))).toEqual(bytes);
  expect(f.tasks.get(id)?.state).toBe("RUNNING"); expect(rawWrites).not.toHaveBeenCalled();
  expect(f.calls.filter(x => x.kind === "submit-once")).toHaveLength(0);
  await expect(f.executor.close()).rejects.toBeInstanceOf(AggregateError);
  expect(f.calls.some(x => x.kind === "stopped")).toBe(false);
});
it("cancels unsent local work during close and joins the observer without sending a compound", async () => {
  const f = await fixture(), initial = deferred(), finish = deferred(), staged = deferred();
  let first = true;
  f.state.claim = async () => { if (first) { first = false; initial.resolve(); await finish.promise; } return f.claim(); };
  const put = f.store.put.bind(f.store);
  vi.spyOn(f.store, "put").mockImplementation(async bytes => { const value = await put(bytes); staged.resolve(); return value; });
  await f.executor.start(); await initial.promise;
  const write = f.executor.writeOnce(randomUUID(), "never-sent.bin", Buffer.from("unsent"), options).catch((error: unknown) => error);
  await staged.promise; await delay(2);
  const close = f.executor.close(); finish.resolve();
  expect(await write).toMatchObject({ code: "backend_draining" }); await close;
  expect(f.calls.some(x => x.kind === "compound" || x.kind === "submit-once")).toBe(false);
  expect(await fs.readdir(f.store.directory)).toEqual([]);
  expect(f.calls.filter(x => x.kind === "stopped")).toHaveLength(1);
});
