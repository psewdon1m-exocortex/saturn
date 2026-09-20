import { Readable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import type { SaturnConfig } from "@saturn/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SftpStorageAdapter } from "./sftp-storage.adapter.js";

const fixture = vi.hoisted(() => ({ reader: undefined as Readable | undefined, release: vi.fn(async () => undefined) }));
vi.mock("./sftp-pool.js", () => ({
  callSftp: vi.fn(),
  SftpConnectionPool: class {
    async acquire() {
      return { release: fixture.release, sftp: { createReadStream() {
        queueMicrotask(() => fixture.reader?.emit("open", Buffer.from("handle")));
        return fixture.reader;
      } } };
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
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

beforeEach(() => {
  fixture.release.mockClear();
  fixture.reader = new Readable({ read() { /* The synthetic remote explicitly supplies bytes. */ } });
});
afterEach(() => { fixture.reader?.destroy(); vi.useRealTimers(); });

describe("SFTP read lifecycle", () => {
  it("retains bytes supplied before the HTTP consumer attaches and releases once", async () => {
    const source = fixture.reader!;
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
    fixture.reader!.push(Buffer.from("partial")); await tick();
    await vi.advanceTimersByTimeAsync(1001);
    await result; await tick();
    expect(fixture.reader!.destroyed).toBe(true);
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("propagates HTTP cancellation to the remote handle without leaking its lease", async () => {
    const stream = await new SftpStorageAdapter(config).openRead("note.md");
    stream.destroy(); await tick(); await tick();
    expect(fixture.reader!.destroyed).toBe(true);
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("accepts a progressing transfer whose total duration exceeds the idle budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = await new SftpStorageAdapter(config).openRead("note.md");
    const completed = collect(stream);
    for (let i = 0; i < 4; i++) {
      fixture.reader!.push(Buffer.from(String(i))); await tick();
      await vi.advanceTimersByTimeAsync(600);
    }
    fixture.reader!.push(null);
    expect((await completed).toString()).toBe("0123");
    await tick();
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
