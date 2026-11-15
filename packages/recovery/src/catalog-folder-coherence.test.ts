import { describe,expect,it } from "vitest";
import { coherenceSchema } from "./consistent-snapshot.js";

const manifest=()=>({schema:"saturn.backup-coherence.v1",snapshotId:"00000001-00000001-1",snapshotStartedAt:"fixture",journal:{shape:"sync-root-journal.v1",registeredRoots:"1",changes:"1",boundOperations:"2",pendingOperations:"1",finalReceipts:"1",dumpPolicy:"durable-journal-with-upload-dependencies",catalogIntents:"2",catalogResults:"1"},clockCutMember:"metadata/sync_root_clock.jsonl",databaseDumpSha256:"a".repeat(64),metadataAuthority:"diagnostic-only-same-cut",registeredRootRecovery:"blocked-requires-backend-reconciliation"});
describe("catalog folder backup coherence",()=>{
  it("retains exact decimal counts and rejects missing or reversed intent/result shape",()=>{
    const value=manifest();expect(coherenceSchema.parse(value)).toEqual(value);
    expect(coherenceSchema.safeParse({...value,journal:{...value.journal,catalogIntents:"9007199254740993",catalogResults:"9007199254740992"}}).success).toBe(true);
    for(const changed of [{catalogIntents:undefined},{catalogResults:undefined},{catalogResults:"3"},{dumpPolicy:"legacy-transient"}])expect(coherenceSchema.safeParse({...value,journal:{...value.journal,...changed}}).success).toBe(false);
  });
  it.each(["garbage","-1","1e8","1.0","0x10","999999999999999999999"])("rejects malformed count %s without throwing from bigint refinement",catalogResults=>{
    const value=manifest();expect(()=>coherenceSchema.safeParse({...value,journal:{...value.journal,catalogResults}})).not.toThrow();
    expect(coherenceSchema.safeParse({...value,journal:{...value.journal,catalogResults}}).success).toBe(false);
  });
});
