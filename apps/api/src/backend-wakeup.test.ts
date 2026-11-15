import { requireDefined } from "../../../packages/contracts/src/require-defined.js";
import { afterEach, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { DurableBackendExecutor, type BackendCommand } from "../../../packages/storage/src/durable-backend-executor.js";
import type { StorageAdapter } from "../../../packages/storage/src/types.js";

afterEach(() => vi.useRealTimers());
function fixture(lostAck = false) {
  let owned = false;
  const tasks = new Map<string, Record<string, unknown>>();
  const mkdir = vi.fn(async () => {});
  const raw: StorageAdapter = {
    mkdir, rename: vi.fn(async () => {}), copy: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    truncate: vi.fn(async () => {}), write: vi.fn(async () => 0), close: vi.fn(async () => {}),
    exists: async () => false, openRead: async () => Readable.from([]), list: async () => ({ entries: [] }),
    statFs: async () => ({ totalBytes: 1e10, availableBytes: 1e10 }),
    stat: async () => ({ path: "", name: "", type: "file", size: 0, modifiedAt: new Date() }),
  };
  const command: BackendCommand = async (name, _identity, p) => {
    if (name === "acquire") { owned = true; return { owned }; }
    if (name === "submit") { if (!tasks.has(String(p.id))) tasks.set(String(p.id), { ...p, state: "QUEUED" }); return { ...tasks.get(String(p.id)) }; }
    if (name === "claim") { const task = [...tasks.values()].find(t => t.state === "QUEUED"); if (task) task.state = "RUNNING"; return task ? { ...task } : null; }
    if (name === "status") return { ...tasks.get(String(p.id)) };
    if (name === "complete") { Object.assign(requireDefined(tasks.get(String(p.id))), { state: "DONE", result: p.result }); if (lostAck) throw Error("lost SQL ACK"); }
    return {};
  };
  return { raw, mkdir, tasks, command, executor: new DurableBackendExecutor(raw, command, "backend", "generation") };
}
it.each([false, true])("local submit/completion wakes without polling delay; lost ACK=%s never replays raw effect", async lostAck => {
  vi.useFakeTimers();
  const f = fixture(lostAck); await f.executor.start(); await vi.advanceTimersByTimeAsync(1);
  let finished = false;
  const pending = f.executor.mkdir("file").then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(1);
  expect(finished).toBe(true); expect(f.mkdir).toHaveBeenCalledTimes(1);
  expect([...f.tasks.values()].map(t => t.state)).toEqual(["DONE"]);
  await pending; const closed = f.executor.close(); await vi.advanceTimersByTimeAsync(1); await closed;
  expect(vi.getTimerCount()).toBe(0);
});
it("remote submissions still use bounded polling without a local notification", async () => {
  vi.useFakeTimers(); const f = fixture();
  await f.executor.start(); await vi.advanceTimersByTimeAsync(1);
  // Bypass local wake exactly as a different process would.
  await f.command("submit", f.executor.identity, { id: "remote", command: "mkdir", body: { path: "remote" }, reservedBytes: "0" });
  expect(f.mkdir).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100); expect(f.mkdir).toHaveBeenCalledExactlyOnceWith("remote");
  const closed = f.executor.close(); await vi.advanceTimersByTimeAsync(1); await closed;
});
it("a submit racing an in-flight empty claim reply cannot lose its wakeup", async () => {
  vi.useFakeTimers(); const f = fixture(); let release!: () => void, first = true;
  const claimed = new Promise<void>(resolve => { release = resolve; });
  const executor = new DurableBackendExecutor(f.raw, async (name, id, payload) => {
    if (name === "claim" && first) { first = false; await claimed; return null; }
    return f.command(name, id, payload);
  }, "backend", "generation");
  await executor.start(); let finished = false;
  const operation = executor.mkdir("racing").then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(1); release(); await vi.advanceTimersByTimeAsync(1);
  expect(finished).toBe(true); expect(f.mkdir).toHaveBeenCalledExactlyOnceWith("racing"); await operation;
  const closed = executor.close(); await vi.advanceTimersByTimeAsync(1); await closed;
});

it('uses one bounded queue observer for four idle workers',async()=>{
  vi.useFakeTimers();const f=fixture(),send=vi.fn(f.command),executor=new DurableBackendExecutor(f.raw,send,'backend','generation',268435456,undefined,{workers:4});
  await executor.start();await vi.advanceTimersByTimeAsync(1);
  expect(send.mock.calls.filter(([command])=>command==='claim')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(300);
  expect(send.mock.calls.filter(([command])=>command==='claim')).toHaveLength(4);
  const close=executor.close();await vi.advanceTimersByTimeAsync(1);await close;expect(vi.getTimerCount()).toBe(0);
});

it('does not query an empty queue after every local effect while still polling remote work',async()=>{
  vi.useFakeTimers();const f=fixture(),send=vi.fn(f.command),executor=new DurableBackendExecutor(f.raw,send,'backend','generation');
  await executor.start();await vi.advanceTimersByTimeAsync(1);
  for(let n=0;n<16;n++){
    const work=executor.mkdir('local-'+String(n));await vi.advanceTimersByTimeAsync(2);await work;
  }
  expect(f.mkdir).toHaveBeenCalledTimes(16);
  expect(send.mock.calls.filter(([command])=>command==='claim').length).toBeLessThanOrEqual(18);
  await f.command('submit',executor.identity,{id:'peer',command:'mkdir',body:{path:'peer'},reservedBytes:'0'});
  await vi.advanceTimersByTimeAsync(100);expect(f.mkdir).toHaveBeenCalledTimes(17);
  const close=executor.close();await vi.advanceTimersByTimeAsync(1);await close;
});

it('serializes queue claims while allowing four effects and retaining the fifth in the durable queue',async()=>{
  vi.useFakeTimers();const f=fixture();let release!:()=>void,active=0,peak=0,claimActive=0,claimPeak=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.mkdir.mockImplementation(async()=>{active++;peak=Math.max(peak,active);try{await gate;}finally{active--;}});
  const executor=new DurableBackendExecutor(f.raw,async(command,identity,payload)=>{
    if(command!=='claim')return f.command(command,identity,payload);
    claimActive++;claimPeak=Math.max(claimPeak,claimActive);
    try{await new Promise<void>(resolve=>setTimeout(resolve,2));return await f.command(command,identity,payload);}finally{claimActive--;}
  },'backend','generation',268435456,undefined,{workers:4});
  await executor.start();const operations=Array.from({length:5},(_,n)=>executor.mkdir('concurrent-'+String(n)));
  await vi.advanceTimersByTimeAsync(20);
  expect(peak).toBe(4);expect(f.mkdir).toHaveBeenCalledTimes(4);expect(claimPeak).toBe(1);
  expect([...f.tasks.values()].filter(t=>t.state==='QUEUED')).toHaveLength(1);
  release();await vi.advanceTimersByTimeAsync(30);await Promise.all(operations);
  expect(f.mkdir).toHaveBeenCalledTimes(5);expect(peak).toBe(4);expect([...f.tasks.values()].every(t=>t.state==='DONE')).toBe(true);
  const close=executor.close();await vi.advanceTimersByTimeAsync(10);await close;expect(vi.getTimerCount()).toBe(0);
});
