import {expect,it} from "vitest";
import {coherenceSchema,assertUnregisteredRecovery} from "./consistent-snapshot.js";

it("retains the bound revalidation journal in coherent dumps and forbids partial restore",()=>{
  const journal={shape:"sync-root-journal.v1",registeredRoots:"1",changes:"4",boundOperations:"9007199254740993",pendingOperations:"0",finalReceipts:"9007199254740993",dumpPolicy:"durable-journal-with-upload-dependencies",
    folderRevalidationShape:"saturn.catalog-folder-revalidation-intent.v1",folderRevalidationOperations:"9007199254740993"} as const;
  const manifest={schema:"saturn.backup-coherence.v1",snapshotId:"00000001-00000001-1",snapshotStartedAt:"fixture",journal,clockCutMember:"metadata/sync_root_clock.jsonl",databaseDumpSha256:"a".repeat(64),metadataAuthority:"diagnostic-only-same-cut",registeredRootRecovery:"blocked-requires-backend-reconciliation"};
  expect(coherenceSchema.parse(manifest)).toEqual(manifest);
  for(const changed of [{folderRevalidationShape:undefined},{folderRevalidationOperations:undefined},{folderRevalidationOperations:"9007199254740994"},{folderRevalidationOperations:"1e3"},{dumpPolicy:"legacy-transient"}])
    expect(coherenceSchema.safeParse({...manifest,journal:{...journal,...changed}}).success).toBe(false);
  expect(()=>assertUnregisteredRecovery({...journal,registeredRoots:"0",changes:"0",boundOperations:"0"})).toThrow("automatic recovery is blocked");
});
