import { readFileSync } from "node:fs";
import { describe,it,expect } from "vitest";
import { readSyncSnapshotEntriesPage } from "./sync-snapshot-page.js";
import { encodeSyncJson, type SyncSnapshotReady } from "./sync-protocol.js";

const corpus=JSON.parse(readFileSync(new URL("../fixtures/sync-snapshot-page.v1.boundaries.json",import.meta.url),"utf8")) as {
  snapshot:SyncSnapshotReady;
  cases:readonly {name:string;afterNodeId:string|null;inputHex:string;accepted:boolean}[];
};
describe("additive inactive snapshot entries pages",()=>{
  it.each(corpus.cases)("shared exact raw vector $name",row=>{
    const read=()=>readSyncSnapshotEntriesPage(Buffer.from(row.inputHex,"hex"),corpus.snapshot,row.afterNodeId);
    if(row.accepted)expect(read).not.toThrow();else expect(read).toThrow();
  });
  it("does not fabricate membership, completeness or deletion from terminal/UNKNOWN shape",()=>{
    const row=corpus.cases.find(c=>c.name==="UNKNOWN is preserved namespace");if(!row)throw new Error("Missing qualified UNKNOWN case");
    const result=readSyncSnapshotEntriesPage(Buffer.from(row.inputHex,"hex"),corpus.snapshot,null);
    expect(result.items[0]?.availability).toBe("UNKNOWN");expect(result.has_more).toBe(false);
    expect(result).not.toHaveProperty("complete");expect(result).not.toHaveProperty("baseline");
  });
  it("rejects unqualified expected snapshot before any interpretation",()=>{
    const row=corpus.cases.find(c=>c.accepted);if(!row)throw new Error("Missing qualified first page");
    expect(()=>readSyncSnapshotEntriesPage(Buffer.from(row.inputHex,"hex"),{...corpus.snapshot,state:"BUILDING"} as unknown as SyncSnapshotReady,null)).toThrow();
    expect(()=>readSyncSnapshotEntriesPage(Buffer.from(row.inputHex,"hex"),{...corpus.snapshot,lease_seconds:0},null)).toThrow();
  });
  it("received byte budget is preserved without expanding ignored numeric fields",()=>{
    const row=corpus.cases.find(c=>c.name==="nonempty terminal page");if(!row)throw new Error("Missing qualified terminal page");
    const raw=Buffer.from(row.inputHex,"hex").toString().replace(/}$/,',"future":['+Array(710000).fill("1e4").join(",")+']}');
    const bytes=Buffer.from(raw);expect(bytes.length).toBeLessThan(4*1024*1024);
    const page=readSyncSnapshotEntriesPage(bytes,corpus.snapshot,row.afterNodeId);
    expect(page.items).toHaveLength(2);expect(()=>encodeSyncJson(page)).toThrow("page_limit");
    expect(()=>readSyncSnapshotEntriesPage(new Uint8Array(4*1024*1024+1),corpus.snapshot,null)).toThrow("page_limit");
  });
});
