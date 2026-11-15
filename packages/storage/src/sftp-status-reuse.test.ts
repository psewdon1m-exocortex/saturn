import type { EventEmitter } from "node:events";
import type { SaturnConfig } from "@saturn/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SftpStorageAdapter } from "./sftp-storage.adapter.js";

interface Fixture {
  clients: Array<EventEmitter & { channel: EventEmitter }>; ends: number; calls: number;
  failure: number | "throw-numeric" | "timeout" | "disconnect" | "coded-transport";
}
const fixture = vi.hoisted<Fixture>(() => ({
  clients: [], ends: 0, calls: 0, failure: 2,
}));
vi.mock("node:fs/promises", () => ({ default: { readFile: async () => "synthetic-password" } }));
vi.mock("ssh2", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  return { Client: class extends Emitter {
    readonly channel = Object.assign(new Emitter(), {
      lstat: (_path: string, callback: (error: Error) => void) => this.rpc(callback),
      mkdir: (_path: string, _mode: unknown, callback: (error: Error) => void) => this.rpc(callback),
    });
    constructor() { super(); fixture.clients.push(this); }
    rpc(callback: (error: Error) => void) {
      fixture.calls++;
      if (fixture.failure === "timeout") return;
      if (fixture.failure === "throw-numeric") throw Object.assign(new Error("local coded error"), { code: 2 });
      if (fixture.failure === "disconnect") { this.channel.emit("close"); callback(Object.assign(new Error("status after close"), { code: 2 })); return; }
      callback(Object.assign(new Error("synthetic RPC failure"), { code: fixture.failure === "coded-transport" ? "ECONNRESET" : fixture.failure }));
    }
    connect() { queueMicrotask(() => this.emit("ready")); return this; }
    setNoDelay() { return this; }
    sftp(callback: (error: undefined, channel: EventEmitter) => void) { callback(undefined,this.channel); }
    end() { fixture.ends++; queueMicrotask(() => { this.emit("end"); this.emit("close"); }); return this; }
    destroy() { this.emit("close"); return this; }
  } };
});
const config: SaturnConfig["storage"] = {
  host: "fixture.invalid",port: 22,username: "qa",root: "/fixture",authMode: "password_file",passwordFile: "/fixture/unused",
  hostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",maxConnections: 1,operationTimeoutMs: 40,healthTimeoutMs: 40,
};
beforeEach(() => { fixture.clients.length=0; fixture.ends=0; fixture.calls=0; fixture.failure=2; });
describe("SFTP RPC status keeps a healthy transport", () => {
  it("ten expected absent probes reuse one connection without replaying an RPC", async () => {
    const storage = new SftpStorageAdapter(config);
    try {
      for (let i=0;i<10;i++) expect(await storage.exists("absent")).toBe(false);
      expect(fixture.clients).toHaveLength(1); expect(fixture.ends).toBe(0); expect(fixture.calls).toBe(10);
    } finally { await storage.close(); }
  });
  it.each([1,2,3,4,8])("propagates valid callback status %s without closing or retrying the channel", async code => {
    fixture.failure=code; const storage=new SftpStorageAdapter(config);
    try {
      await expect(storage.mkdir("collision-or-denied")).rejects.toMatchObject({ code });
      await expect(storage.stat("logical-failure")).rejects.toMatchObject({ code });
      expect(fixture.clients).toHaveLength(1); expect(fixture.ends).toBe(0); expect(fixture.calls).toBe(2);
    } finally { await storage.close(); }
  });
  it.each([5,6,7,99,"throw-numeric","coded-transport","disconnect","timeout"] as const)("retires failed or unproven transport error %s and permits a new connection", async failure => {
    fixture.failure=failure; const storage=new SftpStorageAdapter(config);
    try {
      await expect(storage.stat("unproven")).rejects.toBeInstanceOf(Error);
      expect(fixture.clients).toHaveLength(1); expect(fixture.ends).toBe(1);
      fixture.failure=2; expect(await storage.exists("absent")).toBe(false);
      expect(fixture.clients).toHaveLength(2); expect(fixture.calls).toBe(2);
    } finally { await storage.close(); }
  });
});
