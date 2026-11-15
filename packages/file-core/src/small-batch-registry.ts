import type { Database } from "@saturn/database";
import type { SyncRootBinding } from "../../contracts/src/sync-protocol.js";
import type { CatalogFolderAuthority, CatalogFolderAuthorityIssuer } from "./catalog-folder-authority.js";
import { readSmallBatchPlan, SmallBatchPlanError, type SmallBatchPlan } from "./small-batch-plan.js";

export interface SmallBatchRegisteredItem {
  readonly operationId: string;
  readonly admitted: boolean;
  readonly uploadId: string | null;
}
export interface SmallBatchRegistration {
  readonly plan: SmallBatchPlan;
  readonly items: readonly SmallBatchRegisteredItem[];
  readonly replayed: boolean;
}
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const errors = new Set(["invalid_input", "binding_invalid", "authorization_changed", "operation_reused", "admission_full"]);
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SmallBatchPlanError("projection_mismatch");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) throw new SmallBatchPlanError("projection_mismatch");
  return row;
}

/** An immutable transport declaration only. Upload identity, lifecycle and every
 * receipt remain in operation_journal; registering a batch creates no upload
 * session or physical file. The separately qualified fixed function owns writes. */
export class SmallBatchRegistry {
  #active = 0;
  constructor(private readonly database: Database, private readonly authority: CatalogFolderAuthorityIssuer) {}

  async #command(command: "register" | "status", binding: SyncRootBinding, proof: CatalogFolderAuthority, payload: unknown): Promise<SmallBatchRegistration | undefined> {
    const credential = this.authority.deviceCredential(proof, binding.root_id);
    if (this.#active >= 4) throw new SmallBatchPlanError("admission_full");
    this.#active++;
    try {
      const value = await this.database.transaction(async sql => {
        await sql`SET LOCAL statement_timeout='2s'`; await sql`SET LOCAL lock_timeout='2s'`; await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
        return (await sql<{ value: unknown }[]>`SELECT public.sync_small_batch_command(${command},${JSON.stringify(binding)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]?.value;
      });
      if (!value || Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw new SmallBatchPlanError("projection_mismatch");
      if (typeof value === "object" && "found" in value && value.found === false) {
        fields(value, ["found"]);
        if (command !== "status") throw new SmallBatchPlanError("projection_mismatch");
        return undefined;
      }
      const row = fields(value, ["found", "plan", "items", "replayed"]);
      if (row.found !== true || typeof row.replayed !== "boolean") throw new SmallBatchPlanError("projection_mismatch");
      // Historical registration retains its own exact binding; current outer
      // binding and device authority were checked by the SQL command above.
      const stored = fields(row.plan, ["manifest", "inputs"]);
      const plan = readSmallBatchPlan(stored, stored.manifest as SyncRootBinding);
      if (plan.manifest.root_id !== binding.root_id || plan.inputs.some(input => input.intent.deviceId !== credential.deviceId || input.intent.deviceKind !== credential.deviceKind)
        || !Array.isArray(row.items) || row.items.length !== plan.manifest.items.length) throw new SmallBatchPlanError("projection_mismatch");
      const items = row.items.map((item: unknown, index): SmallBatchRegisteredItem => {
        const entry = fields(item, ["operationId", "admitted", "uploadId"]);
        if (typeof entry.operationId !== "string" || entry.operationId !== plan.manifest.items[index]?.operation_id
          || typeof entry.admitted !== "boolean" || entry.uploadId !== null && (typeof entry.uploadId !== "string" || !uuid.test(entry.uploadId))
          || !entry.admitted && entry.uploadId !== null) throw new SmallBatchPlanError("projection_mismatch");
        return Object.freeze({ operationId: entry.operationId, admitted: entry.admitted, uploadId: entry.uploadId });
      });
      return Object.freeze({ plan, items: Object.freeze(items), replayed: row.replayed });
    } catch (error) {
      if (error instanceof SmallBatchPlanError) throw error;
      if (error instanceof Error && errors.has(error.message)) throw new SmallBatchPlanError(error.message, { cause: error });
      if (error && typeof error === "object" && "code" in error && typeof error.code === "string"
        && ["57014", "55P03", "40P01"].includes(error.code)) throw new SmallBatchPlanError("admission_full", { cause: error });
      throw error;
    } finally { this.#active--; }
  }
  async register(value: unknown, binding: SyncRootBinding, proof: CatalogFolderAuthority): Promise<SmallBatchRegistration> {
    const plan = readSmallBatchPlan(value, binding), record = await this.#command("register", binding, proof, plan);
    if (!record) throw new SmallBatchPlanError("projection_mismatch");
    return record;
  }
  status(batchId: string, binding: SyncRootBinding, proof: CatalogFolderAuthority): Promise<SmallBatchRegistration | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(batchId)) throw new SmallBatchPlanError();
    return this.#command("status", binding, proof, { batch_id: batchId });
  }
}
