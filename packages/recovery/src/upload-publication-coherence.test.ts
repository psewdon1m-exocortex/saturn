import { expect,it } from "vitest";
import { coherenceSchema } from "./consistent-snapshot.js";

const manifest=()=>({schema:"saturn.backup-coherence.v1",snapshotId:"00000003-00000005-1",snapshotStartedAt:"2026-10-12T12:00:00.000Z",
  journal:{shape:"sync-root-journal.v1",registeredRoots:"0",changes:"0",boundOperations:"0",pendingOperations:"0",finalReceipts:"0",dumpPolicy:"legacy-transient"},
  clockCutMember:"metadata/sync_root_clock.jsonl",databaseDumpSha256:"a".repeat(64),metadataAuthority:"diagnostic-only-same-cut",
  registeredRootRecovery:"blocked-requires-backend-reconciliation"});
it("preserves earlier coherent manifest compatibility and exact new receipt counts",()=>{
  const old=manifest();expect(coherenceSchema.safeParse(old).success).toBe(true);
  const current={...old,journal:{...old.journal,uploadIntents:"9007199254740993",uploadReceipts:"9007199254740992",dumpPolicy:"durable-journal-with-upload-dependencies"}};
  expect(coherenceSchema.parse(current).journal.uploadIntents).toBe("9007199254740993");
});
it("rejects partial receipt counts, impossible receipt prefixes and transient dump policy without throwing from invalid decimal input",()=>{
  const old=manifest();
  for(const fields of [{uploadIntents:"1"},{uploadReceipts:"1"},{uploadIntents:"1",uploadReceipts:"2",dumpPolicy:"durable-journal-with-upload-dependencies"},
    {uploadIntents:"1",uploadReceipts:"1"},{uploadIntents:"invalid",uploadReceipts:"1"},{uploadIntents:"1",uploadReceipts:"-1"},
    {uploadIntents:1,uploadReceipts:1},{uploadIntents:"1".repeat(100),uploadReceipts:"1"}]) {
    expect(coherenceSchema.safeParse({...old,journal:{...old.journal,...fields}}).success).toBe(false);
  }
});
