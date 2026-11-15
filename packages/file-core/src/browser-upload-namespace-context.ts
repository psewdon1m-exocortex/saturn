import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";
import type { BackendCommand, BackendExecutorIdentity } from "../../storage/src/durable-backend-executor.js";
import type { TransactionSql } from "postgres";

export interface BrowserNamespaceBinding { readonly backendIdentity: string; readonly generation: string }
export interface BrowserNamespaceIntent {
  readonly operationId: string;
  readonly kind: "create-folder" | "file-publication" | "move" | "trash" | "restore" | "restore-version" | "directory-chain";
  readonly sourceId?: string;
  readonly parentId?: string;
  readonly name?: string;
}
interface Lease extends BrowserNamespaceBinding { readonly operationId: string; readonly epoch: string; readonly producerId: string }
declare const namespacePermit: unique symbol;
export interface BrowserNamespacePermit { readonly [namespacePermit]: true }
interface Held { readonly lease: Lease; readonly proof: BrowserNamespacePermit; live: boolean }
const current = new AsyncLocalStorage<Held>();
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const kinds = new Set(["create-folder", "file-publication", "move", "trash", "restore", "restore-version", "directory-chain"]);
export class BrowserNamespaceError extends Error { constructor(readonly code: string) { super(code); this.name = "BrowserNamespaceError"; } }
function validateBinding(binding: BrowserNamespaceBinding): void {
  if (!binding.backendIdentity || binding.backendIdentity.trim() !== binding.backendIdentity || Buffer.byteLength(binding.backendIdentity) > 256 || Array.from(binding.backendIdentity).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !uuid.test(binding.generation)) throw new BrowserNamespaceError("namespace_binding_invalid");
}
function validateIntent(intent: BrowserNamespaceIntent): void {
  if (!uuid.test(intent.operationId) || !kinds.has(intent.kind) || Object.keys(intent).some(key => !["operationId","kind","sourceId","parentId","name"].includes(key))
    || intent.sourceId !== undefined && !uuid.test(intent.sourceId) || intent.parentId !== undefined && !uuid.test(intent.parentId)
    || intent.name !== undefined && (typeof intent.name !== "string" || Buffer.byteLength(intent.name) > 1024)
    || Buffer.byteLength(JSON.stringify(intent)) > 4096) throw new BrowserNamespaceError("namespace_intent_invalid");
}
function liveContext(): Held | undefined {
  const value = current.getStore();
  if (value && !value.live) throw new BrowserNamespaceError("namespace_permit_closed");
  return value;
}

/** Fixed repository hook: call inside the SAME transaction as each affected
 * catalog mutation. SQL0110 must enforce the epoch and retain its row lock to
 * transaction end. Missing context is NOT a permission: SQL scope triggers
 * still exclude conflicting/nonparticipating writers. */
export async function assertBrowserNamespaceCatalogPermit(sql: TransactionSql, requiredOperationId?: string): Promise<void> {
  const held = liveContext();
  // Fixed tree execution always supplies its durable operation ID. Legacy
  // repository callers may omit it, while SQL still excludes held conflicts.
  if (requiredOperationId !== undefined && (!uuid.test(requiredOperationId) || !held || held.lease.operationId !== requiredOperationId)) throw new BrowserNamespaceError("namespace_permit_invalid");
  if (!held) return;
  const p = held.lease;
  const result = await sql<{ allowed: boolean }[]>`SELECT public.browser_namespace_catalog_admit(${p.backendIdentity},${p.generation}::uuid,${p.producerId}::uuid,${p.operationId}::uuid,${p.epoch}::uuid) AS allowed`;
  if (result[0]?.allowed !== true) throw new BrowserNamespaceError("namespace_catalog_denied");
}

/** Small trusted runtime composition hook. No API-supplied binding or bypass.
 * The fixed SQL backend command validates/links namespace at submission and
 * claim; this wrapper alone is not a physical fence or capability. */
export function withBrowserNamespaceBackendContext(send: BackendCommand): BackendCommand {
  return async (command: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>) => {
    if (Object.hasOwn(payload, "namespace")) throw new BrowserNamespaceError("namespace_payload_forged");
    // Permanent backend worker pumps may inherit an older AsyncLocal context;
    // only actual producer submission carries a permit, never claim/done/status.
    if (command !== "submit" && command !== "submit-once") return send(command, identity, payload);
    const held = liveContext();
    if (!held) return send(command, identity, payload);
    const p = held.lease;
    if (identity.backendIdentity !== p.backendIdentity || identity.generation !== p.generation) throw new BrowserNamespaceError("namespace_backend_mismatch");
    return send(command, identity, { ...payload, namespace: Object.freeze({ schema: "saturn.namespace-permit.v1", operationId: p.operationId, epoch: p.epoch, producerId: p.producerId }) });
  };
}

/** Draft fixed PostgreSQL coordinator. Its SQL0110/runtime/repository hooks are
 * not integrated yet, so this class is NOT constructed by production code.
 * Every ambiguous failure retains a durable original; no lease expiry/stealing.
 * acquire/finish/unknown are fixed reviewed functions, not request callbacks. */
export class PostgresBrowserNamespaceCoordinator {
  readonly #producerId = randomUUID();
  readonly #running = new Set<string>();
  readonly #proofs = new WeakMap<object, Held>();
  readonly #binding: BrowserNamespaceBinding;
  constructor(private readonly database: Database, binding: BrowserNamespaceBinding) {
    validateBinding(binding); this.#binding = Object.freeze({ ...binding });
  }
  async run<T>(intent: BrowserNamespaceIntent, action: (permit: BrowserNamespacePermit) => Promise<T>, signal?: AbortSignal): Promise<T> {
    validateIntent(intent); signal?.throwIfAborted();
    if (current.getStore() || this.#running.has(intent.operationId)) throw new BrowserNamespaceError("namespace_operation_already_running");
    this.#running.add(intent.operationId);
    let held: Held | undefined;
    const binding = this.#binding, producer = this.#producerId;
    try {
      const rows = await this.database.withSql(sql => sql<{ epoch: string; state: string }[]>`SELECT epoch::text,state FROM public.browser_namespace_acquire(${binding.backendIdentity},${binding.generation}::uuid,${producer}::uuid,${intent.operationId}::uuid,${sql.json({ ...intent })}::jsonb)`);
      const row = rows[0];
      if (!row || rows.length !== 1 || !uuid.test(row.epoch) || row.state !== "HELD") throw new BrowserNamespaceError("namespace_admission_unknown");
      const proof = Object.freeze({}) as BrowserNamespacePermit;
      held = { proof, lease: Object.freeze({ ...binding, operationId: intent.operationId, epoch: row.epoch, producerId: producer }), live: true };
      this.#proofs.set(proof, held);
      // Signal cancellation after durable acquisition is a retained original,
      // not an excuse to assume no upstream SQL effect occurred.
      signal?.throwIfAborted();
      const result = await current.run(held, () => action(proof));
      held.live = false; // Also rejects unjoined JS continuations before SQL closes.
      const p = held.lease;
      const finish=()=>this.database.withSql(sql => sql<{ state: string }[]>`SELECT state FROM public.browser_namespace_finish(${p.backendIdentity},${p.generation}::uuid,${p.producerId}::uuid,${p.operationId}::uuid,${p.epoch}::uuid)`);
      // The fixed SQL function replays the exact closed epoch's receipt. Only
      // this acknowledgement is retried; the physical/catalog action is not.
      let finished:{state:string}[];
      try{finished=await finish();}catch{finished=await finish();}
      if (finished.length!==1||finished[0]?.state !== "RELEASED") throw new BrowserNamespaceError("namespace_reconciliation_required");
      return result;
    } catch (error) {
      if (held) {
        held.live = false;
        const p = held.lease;
        await this.database.withSql(sql => sql`SELECT public.browser_namespace_unknown(${p.backendIdentity},${p.generation}::uuid,${p.producerId}::uuid,${p.operationId}::uuid,${p.epoch}::uuid)`).catch(() => undefined);
      }
      // A lost acquire reply may have committed HELD. SQL never expires it;
      // status/reconciliation uses the same operationId, never a replacement.
      throw error;
    } finally { if (held) held.live = false; this.#running.delete(intent.operationId); }
  }
  async assertHeld(permit: BrowserNamespacePermit): Promise<void> {
    const held = this.#proofs.get(permit);
    if (!held || !held.live || current.getStore() !== held) throw new BrowserNamespaceError("namespace_permit_invalid");
    await this.database.transaction(sql => assertBrowserNamespaceCatalogPermit(sql));
  }
}
