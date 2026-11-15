import { randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";
import type { TransactionSql } from "postgres";

export const ROOT_JOURNAL_MAX_ITEMS = 500;
export const ROOT_JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
const MAX_BIGINT = 9223372036854775807n;
const CALLBACK_MS = 1000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export class RootJournalError extends Error {
  constructor(readonly code: "invalid_input" | "root_unavailable" | "epoch_mismatch" | "cursor_expired" | "cursor_ahead" | "journal_gap" | "operation_reused" | "operation_unavailable" | "callback_expired" | "projection_mismatch" | "counter_exhausted") {
    super(code);
  }
}
export interface RootJournalCursor { readonly rootId: string; readonly epoch: string; readonly afterSeq: string }
export interface RootJournalClock { readonly rootId: string; readonly epoch: string; readonly publishedSeq: string; readonly retainedAfterSeq: string }
export interface RootJournalProjection {
  readonly parentId: string | null;
  readonly name: string;
  readonly type: "file" | "folder";
  readonly sizeBytes: string;
  readonly sha256: string | null;
  /** Existing version identity, not a new universal CAS metadata version. */
  readonly versionId: string | null;
}
export interface RootJournalEvent {
  readonly nodeId: string;
  readonly kind: "upsert" | "tombstone";
  /** Full new projection for upsert; full pre-mutation projection for tombstone. */
  readonly description: RootJournalProjection;
  readonly reason: string;
  readonly actor: { readonly type: string; readonly id: string };
}
export interface RootJournalRecord extends RootJournalEvent { readonly seq: string; readonly operationId: string }
export interface RootJournalReceipt {
  readonly rootId: string; readonly epoch: string; readonly firstSeq: string; readonly lastSeq: string;
  readonly operationId: string; readonly result: Readonly<Record<string, unknown>>; readonly replayed: boolean;
}
/** Trusted internal SQL-only boundary. No raw transaction, commit, connection or storage handle. */
export interface RootJournalSql {
  query(text: string, values?: readonly (string | number | boolean | null | Date)[]): Promise<readonly Record<string, unknown>[]>;
}
interface ClockRow { root_id: string; epoch: string; published_seq: string; retained_after_seq: string }
interface OperationRow {
  state: string; sync_root_id: string | null; sync_epoch: string | null; sync_first_seq: string | null;
  sync_last_seq: string | null; sync_intent_hash: string | null; sync_result: Record<string, unknown> | null;
}
function onlyClock(rows: readonly ClockRow[]): ClockRow {
  const row = rows[0]; if (!row) throw new RootJournalError("root_unavailable"); return row;
}
function id(value: string): void { if (!UUID.test(value)) throw new RootJournalError("invalid_input"); }
function seq(value: string): bigint {
  if (!/^(0|[1-9]\d{0,18})$/.test(value)) throw new RootJournalError("invalid_input");
  const result = BigInt(value);
  if (result > MAX_BIGINT) throw new RootJournalError("invalid_input");
  return result;
}
export function rootJournalJsonBound(value: unknown, maximum: number): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maximum) throw new RootJournalError("invalid_input");
  return serialized;
}
function clock(row: ClockRow): RootJournalClock {
  return { rootId: row.root_id, epoch: row.epoch, publishedSeq: row.published_seq, retainedAfterSeq: row.retained_after_seq };
}
export function validateRootJournalEvents(events: readonly RootJournalEvent[]): void {
  if (events.length < 1 || events.length > ROOT_JOURNAL_MAX_ITEMS || new Set(events.map(e => e.nodeId.toLowerCase())).size !== events.length) throw new RootJournalError("invalid_input");
  for (const event of events) {
    if (Object.keys(event).some(key => !["nodeId","kind","description","reason","actor"].includes(key))
      || Object.keys(event.description).some(key => !["parentId","name","type","sizeBytes","sha256","versionId"].includes(key))
      || Object.keys(event.actor).some(key => !["type","id"].includes(key))) throw new RootJournalError("invalid_input");
    id(event.nodeId);
    if (!["upsert","tombstone"].includes(event.kind)) throw new RootJournalError("invalid_input");
    const d = event.description;
    if (d.parentId !== null) id(d.parentId);
    if (d.versionId !== null) id(d.versionId);
    seq(d.sizeBytes);
    if (!d.name || Buffer.byteLength(d.name) > 1020 || !["file", "folder"].includes(d.type)
      || (d.sha256 !== null && !/^[a-f\d]{64}$/.test(d.sha256)) || (d.type === "folder" && d.sha256 !== null)
      || [event.reason,event.actor.type,event.actor.id].some(s => !s || Buffer.byteLength(s) > 128)) throw new RootJournalError("invalid_input");
    rootJournalJsonBound(event, 4096);
  }
  rootJournalJsonBound(events, ROOT_JOURNAL_MAX_BYTES);
}

/** Inactive foundation: callers must qualify every catalog writer before advertising a feed. */
export class PostgresRootJournal {
  constructor(private readonly database: Database) {}

  async registerRoot(rootId: string): Promise<RootJournalClock> {
    id(rootId);
    return this.database.transaction(async sql => {
      const valid = await sql`SELECT id FROM resources WHERE id=${rootId} AND type='folder' AND status='active' FOR SHARE`;
      if (valid.length !== 1) throw new RootJournalError("root_unavailable");
      await sql`INSERT INTO sync_root_clock(root_id,epoch) VALUES(${rootId},${randomUUID()}) ON CONFLICT(root_id) DO NOTHING`;
      const rows = await sql<ClockRow[]>`SELECT root_id,epoch,published_seq::text,retained_after_seq::text FROM sync_root_clock WHERE root_id=${rootId}`;
      return clock(onlyClock(rows));
    });
  }

  /** Bind an existing recovery operation before backend work. Never creates a second identity. */
  async bindOperation(rootId: string, epoch: string, operationId: string, intentHash: string): Promise<void> {
    id(rootId); id(epoch); id(operationId);
    if (!/^[a-f\d]{64}$/.test(intentHash)) throw new RootJournalError("invalid_input");
    await this.database.transaction(async sql => {
      const current = await this.#lock(sql, rootId, epoch);
      const rows = await sql<(OperationRow & { witness: string | null })[]>`
        SELECT j.state,j.sync_root_id,j.sync_epoch,j.sync_first_seq::text,j.sync_last_seq::text,j.sync_intent_hash,j.sync_result,
          coalesce(j.resource_id,u.parent_id) AS witness FROM operation_journal j LEFT JOIN upload_sessions u ON u.id=j.upload_id
        WHERE j.id=${operationId} FOR UPDATE OF j`;
      const operation = rows[0];
      if (!operation) throw new RootJournalError("operation_unavailable");
      if (operation.sync_root_id !== null) {
        if (operation.sync_root_id !== current.root_id || operation.sync_epoch !== current.epoch || operation.sync_intent_hash !== intentHash) throw new RootJournalError("operation_reused");
        return;
      }
      if (operation.state === "active" || operation.witness === null) throw new RootJournalError("operation_unavailable");
      const scoped = await this.#scopedRows(sql, rootId, [operation.witness]);
      if (scoped.length !== 1) throw new RootJournalError("operation_reused");
      await sql`UPDATE operation_journal SET sync_root_id=${current.root_id},sync_epoch=${current.epoch},sync_intent_hash=${intentHash},updated_at=now() WHERE id=${operationId}`;
    });
  }

  async #lock(sql: TransactionSql, rootId: string, epoch: string): Promise<ClockRow> {
    await sql`SET LOCAL lock_timeout='2s'`;
    await sql`SET LOCAL statement_timeout='2s'`;
    await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
    const rows = await sql<ClockRow[]>`
      SELECT c.root_id,c.epoch,c.published_seq::text,c.retained_after_seq::text
      FROM sync_root_clock c JOIN resources r ON r.id=c.root_id
      WHERE c.root_id=${rootId} AND r.type='folder' AND r.status='active' FOR UPDATE OF c FOR SHARE OF r`;
    const row = rows[0];
    if (!row) throw new RootJournalError("root_unavailable");
    if (row.epoch !== epoch.toLowerCase()) throw new RootJournalError("epoch_mismatch");
    return row;
  }

  async commit(input: {
    readonly rootId: string; readonly epoch: string; readonly operationId: string; readonly intentHash: string;
    readonly events: readonly RootJournalEvent[];
    /** Attestation by trusted prepared writer; this primitive does not verify backend bytes. */
    readonly preparedBackend: "stored_verified" | "metadata_only" | "isolated_metadata_fixture";
  }, applyCatalogAndResult: (sql: RootJournalSql, range: { readonly firstSeq: string; readonly lastSeq: string }) => Promise<Readonly<Record<string, unknown>>>): Promise<RootJournalReceipt> {
    id(input.rootId); id(input.epoch); id(input.operationId); validateRootJournalEvents(input.events);
    if (!/^[a-f\d]{64}$/.test(input.intentHash) || !["stored_verified","metadata_only","isolated_metadata_fixture"].includes(input.preparedBackend)
      || (input.preparedBackend === "metadata_only" && input.events.some(e => e.kind === "upsert" && e.description.type === "file"))) throw new RootJournalError("invalid_input");
    // Seal bounded input before the first await; caller mutation cannot alter a queued commit.
    input = structuredClone(input);
    return this.database.transaction(async sql => {
      const current = await this.#lock(sql, input.rootId, input.epoch);
      const operations = await sql<OperationRow[]>`SELECT state,sync_root_id,sync_epoch,sync_first_seq::text,sync_last_seq::text,sync_intent_hash,sync_result
        FROM operation_journal WHERE id=${input.operationId} FOR UPDATE`;
      const operation = operations[0];
      if (!operation) throw new RootJournalError("operation_unavailable");
      if (operation.sync_root_id !== current.root_id || operation.sync_epoch !== current.epoch || operation.sync_intent_hash !== input.intentHash) throw new RootJournalError("operation_reused");
      if (operation.sync_result !== null) {
        if (operation.sync_first_seq === null || operation.sync_last_seq === null) throw new RootJournalError("operation_unavailable");
        return { rootId: current.root_id, epoch: current.epoch, firstSeq: operation.sync_first_seq, lastSeq: operation.sync_last_seq, operationId: input.operationId, result: operation.sync_result, replayed: true };
      }
      if (operation.state === "active") throw new RootJournalError("operation_unavailable");
      const first = BigInt(current.published_seq) + 1n, last = first + BigInt(input.events.length) - 1n;
      if (last > MAX_BIGINT) throw new RootJournalError("counter_exhausted");
      const tombstones = input.events.filter(e => e.kind === "tombstone");
      await this.#verifyProjection(sql, current.root_id, tombstones, true);
      let active = true, queries = 0;
      const pending = new Set<Promise<readonly Record<string, unknown>[]>>();
      const boundary: RootJournalSql = { query: (text, values = []) => {
        if (!active) return Promise.reject(new RootJournalError("callback_expired"));
        // No multi-statements or transaction/session controls; trusted DML/SELECT only.
        if (++queries > 1000 || text.length > 65536 || values.length > 2000 || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(text) || text.includes(";")) return Promise.reject(new RootJournalError("invalid_input"));
        const query = Promise.resolve(sql.unsafe<Record<string, unknown>[]>(text, [...values]));
        pending.add(query);
        void query.finally(() => pending.delete(query)).catch(() => undefined);
        return query;
      } };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: Readonly<Record<string, unknown>>;
      try {
        result = await Promise.race([
          applyCatalogAndResult(boundary, { firstSeq: first.toString(), lastSeq: last.toString() }).then(async receipt => {
            // Fire-and-forget SQL is not allowed to escape the callback's atomic boundary.
            await Promise.all(pending); return receipt;
          }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { active = false; reject(new RootJournalError("callback_expired")); }, CALLBACK_MS); }),
        ]);
      } finally { active = false; if (timer) clearTimeout(timer); }
      rootJournalJsonBound(result, 65536);
      await this.#verifyProjection(sql, current.root_id, input.events.filter(e => e.kind === "upsert"), true);
      await this.#verifyProjection(sql, current.root_id, tombstones, false);
      await sql`INSERT INTO sync_root_changes(root_id,epoch,seq,node_id,operation_id,document)
        SELECT ${current.root_id}::uuid,${current.epoch}::uuid,${first.toString()}::bigint+ordinal-1,
          (document->>'nodeId')::uuid,${input.operationId}::uuid,document
        FROM jsonb_array_elements(${rootJournalJsonBound(input.events,ROOT_JOURNAL_MAX_BYTES)}::text::jsonb) WITH ORDINALITY AS batch(document,ordinal)`;
      await sql`UPDATE operation_journal SET state='active',error_code=NULL,sync_root_id=${current.root_id},sync_epoch=${current.epoch},
        sync_first_seq=${first.toString()},sync_last_seq=${last.toString()},sync_intent_hash=${input.intentHash},sync_result=${rootJournalJsonBound(result,65536)}::text::jsonb,updated_at=now() WHERE id=${input.operationId}`;
      await sql`UPDATE sync_root_clock SET published_seq=${last.toString()},updated_at=now() WHERE root_id=${current.root_id}`;
      return { rootId: current.root_id, epoch: current.epoch, firstSeq: first.toString(), lastSeq: last.toString(), operationId: input.operationId, result, replayed: false };
    });
  }

  async #verifyProjection(sql: TransactionSql, rootId: string, events: readonly RootJournalEvent[], present: boolean): Promise<void> {
    if (events.length === 0) return;
    const rows = await this.#scopedRows(sql, rootId, events.map(e => e.nodeId));
    const found = new Map(rows.map(r => [r.id,r]));
    for (const event of events) {
      const row = found.get(event.nodeId.toLowerCase());
      if (!present) { if (row) throw new RootJournalError("projection_mismatch"); continue; }
      const d = event.description;
      if (!row || row.parent_id !== (d.parentId?.toLowerCase() ?? null)
        || row.name !== d.name || row.type !== d.type || row.size_bytes !== d.sizeBytes || row.sha256 !== d.sha256
        || row.current_version_id !== (d.versionId?.toLowerCase() ?? null)) throw new RootJournalError("projection_mismatch");
    }
  }

  #scopedRows(sql: TransactionSql, rootId: string, nodeIds: readonly string[]) {
    return sql<{ id: string; parent_id: string | null; name: string; type: "file" | "folder"; size_bytes: string; sha256: string | null; current_version_id: string | null }[]>`
      WITH RECURSIVE chain AS (
        SELECT id AS origin,id,parent_id,0 AS depth,ARRAY[id] AS visited FROM resources
        WHERE id=ANY(${nodeIds}::uuid[]) AND status='active'
        UNION ALL
        SELECT c.origin,p.id,p.parent_id,c.depth+1,c.visited||p.id FROM chain c
        JOIN LATERAL(SELECT id,parent_id FROM resources WHERE id=c.parent_id AND status='active' AND type='folder' LIMIT 1) p ON true
        WHERE c.id<>${rootId} AND c.depth<128 AND NOT(p.id=ANY(c.visited))
      ) SELECT r.id,CASE WHEN r.id=${rootId} THEN NULL ELSE r.parent_id END AS parent_id,r.name,r.type,r.size_bytes::text,r.sha256,r.current_version_id
      FROM resources r WHERE r.id IN(SELECT origin FROM chain WHERE id=${rootId})`;
  }

  async read(input: RootJournalCursor & { readonly limit?: number; readonly throughSeq?: string }): Promise<{
    readonly clock: RootJournalClock; readonly throughSeq: string; readonly next: RootJournalCursor; readonly events: readonly RootJournalRecord[]; readonly hasMore: boolean;
  }> {
    id(input.rootId); id(input.epoch); const after = seq(input.afterSeq);
    const requestedThrough = input.throughSeq === undefined ? null : seq(input.throughSeq).toString();
    const limit = input.limit ?? ROOT_JOURNAL_MAX_ITEMS;
    if (!Number.isInteger(limit) || limit < 1 || limit > ROOT_JOURNAL_MAX_ITEMS) throw new RootJournalError("invalid_input");
    // One statement snapshot: clock and inclusive high-water range cannot see different commits.
    const rows = await this.database.withSql(sql => sql<(ClockRow & { events: RootJournalRecord[] })[]>`
      SELECT c.root_id,c.epoch,c.published_seq::text,c.retained_after_seq::text,
        coalesce(p.events,'[]'::jsonb) AS events
      FROM sync_root_clock c JOIN resources r ON r.id=c.root_id AND r.status='active' AND r.type='folder'
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(document || jsonb_build_object('seq',seq::text,'operationId',operation_id) ORDER BY seq) AS events FROM (
          SELECT document,seq,operation_id FROM sync_root_changes
          WHERE root_id=c.root_id AND epoch=c.epoch AND seq>${input.afterSeq}::bigint
            AND seq<=coalesce(${requestedThrough}::bigint,c.published_seq)
            AND c.epoch=${input.epoch}::uuid AND ${input.afterSeq}::bigint BETWEEN c.retained_after_seq AND c.published_seq
          ORDER BY seq LIMIT ${limit}
        ) bounded
      ) p ON true WHERE c.root_id=${input.rootId}`);
    const row = rows[0];
    if (!row) throw new RootJournalError("root_unavailable");
    if (row.epoch !== input.epoch.toLowerCase()) throw new RootJournalError("epoch_mismatch");
    if (after < BigInt(row.retained_after_seq)) throw new RootJournalError("cursor_expired");
    const through = requestedThrough === null ? BigInt(row.published_seq) : BigInt(requestedThrough);
    if (after > BigInt(row.published_seq) || through > BigInt(row.published_seq) || through < after) throw new RootJournalError("cursor_ahead");
    const expectedCount = Number(through-after > BigInt(limit) ? BigInt(limit) : through-after);
    // CJ02 full namespace documents require their own qualified consumer.
    // Never cast a new discriminator to this historical six-field reader.
    if (row.events.some(event=>"schema" in event)) throw new RootJournalError("projection_mismatch");
    if (row.events.length !== expectedCount || row.events.some((event,i) => seq(event.seq) !== after+BigInt(i)+1n)) throw new RootJournalError("journal_gap");
    const nextSeq = (after+BigInt(row.events.length)).toString();
    const result = { clock: clock(row), throughSeq: through.toString(), next: { rootId: row.root_id, epoch: row.epoch, afterSeq: nextSeq }, events: row.events, hasMore: BigInt(nextSeq)<through };
    rootJournalJsonBound(result, ROOT_JOURNAL_MAX_BYTES);
    return result;
  }

  /** No history is destroyed. Old cursors/receipts become invalid for the new epoch. */
  async rotateEpoch(rootId: string, expectedEpoch: string): Promise<RootJournalClock> {
    id(rootId); id(expectedEpoch);
    return this.database.transaction(async sql => {
      await this.#lock(sql, rootId, expectedEpoch);
      const rows = await sql<ClockRow[]>`UPDATE sync_root_clock SET epoch=${randomUUID()},published_seq=0,retained_after_seq=0,updated_at=now()
        WHERE root_id=${rootId} RETURNING root_id,epoch,published_seq::text,retained_after_seq::text`;
      return clock(onlyClock(rows));
    });
  }

  /** Marks an expired prefix without deleting data; physical retention is a separate gate. */
  async advanceRetentionFloor(rootId: string, epoch: string, retainedAfterSeq: string): Promise<RootJournalClock> {
    id(rootId); id(epoch); const floor = seq(retainedAfterSeq);
    return this.database.transaction(async sql => {
      const current = await this.#lock(sql, rootId, epoch);
      if (floor < BigInt(current.retained_after_seq) || floor > BigInt(current.published_seq)) throw new RootJournalError("cursor_ahead");
      const rows = await sql<ClockRow[]>`UPDATE sync_root_clock SET retained_after_seq=${retainedAfterSeq},updated_at=now()
        WHERE root_id=${rootId} RETURNING root_id,epoch,published_seq::text,retained_after_seq::text`;
      return clock(onlyClock(rows));
    });
  }
}
