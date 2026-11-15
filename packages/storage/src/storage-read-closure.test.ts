import { requireTestValue } from "../../contracts/src/test-support.js";
import { createRequire } from "node:module";
import { Readable, type Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SaturnConfig } from "@saturn/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SftpStorageAdapter } from "./sftp-storage.adapter.js";
import { LocalStorageAdapter } from "./local-storage.adapter.js";
import type * as Pool from "./sftp-pool.js";

type CloseCallback = (error?: Error) => void;
const fixture = vi.hoisted(() => ({ remote: {}, release: vi.fn(async () => undefined), disconnected: new AbortController() }));
vi.mock("./sftp-pool.js", async original => ({
  ...await original<typeof Pool>(),
  callSftp: vi.fn(async () => Buffer.from("independent-fsync-handle")),
  SftpConnectionPool: class { async acquire() { return { sftp: fixture.remote, release: fixture.release, disconnected: fixture.disconnected.signal }; } },
}));
const require = createRequire(import.meta.url);
// Exercise the exact pinned ssh2 stream state machine; only wire callbacks are controlled.
const { SFTP } = require("ssh2/lib/protocol/SFTP.js") as { SFTP: { prototype: {
  createReadStream: (this: object, filename: string, options: object) => Readable;
  createWriteStream: (this: object, filename: string, options: object) => Writable;
} } };
const config: SaturnConfig["storage"] = { host: "fixture.invalid", port: 22, username: "saturn", root: "/fixture", hostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", authMode: "password_file", passwordFile: "/fixture/unused", operationTimeoutMs: 1000, healthTimeoutMs: 1000, maxConnections: 1 };
let acknowledgements: CloseCallback[] = [], openError: Error | undefined;
beforeEach(() => {
  acknowledgements = []; openError = undefined; fixture.release.mockClear(); fixture.disconnected = new AbortController();
  fixture.remote = {
    open: (_path: string, _flags: string, _mode: number, callback: (error: Error | undefined, handle?: Buffer) => void) => queueMicrotask(() => callback(openError, openError ? undefined : Buffer.from("owned-handle"))),
    read: (_handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: undefined, bytes: number) => void) => {
      const bytes = Buffer.from("abcdef").subarray(position, position + length); bytes.copy(buffer, offset); queueMicrotask(() => callback(undefined, bytes.length));
    },
    write: (_handle: Buffer, _buffer: Buffer, _offset: number, length: number, _position: number, callback: (error: undefined, bytes: number) => void) => queueMicrotask(() => callback(undefined, length)),
    fchmod: (_handle: Buffer, _mode: number, callback: CloseCallback) => queueMicrotask(() => callback()),
    close: (_handle: Buffer, callback: CloseCallback) => acknowledgements.push(callback),
    createReadStream(filename: string, options: object) { return SFTP.prototype.createReadStream.call(this, filename, options); },
    createWriteStream(filename: string, options: object) { return SFTP.prototype.createWriteStream.call(this, filename, options); },
  };
});
afterEach(async () => { for (const acknowledge of acknowledgements.splice(0)) acknowledge(); await tick(); vi.useRealTimers(); });

describe("physical storage read closure", () => {
  it.each([false, true])("keeps the SFTP lease after body EOF until remote CLOSE ACK (range=%s)", async range => {
    const stream = await new SftpStorageAdapter(config).openRead("owned", range ? { offset: 2, length: 3 } : {});
    expect(Buffer.concat(await stream.toArray()).toString()).toBe(range ? "cde" : "abcdef"); await tick();
    expect(acknowledgements).toHaveLength(1); expect(fixture.release).not.toHaveBeenCalled();
    expect(stream.storageClosed).toBeInstanceOf(Promise);
    let proved = false; void requireTestValue(stream.storageClosed).then(() => { proved = true; }); await tick(); expect(proved).toBe(false);
    requireTestValue(acknowledgements.shift())(); await stream.storageClosed; expect(fixture.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(Reflect.set(stream, "storageClosed", Promise.resolve())).toBe(false);
    expect(() => Object.defineProperty(stream, "storageClosed", { value: Promise.resolve() })).toThrow();
  });
  it("keeps cancellation pending until successful physical CLOSE instead of inferring from Transform close", async () => {
    const stream = await new SftpStorageAdapter(config).openRead("owned");
    expect(stream.storageClosed).toBeInstanceOf(Promise);
    let confirmed = false; const proof = requireTestValue(stream.storageClosed).then(() => { confirmed = true; });
    void proof.catch(() => undefined);
    stream.destroy(); await tick(); expect(stream.closed).toBe(true); expect(confirmed).toBe(false); expect(fixture.release).not.toHaveBeenCalled();
    for (const acknowledge of acknowledgements.splice(0)) acknowledge(); await proof;
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(["close-error", "disconnect", "timeout"])("retains UNKNOWN after %s instead of certifying Transform close", async reason => {
    if (reason === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = await new SftpStorageAdapter(config).openRead("owned");
    expect(stream.storageClosed).toBeInstanceOf(Promise); const proof = expect(stream.storageClosed).rejects.toThrow();
    await stream.toArray(); await tick();
    if (reason === "close-error") requireTestValue(acknowledgements.shift())(new Error("Remote CLOSE failed"));
    if (reason === "disconnect") fixture.disconnected.abort();
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(1001);
    await proof; expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("rejects an OPEN failure without returning a misleading closure proof", async () => {
    openError = new Error("Remote OPEN failed");
    await expect(new SftpStorageAdapter(config).openRead("owned")).rejects.toThrow("Remote OPEN failed");
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("binds LocalStorage proof to the actual FileHandle close, including cancellation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "d04-read-closure-"));
    try {
      await fs.writeFile(path.join(root, "owned.bin"), Buffer.from("abcdef")); const storage = new LocalStorageAdapter(root);
      for (const cancel of ['none', 'destroy', 'signal']) {
        const abort = new AbortController();
        const stream = await storage.openRead("owned.bin", { signal: abort.signal });
        try {
          expect(stream.storageClosed).toBeInstanceOf(Promise);
          if (cancel === 'destroy') stream.destroy(); else if (cancel === 'signal') abort.abort(); else expect(Buffer.concat(await stream.toArray()).toString()).toBe("abcdef");
          await stream.storageClosed; expect(stream.closed).toBe(true);
        } finally { stream.destroy(); if (!stream.closed) await new Promise<void>(resolve => stream.once('close', resolve)); }
      }
    } finally { await fs.rm(root, { recursive: true }); }
  });
  it("does not finish a successful SFTP write before the pinned stream receives CLOSE ACK", async () => {
    let finished = false; const operation = new SftpStorageAdapter(config).write("owned", Readable.from([Buffer.from("abcdef")]), { offset: 0, create: true }).then(bytes => { finished = true; return bytes; });
    await tick(); await tick(); expect(acknowledgements).toHaveLength(1);
    try { expect(finished).toBe(false); } finally { requireTestValue(acknowledgements.shift())(); }
    expect(await operation).toBe(6);
  });
});
