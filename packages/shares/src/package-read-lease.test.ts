import { requireTestValue } from "../../contracts/src/test-support.js";
import { PassThrough } from "node:stream";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeasedPackageStream } from "./package-read-lease.js";

afterEach(() => vi.restoreAllMocks());
describe("package read lease", () => {
  it("checks monotonic expiry before emitting a chunk even if the timer has not run", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0), source = new PassThrough();
    const renew = vi.fn(async () => true), release = vi.fn(async () => {});
    const stream = createLeasedPackageStream(source, { startedAt: 0, durationMs: 60_000, renew, release });
    const result = expect(stream.toArray()).rejects.toThrow("lease expired");
    now.mockReturnValue(60_001); source.end("must never be released"); await result;
    expect(renew).not.toHaveBeenCalled(); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(source.destroyed).toBe(true);
  });

  it("does not revive a lease when a renewal response arrives after the old deadline", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0), source = new PassThrough();
    let complete: ((value: boolean) => void) | undefined;
    const renew = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
    const release = vi.fn(async () => {});
    const stream = createLeasedPackageStream(source, { startedAt: 0, durationMs: 60_000, renew, release });
    const chunks: Buffer[] = []; stream.on("data", (chunk: unknown) => { expect(Buffer.isBuffer(chunk)).toBe(true); chunks.push(chunk as Buffer); });
    const result = expect(stream.toArray()).rejects.toThrow("lease expired");
    now.mockReturnValue(40_000); source.write("pending");
    await vi.waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    now.mockReturnValue(61_000); complete?.(true); await result;
    expect(chunks).toHaveLength(0); await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("renews a progressing transfer and closes only the cancelled receiver", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0), first = new PassThrough(), second = new PassThrough();
    const releases = [vi.fn(async () => {}), vi.fn(async () => {})], renew = vi.fn(async () => true);
    const a = createLeasedPackageStream(first, { startedAt: 0, durationMs: 60_000, renew, release: requireTestValue(releases[0]) });
    const b = createLeasedPackageStream(second, { startedAt: 0, durationMs: 60_000, renew, release: requireTestValue(releases[1]) });
    const result = b.toArray(); a.destroy();
    await vi.waitFor(() => expect(releases[0]).toHaveBeenCalledTimes(1));
    expect(second.destroyed).toBe(false); expect(releases[1]).not.toHaveBeenCalled();
    now.mockReturnValue(40_000); second.end("complete");
    expect(Buffer.concat(await result).toString()).toBe("complete"); expect(renew).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(releases[1]).toHaveBeenCalledTimes(1));
  });
});
