import type {Database} from "@saturn/database";
import {BrowserTreeAuthorityIssuer,type BrowserTreeAuthority,type BrowserTreePrincipal} from "./browser-upload-tree-authority.js";
import type {BrowserTreeStreamQueuedRequest} from "./browser-upload-tree-stream-database.js";
import {DROP_POINT_RESOURCE_ID} from "./models.js";

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function fail():never{throw Error("browser_tree_authorization_changed");}
interface RequestPrincipal {principal_kind:string;scope_id:string;root_id:string;request_session_id:string;request_credential_revision:string|null}

/** Internal worker issuance from an exact durable queued request. It does not
 * accept a cookie, token, principal or HTTP object from a caller. Session hashes
 * are read from current private auth tables and exist only in the issuer's
 * WeakMap. Queue rows contain session/revision references, never bearer secrets.
 * Every claim/effect/publication must still recheck current authorization. */
export class BrowserTreeStreamWorkerAuthority {
 readonly authority:BrowserTreeAuthorityIssuer;
 readonly #tickets=new WeakMap<object,BrowserTreePrincipal>();
 readonly #options:{readonly backendIdentity:string;readonly backendGeneration:string;readonly spoolId:string};
 constructor(private readonly database:Database,options:{readonly backendIdentity:string;readonly backendGeneration:string;readonly spoolId:string}){
  if(!options.backendIdentity||options.backendIdentity.length>128||!uuid.test(options.backendGeneration)||!uuid.test(options.spoolId))throw Error("browser_tree_configuration_invalid");
  this.#options=Object.freeze({...options});
  this.authority=new BrowserTreeAuthorityIssuer({
   ownerSession:input=>{
    const p=this.#ticket(input);if(p.kind!=="owner")fail();
    return Promise.resolve({id:p.sessionId,tokenHash:p.tokenHash,credentialRevision:p.credentialRevision});
   },
   dropSession:input=>{
    const p=this.#ticket(input);if(p.kind!=="drop")fail();
    return Promise.resolve({id:p.sessionId,tokenHash:p.tokenHash,channelId:p.scopeId});
   },
  });
 }
 #ticket(input:unknown):BrowserTreePrincipal{
  if(input===null||typeof input!=="object")fail();const p=this.#tickets.get(input);if(!p)fail();return p;
 }
 async forQueuedRequest(input:Partial<BrowserTreeStreamQueuedRequest>|null|undefined):Promise<BrowserTreeAuthority>{
  if(!input||!input.reference||typeof input.requestId!=="string"||![input.reference.treeId,input.reference.jobId,input.reference.itemId,input.requestId].every(v=>uuid.test(v))
   ||typeof input.authorizationGeneration!=="number"||!Number.isSafeInteger(input.authorizationGeneration)||input.authorizationGeneration<1)throw Error("browser_tree_identity_invalid");
  const request=Object.freeze({...input,requestId:input.requestId,authorizationGeneration:input.authorizationGeneration,reference:Object.freeze({...input.reference})}),ref=request.reference;
  const principal=await this.database.transaction(async sql=>{
   // Use the same positive-admission lock order as the fixed stream adapter.
   await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-drop-buffer-reservation',0))`;
   await sql`SELECT pg_advisory_xact_lock(hashtextextended('saturn-browser-tree-admission',0))`;
   const rows=await sql<RequestPrincipal[]>`SELECT t.principal_kind,t.scope_id,t.root_id,q.request_session_id,q.request_credential_revision::text
    FROM browser_upload_stream_requests q JOIN browser_upload_trees t ON t.id=q.tree_id
    JOIN browser_upload_jobs j ON j.tree_id=q.tree_id AND j.id=q.job_id
    JOIN browser_upload_items i ON i.tree_id=q.tree_id AND i.item_id=q.item_id AND i.job_id=q.job_id
    JOIN browser_upload_streams s ON s.tree_id=q.tree_id AND s.item_id=q.item_id
    JOIN browser_upload_spool_reservations r ON r.tree_id=q.tree_id AND r.item_id=q.item_id
    WHERE q.tree_id=${ref.treeId} AND q.job_id=${ref.jobId} AND q.item_id=${ref.itemId} AND q.request_id=${request.requestId}
     AND q.authorization_generation=${request.authorizationGeneration} AND q.state='queued' AND j.state='accepted' AND i.state='reserved'
     AND q.operation_id=i.operation_id AND r.operation_id=i.operation_id AND i.payload_mode='stream' AND j.payload_mode='stream'
     AND t.backend_identity=${this.#options.backendIdentity} AND t.backend_generation=${this.#options.backendGeneration}
     AND s.spool_id=${this.#options.spoolId} AND r.spool_id=s.spool_id AND r.state='retained'
     AND r.backend_identity=t.backend_identity AND r.backend_generation=t.backend_generation AND r.principal_kind=t.principal_kind AND r.scope_id=t.scope_id
     AND s.state='sealed' AND s.expected_size=i.size_bytes AND s.received_size=i.size_bytes AND r.expected_size=i.size_bytes
     AND s.expected_sha256=i.sha256 AND s.seal_sha256=i.sha256
    FOR SHARE OF q,t,j,i,s,r`;
   const row=rows[0];if(rows.length!==1||!row||!uuid.test(row.root_id)||!uuid.test(row.request_session_id))fail();
   if(row.principal_kind==="owner"){
    if(row.scope_id!=="owner"||row.request_credential_revision===null||! /^[1-9][0-9]*$/.test(row.request_credential_revision))fail();
    const sessions=await sql<{id:string;token_hash:string}[]>`SELECT id,token_hash FROM web_sessions WHERE id=${row.request_session_id} AND state='active' AND idle_expires_at>clock_timestamp() AND expires_at>clock_timestamp() FOR SHARE`;
    const owner=await sql`SELECT owner_id FROM owner_credentials WHERE owner_id='owner' AND revision::text=${row.request_credential_revision} FOR SHARE`;
    const session=sessions[0];if(sessions.length!==1||!session||session.id!==row.request_session_id||owner.length!==1)fail();
    return {kind:"owner",scopeId:"owner",rootId:row.root_id,sessionId:session.id,tokenHash:session.token_hash,credentialRevision:row.request_credential_revision} as const;
   }
   if(row.principal_kind!=="drop"||!uuid.test(row.scope_id)||row.root_id!==DROP_POINT_RESOURCE_ID||row.request_credential_revision!==null)fail();
   const sessions=await sql<{id:string;token_hash:string}[]>`SELECT id,token_hash FROM drop_sessions WHERE id=${row.request_session_id} AND channel_id=${row.scope_id} AND state='active' AND expires_at>clock_timestamp() FOR SHARE`;
   const channels=await sql`SELECT id FROM drop_channels WHERE id=${row.scope_id} AND state='active' AND expires_at>clock_timestamp() FOR SHARE`;
   const session=sessions[0];if(sessions.length!==1||!session||session.id!==row.request_session_id||channels.length!==1)fail();
   return {kind:"drop",scopeId:row.scope_id,rootId:DROP_POINT_RESOURCE_ID,sessionId:session.id,tokenHash:session.token_hash} as const;
  });
  const ticket=Object.freeze({});this.#tickets.set(ticket,principal);
  try{return principal.kind==="owner"?await this.authority.ownerSession(ticket,principal.rootId):await this.authority.dropSession(ticket);}
  finally{this.#tickets.delete(ticket);}
 }
}
