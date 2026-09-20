import { createHash } from "node:crypto";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Database } from "@saturn/database";
import { z } from "zod";

const pipeline = z.enum(["archive", "mirror"]);
const archiveIntent = z.object({ enabled: z.boolean(), intervalHours: z.number().int().min(1).max(8760) }).strict();
const mirrorIntent = z.object({ enabled: z.boolean(), intervalMinutes: z.number().int().min(1).max(10080) }).strict();
const base = { expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), requestId: z.uuid() };
export const policyMutationSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("schedule"), pipeline, enabled: z.boolean(), intervalHours: z.number().finite().min(1 / 60).max(8760) }).strict(),
  z.object({ ...base, kind: z.literal("restore"), archive: archiveIntent, mirror: mirrorIntent.nullable() }).strict(),
  z.object({ ...base, kind: z.literal("resume") }).strict(),
]);
export type PolicyMutation = z.infer<typeof policyMutationSchema>;
export const policyRunSchema = z.object({ requestId: z.uuid(), pipeline }).strict();

interface PolicyRow {
  service_id: string; desired_revision: string; applied_revision: string;
  archive_enabled: boolean; archive_interval_hours: number;
  mirror_enabled: boolean; mirror_interval_minutes: number; policy_paused: boolean;
  namespace_slug: string; deployment_id: string; mirror_root: string | null;
  archive_status: Record<string, unknown>; mirror_status: Record<string, unknown>;
  agent_version: string | null; last_seen_at: Date | null;
}

function view(row: PolicyRow) {
  return {
    schema: "exocortex.backup.policy.v1", owner: "service",
    scope: { serviceId: row.service_id, service: row.namespace_slug, deploymentId: row.deployment_id, mirrorRoot: row.mirror_root },
    revision: Number(row.desired_revision), appliedRevision: Number(row.applied_revision),
    paused: row.policy_paused,
    archive: { enabled: row.archive_enabled, intervalHours: row.archive_interval_hours },
    mirror: row.mirror_root === null ? null : { enabled: row.mirror_enabled, intervalMinutes: row.mirror_interval_minutes },
    observed: { online: row.last_seen_at !== null && Date.now() - row.last_seen_at.getTime() < 45000,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null, version: row.agent_version,
      archive: row.archive_status, mirror: row.mirror_status },
  };
}

// The producer identity selects the scope; caller-supplied service IDs, targets,
// credentials and paths are never accepted. Saturn remains the only policy DB.
export class ServiceBackupPolicy {
  constructor(private readonly database: Database) {}

  async read(serviceId: string) {
    const rows = await this.database.withSql(sql => sql<PolicyRow[]>`
      SELECT a.*, a.desired_revision::text, a.applied_revision::text,
        s.namespace_slug, s.deployment_id, s.mirror_root
      FROM neptune_agents a JOIN backup_services s ON s.id=a.service_id
      WHERE a.service_id=${serviceId} AND s.state='active'
    `);
    if (!rows[0]) throw new NotFoundException("The service has no enrolled backup policy");
    return view(rows[0]);
  }

  async mutate(serviceId: string, input: PolicyMutation) {
    const digest = createHash("sha256").update(JSON.stringify(policyMutationSchema.parse(input))).digest("hex");
    return this.database.transaction(async sql => {
      const rows = await sql<PolicyRow[]>`
        SELECT a.*, a.desired_revision::text, a.applied_revision::text,
          s.namespace_slug, s.deployment_id, s.mirror_root
        FROM neptune_agents a JOIN backup_services s ON s.id=a.service_id
        WHERE a.service_id=${serviceId} AND s.state='active' FOR UPDATE OF a,s
      `;
      const row = rows[0];
      if (!row) throw new NotFoundException("The service has no enrolled backup policy");
      const previous = await sql<{ request_digest: string; result: ReturnType<typeof view> }[]>`
        SELECT request_digest,result FROM neptune_policy_operations WHERE service_id=${serviceId} AND request_id=${input.requestId}
      `;
      if (previous[0]) {
        if (previous[0].request_digest !== digest) throw new ConflictException("Request ID belongs to another policy change");
        return previous[0].result;
      }
      if (Number(row.desired_revision) !== input.expectedRevision) throw new ConflictException("Backup policy changed; refresh and review your draft");
      const capacity = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM neptune_policy_operations WHERE service_id=${serviceId}`;
      if (Number(capacity[0]?.count) >= 10000) throw new ServiceUnavailableException("Policy history capacity reached; preserve history and contact the operator");
      if (input.kind === "schedule") {
        if (input.pipeline === "mirror" && row.mirror_root === null) throw new NotFoundException("This service has no mirror pipeline");
        const minutes = input.intervalHours * 60;
        const unchangedLegacyMirror = input.pipeline === "mirror" && Math.abs(minutes - row.mirror_interval_minutes) < 1e-8;
        if ((!Number.isInteger(input.intervalHours) || input.intervalHours < 1) && !unchangedLegacyMirror)
          throw new ConflictException("Choose a whole number of hours; an imported interval may only be preserved unchanged");
        if (input.pipeline === "mirror" && minutes > 10080) throw new ConflictException("Mirror interval cannot exceed 168 hours");
        if (input.pipeline === "archive") {
          row.archive_enabled = input.enabled; row.archive_interval_hours = input.intervalHours;
        } else {
          row.mirror_enabled = input.enabled; row.mirror_interval_minutes = Math.round(minutes);
        }
      } else if (input.kind === "restore") {
        if ((input.mirror !== null) !== (row.mirror_root !== null)) throw new ConflictException("Backup pipeline profile differs from this deployment");
        row.archive_enabled = input.archive.enabled; row.archive_interval_hours = input.archive.intervalHours;
        if (input.mirror) { row.mirror_enabled = input.mirror.enabled; row.mirror_interval_minutes = input.mirror.intervalMinutes; }
        row.policy_paused = true;
        // Old queued commands are resolved explicitly, never re-created on restore.
        await sql`UPDATE neptune_agent_commands SET state='failed',error='policy_restored_pending_verification',completed_at=now()
          WHERE service_id=${serviceId} AND kind IN ('archive.run','mirror.run') AND state='pending'`;
      } else {
        if (!row.policy_paused) throw new ConflictException("No restored policy awaits verification");
        row.policy_paused = false;
      }
      await sql`UPDATE neptune_agents SET desired_revision=desired_revision+1,
        archive_enabled=${row.archive_enabled},archive_interval_hours=${row.archive_interval_hours},
        mirror_enabled=${row.mirror_enabled},mirror_interval_minutes=${row.mirror_interval_minutes},
        policy_paused=${row.policy_paused},updated_at=now() WHERE service_id=${serviceId}`;
      row.desired_revision = String(Number(row.desired_revision) + 1);
      const result = view(row);
      await sql`INSERT INTO neptune_policy_operations(service_id,request_id,request_digest,result)
        VALUES(${serviceId},${input.requestId},${digest},${sql.json(result as never)})`;
      return result;
    });
  }

  async run(serviceId: string, input: z.infer<typeof policyRunSchema>) {
    return this.database.transaction(async sql => {
      const agents = await sql<{ policy_paused: boolean; mirror_root: string | null }[]>`
        SELECT a.policy_paused,s.mirror_root FROM neptune_agents a JOIN backup_services s ON a.service_id=s.id
        WHERE a.service_id=${serviceId} AND s.state='active' FOR UPDATE OF a,s`;
      const agent = agents[0];
      if (!agent) throw new NotFoundException("The service has no enrolled backup policy");
      const kind = input.pipeline + ".run";
      const previous = await sql<{ service_id: string; kind: string; state: string; error: string | null }[]>`
        SELECT service_id,kind,state,error FROM neptune_agent_commands WHERE id=${input.requestId}`;
      if (previous[0]) {
        if (previous[0].service_id !== serviceId || previous[0].kind !== kind) throw new ConflictException("Request ID belongs to another run");
        return { id: input.requestId, state: previous[0].state, error: previous[0].error, pipeline: input.pipeline };
      }
      if (agent.policy_paused) throw new ConflictException("Restored policy awaits verification");
      if (input.pipeline === "mirror" && agent.mirror_root === null) throw new NotFoundException("This service has no mirror pipeline");
      const active = await sql<{ id: string }[]>`SELECT id FROM neptune_agent_commands
        WHERE service_id=${serviceId} AND kind=${kind} AND state='pending' AND created_at>now()-interval '7 days'`;
      if (active.length) throw new ConflictException("A run is already pending; observe the existing run");
      await sql`INSERT INTO neptune_agent_commands(id,service_id,kind,payload,created_at)
        VALUES(${input.requestId},${serviceId},${kind},${sql.json({ source: "service" } as never)},now())`;
      return { id: input.requestId, pipeline: input.pipeline, state: "pending", error: null };
    });
  }

  async jobs(serviceId: string) {
    await this.read(serviceId);
    return this.database.withSql(sql => sql`SELECT id,kind,state,error,created_at,completed_at FROM neptune_agent_commands
      WHERE service_id=${serviceId} AND kind IN ('archive.run','mirror.run') ORDER BY created_at DESC LIMIT 100`);
  }
}
