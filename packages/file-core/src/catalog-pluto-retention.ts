import type { Database } from "@saturn/database";
import type { BackendExecutorIdentity } from "../../storage/src/durable-backend-executor.js";
import type { CatalogRootAdmission } from "./catalog-root-admission.js";

export interface RetentionProgress { planned: number; completed: number; resumed: number; deferred?: string }

/** SQL atomically expires eligible metadata and enqueues its immutable delete
 * original. Physical deletion uses the same backend writer as publication. */
export class CatalogPlutoRetention {
  constructor(private readonly writer: Database, private readonly admission: CatalogRootAdmission,
    private readonly identity: BackendExecutorIdentity) {}

  tick(rootId: string): Promise<RetentionProgress> {
    return this.admission.run(rootId, () => this.writer.transaction(async sql => {
      await sql`SET LOCAL lock_timeout='2s'`;
      await sql`SET LOCAL statement_timeout='5s'`;
      await sql`SET LOCAL idle_in_transaction_session_timeout='2s'`;
      const result = (await sql<{ value: RetentionProgress }[]>`SELECT public.sync_retention_command(${rootId}::uuid,${JSON.stringify(this.identity)}::text::jsonb) AS value`)[0]?.value;
      if (!result || ![result.planned,result.completed,result.resumed].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 16))
        throw new Error("retention_projection_mismatch");
      return result;
    }));
  }
}
