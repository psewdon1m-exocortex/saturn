import { parseSyncJson, validateSyncDescriptor, validateSyncSnapshotReady, SyncProtocolError,
  SYNC_MAX_PAGE_ITEMS, type SyncSnapshotReady, type SyncRootBinding, type SyncNodeDescriptor } from "./sync-protocol.js";

/** Additive inactive reader. A terminal page is a shape, not proof that all
 * writers were observed or that the server completed a coherent snapshot. */
export interface SyncSnapshotEntriesPage extends SyncRootBinding {
  readonly snapshot_id:string;
  readonly cut_seq:string;
  readonly after_node_id:string|null;
  readonly last_node_id:string|null;
  readonly items:readonly SyncNodeDescriptor[];
  readonly next_cursor:string;
  readonly has_more:boolean;
}
export class SyncSnapshotPageError extends Error {
  constructor(readonly code:"snapshot_mismatch"|"snapshot_page_gap") { super(code); }
}
const invalid=():never=>{throw new SyncProtocolError("invalid_contract");};
const opaque=(value:unknown,maximum=128):value is string=>typeof value==="string"&&value.length>0&&value.length<=maximum&&/^[\x21-\x7e]+$/.test(value);
const keys=["protocol","descriptor_schema","server_identity","root_id","server_epoch","policy_version","binding_version"] as const;
export function validateSyncSnapshotEntriesPage(value:unknown,snapshot:SyncSnapshotReady,after:string|null):asserts value is SyncSnapshotEntriesPage {
  validateSyncSnapshotReady(snapshot);
  if(typeof value!=="object"||value===null||Array.isArray(value))return invalid();
  const page=value as Record<string,unknown>;
  for(const key of keys)if(page[key]!==snapshot[key])throw new SyncProtocolError("binding_mismatch");
  if(page.snapshot_id!==snapshot.snapshot_id||page.cut_seq!==snapshot.cut_seq)throw new SyncSnapshotPageError("snapshot_mismatch");
  if(after!==null&&!opaque(after))return invalid();
  if(page.after_node_id!==null&&!opaque(page.after_node_id)||page.last_node_id!==null&&!opaque(page.last_node_id))return invalid();
  if(page.after_node_id!==after)throw new SyncSnapshotPageError("snapshot_page_gap");
  if(!Array.isArray(page.items)||page.items.length>SYNC_MAX_PAGE_ITEMS)throw new SyncProtocolError("page_limit");
  let last=after;
  for(const item of page.items){
    validateSyncDescriptor(item);
    // IDs are bounded ASCII. This order agrees with PostgreSQL canonical UUID
    // order; locale-aware or numeric ordering would disagree at page boundaries.
    if(last!==null&&item.node_id<=last)throw new SyncSnapshotPageError("snapshot_page_gap");
    last=item.node_id;
  }
  if(page.last_node_id!==last)throw new SyncSnapshotPageError("snapshot_page_gap");
  if(!opaque(page.next_cursor,4096)||typeof page.has_more!=="boolean")return invalid();
  if(page.has_more&&page.items.length===0)throw new SyncSnapshotPageError("snapshot_page_gap");
}
export function readSyncSnapshotEntriesPage(raw:Uint8Array,snapshot:SyncSnapshotReady,after:string|null):SyncSnapshotEntriesPage {
  const value=parseSyncJson(raw);validateSyncSnapshotEntriesPage(value,snapshot,after);return value;
}
