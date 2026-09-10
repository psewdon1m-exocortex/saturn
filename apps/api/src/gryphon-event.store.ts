import type { Database } from "@saturn/database";
import type { GryphonCommandResponse } from "@saturn/drop";

interface EventRow {
  readonly state: "processing" | "completed" | "failed";
  readonly response: GryphonCommandResponse | null;
}

export class GryphonEventStore {
  constructor(private readonly database: Database) {}

  async begin(eventId: string): Promise<GryphonCommandResponse | undefined> {
    return this.database.transaction(async (sql) => {
      const inserted = await sql<{ readonly event_id: string }[]>`
        INSERT INTO gryphon_events (event_id, state) VALUES (${eventId}, 'processing')
        ON CONFLICT DO NOTHING RETURNING event_id
      `;
      if (inserted.length > 0) return undefined;
      const rows = await sql<EventRow[]>`SELECT state, response FROM gryphon_events WHERE event_id=${eventId} FOR UPDATE`;
      const current = rows[0];
      if (current?.state === "completed" && current.response !== null) return current.response;
      if (current?.state === "failed") {
        await sql`UPDATE gryphon_events SET state='processing',response=NULL,started_at=now(),completed_at=NULL WHERE event_id=${eventId}`;
        return undefined;
      }
      const recovered = await sql<{ readonly event_id: string }[]>`
        UPDATE gryphon_events SET started_at=now()
        WHERE event_id=${eventId} AND state='processing' AND started_at < now() - interval '5 minutes'
        RETURNING event_id
      `;
      if (recovered.length > 0) return undefined;
      throw new Error("Gryphon event is already in progress");
    });
  }

  complete(eventId: string, response: GryphonCommandResponse): Promise<void> {
    return this.database.withSql(async (sql) => {
      await sql`UPDATE gryphon_events SET state='completed',response=${sql.json(response as never)},completed_at=now() WHERE event_id=${eventId} AND state='processing'`;
    });
  }

  fail(eventId: string): Promise<void> {
    return this.database.withSql(async (sql) => {
      await sql`UPDATE gryphon_events SET state='failed',completed_at=now() WHERE event_id=${eventId} AND state='processing'`;
    });
  }
}
