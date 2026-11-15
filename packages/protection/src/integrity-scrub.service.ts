import { createHash, type Hash } from "node:crypto";
import type { Database } from "@saturn/database";
import { PostgresFileRepository } from "@saturn/file-core";
import type { StorageAdapter } from "@saturn/storage";
import { v7 as uuidv7 } from "uuid";

export interface ScrubVersion { readonly id:string; readonly resource_id:string; readonly storage_path:string; readonly size_bytes:string; readonly sha256:string }
export interface IntegrityScrubOptions {
  readonly maximumBytes?:number; readonly maximumMs?:number;
  readonly quarantine?:(row:ScrubVersion,actualSize:number)=>Promise<boolean>;
}
/** Hash state is process-local. On restart the partial object's hash is read
 * again; persisted offsets are diagnostics, never reconstructed hash state. */
export class IntegrityScrubService {
  #partial:{id:string;sha256:string;path:string;offset:number;size:number;modifiedAt:number;hash:Hash}|undefined;
  constructor(private readonly database: Database, private readonly storage: StorageAdapter,private readonly options:IntegrityScrubOptions={}) {
    if(!Number.isSafeInteger(options.maximumBytes??268435456)||(options.maximumBytes??268435456)<1||(options.maximumBytes??268435456)>1073741824
      ||!Number.isSafeInteger(options.maximumMs??10000)||(options.maximumMs??10000)<1||(options.maximumMs??10000)>30000)throw new Error("Invalid scrub budget");
  }

  async run(limit = 10,signal?:AbortSignal): Promise<{ checked: number; mismatched: number; bytes:number; deferred:boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid scrub limit");
    return this.database.withAdvisoryLock("saturn-integrity-scrub", async () => {
      const state = await this.database.withSql(sql => sql<{ last_version_id: string }[]>`SELECT last_version_id FROM integrity_scrub_state WHERE id=true`);
      const cursor = state[0]?.last_version_id ?? "";
      const rows = await this.database.withSql(sql => sql<{ id: string; resource_id: string; storage_path: string; size_bytes: string; sha256: string }[]>`
        SELECT id::text, resource_id::text, storage_path, size_bytes::text, sha256 FROM file_versions
        WHERE state='active' AND id::text>${cursor} ORDER BY id::text LIMIT ${limit}
      `);
      const files = new PostgresFileRepository(this.database);
      let checked = 0, mismatched = 0;
      let bytes = 0;
      let deferred=false;
      const maximumBytes=this.options.maximumBytes??256*1024*1024,deadline=Date.now()+(this.options.maximumMs??10000);
      const runSignal=AbortSignal.any([AbortSignal.timeout(this.options.maximumMs??10000),...(signal?[signal]:[])]);
      const aborted=()=>runSignal.aborted;
      let next = cursor;
      for (const row of rows) {
        if (bytes>=maximumBytes||Date.now()>=deadline||aborted()) {deferred=true;break;}
        const lease = uuidv7();
        if (!(await files.acquireLocks(lease, [`resource:${row.resource_id}`], new Date(Date.now()+60000)))) {deferred=true;break;}
        try {
          const current = await files.getVersion(row.resource_id, row.id);
          if (current?.state !== 'active' || current.storagePath !== row.storage_path || current.sha256 !== row.sha256) { next=row.id; continue; }
          const before=await this.storage.stat(row.storage_path);
          if(before.type!=="file")throw new Error("Scrub source unavailable");
          if(!this.#partial||this.#partial.id!==row.id||this.#partial.sha256!==row.sha256||this.#partial.path!==row.storage_path||this.#partial.size!==before.size||this.#partial.modifiedAt!==before.modifiedAt.getTime())
            this.#partial={id:row.id,sha256:row.sha256,path:row.storage_path,offset:0,size:before.size,modifiedAt:before.modifiedAt.getTime(),hash:createHash("sha256")};
          const partial=this.#partial;
          while(partial.offset<before.size&&bytes<maximumBytes&&Date.now()<deadline&&!aborted()){
            const length=Math.min(8*1024*1024,before.size-partial.offset,maximumBytes-bytes);let read=0;
            for await(const raw of await this.storage.openRead(row.storage_path,{offset:partial.offset,length,priority:"scrub",signal:runSignal})){
              const chunk=Buffer.from(raw as Uint8Array);read+=chunk.length;if(read>length)throw new Error("Scrub budget exceeded");partial.hash.update(chunk);partial.offset+=chunk.length;bytes+=chunk.length;
            }
            if(read!==length)throw new Error("Scrub source changed");
          }
          const after=await this.storage.stat(row.storage_path);
          if(after.size!==before.size||after.modifiedAt.getTime()!==before.modifiedAt.getTime()){this.#partial=undefined;deferred=true;break;}
          if(partial.offset<before.size){deferred=true;break;}
          const size=partial.offset,hash=partial.hash;this.#partial=undefined;checked++;
          if (size !== Number(row.size_bytes) || hash.digest('hex') !== row.sha256) {
            const handled=await this.options.quarantine?.(row,size)??false;
            if(!handled)await this.database.transaction(async sql => {
              await sql`UPDATE file_versions SET state='error' WHERE id=${row.id} AND state='active' AND storage_path=${row.storage_path} AND sha256=${row.sha256}`;
              await sql`UPDATE resources SET status='quarantined', updated_at=now() WHERE id=${row.resource_id} AND current_version_id=${row.id}`;
              await sql`INSERT INTO audit_events (id,actor_type,actor_id,action,outcome,correlation_id,details)
                VALUES (${uuidv7()},'worker','integrity-scrub','file.integrity.mismatch','failure',${`scrub:${row.id}:${uuidv7()}`},${sql.json({resourceId:row.resource_id,versionId:row.id,expectedSha256:row.sha256,actualSize:size})})`;
            });
            mismatched++;
          }
          next=row.id;
        } catch(error) {
          this.#partial=undefined;
          const code=error&&typeof error==="object"&&"code"in error?String(error.code):"unavailable";
          if(aborted()||["admission_full","capacity","backend_draining","cancelled"].includes(code)){deferred=true;break;}
          // An unreadable object is not evidence of corruption. Record the
          // failed check and continue; the next cursor cycle retries it.
          await this.database.withSql(sql => sql`INSERT INTO audit_events (id,actor_type,actor_id,action,outcome,correlation_id,details)
            VALUES (${uuidv7()},'worker','integrity-scrub','file.integrity.unavailable','failure',${`scrub:${row.id}:${uuidv7()}`},${sql.json({resourceId:row.resource_id,versionId:row.id})})`);
          next=row.id;
        } finally { await files.releaseLocks(lease); }
      }
      if (rows.length === 0) next="";
      await this.database.withSql(async sql => { await sql`UPDATE integrity_scrub_state SET last_version_id=${next},updated_at=now() WHERE id=true`; });
      if(this.options.quarantine)await this.database.withSql(sql=>sql`INSERT INTO sync_scrub_progress(id,version_id,offset_bytes,bytes_this_run,updated_at)
        VALUES(true,${this.#partial?.id??null}::uuid,${String(this.#partial?.offset??0)}::bigint,${bytes},now())
        ON CONFLICT(id) DO UPDATE SET version_id=EXCLUDED.version_id,offset_bytes=EXCLUDED.offset_bytes,bytes_this_run=EXCLUDED.bytes_this_run,updated_at=now()`);
      return { checked, mismatched,bytes,deferred };
    });
  }
}
