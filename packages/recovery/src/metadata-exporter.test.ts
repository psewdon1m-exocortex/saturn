import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Database } from "@saturn/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseMetadataExporter } from "./metadata-exporter.js";
import type { RecoverySnapshot } from "./consistent-snapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("DatabaseMetadataExporter", () => {
  it("serializes a complete row without alias ambiguity", async () => {
    const queries: string[] = [];
    const database = {
      transaction: async (callback: (sql: { unsafe: (query: string) => Promise<readonly unknown[]> }) => Promise<unknown>) =>
        callback({
          unsafe: async (query: string) => {
            queries.push(query);
            if (query.includes("pg_export_snapshot")) return [{ snapshot_id: "00000001-00000002-1", started_at: "2026-10-12 00:00:00+00" }];
            if (!query.includes("WITH page AS") || /WHERE \w+>/.test(query)) return [];
            return [{
              cursor_value: "00000000-0000-7000-8000-000000000001",
              cursor_root: null, cursor_epoch: null, row_bytes: "100",
              value_text: JSON.stringify({ id: "00000000-0000-7000-8000-000000000001", source: "manual" }),
            }];
          },
        }),
    } as unknown as Database;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-metadata-export-"));
    roots.push(root);
    await new DatabaseMetadataExporter(database).exportTo(root);

    const resourceLine = await fs.readFile(path.join(root, "resources.jsonl"), "utf8");
    expect(JSON.parse(resourceLine)).toEqual({
      id: "00000000-0000-7000-8000-000000000001",
      source: "manual",
    });
    expect(queries.filter(query => query.includes("WITH page AS")).every((query) => query.includes("to_jsonb(export_row)"))).toBe(true);
    expect(queries[0]).toContain("REPEATABLE READ READ ONLY");
  });
  it("bounds page size to 500 before using the database", () => {
    expect(() => new DatabaseMetadataExporter({} as Database, 501)).toThrow("page size");
  });
  it("uses the configured recovery spool budget above 256 MiB without buffering the complete export", async () => {
    let written=0;
    const value=JSON.stringify({padding:'x'.repeat(512*1024-100)});
    const handle={write:async (text:string)=>{written+=Buffer.byteLength(text);},sync:()=>Promise.resolve(),close:()=>Promise.resolve()};
    vi.spyOn(fs,'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs,'open').mockResolvedValue(handle as unknown as fs.FileHandle);
    const snapshot:RecoverySnapshot={snapshotId:'00000001-00000002-1',startedAt:'2026-10-12',signal:new AbortController().signal,
      journal:{shape:'legacy',registeredRoots:'0',changes:'0',boundOperations:'0',pendingOperations:'0',finalReceipts:'0',dumpPolicy:'legacy-transient'},
      exportBudget:{totalBytes:512*1024*1024,memberBytes:512*1024*1024},
      query:<T extends readonly Record<string,unknown>[]>(query:string,parameters:readonly unknown[]=[]):Promise<T>=>{
        if(!query.includes('WITH page AS')||!query.includes('FROM public.resources'))return Promise.resolve([] as unknown as T);
        const start=parameters.length===1?0:Number(parameters[0]);
        const rows=Array.from({length:Math.min(8,520-start)},(_,i)=>({cursor_value:String(start+i+1),cursor_root:null,cursor_epoch:null,
          row_bytes:String(Buffer.byteLength(value)+1),value_text:value}));
        expect(rows.reduce((sum,row)=>sum+Number(row.row_bytes),0)).toBeLessThanOrEqual(4*1024*1024);
        return Promise.resolve(rows as unknown as T);
      }};
    try{
      await new DatabaseMetadataExporter({} as Database).exportFromSnapshot('configured-spool-fixture',snapshot);
      expect(written).toBeGreaterThan(256*1024*1024);
      expect(written).toBeLessThan(512*1024*1024);
    }finally{vi.restoreAllMocks();}
  });
});
