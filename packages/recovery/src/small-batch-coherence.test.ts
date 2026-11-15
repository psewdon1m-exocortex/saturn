import { expect, it } from "vitest";
import { coherenceSchema, assertUnregisteredRecovery } from "./consistent-snapshot.js";

const journal = { shape: "sync-root-journal.v1", registeredRoots: "1", changes: "0", boundOperations: "0", pendingOperations: "0", finalReceipts: "0",
  dumpPolicy: "durable-journal-with-upload-dependencies", smallBatchShape: "saturn.small-file-batch.v1", smallBatchOperations: "500", smallBatches: "1", smallBatchMetadataBytes: "700000" } as const;
const manifest = { schema: "saturn.backup-coherence.v1", snapshotId: "00000001-00000001-1", snapshotStartedAt: "fixture", journal,
  clockCutMember: "metadata/sync_root_clock.jsonl", databaseDumpSha256: "a".repeat(64), metadataAuthority: "diagnostic-only-same-cut", registeredRootRecovery: "blocked-requires-backend-reconciliation" };
it("retains transport-only declarations without inventing upload receipts", () => {
  expect(coherenceSchema.parse(manifest)).toEqual(manifest);
  expect(() => assertUnregisteredRecovery({ ...journal, registeredRoots: "0" })).toThrow("automatic recovery is blocked");
});
it.each(["smallBatchShape", "smallBatchOperations", "smallBatches", "smallBatchMetadataBytes"])("rejects missing %s", field => {
  expect(coherenceSchema.safeParse({ ...manifest, journal: { ...journal, [field]: undefined } }).success).toBe(false);
});
it("rejects transient recovery, lossy counts and unknown batch schema", () => {
  for (const changed of [{ dumpPolicy: "legacy-transient" }, { smallBatchOperations: 500 }, { smallBatchMetadataBytes: "7e5" }, { smallBatchShape: "unknown" }]) {
    expect(coherenceSchema.safeParse({ ...manifest, journal: { ...journal, ...changed } }).success).toBe(false);
  }
});
