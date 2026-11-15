import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readSmallBatchPlan } from "./small-batch-plan.js";
import { SMALL_BATCH_SCHEMA } from "../../contracts/src/sync-small-batch.js";
import { SYNC_DESCRIPTOR_SCHEMA, SYNC_PROTOCOL } from "../../contracts/src/sync-protocol.js";

const root = "00000000-0000-7000-8000-000000000100", epoch = "00000000-0000-7000-8000-000000000101";
const binding = { protocol: SYNC_PROTOCOL, descriptor_schema: SYNC_DESCRIPTOR_SCHEMA, server_identity: "server",
  root_id: root, server_epoch: epoch, policy_version: "policy", binding_version: "00000000-0000-7000-8000-000000000102" } as const;
const sha = createHash("sha256").update("abc").digest("hex");
function first<T>(values: readonly T[]): T { const value = values[0]; if (!value) throw new Error("Missing fixture element"); return value; }
function plan() {
  return { manifest: { ...binding, schema: SMALL_BATCH_SCHEMA, batch_id: "batch-01", rules_version: "rules-1",
    items: [{ operation_id: "operation-01", source_generation: "1", source_identity: "source-1", parent_id: root,
      name: "a.txt", size_bytes: "3", sha256: sha, expected: { kind: "absent" } }] },
  inputs: [{ epoch, bindingVersion: binding.binding_version, backendIdentity: "backend",
    intent: { schema: "saturn.upload-intent.v2", deviceKind: "pluto", deviceId: "00000000-0000-7000-8000-000000000103",
      rootId: root, requestPath: "/a.txt", idempotencyKey: "operation-01", parentId: root, name: "a.txt",
      targetId: null, sizeBytes: "3", sha256: sha, ifMatch: null, ifNoneMatch: "*", requireAbsent: true,
      expectedVersionId: null, condition: { kind: "absent" }, parentTopology: [{ nodeId: root, parentId: null, name: "root" }] } }] };
}
describe("complete guarded small-batch preparation", () => {
  it("retains the original intent and frozen topology", () => {
    const input = plan(), actual = readSmallBatchPlan(input, binding);
    expect(actual.inputs[0]).toEqual(input.inputs[0]);
    expect(Object.isFrozen(actual.inputs)).toBe(true);
    expect(Object.isFrozen(actual.inputs[0]?.intent)).toBe(true);
    first(first(input.inputs).intent.parentTopology).name = "changed";
    expect(actual.inputs[0]?.intent).toMatchObject({ parentTopology: [{ name: "root" }] });
  });
  it.each(["rootId", "idempotencyKey", "parentId", "name", "sizeBytes", "sha256"])("rejects a mismatched original %s", field => {
    const input = plan(); Object.assign(first(input.inputs).intent, { [field]: field === "sizeBytes" ? "4" : "different" });
    expect(() => readSmallBatchPlan(input, binding)).toThrow();
  });
  it.each(["epoch", "bindingVersion"])("rejects a mismatched %s", field => {
    const input = plan(); Object.assign(first(input.inputs), { [field]: root });
    expect(() => readSmallBatchPlan(input, binding)).toThrow();
  });
  it("does not manufacture an absent condition from a partial remote view", () => {
    const input = plan(); Object.assign(first(input.manifest.items), { expected: { kind: "version", node_id: root, version: epoch } });
    expect(() => readSmallBatchPlan(input, binding)).toThrow();
  });
  it("requires every original input, without extra or reordered members", () => {
    const input = plan(); input.inputs = [];
    expect(() => readSmallBatchPlan(input, binding)).toThrow();
    expect(() => readSmallBatchPlan({ ...plan(), path: "untrusted" }, binding)).toThrow();
  });
  it("rejects legacy intent and a replaced topology witness", () => {
    const input = plan(); first(input.inputs).intent.schema = "saturn.upload-intent.v1";
    expect(() => readSmallBatchPlan(input, binding)).toThrow();
    const altered = plan(); first(altered.inputs).intent.parentTopology = [];
    expect(() => readSmallBatchPlan(altered, binding)).toThrow();
  });
});
