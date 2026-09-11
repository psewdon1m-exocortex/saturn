import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { BackupIngestService } from "@saturn/backup-ingest";
import type { Database } from "@saturn/database";
import { BACKUP_INGEST_SERVICE, DATABASE } from "./tokens.js";

export type NeptuneCommandKind = "archive.run" | "mirror.run" | "agent.update";

export interface NeptuneFleetCheckIn {
  readonly clientInstanceId: string;
  readonly projectId: string;
  readonly version: string;
  readonly appliedRevision: number;
  readonly archive: Record<string, unknown>;
  readonly mirror?: Record<string, unknown> | null;
  readonly latestError?: string | null;
  readonly commandResults: readonly {
    readonly id: string;
    readonly state: "succeeded" | "failed";
    readonly error?: string | null;
  }[];
}

interface AgentRow {
  readonly service_id: string;
  readonly desired_revision: string;
  readonly archive_enabled: boolean;
  readonly archive_interval_hours: number;
  readonly mirror_enabled: boolean;
  readonly mirror_interval_minutes: number;
  readonly desired_version: string | null;
  readonly client_instance_id: string | null;
  readonly project_id: string | null;
  readonly agent_version: string | null;
  readonly applied_revision: string;
  readonly archive_status: Record<string, unknown>;
  readonly mirror_status: Record<string, unknown>;
  readonly latest_error: string | null;
  readonly last_seen_at: Date | null;
  readonly updated_at: Date;
}

interface CommandRow {
  readonly id: string;
  readonly kind: NeptuneCommandKind;
  readonly payload: Record<string, unknown>;
  readonly state: "pending" | "succeeded" | "failed";
  readonly error: string | null;
  readonly created_at: Date;
  readonly completed_at: Date | null;
}

function publicAgent(row: AgentRow) {
  return {
    serviceId: row.service_id,
    desired: {
      revision: Number(row.desired_revision),
      archiveEnabled: row.archive_enabled,
      archiveIntervalHours: row.archive_interval_hours,
      mirrorEnabled: row.mirror_enabled,
      mirrorIntervalMinutes: row.mirror_interval_minutes,
      ...(row.desired_version === null ? {} : { version: row.desired_version }),
    },
    observed: {
      ...(row.client_instance_id === null ? {} : { clientInstanceId: row.client_instance_id }),
      ...(row.project_id === null ? {} : { projectId: row.project_id }),
      ...(row.agent_version === null ? {} : { version: row.agent_version }),
      appliedRevision: Number(row.applied_revision),
      archive: row.archive_status,
      mirror: row.mirror_status,
      ...(row.latest_error === null ? {} : { latestError: row.latest_error }),
      ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at.toISOString() }),
    },
    updatedAt: row.updated_at.toISOString(),
  };
}

@Injectable()
export class NeptuneFleetService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(BACKUP_INGEST_SERVICE) private readonly backups: BackupIngestService,
  ) {}

  async authenticate(authorization: string | undefined): Promise<string> {
    return (await this.backups.authenticate(authorization)).service.id;
  }

  async list() {
    const rows = await this.database.withSql((sql) => sql<AgentRow[]>`
      SELECT service_id, desired_revision::text, archive_enabled, archive_interval_hours,
        mirror_enabled, mirror_interval_minutes, desired_version, client_instance_id,
        project_id, agent_version, applied_revision::text, archive_status, mirror_status,
        latest_error, last_seen_at, updated_at
      FROM neptune_agents
      ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC
    `);
    return rows.map(publicAgent);
  }

  async get(serviceId: string) {
    const row = await this.ensure(serviceId);
    return publicAgent(row);
  }

  async updateDesired(serviceId: string, input: {
    readonly archiveEnabled: boolean;
    readonly archiveIntervalHours: number;
    readonly mirrorEnabled?: boolean;
    readonly mirrorIntervalMinutes?: number;
  }) {
    const row = await this.database.transaction(async (sql) => {
      const services = await sql<{ mirror_root: string | null }[]>`
        SELECT mirror_root FROM backup_services WHERE id = ${serviceId} AND state = 'active' FOR UPDATE
      `;
      const selected = services[0];
      if (selected === undefined) throw new Error("Neptune identity not found or not active");
      if (input.mirrorEnabled === true && selected.mirror_root === null)
        throw new Error("Neptune identity has no mirror pipeline");
      await sql`
        INSERT INTO neptune_agents(service_id) VALUES (${serviceId})
        ON CONFLICT (service_id) DO NOTHING
      `;
      const rows = await sql<AgentRow[]>`
        UPDATE neptune_agents SET
          desired_revision = desired_revision + 1,
          archive_enabled = ${input.archiveEnabled},
          archive_interval_hours = ${input.archiveIntervalHours},
          mirror_enabled = ${selected.mirror_root === null ? false : (input.mirrorEnabled ?? false)},
          mirror_interval_minutes = ${input.mirrorIntervalMinutes ?? 5},
          updated_at = now()
        WHERE service_id = ${serviceId}
        RETURNING service_id, desired_revision::text, archive_enabled, archive_interval_hours,
          mirror_enabled, mirror_interval_minutes, desired_version, client_instance_id,
          project_id, agent_version, applied_revision::text, archive_status, mirror_status,
          latest_error, last_seen_at, updated_at
      `;
      const updated = rows[0];
      if (updated === undefined) throw new Error("Neptune desired state could not be saved");
      return updated;
    });
    return publicAgent(row);
  }

  async enqueue(serviceId: string, kind: NeptuneCommandKind, payload: Record<string, unknown> = {}) {
    const id = randomUUID();
    await this.database.transaction(async (sql) => {
      const services = await sql<{ mirror_root: string | null }[]>`
        SELECT mirror_root FROM backup_services WHERE id = ${serviceId} AND state = 'active' FOR UPDATE
      `;
      const selected = services[0];
      if (selected === undefined) throw new Error("Neptune identity not found or not active");
      if (kind === "mirror.run" && selected.mirror_root === null)
        throw new Error("Neptune identity has no mirror pipeline");
      await sql`
        INSERT INTO neptune_agents(service_id) VALUES (${serviceId})
        ON CONFLICT (service_id) DO NOTHING
      `;
      await sql`
        INSERT INTO neptune_agent_commands(id, service_id, kind, payload, created_at)
        VALUES (${id}, ${serviceId}, ${kind}, ${sql.json(payload as never)}, now())
      `;
      if (kind === "agent.update" && typeof payload.version === "string") {
        await sql`
          UPDATE neptune_agents SET desired_version = ${payload.version}, desired_revision = desired_revision + 1, updated_at = now()
          WHERE service_id = ${serviceId}
        `;
      }
    });
    return { id, kind, state: "pending" as const };
  }

  async checkIn(serviceId: string, input: NeptuneFleetCheckIn) {
    const result = await this.database.transaction(async (sql) => {
      const serviceRows = await sql<{ state: string; mirror_root: string | null }[]>`
        SELECT state, mirror_root FROM backup_services WHERE id = ${serviceId} FOR UPDATE
      `;
      if (serviceRows[0]?.state !== "active") throw new Error("Neptune identity is not active");
      for (const completed of input.commandResults) {
        await sql`
          UPDATE neptune_agent_commands SET state = ${completed.state}, error = ${completed.error ?? null}, completed_at = now()
          WHERE id = ${completed.id} AND service_id = ${serviceId} AND state = 'pending'
        `;
      }
      await sql`
        UPDATE neptune_agent_commands SET state = 'failed', error = 'command_expired', completed_at = now()
        WHERE service_id = ${serviceId} AND state = 'pending' AND created_at < now() - interval '7 days'
      `;
      await sql`
        DELETE FROM neptune_agent_commands
        WHERE service_id = ${serviceId} AND completed_at < now() - interval '30 days'
      `;
      const rows = await sql<AgentRow[]>`
        INSERT INTO neptune_agents(
          service_id, client_instance_id, project_id, agent_version, applied_revision,
          archive_status, mirror_status, latest_error, last_seen_at, updated_at)
        VALUES (
          ${serviceId}, ${input.clientInstanceId}, ${input.projectId}, ${input.version}, ${input.appliedRevision},
          ${sql.json(input.archive as never)}, ${sql.json((input.mirror ?? {}) as never)}, ${input.latestError ?? null}, now(), now())
        ON CONFLICT (service_id) DO UPDATE SET
          client_instance_id = EXCLUDED.client_instance_id,
          project_id = EXCLUDED.project_id,
          agent_version = EXCLUDED.agent_version,
          applied_revision = EXCLUDED.applied_revision,
          archive_status = EXCLUDED.archive_status,
          mirror_status = EXCLUDED.mirror_status,
          latest_error = EXCLUDED.latest_error,
          last_seen_at = EXCLUDED.last_seen_at,
          updated_at = EXCLUDED.updated_at
        RETURNING service_id, desired_revision::text, archive_enabled, archive_interval_hours,
          mirror_enabled, mirror_interval_minutes, desired_version, client_instance_id,
          project_id, agent_version, applied_revision::text, archive_status, mirror_status,
          latest_error, last_seen_at, updated_at
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("Neptune check-in could not be stored");
      const commands = await sql<CommandRow[]>`
        SELECT id, kind, payload, state, error, created_at, completed_at
        FROM neptune_agent_commands
        WHERE service_id = ${serviceId} AND state = 'pending'
        ORDER BY created_at
        LIMIT 20
      `;
      return { row, commands };
    });
    return {
      schema: "saturn.neptune.control.v1",
      desired: publicAgent(result.row).desired,
      commands: result.commands.map((command) => ({ id: command.id, kind: command.kind, payload: command.payload, expiresAt: new Date(new Date(command.created_at).getTime() + 7 * 86_400_000).toISOString() })),
    };
  }

  private async ensure(serviceId: string): Promise<AgentRow> {
    const rows = await this.database.withSql(async (sql) => {
      await sql`
        INSERT INTO neptune_agents(service_id)
        SELECT id FROM backup_services WHERE id = ${serviceId} AND state = 'active'
        ON CONFLICT (service_id) DO NOTHING
      `;
      return sql<AgentRow[]>`
        SELECT service_id, desired_revision::text, archive_enabled, archive_interval_hours,
          mirror_enabled, mirror_interval_minutes, desired_version, client_instance_id,
          project_id, agent_version, applied_revision::text, archive_status, mirror_status,
          latest_error, last_seen_at, updated_at
        FROM neptune_agents WHERE service_id = ${serviceId}
      `;
    });
    const row = rows[0];
    if (row === undefined) throw new Error("Neptune identity not found or not active");
    return row;
  }
}
