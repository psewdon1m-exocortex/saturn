import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { SMALL_BATCH_SCHEMA, type SmallBatchItem } from "../../../packages/contracts/src/sync-small-batch.js";
import { receiveSmallBatch, smallBatchBoundary, type SmallBatchReceiver } from "./sync-small-batch-stream.js";

const binding: SyncRootBinding = { protocol: "neptune-sync/1", descriptor_schema: "saturn.current-namespace.v1", server_identity: "server", root_id: "root", server_epoch: "epoch", policy_version: "policy", binding_version: "00000000-0000-0000-0000-000000000001" };
const boundary = "batch-test-178adcc2", type = `multipart/related; boundary=${boundary}`;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function at<T>(values: readonly T[], index: number): T { const value = values[index]; if (value === undefined) throw Error("Missing fixture entry"); return value; }
function fixture(payloads = [Buffer.from("one"), Buffer.alloc(0), Buffer.from("three")]) {
  const items = payloads.map((bytes, n) => ({ operation_id: `operation-${String(n)}`, source_generation: "1", source_identity: `sealed-${String(n)}`, parent_id: "parent", name: `file-${String(n)}`, size_bytes: String(bytes.length), sha256: digest(bytes), expected: { kind: "absent" } }));
  const manifest = { ...binding, schema: SMALL_BATCH_SCHEMA, batch_id: "batch-1", rules_version: "rules-1", items };
  const json = Buffer.from(JSON.stringify(manifest));
  const head = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Length: ${String(json.length)}\r\n\r\n`), json, Buffer.from(`\r\n--${boundary}\r\n`)]);
  const parts = items.map((item, n) => Buffer.concat([Buffer.from(`Content-Type: application/octet-stream\r\nContent-ID: <${item.operation_id}>\r\nContent-Length: ${item.size_bytes}\r\n\r\n`), at(payloads, n)]));
  const body = (indices = items.map((_, n) => n)) => Buffer.concat([head, ...indices.flatMap((n, i) => [at(parts, n), Buffer.from(`\r\n--${boundary}${i === indices.length - 1 ? "--" : ""}\r\n`)])]);
  return { manifest, payloads, head, parts, body };
}
async function* chunks(bytes: Uint8Array, size = 113): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
function receiver(onWrite?: (bytes: Uint8Array) => Promise<void>) {
  const received: string[] = [], interrupted: string[] = [], data = new Map<string, Buffer[]>(); let manifests = 0;
  const sink: SmallBatchReceiver = {
    manifest: async () => { manifests++; },
    part: async (item: SmallBatchItem) => {
      if (manifests !== 1) throw Error("part before manifest admission");
      const saved: Buffer[] = []; data.set(item.operation_id, saved);
      return {
        write: async bytes => { saved.push(Buffer.from(bytes)); await onWrite?.(bytes); },
        received: async () => { received.push(item.operation_id); },
        interrupted: async () => { interrupted.push(item.operation_id); },
      };
    },
  };
  return { sink, received, interrupted, data, manifests: () => manifests };
}

describe("bounded multipart small-file transport", () => {
  it.each([1, 2, 7, 113, 65536])("accepts exact bytes with %i-byte input fragments including an empty file", async size => {
    const f = fixture(), r = receiver();
    const result = await receiveSmallBatch(chunks(f.body(), size), type, binding, r.sink);
    expect(result.items).toHaveLength(3); expect(r.received).toEqual(f.manifest.items.map(i => i.operation_id));
    expect(r.interrupted).toEqual([]);
    for (let n = 0; n < 3; n++) expect(Buffer.concat(r.data.get(`operation-${String(n)}`) ?? [])).toEqual(f.payloads[n]);
  });
  it("resolves arbitrary part order by unique operation ID", async () => {
    const f = fixture(), r = receiver();
    await receiveSmallBatch(chunks(f.body([2, 0, 1])), type, binding, r.sink);
    expect(r.received).toEqual(["operation-2", "operation-0", "operation-1"]);
  });
  it("limits write buffers and awaits downstream backpressure", async () => {
    const f = fixture([Buffer.alloc(262144, 0x51)]); let active = 0, peak = 0, largest = 0;
    const r = receiver(async bytes => { active++; peak = Math.max(peak, active); largest = Math.max(largest, bytes.length); await new Promise(resolve => setTimeout(resolve, 1)); active--; });
    await receiveSmallBatch(chunks(f.body(), 300000), type, binding, r.sink);
    expect(peak).toBe(1); expect(largest).toBeLessThanOrEqual(65536); expect(r.received).toEqual(["operation-0"]);
  });
  it("preserves an earlier received item and never accepts a truncated later part", async () => {
    const f = fixture([Buffer.from("one"), Buffer.alloc(200, 0x52)]), r = receiver();
    const body = f.body();
    await expect(receiveSmallBatch(chunks(body.subarray(0, body.length - 100)), type, binding, r.sink)).rejects.toThrow("incomplete_part");
    expect(r.received).toEqual(["operation-0"]); expect(r.interrupted).toEqual(["operation-1"]);
  });
  it("does not call received when the content hash differs", async () => {
    const f = fixture([Buffer.from("one")]), r = receiver();
    const body = Buffer.from(f.body().toString().replace("\r\n\r\none\r\n", "\r\n\r\ntwo\r\n"));
    await expect(receiveSmallBatch(chunks(body), type, binding, r.sink)).rejects.toThrow("hash_mismatch");
    expect(r.received).toEqual([]); expect(r.interrupted).toEqual(["operation-0"]);
  });
  it.each([
    ["duplicate binary ID", (f: ReturnType<typeof fixture>) => f.body([0, 0, 2])],
    ["missing part", (f: ReturnType<typeof fixture>) => f.body([0, 1])],
    ["extra part", (f: ReturnType<typeof fixture>) => f.body([0, 1, 2, 0])],
    ["unknown ID", (f: ReturnType<typeof fixture>) => Buffer.from(f.body().toString().replace("Content-ID: <operation-0>", "Content-ID: <foreign>"))],
    ["wrong length", (f: ReturnType<typeof fixture>) => Buffer.from(f.body().toString().replace("Content-Length: 3\r\n", "Content-Length: 4\r\n"))],
    ["duplicate header", (f: ReturnType<typeof fixture>) => Buffer.from(f.body().toString().replace("Content-Length: 3\r\n", "Content-Length: 3\r\ncontent-length: 3\r\n"))],
    ["path header", (f: ReturnType<typeof fixture>) => Buffer.from(f.body().toString().replace("Content-ID: <operation-0>", 'Content-Disposition: form-data; filename="../escape"'))],
    ["encoding", (f: ReturnType<typeof fixture>) => Buffer.from(f.body().toString().replace("Content-ID: <operation-0>", "Content-Transfer-Encoding: base64"))],
    ["trailing data", (f: ReturnType<typeof fixture>) => Buffer.concat([f.body(), Buffer.from("unexpected")])],
    ["bare LF", (f: ReturnType<typeof fixture>) => Buffer.from(f.body().toString().replaceAll("\r\n", "\n"))],
  ] as const)("rejects %s", async (_name, change) => {
    const f = fixture(), r = receiver();
    await expect(receiveSmallBatch(chunks(change(f), 5), type, binding, r.sink)).rejects.toThrow();
    expect(r.received.length).toBeLessThan(3);
  });
  it.each([`--${boundary}injected`, `prefix\r\n--${boundary}injected`])("rejects a boundary prefix inside bytes across one-byte chunks", async value => {
    const f = fixture([Buffer.from(value)]), r = receiver();
    await expect(receiveSmallBatch(chunks(f.body(), 1), type, binding, r.sink)).rejects.toThrow("invalid_batch");
    expect(r.received).toEqual([]); expect(r.interrupted).toEqual(["operation-0"]);
  });
  it("validates the complete manifest and binding before private part creation", async () => {
    const f = fixture(), r = receiver();
    await expect(receiveSmallBatch(chunks(f.body()), type, { ...binding, root_id: "other" }, r.sink)).rejects.toThrow("binding_mismatch");
    expect(r.manifests()).toBe(0); expect(r.data.size).toBe(0);
  });
  it("joins the input on refused manifest admission", async () => {
    const f = fixture(), r = receiver(); let closed = false;
    async function* input() { try { yield* chunks(f.body()); } finally { closed = true; } }
    r.sink.manifest = async () => { throw Error("reservation refused"); };
    await expect(receiveSmallBatch(input(), type, binding, r.sink)).rejects.toThrow("reservation refused");
    expect(closed).toBe(true); expect(r.data.size).toBe(0);
  });
  it("cancellation after a private write cannot acknowledge that part", async () => {
    const abort = new AbortController(), f = fixture([Buffer.alloc(90000, 0x53)]), r = receiver(async () => { abort.abort(Error("cancelled")); });
    await expect(receiveSmallBatch(chunks(f.body()), type, binding, r.sink, abort.signal)).rejects.toThrow("cancelled");
    expect(r.received).toEqual([]); expect(r.interrupted).toEqual(["operation-0"]);
  });
  it.each(["private", "input"])("preserves the primary failure when %s cleanup also fails", async mode => {
    const f = fixture([Buffer.from("one")]), r = receiver();
    const body = Buffer.from(f.body().toString().replace("\r\n\r\none\r\n", "\r\n\r\ntwo\r\n"));
    if (mode === "private") {
      const original = r.sink.part.bind(r.sink);
      r.sink.part = async item => ({ ...await original(item), interrupted: async () => { throw Error("private cleanup failure"); } });
    }
    const input: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() {
      const iterator = chunks(body);
      return { next: () => iterator.next(), return: async () => {
        const result = await iterator.return(undefined);
        if (mode === "input") throw Error("input cleanup failure");
        return result;
      } };
    } };
    let failure: unknown;
    try { await receiveSmallBatch(input, type, binding, r.sink); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw Error("Missing combined diagnostic");
    expect(failure.errors.map((e: unknown) => e instanceof Error ? e.message : String(e))).toEqual(["hash_mismatch", `${mode} cleanup failure`]);
    expect(r.received).toEqual([]);
  });
  it.each(["text/plain", `multipart/related; boundary=${"x".repeat(71)}`, "multipart/related; boundary=x; boundary=y", 'multipart/related; boundary="x "', "multipart/related; boundary=x\r\nInjected: value"])("rejects ambiguous content type %s", value => {
    expect(() => smallBatchBoundary(value)).toThrow();
  });
  it("supports a quoted RFC boundary and optional manifest media type", () => {
    expect(smallBatchBoundary('multipart/related; boundary="a:b /c"; type="application/json"')).toBe("a:b /c");
  });
});
