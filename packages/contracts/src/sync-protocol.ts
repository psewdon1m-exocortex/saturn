/** Inactive proposed sync/1 contract. No route, feature or writer is enabled here.
 * `version` is an opaque metadata CAS identity; content_version_id is separate.
 * Historical upload receipts never become a descriptor, snapshot cut or B.
 */
export const SYNC_PROTOCOL = "neptune-sync/1";
export const SYNC_DESCRIPTOR_SCHEMA = "saturn.current-namespace.v1";
export const SYNC_MAX_PAGE_ITEMS = 500;
export const SYNC_MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const SYNC_MAX_INTEGER64 = 9223372036854775807n;

export type SyncRootState = "LEGACY" | "ENROLLING" | "QUALIFYING" | "ACTIVE" | "BACKEND_UNCERTAIN" | "REBUILDING" | "RETIRED";
export type SyncAvailability = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
export interface SyncNodeDescriptor {
  readonly node_id: string;
  /** Root descriptor uses null; every other parent is an in-root stable ID. */
  readonly parent_id: string | null;
  readonly name: string;
  readonly type: "file" | "folder";
  readonly size_bytes: string;
  readonly content_sha256: string | null;
  readonly content_version_id: string | null;
  /** UUID updated only for a meaningful change of this public descriptor. */
  readonly version: string;
  /** Unavailable/unknown does not imply namespace absence or deletion. */
  readonly availability: SyncAvailability;
}
export type SyncExpected = {readonly kind:"absent"} | {readonly kind:"version";readonly node_id:string;readonly version:string};
export interface SyncRootBinding {
  readonly protocol: typeof SYNC_PROTOCOL;
  readonly descriptor_schema: typeof SYNC_DESCRIPTOR_SCHEMA;
  readonly server_identity: string;
  readonly root_id: string;
  readonly server_epoch: string;
  readonly policy_version: string;
  /** Root qualification/availability incarnation, independent of permissions. */
  readonly binding_version: string;
}
export interface SyncSnapshotReady extends SyncRootBinding {
  readonly snapshot_id: string;
  readonly state: "READY";
  readonly cut_seq: string;
  readonly entries_cursor: string;
  readonly changes_cursor: string;
  readonly lease_seconds: number;
  readonly absolute_lifetime_seconds: number;
}
export interface SyncFeedUpsert extends SyncNodeDescriptor {
  readonly seq: string;
  readonly kind: "upsert";
  readonly operation_id: string;
}
export interface SyncFeedTombstone extends SyncNodeDescriptor {
  readonly seq: string;
  readonly kind: "tombstone";
  readonly operation_id: string;
  /** The retained pre-state CAS identity; `version` identifies the deletion. */
  readonly before_version: string;
}
export interface SyncFeedPage extends SyncRootBinding {
  readonly from_exclusive: string;
  readonly to_inclusive: string;
  readonly items: readonly (SyncFeedUpsert|SyncFeedTombstone)[];
  readonly next_cursor: string;
  readonly has_more: boolean;
}
export class SyncProtocolError extends Error {
  constructor(readonly code:"invalid_json"|"invalid_contract"|"page_limit"|"feed_gap"|"binding_mismatch") {super(code);}
}
const bad=():never=>{throw new SyncProtocolError("invalid_contract");};
const object=(v:unknown):Record<string,unknown>=>typeof v==="object"&&v!==null&&!Array.isArray(v)?v as Record<string,unknown>:bad();
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const opaque=/^[\x21-\x7e]{1,128}$/;
const scalar=(s:string):boolean=>{
  for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const d=s.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))return false;}else if(c>=0xdc00&&c<=0xdfff)return false;}
  return true;
};
export function syncInteger64(v:unknown):bigint {
  if(typeof v!=="string"||!/^(0|[1-9][0-9]{0,18})$/.test(v))return bad();
  const n=BigInt(v);return n<=SYNC_MAX_INTEGER64?n:bad();
}
function id(v:unknown):void{if(typeof v!=="string"||!opaque.test(v))bad();}
function version(v:unknown):void{if(typeof v!=="string"||!uuid.test(v))bad();}
function cursor(v:unknown):void{if(typeof v!=="string"||!v||v.length>4096||!/^[\x21-\x7e]+$/.test(v))bad();}
export function validateSyncDescriptor(value:unknown):asserts value is SyncNodeDescriptor {
  const d=object(value);id(d.node_id);if(d.parent_id!==null)id(d.parent_id);if(d.node_id===d.parent_id)bad();version(d.version);syncInteger64(d.size_bytes);
  if(typeof d.name!=="string"||!d.name||!scalar(d.name)||new TextEncoder().encode(d.name).length>1020||d.name.includes("\0")||/[/\\]/.test(d.name))bad();
  if(d.type!=="file"&&d.type!=="folder")bad();
  if(typeof d.availability!=="string"||!["AVAILABLE","UNAVAILABLE","UNKNOWN"].includes(d.availability))bad();
  if(d.content_sha256!==null&&(typeof d.content_sha256!=="string"||!/^[a-f0-9]{64}$/.test(d.content_sha256)))bad();
  if(d.content_version_id!==null)id(d.content_version_id);
  if(d.type==="folder"&&(d.content_sha256!==null||d.content_version_id!==null))bad();
  if(d.type==="file"&&d.availability==="AVAILABLE"&&(d.content_sha256===null||d.content_version_id===null))bad();
}
export function validateSyncExpected(value:unknown):asserts value is SyncExpected {
  const d=object(value);if(d.kind==="absent"){if(Object.keys(d).length!==1)bad();return;}
  if(d.kind!=="version"||Object.keys(d).length!==3||Object.keys(d).some(k=>!["kind","node_id","version"].includes(k)))bad();
  id(d.node_id);version(d.version);
}
function binding(v:unknown):asserts v is SyncRootBinding {
  const d=object(v);if(d.protocol!==SYNC_PROTOCOL||d.descriptor_schema!==SYNC_DESCRIPTOR_SCHEMA)bad();
  for(const k of ["server_identity","root_id","server_epoch","policy_version"])id(d[k]);version(d.binding_version);
}
export function validateSyncSnapshotReady(value:unknown):asserts value is SyncSnapshotReady {
  binding(value);const d=object(value);id(d.snapshot_id);if(d.state!=="READY")bad();syncInteger64(d.cut_seq);cursor(d.entries_cursor);cursor(d.changes_cursor);
  for(const k of ["lease_seconds","absolute_lifetime_seconds"])if(typeof d[k]!=="number"||!Number.isSafeInteger(d[k])||d[k]<1||d[k]>86400)bad();
  if((d.lease_seconds as number)>(d.absolute_lifetime_seconds as number))bad();
}
/** Semantic qualification comes from complete writer coverage and signed server
 * cursors. This validator checks wire shape/continuity, never grants authority.
 */
export function validateSyncFeedPage(value:unknown,previous:SyncRootBinding&{readonly after_seq:string}):asserts value is SyncFeedPage {
  binding(value);const d=object(value),p=object(previous);
  for(const k of ["protocol","descriptor_schema","server_identity","root_id","server_epoch","policy_version","binding_version"])if(d[k]!==p[k])throw new SyncProtocolError("binding_mismatch");
  const from=syncInteger64(d.from_exclusive),through=syncInteger64(d.to_inclusive);if(from!==syncInteger64(previous.after_seq)||through<from)throw new SyncProtocolError("feed_gap");
  if(!Array.isArray(d.items)||d.items.length>SYNC_MAX_PAGE_ITEMS)throw new SyncProtocolError("page_limit");
  let seq=from;for(const entry of d.items){validateSyncDescriptor(entry);const row=object(entry);if(row.kind!=="upsert"&&row.kind!=="tombstone")bad();id(row.operation_id);if(syncInteger64(row.seq)!==++seq)throw new SyncProtocolError("feed_gap");if(row.kind==="tombstone"){version(row.before_version);if(row.before_version===row.version)bad();}}
  if(seq!==through)throw new SyncProtocolError("feed_gap");cursor(d.next_cursor);if(typeof d.has_more!=="boolean")bad();
  if(d.has_more&&d.items.length===0)throw new SyncProtocolError("feed_gap");
}
/** Bound bytes and validate UTF-8, scalar strings, duplicate keys and depth
 * before a consumer interprets a response. Forward response fields are allowed;
 * request semantic unions are separately strict.
 */
export function parseSyncJson(bytes:Uint8Array,maximum=SYNC_MAX_PAGE_BYTES):unknown {
  if(bytes.length>maximum)throw new SyncProtocolError("page_limit");
  try{
    const source=new TextDecoder("utf-8",{fatal:true}).decode(bytes),parsed:unknown=JSON.parse(source);let at=0;
    const space=()=>{while(/[ \t\n\r]/.test(source[at]??"!"))at++;};
    const string=():string=>{const start=at++;while(at<source.length){const c=source[at++];if(c==="\\")at++;else if(c==='"'){const s:unknown=JSON.parse(source.slice(start,at));if(typeof s!=="string")return bad();if(!scalar(s))return bad();return s;}}return bad();};
    const value=(depth:number):void=>{if(depth>32)bad();space();if(source[at]==="{"){at++;space();const keys=new Set<string>();while(source[at]!=="}"){const key=string();if(keys.has(key))bad();keys.add(key);space();at++;value(depth+1);space();if(source[at]!==",")break;at++;space();}at++;}else if(source[at]==="["){at++;space();while(source[at]!=="]"){value(depth+1);space();if(source[at]!==",")break;at++;space();}at++;}else if(source[at]==='"')string();else while(at<source.length&&!/[ \t\n\r,}\]]/.test(source[at]??""))at++;};
    value(0);space();if(at!==source.length)bad();return parsed;
  }catch(e){if(e instanceof SyncProtocolError)throw e;throw new SyncProtocolError("invalid_json");}
}
/** The response budget applies to the bytes sent, including forward fields.
 * Re-serializing received JSON can change numeric spellings and is not an
 * incoming byte measure. Producers must use this bounded encoder.
 */
export function encodeSyncJson(value:unknown):Uint8Array {
  try{
    const source=JSON.stringify(value);if(typeof source!=="string")return bad();
    const bytes=new TextEncoder().encode(source);parseSyncJson(bytes);return bytes;
  }catch(e){if(e instanceof SyncProtocolError)throw e;throw new SyncProtocolError("invalid_json");}
}
