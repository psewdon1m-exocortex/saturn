import { createHash } from "node:crypto";
import type { SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import {
  readSmallBatchManifest, SMALL_BATCH_MAX_DATA_BYTES, SMALL_BATCH_MAX_ITEMS, SMALL_BATCH_MAX_MANIFEST_BYTES,
  type SmallBatchItem, type SmallBatchManifest,
} from "../../../packages/contracts/src/sync-small-batch.js";

const MAX_HEADERS = 4096;
const MAX_WIRE_BYTES = SMALL_BATCH_MAX_DATA_BYTES + SMALL_BATCH_MAX_MANIFEST_BYTES + (SMALL_BATCH_MAX_ITEMS + 1) * (MAX_HEADERS + 256);
const CHUNK_BYTES = 65536;
export class SmallBatchStreamError extends Error {
  constructor(readonly code: "invalid_batch" | "batch_limit" | "incomplete_part" | "hash_mismatch") { super(code); }
}
const invalid = (): never => { throw new SmallBatchStreamError("invalid_batch"); };

/** Application profile of RFC2046 multipart/related: one JSON manifest, binary
 * parts with exact lengths and Content-ID, no nested encodings or path headers.
 * Random boundaries must not occur as a line prefix in any encapsulated part. */
export function smallBatchBoundary(contentType: string): string {
  if (contentType.length > 256 || /[\r\n\0]/.test(contentType)) return invalid();
  const match = /^multipart\/related\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,./:=? -]{1,70})"|([-0-9A-Za-z'._+]{1,70}))(?:\s*;\s*type="application\/json")?\s*$/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.endsWith(" ")) return invalid();
  return boundary;
}

class BatchReader {
  readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array = new Uint8Array();
  private offset = 0;
  private received = 0;
  private ended = false;
  constructor(body: AsyncIterable<Uint8Array>, private readonly signal?: AbortSignal) { this.iterator = body[Symbol.asyncIterator](); }
  check(): void { this.signal?.throwIfAborted(); }
  private async fill(): Promise<boolean> {
    this.check();
    if (this.offset < this.current.length) return true;
    if (this.ended) return false;
    for (let empty = 0; empty < 32; empty++) {
      this.check();
      const result = await this.iterator.next();
      this.check();
      if (result.done) { this.ended = true; return false; }
      if (!(result.value instanceof Uint8Array)) return invalid();
      this.received += result.value.byteLength;
      if (this.received > MAX_WIRE_BYTES) throw new SmallBatchStreamError("batch_limit");
      this.current = result.value; this.offset = 0;
      if (this.current.length) return true;
    }
    return invalid();
  }
  async take(maximum: number): Promise<Uint8Array> {
    if (!await this.fill()) throw new SmallBatchStreamError("incomplete_part");
    const end = Math.min(this.current.length, this.offset + maximum);
    const bytes = this.current.subarray(this.offset, end); this.offset = end;
    return bytes;
  }
  async exact(length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > SMALL_BATCH_MAX_MANIFEST_BYTES) return invalid();
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) { const chunk = await this.take(length - offset); bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  async line(maximum: number): Promise<string> {
    const fragments: Uint8Array[] = []; let size = 0;
    for (;;) {
      if (!await this.fill()) throw new SmallBatchStreamError("incomplete_part");
      const newline = this.current.indexOf(10, this.offset);
      const end = newline < 0 ? this.current.length : newline + 1;
      const chunk = this.current.subarray(this.offset, end); this.offset = end;
      size += chunk.length;
      if (size > maximum + 2) throw new SmallBatchStreamError("batch_limit");
      fragments.push(chunk);
      if (newline >= 0) {
        const line = Buffer.concat(fragments, size);
        if (size < 2 || line[size - 2] !== 13 || line.subarray(0, size - 2).some(byte => byte > 126 || byte < 32 && byte !== 9)) return invalid();
        return line.subarray(0, size - 2).toString("ascii");
      }
    }
  }
  async headers(): Promise<Map<string, string>> {
    const headers = new Map<string, string>(); let budget = 0;
    for (let count = 0; count < 8; count++) {
      const line = await this.line(MAX_HEADERS - budget); budget += line.length + 2;
      if (budget > MAX_HEADERS) throw new SmallBatchStreamError("batch_limit");
      if (!line) return headers;
      const match = /^(Content-Type|Content-Length|Content-ID):[ \t]*([^\t]+?)[ \t]*$/i.exec(line);
      if (!match) return invalid();
      const key = match[1]?.toLowerCase(), value = match[2];
      if (!key || value === undefined) return invalid();
      if (headers.has(key)) return invalid();
      headers.set(key, value);
    }
    return invalid();
  }
  async separator(boundary: string): Promise<boolean> {
    if (!(await this.exact(2)).equals(Buffer.from("\r\n"))) return invalid();
    const line = (await this.line(256)).replace(/[ \t]+$/, "");
    if (line === `--${boundary}`) return false;
    if (line === `--${boundary}--`) return true;
    return invalid();
  }
  async eof(): Promise<void> { if (await this.fill()) return invalid(); }
  async close(): Promise<void> { if (!this.ended) await this.iterator.return?.(); }
}

export interface SmallBatchPartWriter {
  /** Private uncommitted bytes only. This callback must apply backpressure. */
  write(bytes: Uint8Array): Promise<void>;
  /** Called only after exact length/hash and a complete following delimiter.
   * Final backend verification and per-item publication remain the executor's job. */
  received(): Promise<void>;
  /** Preserve or cancel incomplete private work under the durable registry. */
  interrupted(cause: unknown): Promise<void>;
}
export interface SmallBatchReceiver {
  /** Explicit execution-job profile carries the exact accepted plan as the
   * first part. It must validate and authorize that plan before returning. */
  plan?(bytes:Uint8Array):Promise<SmallBatchManifest>;
  /** Authenticate current root and register the immutable manifest/reservation
   * here, before any part is offered. This parser grants no server authority. */
  manifest(value: SmallBatchManifest): Promise<void>;
  part(item: SmallBatchItem): Promise<SmallBatchPartWriter>;
}

/** Bounded streaming transport. The caller owns request timeouts and cancellation
 * of a stalled input stream; no file or publication is created by the parser.
 * Earlier fully received items are independent of a later interrupted part. */
export async function receiveSmallBatch(body: AsyncIterable<Uint8Array>, contentType: string, expected: SyncRootBinding, sink: SmallBatchReceiver, signal?: AbortSignal): Promise<SmallBatchManifest> {
  const boundary = smallBatchBoundary(contentType), reader = new BatchReader(body, signal);
  const failures: unknown[] = [];
  let result: SmallBatchManifest | undefined;
  try {
    if ((await reader.line(256)).replace(/[ \t]+$/, "") !== `--${boundary}`) return invalid();
    const headers = await reader.headers(), lengthText = headers.get("content-length");
    if (headers.size !== 2 || !/^application\/json(?:;[ \t]*charset=utf-8)?$/i.test(headers.get("content-type") ?? "") || !/^[1-9]\d{0,7}$/.test(lengthText ?? "")) return invalid();
    const length = Number(lengthText);
    if (length > SMALL_BATCH_MAX_MANIFEST_BYTES) throw new SmallBatchStreamError("batch_limit");
    const metadata = await reader.exact(length);
    if (await reader.separator(boundary)) return invalid();
    reader.check();
    const manifest = sink.plan ? await sink.plan(metadata) : readSmallBatchManifest(metadata, expected);
    reader.check(); await sink.manifest(manifest);
    const byId = new Map(manifest.items.map(item => [item.operation_id, item])), seen = new Set<string>();
    const prefix = Buffer.from(`\r\n--${boundary}`), firstPrefix = Buffer.from(`--${boundary}`);
    for (let index = 0; index < manifest.items.length; index++) {
      const fields = await reader.headers(), id = /^<([A-Za-z0-9][A-Za-z0-9._:-]{0,127})>$/.exec(fields.get("content-id") ?? "")?.[1];
      const item = id ? byId.get(id) : undefined;
      if (fields.size !== 3 || !item || !id || seen.has(id) || fields.get("content-length") !== item.size_bytes || fields.get("content-type")?.toLowerCase() !== "application/octet-stream") return invalid();
      seen.add(id); reader.check(); const writer = await sink.part(item);
      try {
        const hash = createHash("sha256"); let remaining = Number(item.size_bytes), tail = Buffer.alloc(0), total = 0;
        while (remaining) {
          const chunk = await reader.take(Math.min(CHUNK_BYTES, remaining));
          const joined = Buffer.concat([tail, chunk]);
          if (joined.includes(prefix) || total < firstPrefix.length && joined.subarray(0, firstPrefix.length).equals(firstPrefix)) return invalid();
          tail = Buffer.from(joined.subarray(Math.max(0, joined.length - prefix.length)));
          hash.update(chunk); remaining -= chunk.length; total += chunk.length;
          reader.check(); await writer.write(chunk);
        }
        if (hash.digest("hex") !== item.sha256) throw new SmallBatchStreamError("hash_mismatch");
        const last = await reader.separator(boundary);
        if (last !== (index === manifest.items.length - 1)) return invalid();
        if (last) await reader.eof();
        reader.check(); await writer.received();
      } catch (error) {
        try { await writer.interrupted(error); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Small batch failed and private cleanup failed"); }
        throw error;
      }
    }
    result = manifest;
  } catch (error) { failures.push(error); }
  try { await reader.close(); } catch (cleanup) { failures.push(cleanup); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Small batch failed and input closure failed");
  return result ?? invalid();
}
