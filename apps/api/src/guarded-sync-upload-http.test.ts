import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readGuardedUploadFrame, GUARDED_UPLOAD_CHUNK_BYTES, GUARDED_UPLOAD_METADATA_BYTES } from "./guarded-sync-upload-http.js";

const metadata = () => ({ binding: { protocol: "neptune-sync/1", descriptor_schema: "saturn.current-namespace.v1", server_identity: "fixture-server", root_id: randomUUID(), server_epoch: randomUUID(), policy_version: "1", binding_version: randomUUID() }, input: { fixture: "opaque until restore" }, upload_id: randomUUID(), offset: "9007199254740993" });
function frame(value: unknown, bytes = Buffer.from([0, 255, 34, 92, 13, 10])): Buffer {
  const json = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length); return Buffer.concat([length, json, bytes]);
}
describe("guarded upload binary framing", () => {
  it("keeps >2^53 offset exact and transports arbitrary bytes without base64", () => {
    const m = metadata(), f = frame(m), parsed = readGuardedUploadFrame(f);
    expect(parsed.metadata.offset).toBe("9007199254740993"); expect(parsed.metadata.upload_id).toBe(m.upload_id); expect(parsed.bytes).toEqual(Buffer.from([0, 255, 34, 92, 13, 10])); expect(parsed.bytes.buffer).toBe(f.buffer);
  });
  it("accepts exact zero and signed BIGINT maximum offsets", () => { for (const offset of ["0", "9223372036854775807"]) expect(readGuardedUploadFrame(frame({ ...metadata(), offset })).metadata.offset).toBe(offset); });
  it.each(["01", "-1", "1.0", "1e3", "9223372036854775808", 0, 9007199254740992])("rejects noncanonical or overflowing offset %s", offset => { expect(() => readGuardedUploadFrame(frame({ ...metadata(), offset }))).toThrow(); });
  it("rejects duplicate JSON keys before ordinary JSON parsing", () => { const raw = JSON.stringify(metadata()).replace('"offset":"9007199254740993"', '"offset":"0","offset":"1"'); expect(() => readGuardedUploadFrame(frame(Buffer.from(raw)))).toThrow(); });
  it("rejects malformed UTF-8, truncated prefixes and trailing metadata", () => { expect(() => readGuardedUploadFrame(frame(Buffer.from([0xc3, 0x28])))).toThrow(); expect(() => readGuardedUploadFrame(Buffer.from([0, 0, 0]))).toThrow(); expect(() => readGuardedUploadFrame(frame(Buffer.from(JSON.stringify(metadata()) + "x")))).toThrow(); });
  it("rejects unrecognized metadata and binding fields", () => { const m = metadata(); expect(() => readGuardedUploadFrame(frame({ ...m, physical_path: "outside" }))).toThrow(); expect(() => readGuardedUploadFrame(frame({ ...m, binding: { ...m.binding, epoch_alias: m.binding.server_epoch } }))).toThrow(); });
  it("rejects absent data and forged metadata-length prefix", () => { expect(() => readGuardedUploadFrame(frame(metadata(), Buffer.alloc(0)))).toThrow(); const f = frame(metadata()); f.writeUInt32BE(0xffffffff); expect(() => readGuardedUploadFrame(f)).toThrow(); });
  it("admits bounded long ancestry metadata independently of header limits", () => { const m = metadata(); expect(readGuardedUploadFrame(frame({ ...m, input: { padding: "n".repeat(32000) } })).metadata.offset).toBe(m.offset); expect(() => readGuardedUploadFrame(frame({ ...m, input: { padding: "n".repeat(GUARDED_UPLOAD_METADATA_BYTES) } }))).toThrow(); });
  it("accepts exact chunk bound and rejects one extra byte", () => { expect(readGuardedUploadFrame(frame(metadata(), Buffer.alloc(GUARDED_UPLOAD_CHUNK_BYTES))).bytes.length).toBe(GUARDED_UPLOAD_CHUNK_BYTES); expect(() => readGuardedUploadFrame(frame(metadata(), Buffer.alloc(GUARDED_UPLOAD_CHUNK_BYTES + 1)))).toThrow(); });
});
