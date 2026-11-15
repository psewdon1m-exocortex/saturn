import { describe, expect, it } from "vitest";
import { encodeSyncJson, type SyncRootBinding } from "./sync-protocol.js";
import { EMPTY_CONTENT_SHA256, readSmallBatchManifest, SMALL_BATCH_SCHEMA } from "./sync-small-batch.js";

const binding: SyncRootBinding = { protocol: "neptune-sync/1", descriptor_schema: "saturn.current-namespace.v1", server_identity: "server", root_id: "root", server_epoch: "epoch", policy_version: "policy", binding_version: "00000000-0000-0000-0000-000000000001" };
const item = (n = 0) => ({ operation_id: `operation-${String(n)}`, source_generation: "9007199254740993", source_identity: `sealed-${String(n)}`, parent_id: "parent", name: `file-${String(n)}`, size_bytes: "3", sha256: "a".repeat(64), expected: { kind: "absent" } });
const manifest = () => ({ ...binding, schema: SMALL_BATCH_SCHEMA, batch_id: "batch-1", rules_version: "rules-1", items: [item()] });
const parse = (value: unknown) => readSmallBatchManifest(encodeSyncJson(value), binding);
const first = (input: ReturnType<typeof manifest>) => { const row = input.items[0]; if (!row) throw Error("Missing fixture item"); return row; };

describe("bounded small-file request manifest", () => {
  it("preserves exact generations, conditions, Unicode names and immutable declarations", () => {
    const input = manifest(); first(input).name = "документ-😀.txt";
    const result = parse(input);
    expect(result.items[0]?.source_generation).toBe("9007199254740993");
    expect(result.items[0]?.name).toBe(first(input).name);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0]?.expected)).toBe(true);
    expect(result).not.toHaveProperty("verified"); expect(result).not.toHaveProperty("published");
  });
  it("accepts exact 500 item and 32MiB boundaries; rejects overflow", () => {
    const input = manifest(); input.items = Array.from({ length: 500 }, (_, n) => item(n));
    expect(parse(input).items).toHaveLength(500);
    input.items.push(item(500)); expect(() => parse(input)).toThrow("page_limit");
    input.items = Array.from({ length: 128 }, (_, n) => ({ ...item(n), size_bytes: "262144" }));
    expect(parse(input).items).toHaveLength(128);
    input.items.push(item(128)); expect(() => parse(input)).toThrow("page_limit");
  });
  it("supports an empty file only with the exact empty digest", () => {
    const input = manifest(); first(input).size_bytes = "0";
    expect(() => parse(input)).toThrow(); first(input).sha256 = EMPTY_CONTENT_SHA256;
    expect(parse(input).items[0]?.size_bytes).toBe("0");
  });
  it.each([
    ["unknown manifest field", { ...manifest(), ready: true }],
    ["unknown item field", { ...manifest(), items: [{ ...item(), overwrite: true }] }],
    ["duplicate operation", { ...manifest(), items: [item(), { ...item(1), operation_id: "operation-0" }] }],
    ["duplicate destination", { ...manifest(), items: [item(), { ...item(1), name: "file-0" }] }],
    ["parent traversal", { ...manifest(), items: [{ ...item(), name: "../file" }] }],
    ["control in name", { ...manifest(), items: [{ ...item(), name: "file\u0085" }] }],
    ["oversized name", { ...manifest(), items: [{ ...item(), name: "a".repeat(256) }] }],
    ["Content-ID injection", { ...manifest(), items: [{ ...item(), operation_id: "a>\r\nx: y" }] }],
    ["numeric generation", { ...manifest(), items: [{ ...item(), source_generation: 42 }] }],
    ["zero generation", { ...manifest(), items: [{ ...item(), source_generation: "0" }] }],
    ["generation overflow", { ...manifest(), items: [{ ...item(), source_generation: "9223372036854775808" }] }],
    ["noncanonical size", { ...manifest(), items: [{ ...item(), size_bytes: "03" }] }],
    ["large file", { ...manifest(), items: [{ ...item(), size_bytes: "262145" }] }],
    ["weak precondition", { ...manifest(), items: [{ ...item(), expected: { kind: "version", node_id: "n", version: 'W/"1"' } }] }],
    ["extra condition", { ...manifest(), items: [{ ...item(), expected: { kind: "absent", overwrite: true } }] }],
    ["empty batch", { ...manifest(), items: [] }],
    ["wrong schema", { ...manifest(), schema: "future" }],
  ])("refuses %s before any file reservation", (_name, input) => { expect(() => parse(input)).toThrow(); });
  it.each(["server_identity", "root_id", "server_epoch", "policy_version", "binding_version"] as const)("checks expected %s", key => {
    const input = manifest(); input[key] = key === "binding_version" ? "00000000-0000-0000-0000-000000000002" : "different";
    expect(() => parse(input)).toThrow("binding_mismatch");
  });
  it("rejects raw duplicate keys, surrogate strings, prototype keys and invalid UTF8", () => {
    const json = JSON.stringify(manifest());
    for (const raw of [json.replace('"batch_id":', '"batch_id":"other","batch_id":'), json.replace('"file-0"', '"\\ud800"'), json.replace(/}$/, ',"__proto__":{}}')]) {
      expect(() => readSmallBatchManifest(new TextEncoder().encode(raw), binding)).toThrow();
    }
    expect(() => readSmallBatchManifest(new Uint8Array([0xff]), binding)).toThrow();
    expect(() => readSmallBatchManifest(new Uint8Array(4 * 1024 * 1024 + 1), binding)).toThrow("page_limit");
  });
});
