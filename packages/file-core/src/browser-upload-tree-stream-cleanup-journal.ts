import type {Database} from "@saturn/database";
import type {TransactionSql} from "postgres";
import type {BrowserTreeOriginalReference} from "./browser-upload-tree-executor.js";
import type {BrowserTreeStreamCleanupOriginal,BrowserTreeStreamCleanupJournal} from "./browser-upload-tree-stream-cleanup.js";
import type {BrowserTreeSpoolChunk,BrowserTreeSpoolRemoval} from "./browser-upload-tree-stream-spool.js";

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function fail(code:string):never{throw Error(code);}
function ref(input:BrowserTreeOriginalReference|null|undefined):BrowserTreeOriginalReference{
 if(!input||![input.treeId,input.jobId,input.itemId].every(v=>uuid.test(v)))fail("browser_tree_identity_invalid");return Object.freeze({...input});
}
interface ChunkRow {offset_bytes:string;length_bytes:number;sha256:string;write_task_id:string;spool_dev:string|null;spool_ino:string|null}
/** Internal maintenance journal for a QUALIFIED fixed spool incarnation. It
 * grants no browser admission or arbitrary deletion authority. The exact
 * terminal original survives session revoke/backend generation changes; the
 * worker must retain custody of the originally configured private spool. */
export class PostgresBrowserTreeStreamCleanupJournal implements BrowserTreeStreamCleanupJournal {
 readonly #options:{readonly backendIdentity:string;readonly backendGeneration:string;readonly spoolId:string};
 constructor(private readonly database:Database,options:{readonly backendIdentity:string;readonly backendGeneration:string;readonly spoolId:string}){
  if(!options.backendIdentity||!uuid.test(options.backendGeneration)||!uuid.test(options.spoolId))fail("browser_tree_cleanup_configuration_invalid");this.#options=Object.freeze({...options});
 }
 withOriginalLock<T>(input:BrowserTreeOriginalReference,action:()=>Promise<T>):Promise<T>{const reference=ref(input);return this.database.withAdvisoryLock(`saturn-browser-stream:${reference.treeId}:${reference.itemId}`,action);}
 async #original(sql:TransactionSql,reference:BrowserTreeOriginalReference,expected?:BrowserTreeStreamCleanupOriginal):Promise<BrowserTreeStreamCleanupOriginal>{
  const row=(await sql<{operation_id:string;spool_id:string;cleanup_task_id:string;state:"retained"|"released";item_state:string;job_state:string;drop_upload_id:string|null}[]>`
   SELECT r.operation_id,r.spool_id,r.cleanup_task_id,r.state,i.state AS item_state,j.state AS job_state,r.drop_upload_id
   FROM browser_upload_spool_reservations r JOIN browser_upload_items i ON i.tree_id=r.tree_id AND i.item_id=r.item_id
   JOIN browser_upload_jobs j ON j.tree_id=i.tree_id AND j.id=i.job_id JOIN browser_upload_trees t ON t.id=i.tree_id
   JOIN browser_upload_streams s ON s.tree_id=i.tree_id AND s.item_id=i.item_id
   WHERE r.tree_id=${reference.treeId} AND r.item_id=${reference.itemId} AND i.job_id=${reference.jobId}
    AND r.backend_identity=${this.#options.backendIdentity} AND r.backend_generation=${this.#options.backendGeneration} AND r.spool_id=${this.#options.spoolId}
    AND r.operation_id=i.operation_id AND r.expected_size=i.size_bytes AND r.expected_size=s.expected_size AND s.expected_sha256=i.sha256 AND r.spool_id=s.spool_id
    AND r.backend_identity=t.backend_identity AND r.backend_generation=t.backend_generation AND r.principal_kind=t.principal_kind AND r.scope_id=t.scope_id
    AND r.drop_upload_id IS NOT DISTINCT FROM i.drop_upload_id AND i.payload_mode='stream' AND j.payload_mode='stream'
   FOR UPDATE OF r,i,j`)[0];
  if(!row)fail("browser_tree_cleanup_original_changed");
  if(!(row.item_state==="published"&&row.job_state==="completed"||row.item_state==="cancelled"&&row.job_state==="cancelled"))fail("browser_tree_cleanup_not_terminal");
  if(row.drop_upload_id!==null){const drop=await sql`SELECT id FROM drop_uploads WHERE id=${row.drop_upload_id} AND state=${row.item_state==="published"?"stored":"cancelled"} AND local_path IS NULL`;if(drop.length!==1)fail("browser_tree_cleanup_drop_retained");}
  const result=Object.freeze({reference,operationId:row.operation_id,spoolId:row.spool_id,cleanupTaskId:row.cleanup_task_id,state:row.state});
  if(expected&&(expected.operationId!==result.operationId||expected.spoolId!==result.spoolId||expected.cleanupTaskId!==result.cleanupTaskId))fail("browser_tree_cleanup_original_changed");return result;
 }
 #chunk(original:BrowserTreeStreamCleanupOriginal,row:ChunkRow):BrowserTreeSpoolChunk{
  const offset=Number(row.offset_bytes);if(!Number.isSafeInteger(offset)||offset<0||offset%4194304!==0||row.length_bytes<1||row.length_bytes>4194304)fail("browser_tree_cleanup_chunk_invalid");
  return Object.freeze({spoolId:original.spoolId,operationId:original.operationId,writeTaskId:row.write_task_id,offset,length:row.length_bytes,sha256:row.sha256,
   identity:row.spool_dev===null||row.spool_ino===null?null:Object.freeze({dev:row.spool_dev,ino:row.spool_ino})});
 }
 inspect(input:BrowserTreeOriginalReference):Promise<BrowserTreeStreamCleanupOriginal>{const reference=ref(input);return this.database.transaction(sql=>this.#original(sql,reference));}
 nextChunk(expected:BrowserTreeStreamCleanupOriginal):Promise<BrowserTreeSpoolChunk|null>{
  const reference=ref(expected.reference);return this.database.transaction(async sql=>{
   const original=await this.#original(sql,reference,expected);if(original.state==="released")return null;
   const row=(await sql<ChunkRow[]>`SELECT c.offset_bytes::text,c.length_bytes,c.sha256,c.write_task_id,c.spool_dev,c.spool_ino
    FROM browser_upload_stream_chunks c LEFT JOIN browser_upload_spool_cleanup_receipts r ON r.tree_id=c.tree_id AND r.item_id=c.item_id AND r.offset_bytes=c.offset_bytes
    WHERE c.tree_id=${reference.treeId} AND c.item_id=${reference.itemId} AND r.tree_id IS NULL ORDER BY c.offset_bytes LIMIT 1`)[0];
   return row?this.#chunk(original,row):null;
  });
 }
 recordRemoval(expected:BrowserTreeStreamCleanupOriginal,input:BrowserTreeSpoolChunk,inputRemoval:BrowserTreeSpoolRemoval):Promise<void>{
  const reference=ref(expected.reference),chunk=structuredClone(input),removal=structuredClone(inputRemoval);
  return this.database.transaction(async sql=>{
   const original=await this.#original(sql,reference,expected),row=(await sql<ChunkRow[]>`SELECT offset_bytes::text,length_bytes,sha256,write_task_id,spool_dev,spool_ino FROM browser_upload_stream_chunks
    WHERE tree_id=${reference.treeId} AND item_id=${reference.itemId} AND offset_bytes=${chunk.offset}`)[0];
   if(!row)fail("browser_tree_cleanup_chunk_changed");const actual=this.#chunk(original,row);
   if(actual.operationId!==chunk.operationId||actual.spoolId!==chunk.spoolId||actual.writeTaskId!==chunk.writeTaskId||actual.offset!==chunk.offset||actual.length!==chunk.length||actual.sha256!==chunk.sha256
    ||actual.identity?.dev!==chunk.identity?.dev||actual.identity?.ino!==chunk.identity?.ino)fail("browser_tree_cleanup_chunk_changed");
   const previous=await sql`SELECT cleanup_task_id FROM browser_upload_spool_cleanup_receipts WHERE tree_id=${reference.treeId} AND item_id=${reference.itemId} AND offset_bytes=${chunk.offset}
    AND cleanup_task_id=${original.cleanupTaskId} AND spool_id=${original.spoolId} AND write_task_id=${chunk.writeTaskId}`;
   if(previous.length===1)return;
   if(original.state!=="retained"||!["removed","absent"].includes(removal.disposition)||!Number.isSafeInteger(removal.removedBytes)||removal.removedBytes<0||removal.removedBytes>chunk.length
    ||removal.disposition==="absent"&&removal.removedBytes!==0||removal.disposition==="removed"&&removal.identity===null
    ||removal.identity!==null&&(!/^\d+$/.test(removal.identity.dev)||!/^\d+$/.test(removal.identity.ino))
    ||chunk.identity!==null&&(removal.identity===null||chunk.identity.dev!==removal.identity.dev||chunk.identity.ino!==removal.identity.ino)||chunk.identity===null&&removal.removedBytes!==0)fail("browser_tree_cleanup_receipt_invalid");
   await sql`INSERT INTO browser_upload_spool_cleanup_receipts(tree_id,item_id,offset_bytes,cleanup_task_id,spool_id,write_task_id,disposition,spool_dev,spool_ino,removed_bytes)
    VALUES(${reference.treeId},${reference.itemId},${chunk.offset},${original.cleanupTaskId},${original.spoolId},${chunk.writeTaskId},${removal.disposition},${removal.identity?.dev??null},${removal.identity?.ino??null},${removal.removedBytes})`;
  });
 }
 release(expected:BrowserTreeStreamCleanupOriginal):Promise<BrowserTreeStreamCleanupOriginal>{
  const reference=ref(expected.reference);return this.database.transaction(async sql=>{
   const original=await this.#original(sql,reference,expected);if(original.state==="released")return original;
   // The database guard independently checks every exact cleanup receipt. No
   // cap/global advisory lock is needed for this negative accounting delta.
   const rows=await sql`UPDATE browser_upload_spool_reservations SET state='released',released_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tree_id=${reference.treeId} AND item_id=${reference.itemId} AND cleanup_task_id=${original.cleanupTaskId} AND state='retained' RETURNING tree_id`;
   if(rows.length!==1)fail("browser_tree_cleanup_release_unconfirmed");return Object.freeze({...original,state:"released"});
  });
 }
}
