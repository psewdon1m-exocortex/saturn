import type { Database } from "@saturn/database";
import { v7 as uuidv7 } from "uuid";
import { redact } from "./redactor.js";
import type { AuditEvent, AuditSink, AuditWriteInput } from "./types.js";

interface AuditRow {
  sequence: string;
  id: string;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_id: string | null;
  outcome: AuditEvent["outcome"];
  correlation_id: string;
  source_ip_hash: string | null;
  details: Record<string, unknown>;
}

function event(row: AuditRow): AuditEvent {
  return {
    sequence: Number(row.sequence),
    id: row.id,
    occurredAt: row.occurred_at,
    actorType: row.actor_type,
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    action: row.action,
    ...(row.resource_id === null ? {} : { resourceId: row.resource_id }),
    outcome: row.outcome,
    correlationId: row.correlation_id,
    ...(row.source_ip_hash === null ? {} : { sourceIpHash: row.source_ip_hash }),
    details: row.details,
  };
}

export class AuditService implements AuditSink {
  readonly #database: Database;
  readonly #knownSecrets: readonly string[];

  constructor(database: Database, knownSecrets: readonly string[] = []) {
    this.#database = database;
    this.#knownSecrets = knownSecrets.filter((value) => value.length >= 8);
  }

  write(input: AuditWriteInput): Promise<void> {
    const details = redact(input.details ?? {}, this.#knownSecrets);
    return this.#database.withSql(async (sql) => {
      await sql`
        INSERT INTO audit_events (
          id, actor_type, actor_id, action, resource_id, outcome,
          correlation_id, source_ip_hash, details
        ) VALUES (
          ${uuidv7()}, ${input.actorType}, ${input.actorId ?? null}, ${input.action},
          ${input.resourceId ?? null}, ${input.outcome}, ${input.correlationId},
          ${input.sourceIpHash ?? null}, ${sql.json(details)}
        ) ON CONFLICT (correlation_id, action, outcome) DO NOTHING
      `;
    });
  }

  list(beforeSequence: number | undefined, limit: number): Promise<readonly AuditEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Audit page limit is invalid");
    if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) {
      throw new Error("Audit cursor is invalid");
    }
    return this.#database.withSql(async (sql) => {
      const rows = beforeSequence === undefined
        ? await sql<AuditRow[]>`SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ${limit}`
        : await sql<AuditRow[]>`
            SELECT * FROM audit_events WHERE sequence < ${beforeSequence}
            ORDER BY sequence DESC LIMIT ${limit}
          `;
      return rows.map(event);
    });
  }

  async *exportJsonl(maximumEvents: number): AsyncGenerator<string> {
    if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1 || maximumEvents > 100_000) {
      throw new Error("Audit export limit is invalid");
    }
    let before: number | undefined;
    let emitted = 0;
    while (emitted < maximumEvents) {
      const page = await this.list(before, Math.min(500, maximumEvents - emitted));
      if (page.length === 0) return;
      for (const item of page) {
        yield `${JSON.stringify(item)}\n`;
        emitted += 1;
      }
      before = page.at(-1)?.sequence;
      if (page.length < 500) return;
    }
  }
}
