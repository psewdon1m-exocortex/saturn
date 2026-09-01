import type { Database } from "@saturn/database";
import type { DeviceRecord, DeviceRepository, DeviceRights, SyncConflict } from "./types.js";

interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly token_hash: string;
  readonly state: DeviceRecord["state"];
  readonly scope_ids: string[];
  readonly can_read: boolean;
  readonly can_write: boolean;
  readonly can_move: boolean;
  readonly can_delete: boolean;
  readonly expires_at: Date | null;
  readonly last_used_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly revoked_at: Date | null;
}

function device(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    state: row.state,
    scopeIds: row.scope_ids,
    rights: { read: row.can_read, write: row.can_write, move: row.can_move, delete: row.can_delete },
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

export class PostgresDeviceRepository implements DeviceRepository {
  constructor(private readonly database: Database) {}

  create(input: Omit<DeviceRecord, "state" | "updatedAt" | "lastUsedAt">): Promise<DeviceRecord> {
    return this.database.withSql(async (sql) => {
      const rows = await sql<DeviceRow[]>`
        INSERT INTO devices (id, name, token_hash, state, scope_ids, can_read, can_write, can_move, can_delete, expires_at, created_at, updated_at)
        VALUES (${input.id}, ${input.name}, ${input.tokenHash}, 'active', ${input.scopeIds as string[]}, ${input.rights.read}, ${input.rights.write}, ${input.rights.move}, ${input.rights.delete}, ${input.expiresAt ?? null}, ${input.createdAt}, ${input.createdAt})
        RETURNING *
      `;
      if (rows[0] === undefined) throw new Error("Device creation returned no row");
      return device(rows[0]);
    });
  }

  getById(id: string): Promise<DeviceRecord | undefined> {
    return this.database.withSql(async (sql) => {
      const rows = await sql<DeviceRow[]>`SELECT * FROM devices WHERE id = ${id}`;
      return rows[0] === undefined ? undefined : device(rows[0]);
    });
  }

  authenticate(tokenHash: string, now: Date): Promise<DeviceRecord | undefined> {
    return this.database.transaction(async (sql) => {
      await sql`UPDATE devices SET state = 'expired', updated_at = ${now} WHERE token_hash = ${tokenHash} AND state = 'active' AND expires_at IS NOT NULL AND expires_at <= ${now}`;
      const rows = await sql<DeviceRow[]>`
        UPDATE devices SET last_used_at = ${now}, updated_at = ${now}
        WHERE token_hash = ${tokenHash} AND state = 'active' AND (expires_at IS NULL OR expires_at > ${now})
        RETURNING *
      `;
      return rows[0] === undefined ? undefined : device(rows[0]);
    });
  }

  list(offset: number, limit: number): Promise<readonly DeviceRecord[]> {
    return this.database.withSql(async (sql) => (await sql<DeviceRow[]>`
      SELECT * FROM devices ORDER BY created_at DESC, id DESC OFFSET ${offset} LIMIT ${limit}
    `).map(device));
  }

  update(id: string, input: { readonly name?: string; readonly scopeIds?: readonly string[]; readonly rights?: DeviceRights; readonly expiresAt?: Date | null }, now: Date): Promise<DeviceRecord> {
    return this.database.withSql(async (sql) => {
      const rows = await sql<DeviceRow[]>`
        UPDATE devices SET
          name = COALESCE(${input.name ?? null}, name),
          scope_ids = COALESCE(${input.scopeIds === undefined ? null : input.scopeIds as string[]}, scope_ids),
          can_read = COALESCE(${input.rights?.read ?? null}, can_read),
          can_write = COALESCE(${input.rights?.write ?? null}, can_write),
          can_move = COALESCE(${input.rights?.move ?? null}, can_move),
          can_delete = COALESCE(${input.rights?.delete ?? null}, can_delete),
          expires_at = CASE WHEN ${input.expiresAt === undefined} THEN expires_at ELSE ${input.expiresAt ?? null} END,
          updated_at = ${now}
        WHERE id = ${id} RETURNING *
      `;
      if (rows[0] === undefined) throw new Error("Device not found");
      return device(rows[0]);
    });
  }

  revoke(id: string, now: Date): Promise<DeviceRecord> {
    return this.database.withSql(async (sql) => {
      const rows = await sql<DeviceRow[]>`UPDATE devices SET state = 'revoked', revoked_at = ${now}, updated_at = ${now} WHERE id = ${id} RETURNING *`;
      if (rows[0] === undefined) throw new Error("Device not found");
      return device(rows[0]);
    });
  }

  reserveDelete(input: { readonly deviceId: string; readonly itemCount: number; readonly since: Date; readonly limit: number; readonly occurredAt: Date }): Promise<boolean> {
    return this.database.transaction(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`vault-device-delete:${input.deviceId}`}, 0))`;
      const rows = await sql<{ total: string }[]>`SELECT COALESCE(sum(item_count), 0)::text AS total FROM device_delete_events WHERE device_id = ${input.deviceId} AND occurred_at >= ${input.since}`;
      if (Number(rows[0]?.total ?? 0) + input.itemCount > input.limit) return false;
      await sql`INSERT INTO device_delete_events (device_id, item_count, occurred_at) VALUES (${input.deviceId}, ${input.itemCount}, ${input.occurredAt})`;
      return true;
    });
  }

  recordConflict(input: SyncConflict): Promise<void> {
    return this.database.withSql(async (sql) => {
      await sql`INSERT INTO sync_conflicts (id, device_id, resource_id, conflict_resource_id, base_etag, current_etag, state, created_at) VALUES (${input.id}, ${input.deviceId}, ${input.resourceId}, ${input.conflictResourceId}, ${input.baseEtag}, ${input.currentEtag}, ${input.state}, ${input.createdAt})`;
    });
  }
}
