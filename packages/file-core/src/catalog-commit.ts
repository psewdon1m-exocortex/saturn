import { createHash } from "node:crypto";
import type { Database } from "@saturn/database";
import { joinStoragePath } from "@saturn/storage";
import type { ParameterOrFragment, ParameterOrJSON, PendingQuery, TransactionSql } from "postgres";
import { ROOT_RESOURCE_ID, SYNC_RESOURCE_ID } from "./models.js";
import type { CommitOverwriteRecord, CommitUploadRecord, CompleteUploadRecordResult } from "./repository.js";
import { rootJournalJsonBound, validateRootJournalEvents, ROOT_JOURNAL_MAX_BYTES, ROOT_JOURNAL_MAX_ITEMS, type RootJournalEvent, type RootJournalProjection } from "./root-journal.js";
import { uploadIntentHash, uploadPublicationIntentSchema, uploadPublicationReceiptSchema, type UploadPublicationAuthorization, type UploadPublicationIntent } from "./upload-publication.js";
import { assertNamespaceBinding, namespaceDescriptor, validateNamespaceChanges, type NamespaceChange, type NamespaceProjectionRow } from "./current-namespace.js";

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MAX_BIGINT = 9223372036854775807n;
const MAX_ANCESTOR_HOPS = 130; // Scoped 128 hops plus the two canonical ancestors.
const CALLBACK_MS = 1000;
const MAX_ACTIVE = 4;

export class CatalogCommitError extends Error {
  constructor(readonly code: "invalid_input" | "admission_full" | "cancelled" | "root_unavailable" | "epoch_mismatch" | "operation_reused" | "authorization_changed" | "membership_changed" | "unprepared_upload" | "callback_expired" | "projection_mismatch" | "counter_exhausted") { super(code); }
}

/** Explicit internal admission only. Registering a clock does not admit a live writer. */
export interface CatalogCommitRoot {
  readonly rootId: string;
  readonly epoch: string;
  /** Trusted composition identity, not an enforced SFTP takeover generation. */
  readonly backendIdentity: string;
  /** Explicit inactive CJ02 fixture binding; absence preserves historical CJ01. */
  readonly namespaceBindingVersion?: string;
}
export interface PreparedCatalogUpload extends CatalogCommitRoot {
  readonly schema: "saturn.catalog-upload-prepared.v1";
  readonly uploadId: string;
  readonly uploadIntentHash: string;
  readonly intentHash: string;
}
export interface VerifiedCatalogUpload extends PreparedCatalogUpload {
  readonly verifiedSizeBytes: string;
  readonly verifiedSha256: string;
}
/** SQL-only trusted module boundary: no transaction controls or storage handles. */
export interface CatalogCommitSql {
  <T extends readonly (object | undefined)[] = Record<string, unknown>[]>(template: TemplateStringsArray, ...parameters: readonly ParameterOrFragment<never>[]): Promise<T>;
  unsafe<T extends object[] = Record<string, unknown>[]>(text: string, parameters?: ParameterOrJSON<never>[]): Promise<T>;
  json: TransactionSql["json"];
}
export interface CatalogCommitContext { readonly accountingAncestorIds: readonly string[]; readonly replayed: boolean }
interface Clock { root_id: string; epoch: string; published_seq: string }
interface Operation {
  state: string; sync_root_id: string | null; sync_epoch: string | null; sync_intent_hash: string | null;
  sync_first_seq: string | null; sync_last_seq: string | null; sync_result: Record<string, unknown> | null;
  upload_intent: unknown; upload_intent_hash: string | null;
}
interface Ancestor { id: string; parent_id: string | null; name: string; storage_path: string; type: string; status: string; hops: number }
type Projection = NamespaceProjectionRow;

function validId(value: string): void { if (!UUID.test(value)) throw new CatalogCommitError("invalid_input"); }
function binding(intent: UploadPublicationIntent, root: CatalogCommitRoot, uploadId: string): PreparedCatalogUpload {
  const publicationHash = uploadIntentHash(intent);
  return Object.freeze({ schema: "saturn.catalog-upload-prepared.v1", uploadId, ...root, uploadIntentHash: publicationHash,
    intentHash: createHash("sha256").update(JSON.stringify(["saturn.catalog-upload.v1",uploadId,publicationHash,root.rootId,root.epoch,root.backendIdentity,
      ...(root.namespaceBindingVersion === undefined ? [] : [root.namespaceBindingVersion])])).digest("hex") });
}
function description(row: Projection, rootId: string): RootJournalProjection {
  return { parentId: row.id === rootId ? null : row.parent_id, name: row.name, type: row.type, sizeBytes: row.size_bytes, sha256: row.sha256, versionId: row.current_version_id };
}

/**
 * Inactive CJ01 composition. Only sealed Windows uploads on explicitly admitted
 * roots are supported. Other writers, public cuts, takeover and feed remain open.
 * Admission is per coordinator instance/process, not API+worker/global storage.
 */
export class CatalogCommitCoordinator {
  readonly #roots = new Map<string, CatalogCommitRoot>();
  #active = 0;
  constructor(private readonly database: Database, roots: readonly CatalogCommitRoot[]) {
    if (roots.length > 16) throw new CatalogCommitError("invalid_input");
    for (const root of roots) {
      validId(root.rootId); validId(root.epoch);
      if (root.namespaceBindingVersion !== undefined) validId(root.namespaceBindingVersion);
      if (!/^[A-Za-z\d._:-]{1,128}$/.test(root.backendIdentity) || this.#roots.has(root.rootId.toLowerCase())) throw new CatalogCommitError("invalid_input");
      this.#roots.set(root.rootId.toLowerCase(), Object.freeze({ ...root, rootId: root.rootId.toLowerCase(), epoch: root.epoch.toLowerCase() }));
    }
  }
  isRootAdmitted(rootId: string): boolean { return this.#roots.has(rootId.toLowerCase()); }

  async #admit<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new CatalogCommitError("cancelled");
    if (this.#active >= MAX_ACTIVE) throw new CatalogCommitError("admission_full");
    this.#active++;
    try { return await action(); } finally { this.#active--; }
  }

  async #clock(sql: TransactionSql, rootId: string): Promise<Clock> {
    await sql`SET LOCAL lock_timeout='2s'`;
    await sql`SET LOCAL statement_timeout='2s'`;
    await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
    // Clock first, no joined root SHARE lock that ancestor accounting upgrades.
    const row = (await sql<Clock[]>`SELECT root_id,epoch,published_seq::text FROM sync_root_clock WHERE root_id=${rootId} FOR UPDATE`)[0];
    if (!row) throw new CatalogCommitError("root_unavailable");
    return row;
  }

  async #authorize(sql: TransactionSql, intent: UploadPublicationIntent, credential?: UploadPublicationAuthorization): Promise<void> {
    if (credential !== undefined && (credential.deviceId !== intent.deviceId || credential.rootId !== intent.rootId)) throw new CatalogCommitError("authorization_changed");
    await sql`SELECT id FROM devices WHERE id=${intent.deviceId} FOR SHARE`;
    const allowed = (await sql<{ allowed: boolean }[]>`SELECT EXISTS(SELECT 1 FROM devices d JOIN resources r ON r.id=d.sync_root_id
      WHERE d.id=${intent.deviceId} AND d.state='active' AND d.device_kind='windows_sync' AND d.can_write
        AND d.sync_root_id=${intent.rootId} AND d.scope_ids=ARRAY[${intent.rootId}::uuid]
        AND (${credential?.tokenHash ?? null}::text IS NULL OR d.token_hash=${credential?.tokenHash ?? null})
        AND (d.expires_at IS NULL OR d.expires_at>now()) AND r.type='folder' AND r.status='active' AND r.parent_id=${SYNC_RESOURCE_ID}) AS allowed`)[0]?.allowed;
    if (!allowed) throw new CatalogCommitError("authorization_changed");
  }

  async #operation(sql: TransactionSql, uploadId: string): Promise<Operation> {
    await sql`SELECT id FROM upload_sessions WHERE id=${uploadId} FOR UPDATE`;
    const row = (await sql<Operation[]>`SELECT state,sync_root_id,sync_epoch,sync_intent_hash,sync_first_seq::text,sync_last_seq::text,sync_result,
      upload_intent,upload_intent_hash FROM operation_journal WHERE id=${uploadId} AND upload_id=${uploadId} FOR UPDATE`)[0];
    if (!row) throw new CatalogCommitError("operation_reused");
    return row;
  }

  #ancestors(sql: TransactionSql, parentId: string) {
    return sql<Ancestor[]>`WITH RECURSIVE chain AS (
      SELECT id,parent_id,name,storage_path,type,status,0 AS hops,ARRAY[id] AS visited FROM resources WHERE id=${parentId}
      UNION ALL SELECT r.id,r.parent_id,r.name,r.storage_path,r.type,r.status,c.hops+1,c.visited||r.id
        FROM chain c JOIN resources r ON r.id=c.parent_id WHERE c.hops<${MAX_ANCESTOR_HOPS} AND NOT r.id=ANY(c.visited)
    ) SELECT id,parent_id,name,storage_path,type,status,hops FROM chain ORDER BY hops`;
  }
  async #lockAncestors(sql: TransactionSql, intent: UploadPublicationIntent): Promise<readonly Ancestor[]> {
    const before = await this.#ancestors(sql,intent.parentId);
    const root = before.find(row => row.id === intent.rootId);
    if (!root || root.hops > 128 || before.at(-1)?.id !== ROOT_RESOURCE_ID || before.some(row => row.type !== "folder" || row.status !== "active")) throw new CatalogCommitError("membership_changed");
    const ids = [...new Set([...before.map(row => row.id), ...(intent.targetId === null ? [] : [intent.targetId])])].sort();
    await sql`SELECT id FROM resources WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
    const after = await this.#ancestors(sql,intent.parentId);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new CatalogCommitError("membership_changed");
    if ((await sql`SELECT root_id FROM sync_root_clock WHERE root_id=ANY(${before.map(row => row.id)}::uuid[]) AND root_id<>${intent.rootId}`).length !== 0) throw new CatalogCommitError("membership_changed");
    if (after.filter(row => row.hops <= root.hops).length + 1 > ROOT_JOURNAL_MAX_ITEMS) throw new CatalogCommitError("invalid_input");
    return after;
  }

  async prepareUpload(uploadId: string, backendIdentity: string, credential?: UploadPublicationAuthorization, signal?: AbortSignal): Promise<PreparedCatalogUpload | undefined> {
    validId(uploadId);
    const authorization = credential === undefined ? undefined : Object.freeze({ ...credential });
    return this.#admit(() => this.database.transaction(async sql => {
    await sql`SET LOCAL lock_timeout='2s'`;
    await sql`SET LOCAL statement_timeout='2s'`;
    await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
    const candidate = (await sql<{ upload_intent: unknown; sync_root_id: string | null }[]>`
      SELECT upload_intent,sync_root_id FROM operation_journal WHERE id=${uploadId} AND upload_id=${uploadId}`)[0];
    if (candidate === undefined) return undefined;
    if (candidate.upload_intent === null) {
      if (candidate.sync_root_id !== null) throw new CatalogCommitError("unprepared_upload");
      return undefined;
    }
    const intent = uploadPublicationIntentSchema.parse(candidate.upload_intent);
    const root = this.#roots.get(intent.rootId);
    if (!root) { if (candidate.sync_root_id !== null) throw new CatalogCommitError("root_unavailable"); return undefined; }
    if (root.backendIdentity !== backendIdentity) throw new CatalogCommitError("unprepared_upload");
    const prepared = binding(intent,root,uploadId);
      const current = await this.#clock(sql,root.rootId);
      if (root.namespaceBindingVersion !== undefined) await assertNamespaceBinding(sql,root.rootId,root.namespaceBindingVersion);
      if (current.epoch !== root.epoch) throw new CatalogCommitError("epoch_mismatch");
      await this.#authorize(sql,intent,authorization);
      const operation = await this.#operation(sql,uploadId);
      if (operation.upload_intent_hash !== prepared.uploadIntentHash || uploadIntentHash(uploadPublicationIntentSchema.parse(operation.upload_intent)) !== prepared.uploadIntentHash) throw new CatalogCommitError("operation_reused");
      if (operation.sync_root_id !== null && (operation.sync_root_id !== prepared.rootId || operation.sync_epoch !== prepared.epoch || operation.sync_intent_hash !== prepared.intentHash)) throw new CatalogCommitError("operation_reused");
      const ancestors = await this.#lockAncestors(sql,intent);
      if (root.namespaceBindingVersion !== undefined) {
        const scopedRoot = ancestors.find(row=>row.id===root.rootId);
        if (!scopedRoot) throw new CatalogCommitError("membership_changed");
        for (const row of await this.#projections(sql,ancestors.filter(a=>a.hops<=scopedRoot.hops).map(a=>a.id))) namespaceDescriptor(row,root.rootId);
      }
      if (signal?.aborted) throw new CatalogCommitError("cancelled");
      if (operation.sync_root_id === null) {
        if (operation.state === "active") throw new CatalogCommitError("unprepared_upload");
        await sql`UPDATE operation_journal SET sync_root_id=${prepared.rootId},sync_epoch=${prepared.epoch},sync_intent_hash=${prepared.intentHash},updated_at=now() WHERE id=${uploadId}`;
      }
      return prepared;
    }),signal);
  }

  #projections(sql: TransactionSql, ids: readonly string[]) {
    return sql<Projection[]>`SELECT id,parent_id,CASE WHEN octet_length(name)<=1020 THEN name ELSE '' END AS name,type,size_bytes::text,sha256,current_version_id,status,metadata_version,sync_availability FROM resources WHERE id=ANY(${ids}::uuid[]) ORDER BY id`;
  }

  async commitUpload(record: CommitUploadRecord | CommitOverwriteRecord, apply: (sql: CatalogCommitSql, context: CatalogCommitContext) => Promise<CompleteUploadRecordResult>, signal?: AbortSignal): Promise<CompleteUploadRecordResult> {
    record = structuredClone(record);
    const prepared = record.catalogEvidence;
    if (!prepared || prepared.uploadId !== record.uploadId
      || prepared.verifiedSizeBytes !== String(record.sizeBytes) || prepared.verifiedSha256 !== record.sha256) throw new CatalogCommitError("unprepared_upload");
    const admitted = this.#roots.get(prepared.rootId);
    if (!admitted || admitted.epoch !== prepared.epoch || admitted.backendIdentity !== prepared.backendIdentity
      || admitted.namespaceBindingVersion !== prepared.namespaceBindingVersion) throw new CatalogCommitError("unprepared_upload");
    validId(record.resourceId); validId(record.versionId);
    return this.#admit(() => this.database.transaction(async sql => {
      const current = await this.#clock(sql,prepared.rootId);
      if (admitted.namespaceBindingVersion !== undefined) await assertNamespaceBinding(sql,prepared.rootId,admitted.namespaceBindingVersion);
      const candidate = (await sql<{ upload_intent: unknown }[]>`SELECT upload_intent FROM operation_journal WHERE id=${record.uploadId}`)[0];
      const intent = uploadPublicationIntentSchema.parse(candidate?.upload_intent);
      const expected = binding(intent,admitted,record.uploadId);
      if (expected.intentHash !== prepared.intentHash || expected.uploadIntentHash !== prepared.uploadIntentHash) throw new CatalogCommitError("operation_reused");
      if (intent.parentId !== record.parentId || intent.name !== record.filename || intent.sizeBytes !== String(record.sizeBytes)
        || intent.sha256 !== record.sha256 || (intent.targetId !== null && intent.targetId !== record.resourceId)
        || ("previousVersionId" in record ? record.previousVersionId !== intent.expectedVersionId : intent.targetId !== null)) throw new CatalogCommitError("operation_reused");
      await this.#authorize(sql,intent,record.publicationAuthorization);
      const operation = await this.#operation(sql,record.uploadId);
      if (operation.sync_root_id !== prepared.rootId || operation.sync_epoch !== prepared.epoch || operation.sync_intent_hash !== prepared.intentHash || operation.upload_intent_hash !== prepared.uploadIntentHash) throw new CatalogCommitError("operation_reused");
      if (operation.sync_result !== null) {
        if (operation.sync_first_seq === null || operation.sync_last_seq === null || operation.state !== "active") throw new CatalogCommitError("projection_mismatch");
        return this.#apply(sql,apply,{ accountingAncestorIds: [], replayed: true },signal);
      }
      if (current.epoch !== prepared.epoch) throw new CatalogCommitError("epoch_mismatch");
      if (operation.state === "active") throw new CatalogCommitError("unprepared_upload");
      const ancestors = await this.#lockAncestors(sql,intent);
      const parent = ancestors[0];
      if (parent?.id !== record.parentId || joinStoragePath(parent.storage_path,record.filename) !== record.storagePath) throw new CatalogCommitError("membership_changed");
      const root = ancestors.find(row => row.id === prepared.rootId);
      if (!root) throw new CatalogCommitError("membership_changed");
      const affectedIds = [...ancestors.filter(row => row.hops <= root.hops).map(row => row.id),record.resourceId].sort();
      const fullNamespace = admitted.namespaceBindingVersion !== undefined;
      const before = new Map((await this.#projections(sql,affectedIds)).map(row => [row.id,fullNamespace ? namespaceDescriptor(row,prepared.rootId) : description(row,prepared.rootId)]));
      const result = await this.#apply(sql,apply,{ accountingAncestorIds: ancestors.map(row => row.id), replayed: false },signal);
      // Only this explicitly qualified verified writer establishes AVAILABLE.
      // Legacy/direct writers never infer it from active status or a stat result.
      if (fullNamespace) await sql`UPDATE resources SET sync_availability='AVAILABLE' WHERE id=${record.resourceId}`;
      if (JSON.stringify(await this.#ancestors(sql,intent.parentId)) !== JSON.stringify(ancestors)) throw new CatalogCommitError("membership_changed");
      const after = await this.#projections(sql,affectedIds);
      const events: RootJournalEvent[] | NamespaceChange[] = fullNamespace
        ? after.filter(row=>JSON.stringify(before.get(row.id))!==JSON.stringify(namespaceDescriptor(row,prepared.rootId))).map(row=>({
          schema:"saturn.current-namespace-change.v1" as const,nodeId:row.id,kind:"upsert",description:namespaceDescriptor(row,prepared.rootId),
          reason:intent.targetId===null?"upload.initial":"upload.overwrite",actor:{type:"device_token",id:intent.deviceId} }))
        : after.filter(row => JSON.stringify(before.get(row.id)) !== JSON.stringify(description(row,prepared.rootId))).map(row => ({
          nodeId: row.id, kind: "upsert", description: description(row,prepared.rootId), reason: intent.targetId === null ? "upload.initial" : "upload.overwrite", actor: { type: "device_token", id: intent.deviceId },
        }));
      if (after.length !== affectedIds.length || after.some(row => row.status !== "active") || result.publicationReceipt?.uploadId !== record.uploadId
        || result.publicationReceipt.intentHash !== prepared.uploadIntentHash || result.resource.id !== record.resourceId
        || result.publicationReceipt.versionId !== record.versionId) throw new CatalogCommitError("projection_mismatch");
      const persisted = (await sql<{ upload_receipt: unknown; state: string; status: string; resource_id: string }[]>`
        SELECT j.upload_receipt,j.state,u.status,u.resource_id FROM operation_journal j JOIN upload_sessions u ON u.id=j.upload_id WHERE j.id=${record.uploadId}`)[0];
      const receipt = uploadPublicationReceiptSchema.parse(persisted?.upload_receipt);
      const leaf = after.find(row => row.id === record.resourceId);
      if (persisted?.state !== "active" || persisted.status !== "active" || persisted.resource_id !== record.resourceId
        || JSON.stringify(receipt) !== JSON.stringify(result.publicationReceipt) || leaf?.current_version_id !== record.versionId
        || leaf.sha256 !== record.sha256 || leaf.size_bytes !== String(record.sizeBytes) || leaf.parent_id !== record.parentId || leaf.name !== record.filename) throw new CatalogCommitError("projection_mismatch");
      if (fullNamespace) validateNamespaceChanges(events as NamespaceChange[]);
      else validateRootJournalEvents(events as RootJournalEvent[]);
      const first = BigInt(current.published_seq)+1n, last = first+BigInt(events.length)-1n;
      if (last > MAX_BIGINT) throw new CatalogCommitError("counter_exhausted");
      await sql`INSERT INTO sync_root_changes(root_id,epoch,seq,node_id,operation_id,document)
        SELECT ${prepared.rootId}::uuid,${prepared.epoch}::uuid,${first.toString()}::bigint+ordinal-1,(document->>'nodeId')::uuid,${record.uploadId}::uuid,document
        FROM jsonb_array_elements(${rootJournalJsonBound(events,ROOT_JOURNAL_MAX_BYTES)}::text::jsonb) WITH ORDINALITY AS batch(document,ordinal)`;
      const finalResult = { schema: "saturn.catalog-upload-result.v1", publicationReceipt: result.publicationReceipt };
      await sql`UPDATE operation_journal SET sync_first_seq=${first.toString()},sync_last_seq=${last.toString()},sync_result=${rootJournalJsonBound(finalResult,65536)}::text::jsonb,updated_at=now() WHERE id=${record.uploadId}`;
      await sql`UPDATE sync_root_clock SET published_seq=${last.toString()},updated_at=now() WHERE root_id=${prepared.rootId}`;
      if (signal?.aborted) throw new CatalogCommitError("cancelled");
      return result;
    }),signal);
  }

  async #apply(sql: TransactionSql, apply: (sql: CatalogCommitSql, context: CatalogCommitContext) => Promise<CompleteUploadRecordResult>, context: CatalogCommitContext, signal?: AbortSignal): Promise<CompleteUploadRecordResult> {
    let active = true, count = 0;
    const pending = new Set<{ cancel(): void }>();
    const promises = new Set<Promise<object[]>>();
    const query = <T extends object[]>(text: string, create: () => PendingQuery<T>): Promise<T> => {
      if (!active) return Promise.reject(new CatalogCommitError("callback_expired"));
      if (++count > 1000 || text.length > 65536 || text.includes(";") || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(text)) return Promise.reject(new CatalogCommitError("invalid_input"));
      const request = create(); pending.add(request);
      const promise = Promise.resolve(request).then(rows => rows as T);
      promises.add(promise);
      void promise.finally(() => { pending.delete(request); promises.delete(promise); }).catch(() => undefined);
      return promise;
    };
    const boundary = (<T extends object[]>(template: TemplateStringsArray, ...parameters: ParameterOrFragment<never>[]) => query<T>(template.join("?"),() => sql<T>(template,...parameters))) as CatalogCommitSql;
    boundary.json = sql.json.bind(sql);
    boundary.unsafe = <T extends object[]>(text: string, values: ParameterOrJSON<never>[] = []) => {
      if (values.length > 2000) return Promise.reject(new CatalogCommitError("invalid_input"));
      return query<T>(text,() => sql.unsafe<T>(text,values));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled: (() => void) | undefined;
    const stop = () => { active = false; for (const request of pending) request.cancel(); };
    try {
      return await Promise.race([
        apply(boundary,Object.freeze({ ...context, accountingAncestorIds: Object.freeze([...context.accountingAncestorIds]) })).then(async result => { await Promise.all(promises); return result; }),
        new Promise<never>((_,reject) => {
          timer = setTimeout(() => { stop(); reject(new CatalogCommitError("callback_expired")); },CALLBACK_MS);
          cancelled = () => { stop(); reject(new CatalogCommitError("cancelled")); };
          signal?.addEventListener("abort",cancelled,{ once: true });
          if (signal?.aborted) cancelled();
        }),
      ]);
    } catch (error) { stop(); await Promise.allSettled(promises); throw error; }
    finally { active = false; if (timer) clearTimeout(timer); if (cancelled) signal?.removeEventListener("abort",cancelled); }
  }
}
