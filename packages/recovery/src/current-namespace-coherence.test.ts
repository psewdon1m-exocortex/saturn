import { expect,it } from "vitest";
import { coherenceSchema } from "./consistent-snapshot.js";
const manifest={schema:"saturn.backup-coherence.v1",snapshotId:"00000003-00000005-1",snapshotStartedAt:"fixture",
  journal:{shape:"sync-root-journal.v1",registeredRoots:"1",changes:"0",boundOperations:"0",pendingOperations:"0",finalReceipts:"0",dumpPolicy:"durable-journal-with-upload-dependencies"},
  clockCutMember:"metadata/sync_root_clock.jsonl",databaseDumpSha256:"a".repeat(64),metadataAuthority:"diagnostic-only-same-cut",registeredRootRecovery:"blocked-requires-backend-reconciliation"};
it("keeps old coherence compatible and exact namespace counts as one optional complete group",()=>{
  expect(coherenceSchema.safeParse(manifest).success).toBe(true);
  expect(coherenceSchema.parse({...manifest,journal:{...manifest.journal,namespaceShape:"saturn.current-namespace.v1",namespaceBindings:"1",metadataVersions:"9007199254740993"}}).journal.metadataVersions).toBe("9007199254740993");
  for(const fields of [{namespaceShape:"saturn.current-namespace.v1"},{namespaceBindings:"1"},{namespaceShape:"unknown",namespaceBindings:"1",metadataVersions:"0"},
    {namespaceShape:"saturn.current-namespace.v1",namespaceBindings:"1",metadataVersions:"0",dumpPolicy:"legacy-transient"}])expect(coherenceSchema.safeParse({...manifest,journal:{...manifest.journal,...fields}}).success).toBe(false);
});
