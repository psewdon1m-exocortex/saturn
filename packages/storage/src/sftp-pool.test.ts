import type { EventEmitter } from "node:events";
import type { SaturnConfig } from "@saturn/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callSftp, SftpConnectionPool } from "./sftp-pool.js";

const fixture = vi.hoisted(() => ({ clients: [] as Array<EventEmitter & { channel: EventEmitter }>, failures: [] as string[] }));
vi.mock("node:fs/promises", () => ({ default: { readFile: async () => "fixture-password" } }));
vi.mock("ssh2", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return { Client: class extends Emitter {
    readonly channel = Object.assign(new Emitter(),{stat() { /* Lost RPC callback. */ }});
    constructor() { super(); fixture.clients.push(this); }
    connect() { const failure=fixture.failures.shift(); queueMicrotask(() => failure ? this.emit("error",Object.assign(new Error(failure),{code:failure})) : this.emit("ready")); return this; }
    setNoDelay() { return this; }
    sftp(callback: (error: undefined, channel: EventEmitter) => void) { callback(undefined, this.channel); }
    end() { queueMicrotask(() => { this.emit("end"); this.emit("close"); }); return this; }
    destroy() { this.emit("close"); return this; }
  } };
});

const config: SaturnConfig["storage"] = {
  host: "fixture.invalid", port: 22, username: "saturn", root: "/fixture",
  hostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", authMode: "password_file",
  passwordFile: "/fixture/unused", operationTimeoutMs: 1000, healthTimeoutMs: 1000, maxConnections: 1,
};
beforeEach(() => { fixture.clients.length = 0; fixture.failures.length = 0; });
describe("SFTP idle connection recovery", () => {
  it("interrupts metadata RPC immediately on channel loss without a callback",async()=>{
    const pool=new SftpConnectionPool(config);
    try {
      const lease=await pool.acquire(),start=Date.now();
      const failure=expect(callSftp(lease.sftp,"stat",60000,"/valuable")).rejects.toThrow("transport disconnected");
      fixture.clients[0]?.channel.emit("close");await failure;expect(Date.now()-start).toBeLessThan(1000);
      await lease.release(true);
      const fresh=await pool.acquire();expect(fresh.sftp).not.toBe(lease.sftp);await fresh.release();
    }finally {await pool.close();}
  });
  it("retries a transient connection refusal once within the original budget",async()=>{
    fixture.failures.push("ECONNREFUSED");const pool=new SftpConnectionPool(config);
    try { const lease=await pool.acquire();expect(fixture.clients).toHaveLength(2);await lease.release(); }finally {await pool.close();}
  });
  it.each(["HOST_KEY_REJECTED","AUTHENTICATION_FAILED"])("does not retry %s",async(code)=>{
    fixture.failures.push(code);const pool=new SftpConnectionPool(config);
    try {await expect(pool.acquire()).rejects.toThrow(code);expect(fixture.clients).toHaveLength(1);}finally {await pool.close();}
  });
  it("stops after two transient failures and permits a subsequent operation to recover",async()=>{
    fixture.failures.push("ECONNRESET","ECONNRESET");const pool=new SftpConnectionPool(config);
    try {await expect(pool.acquire()).rejects.toThrow("ECONNRESET");expect(fixture.clients).toHaveLength(2);const lease=await pool.acquire();await lease.release();}finally {await pool.close();}
  });
  it.each(["end", "close", "channel"])("replaces a connection after its idle %s event", async (event) => {
    const pool = new SftpConnectionPool(config);
    try {
      const first = await pool.acquire(); await first.release();
      const client = fixture.clients[0]; if (client === undefined) throw new Error("Client missing");
      if (event === "channel") client.channel.emit("close"); else client.emit(event);
      expect(first.disconnected?.aborted).toBe(true);
      const replacement = await pool.acquire();
      expect(replacement.disconnected?.aborted).toBe(false);
      expect(replacement.sftp).not.toBe(first.sftp);
      expect(fixture.clients).toHaveLength(2);
      await replacement.release();
    } finally { await pool.close(); }
  });
  it("reuses a healthy idle connection without opening another transport", async () => {
    const pool = new SftpConnectionPool(config);
    try {
      const first = await pool.acquire(); await first.release();
      const second = await pool.acquire();
      expect(second.sftp).toBe(first.sftp); expect(fixture.clients).toHaveLength(1);
      await second.release();
    } finally { await pool.close(); }
  });
});
