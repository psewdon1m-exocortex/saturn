import type { Database } from "@saturn/database";
import type { TransactionSql } from "postgres";
import { createHash,scrypt,timingSafeEqual } from "node:crypto";
import { OUTDOOR_CONNECTIONS_RESOURCE_ID, SYNC_RESOURCE_ID } from "./models.js";
import { CatalogFolderError, type CatalogFolderActor } from "./catalog-folder-intent.js";

/** Opaque, process-local proof. A serialized actor, audit label or plain object is never authority. */
export interface CatalogFolderAuthority { readonly proof: "saturn.catalog-folder-authority.v1" }
interface DevicePrincipal { readonly device: { readonly id:string;readonly tokenHash:string;readonly deviceKind:string;readonly syncRootId?:string;readonly scopeIds:readonly string[];readonly rights:{readonly write:boolean} } }
interface SessionPrincipal {readonly id:string;readonly tokenHash:string}
interface Proof {readonly actor:CatalogFolderActor;readonly rootId:string;readonly tokenHash?:string;readonly sessionId?:string;readonly revision?:string;readonly deviceKind?:string}
export interface CatalogFolderAuthorityValidators {
  /** Trusted composition must call the normal route-authentication service, outside the clock TX. */
  readonly authenticateDevice?:(authorization:string|undefined)=>Promise<DevicePrincipal>;
  readonly validateOwnerSession?:(input:unknown)=>Promise<SessionPrincipal>;
}

export class CatalogFolderAuthorityIssuer {
  readonly #proofs=new WeakMap<object,Proof>();
  #bootstrapChecks=0;
  constructor(private readonly database:Database,private readonly validators:CatalogFolderAuthorityValidators) {}
  #seal(value:Proof):CatalogFolderAuthority {
    const proof=Object.freeze({proof:"saturn.catalog-folder-authority.v1" as const});
    this.#proofs.set(proof,Object.freeze({...value,actor:Object.freeze({...value.actor})})); return proof;
  }
  async #revision():Promise<string> {
    const revision=await this.database.withSql(async sql=>(await sql<{revision:string}[]>`SELECT revision::text FROM owner_credentials WHERE owner_id='owner'`)[0]?.revision);
    if(!revision)throw new CatalogFolderError("authority_invalid"); return revision;
  }
  async device(authorization:string|undefined,rootId:string):Promise<CatalogFolderAuthority> {
    const principal=await this.validators.authenticateDevice?.(authorization);
    const d=principal?.device;
    if(!d||!["windows_sync","pluto"].includes(d.deviceKind)||!d.rights.write||d.syncRootId!==rootId||d.scopeIds.length!==1||d.scopeIds[0]!==rootId
      ||!/^[a-f\d]{64}$/.test(d.tokenHash))throw new CatalogFolderError("authority_invalid");
    return this.#seal({actor:{type:"device_token",id:d.id},rootId,tokenHash:d.tokenHash,deviceKind:d.deviceKind});
  }
  async ownerSession(input:unknown,rootId:string):Promise<CatalogFolderAuthority> {
    const session=await this.validators.validateOwnerSession?.(input);
    if(!session)throw new CatalogFolderError("authority_invalid");
    return this.#seal({actor:{type:"owner_web",id:"owner"},rootId,sessionId:session.id,tokenHash:session.tokenHash,revision:await this.#revision()});
  }
  async ownerBootstrap(input:string,rootId:string):Promise<CatalogFolderAuthority> {
    // OwnerAuthService's legacy bootstrap verifier can be cached. A boolean
    // from that cache cannot be sealed with a newly read credential revision.
    // Read and verify the actual revision outside the catalog transaction.
    if(this.#bootstrapChecks>=4)throw new CatalogFolderError("admission_full");
    this.#bootstrapChecks++;
    try {
      const row=await this.database.withSql(async sql=>(await sql<{algorithm:string;salt_hex:string;verifier_hex:string;revision:string}[]>`
        SELECT algorithm,salt_hex,verifier_hex,revision::text FROM owner_credentials WHERE owner_id='owner'`)[0]);
      if(!row||row.algorithm!=="scrypt-v1"||!/^[a-f\d]{32}$/.test(row.salt_hex)||!/^[a-f\d]{64}$/.test(row.verifier_hex)||input.length>4096)throw new CatalogFolderError("authority_invalid");
      const derived=await new Promise<Buffer>((resolve,reject)=>scrypt(input,Buffer.from(row.salt_hex,"hex"),32,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,result)=>error?reject(error):resolve(result)));
      if(!timingSafeEqual(derived,Buffer.from(row.verifier_hex,"hex")))throw new CatalogFolderError("authority_invalid");
      return this.#seal({actor:{type:"owner_bootstrap",id:"owner"},rootId,revision:row.revision});
    } finally {this.#bootstrapChecks--;}
  }
  actor(authority:CatalogFolderAuthority,rootId:string):CatalogFolderActor {
    const p=this.#proofs.get(authority);
    if(!p||p.rootId!==rootId)throw new CatalogFolderError("authority_invalid"); return p.actor;
  }
  /** Trusted fixed SQL adapter only; a caller-supplied actor can never supply this credential. */
  deviceCredential(authority:CatalogFolderAuthority,rootId:string):Readonly<{deviceId:string;tokenHash:string;deviceKind:string}> {
    this.actor(authority,rootId);const p=this.#proofs.get(authority);
    if(!p||p.actor.type!=="device_token"||!p.tokenHash||!p.deviceKind)throw new CatalogFolderError("authority_invalid");
    return Object.freeze({deviceId:p.actor.id,tokenHash:p.tokenHash,deviceKind:p.deviceKind});
  }
  /** Fixed outside-child commit adapter only. Serialized actor labels cannot
   * recover a proof; bootstrap scrypt/session validation already sealed it. */
  ownerCredential(authority:CatalogFolderAuthority,rootId:string):Readonly<{actorType:string;rootId:string;revision:string;sessionId:string|null;tokenHash:string|null}> {
    this.actor(authority,rootId);const p=this.#proofs.get(authority);
    if(!p||!p.revision||!["owner_bootstrap","owner_web"].includes(p.actor.type))throw new CatalogFolderError("authority_invalid");
    return Object.freeze({actorType:p.actor.type,rootId,revision:p.revision,sessionId:p.sessionId??null,tokenHash:p.tokenHash??null});
  }
  /** Private proof identity is hashed only after the current database authority check. */
  async fingerprint(sql:TransactionSql,authority:CatalogFolderAuthority,rootId:string):Promise<string> {
    await this.check(sql,authority,rootId);const p=this.#proofs.get(authority);
    if(!p)throw new CatalogFolderError("authority_invalid");
    // check() has locked and revalidated this exact device. Cursor reads also
    // require current read permission; auth touch timestamps never enter identity.
    let readBinding:readonly unknown[]|null=null;
    if(p.actor.type==="device_token") {
      const row=(await sql<{can_read:boolean;can_write:boolean;can_move:boolean;can_delete:boolean;expires_at:string|null}[]>`
        SELECT can_read,can_write,can_move,can_delete,
          to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at
          FROM devices WHERE id=${p.actor.id}`)[0];
      if(!row?.can_read)throw new CatalogFolderError("authorization_changed");
      readBinding=[row.can_read,row.can_write,row.can_move,row.can_delete,row.expires_at];
    }
    return createHash("sha256").update(JSON.stringify(["saturn.catalog-authority.v1",p.actor.type,p.actor.id,p.rootId,
      p.tokenHash??null,p.sessionId??null,p.revision??null,p.deviceKind??null,readBinding])).digest("hex");
  }
  /** Fixed SQL recheck; no auth/network/hash callbacks run under the clock lock. */
  async check(sql:TransactionSql,authority:CatalogFolderAuthority,rootId:string):Promise<void> {
    const p=this.#proofs.get(authority); this.actor(authority,rootId);
    if(!p)throw new CatalogFolderError("authority_invalid");
    if(p.actor.type==="device_token") {
      await sql`SELECT id FROM devices WHERE id=${p.actor.id} FOR SHARE`;
      const parent=p.deviceKind==="windows_sync"?SYNC_RESOURCE_ID:OUTDOOR_CONNECTIONS_RESOURCE_ID;
      const allowed=(await sql<{allowed:boolean}[]>`SELECT EXISTS(SELECT 1 FROM devices d JOIN resources r ON r.id=d.sync_root_id
        WHERE d.id=${p.actor.id} AND d.state='active' AND d.can_write AND d.device_kind=${p.deviceKind ?? ''}
          AND d.token_hash=${p.tokenHash ?? ''} AND d.sync_root_id=${rootId} AND d.scope_ids=ARRAY[${rootId}::uuid]
          AND (d.expires_at IS NULL OR d.expires_at>now()) AND r.parent_id=${parent} AND r.type='folder' AND r.status='active') AS allowed`)[0]?.allowed;
      if(!allowed)throw new CatalogFolderError("authorization_changed");
    } else {
      // Password replacement also locks session first, then credentials.
      if(p.actor.type==="owner_web") {
        const allowed=(await sql`SELECT id FROM web_sessions WHERE id=${p.sessionId ?? ''} AND token_hash=${p.tokenHash ?? ''}
          AND state='active' AND idle_expires_at>now() AND expires_at>now() FOR SHARE`).length===1;
        if(!allowed)throw new CatalogFolderError("authorization_changed");
      }
      const allowed=(await sql`SELECT owner_id FROM owner_credentials WHERE owner_id='owner' AND revision=${p.revision ?? ''}::bigint FOR SHARE`).length===1;
      if(!allowed)throw new CatalogFolderError("authorization_changed");
      if((await sql`SELECT id FROM resources WHERE id=${rootId} AND type='folder' AND status='active'`).length!==1)throw new CatalogFolderError("authorization_changed");
    }
  }
}
