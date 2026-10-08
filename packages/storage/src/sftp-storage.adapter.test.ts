import { Readable, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import type { SaturnConfig } from "@saturn/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SftpStorageAdapter } from "./sftp-storage.adapter.js";
import { callSftp } from "./sftp-pool.js";

const fixture = vi.hoisted(() => ({ reader: undefined as Readable | undefined, writer: undefined as Writable | undefined, disconnect: undefined as AbortController | undefined, release: vi.fn(async () => undefined) }));
vi.mock("./sftp-pool.js", () => ({
  callSftp: vi.fn(),
  SftpConnectionPool: class {
    async acquire() {
      return { release: fixture.release, disconnected: fixture.disconnect?.signal, sftp: { createReadStream() {
        queueMicrotask(() => fixture.reader?.emit("open", Buffer.from("handle")));
        return fixture.reader;
      }, createWriteStream() { return fixture.writer; } } };
    }
  },
}));

const config: SaturnConfig["storage"] = {
  host: "fixture.invalid", port: 22, username: "saturn", root: "/fixture",
  hostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", authMode: "password_file",
  passwordFile: "/fixture/unused", operationTimeoutMs: 1000, healthTimeoutMs: 1000, maxConnections: 1,
};

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<unknown>) {
    if (!Buffer.isBuffer(chunk)) throw new Error("SFTP fixture emitted a non-buffer chunk");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function reader(): Readable {
  if (!fixture.reader) throw new Error("SFTP fixture reader is not initialized");
  return fixture.reader;
}

beforeEach(() => {
  vi.mocked(callSftp).mockReset();
  fixture.release.mockClear();
  fixture.reader = new Readable({ read() { /* The synthetic remote explicitly supplies bytes. */ } });
  fixture.writer = new Writable({ write() {}, destroy() {} });
  fixture.disconnect = new AbortController();
});
afterEach(() => { fixture.reader?.destroy(); vi.useRealTimers(); });

describe("SFTP read lifecycle", () => {
  it.each([true,false])("enforces configured remote fsync support (%s)",async(requireFsync)=>{
    vi.mocked(callSftp).mockImplementation(async(_sftp,method)=>{
      if(method==="ext_openssh_fsync") throw new Error("Server does not support this extended request");
      return Buffer.from("handle");
    });
    const operation=new SftpStorageAdapter({...config,requireFsync}).truncate("valuable.bin",0);
    if(requireFsync) {await expect(operation).rejects.toThrow("Server does not support");expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);}
    else {await operation;expect(fixture.release).toHaveBeenCalledExactlyOnceWith();}
    expect(vi.mocked(callSftp).mock.calls.some(call=>call[1]==="close")).toBe(true);
  });
  it.each(['read', 'write', 'copy'] as const)('fails %s immediately on transport loss even without handle-close callbacks', async kind => {
    fixture.reader = new Readable({ read() {}, destroy() {} });
    const storage = new SftpStorageAdapter(config);
    const operation = kind === 'read' ? collect(await storage.openRead('source.bin'))
      : kind === 'write' ? storage.write('pending.bin', Readable.from('valuable'), { offset: 0, create: true })
      : storage.copy('source.bin', 'pending.bin');
    let failure: unknown;
    const completed = operation.catch((error: unknown) => { failure = error; });
    await tick(); fixture.disconnect?.abort(); await tick(); await tick();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('SFTP transport disconnected');
    await completed;
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each(['write', 'copy'] as const)("fails %s without waiting for remote write or CLOSE acknowledgements", async kind => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const storage = new SftpStorageAdapter(config);
    let failure: unknown;
    const operation = (kind === 'write'
      ? storage.write('pending.bin', Readable.from('valuable'), { offset: 0, create: true })
      : storage.copy('source.bin', 'pending.bin')).catch((error: unknown) => { failure = error; });
    await tick();
    await vi.advanceTimersByTimeAsync(1001); await tick();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`SFTP ${kind} idle timeout`);
    await operation;
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("retains bytes supplied before the HTTP consumer attaches and releases once", async () => {
    const source = reader();
    source.push(Buffer.from("before open "));
    const stream = await new SftpStorageAdapter(config).openRead("note.md");
    await tick();
    source.push(Buffer.from("after open")); source.push(null);
    expect((await collect(stream)).toString()).toBe("before open after open");
    await tick();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("fails and retires the connection when an open remote file stops producing data", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = await new SftpStorageAdapter(config).openRead("note.md");
    const result = expect(collect(stream)).rejects.toThrow("SFTP read idle timeout");
    reader().push(Buffer.from("partial")); await tick();
    await vi.advanceTimersByTimeAsync(1001);
    await result; await tick();
    expect(reader().destroyed).toBe(true);
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("propagates HTTP cancellation to the remote handle without leaking its lease", async () => {
    const stream = await new SftpStorageAdapter(config).openRead("note.md");
    stream.destroy(); await tick(); await tick();
    expect(reader().destroyed).toBe(true);
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("fails the consumer even when the disconnected remote never acknowledges handle destruction", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fixture.reader = new Readable({ read() {}, destroy() { /* A dead SSH channel cannot acknowledge CLOSE. */ } });
    const stream = await new SftpStorageAdapter(config).openRead("note.md");
    let failure: unknown;
    const completed = collect(stream).catch((error: unknown) => { failure = error; });
    reader().push(Buffer.from("partial")); await tick();
    await vi.advanceTimersByTimeAsync(1001); await tick();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("SFTP read idle timeout");
    await completed;
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("accepts a progressing transfer whose total duration exceeds the idle budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = await new SftpStorageAdapter(config).openRead("note.md");
    const completed = collect(stream);
    for (let i = 0; i < 4; i++) {
      reader().push(Buffer.from(String(i))); await tick();
      await vi.advanceTimersByTimeAsync(600);
    }
    reader().push(null);
    expect((await completed).toString()).toBe("0123");
    await tick();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
