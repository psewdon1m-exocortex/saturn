import { randomUUID } from "node:crypto";
import type { Database } from "@saturn/database";

export interface PackageWriterClaim {
  readonly id: string;
  readonly packageId: string;
  readonly token: string;
  readonly storagePath: string;
}
export interface PackageCleanupClaim { readonly id: string; readonly packageId: string; readonly storagePath: string; readonly token: string }
type Generation = { id: string; package_id: string; storage_path: string; state: string; writer_token: string | null; writer_state: string; writer_expires_at: Date };

export class PackageCustodyCapacityError extends Error {
  readonly code = "package_custody_capacity";
  constructor() { super("Package storage admission is full; review retained unknown writers and unclosed readers before retrying"); }
}

/** Durable ownership of immutable ZIP paths. Unknown handles are retained and
 * count against admission; expiration never certifies physical handle closure. */
export class PostgresPackageLifecycle {
  constructor(private readonly database: Database, private readonly budgetBytes = 5 * 1024 ** 3, private readonly maximumGenerations = 128) {}

  begin(packageId: string, reservedBytes: number, leaseMs: number): Promise<PackageWriterClaim> {
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 1 || reservedBytes > this.budgetBytes || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new Error("Invalid package reservation");
    return this.database.transaction(async sql => {
      await sql`SELECT pg_advisory_xact_lock(1399677208)`;
      const [value] = await sql<{ share_id: string; generation_id: string | null }[]>`SELECT share_id,generation_id FROM share_packages WHERE id=${packageId} AND state='preparing' AND expires_at>clock_timestamp() FOR UPDATE`;
      if (!value) throw new Error("Package is not preparing");
      if (value.generation_id) {
        const [current] = await sql`SELECT id FROM share_package_generations WHERE id=${value.generation_id} AND writer_expires_at>clock_timestamp() FOR UPDATE`;
        if (current) throw new Error("Package writer is still active");
      }
      const [usage] = await sql<{ count: number; bytes: string }[]>`SELECT count(*)::int count,coalesce(sum(reserved_bytes),0)::text bytes FROM share_package_generations`;
      if (!usage || usage.count >= this.maximumGenerations || BigInt(usage.bytes) + BigInt(reservedBytes) > BigInt(this.budgetBytes)) throw new PackageCustodyCapacityError();
      const id = randomUUID(), token = randomUUID(), storagePath = `_system/packages/${value.share_id}/${packageId}-${id}.zip`;
      if (value.generation_id) await sql`UPDATE share_package_generations SET state='retired' WHERE id=${value.generation_id} AND state='writing'`;
      await sql`INSERT INTO share_package_generations(id,package_id,storage_path,state,writer_token,writer_state,writer_expires_at,reserved_bytes)
        VALUES(${id},${packageId},${storagePath},'writing',${token},'UNKNOWN_WRITER',clock_timestamp()+${leaseMs}*interval '1 millisecond',${reservedBytes})`;
      await sql`UPDATE share_packages SET generation_id=${id},storage_path=${storagePath} WHERE id=${packageId}`;
      return { id, packageId, token, storagePath };
    });
  }

  renewWriter(claim: PackageWriterClaim, leaseMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new Error("Invalid writer lease");
    return this.database.withSql(async sql => (await sql`UPDATE share_package_generations g SET writer_expires_at=clock_timestamp()+${leaseMs}*interval '1 millisecond'
      FROM share_packages p WHERE g.id=${claim.id} AND g.writer_token=${claim.token} AND g.package_id=${claim.packageId}
      AND g.state='writing' AND g.writer_expires_at>clock_timestamp() AND p.id=g.package_id AND p.generation_id=g.id AND p.state='preparing' RETURNING g.id`).length === 1);
  }

  /** Call only after successful close of the write, or before any write started.
   * A rejected remote write alone is not a proof and must leave UNKNOWN_WRITER. */
  confirmWriterClosed(claim: PackageWriterClaim): Promise<void> {
    return this.database.withSql(async sql => { await sql`UPDATE share_package_generations SET writer_state='CLOSED_RECLAIMABLE',writer_closed_at=clock_timestamp()
      WHERE id=${claim.id} AND package_id=${claim.packageId} AND writer_token=${claim.token} AND state IN ('writing','retired')`; });
  }

  publish(claim: PackageWriterClaim, input: { fileCount: number; sizeBytes: number; sha256: string; sourceFingerprint: string }): Promise<boolean> {
    if (!Number.isSafeInteger(input.fileCount) || input.fileCount < 0 || input.fileCount > 2_147_483_647
      || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0
      || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)
      || typeof input.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceFingerprint)) return Promise.reject(new Error("Invalid package publication metadata"));
    return this.database.transaction(async sql => {
      const [value] = await sql`SELECT id FROM share_packages WHERE id=${claim.packageId} AND generation_id=${claim.id} AND state='preparing' AND expires_at>clock_timestamp() FOR UPDATE`;
      if (!value) return false;
      const rows = await sql`UPDATE share_package_generations SET state='ready' WHERE id=${claim.id} AND package_id=${claim.packageId} AND writer_token=${claim.token}
        AND state='writing' AND writer_state='CLOSED_RECLAIMABLE' AND writer_expires_at>clock_timestamp() AND reserved_bytes>=${input.sizeBytes} RETURNING id`;
      if (rows.length !== 1) return false;
      await sql`UPDATE share_packages SET state='ready',file_count=${input.fileCount},size_bytes=${input.sizeBytes},sha256=${input.sha256},source_fingerprint=${input.sourceFingerprint},ready_at=clock_timestamp() WHERE id=${claim.packageId}`;
      return true;
    });
  }

  fail(claim: PackageWriterClaim, code: string): Promise<void> {
    return this.database.transaction(async sql => {
      await sql`SELECT id FROM share_packages WHERE id=${claim.packageId} FOR UPDATE`;
      const rows = await sql`UPDATE share_package_generations SET state='retired' WHERE id=${claim.id} AND package_id=${claim.packageId} AND writer_token=${claim.token} AND state='writing' RETURNING id`;
      if (rows.length) await sql`UPDATE share_packages SET state='failed',error_code=${code} WHERE id=${claim.packageId} AND generation_id=${claim.id} AND state='preparing'`;
    });
  }

  acquireReader(packageId: string, generationId: string, leaseMs: number): Promise<string> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error("Invalid reader lease");
    return this.database.transaction(async sql => {
      await sql`SELECT pg_advisory_xact_lock(1399677209)`;
      const [value] = await sql`SELECT id FROM share_packages WHERE id=${packageId} AND generation_id=${generationId} AND state='ready' AND expires_at>clock_timestamp() FOR UPDATE`;
      if (!value) throw new Error("Package is unavailable");
      const [generation] = await sql`SELECT id FROM share_package_generations WHERE id=${generationId} AND package_id=${packageId} AND state='ready' FOR UPDATE`;
      const [count] = await sql<{ total: number }[]>`SELECT count(*)::int total FROM share_package_read_leases`;
      if (!generation || !count || count.total >= 256) throw new Error("Package reader capacity is unavailable");
      const id = randomUUID();
      await sql`INSERT INTO share_package_read_leases(id,generation_id,expires_at) VALUES(${id},${generationId},clock_timestamp()+${leaseMs}*interval '1 millisecond')`;
      return id;
    });
  }

  renewReader(id: string, generationId: string, leaseMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error("Invalid reader lease");
    return this.database.transaction(async sql => {
      const [generation] = await sql`SELECT id FROM share_package_generations WHERE id=${generationId} AND state='ready' FOR UPDATE`;
      if (!generation) return false;
      return (await sql`UPDATE share_package_read_leases SET expires_at=clock_timestamp()+${leaseMs}*interval '1 millisecond' WHERE id=${id} AND generation_id=${generationId} AND expires_at>clock_timestamp() RETURNING id`).length === 1;
    });
  }

  releaseReader(id: string, generationId: string): Promise<void> {
    return this.database.withSql(async sql => { await sql`DELETE FROM share_package_read_leases WHERE id=${id} AND generation_id=${generationId}`; });
  }

  claimCleanup(limit: number): Promise<readonly PackageCleanupClaim[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid cleanup batch");
    return this.database.transaction(async sql => {
      await sql`SELECT pg_advisory_xact_lock(1399677208)`;
      const [usage] = await sql<{ count: number; bytes: string }[]>`SELECT count(*)::int count,coalesce(sum(reserved_bytes),0)::text bytes FROM share_package_generations`;
      let retainedBytes = BigInt(usage?.bytes ?? "0"), retainedCount = usage?.count ?? 0;
      const softBytes = BigInt(Math.floor(this.budgetBytes * 0.75)), softCount = Math.floor(this.maximumGenerations * 0.75);
      if (retainedBytes > softBytes || retainedCount > softCount) {
        const idle = await sql<(Generation & { reserved_bytes: string })[]>`SELECT g.* FROM share_package_generations g JOIN share_packages p ON p.id=g.package_id AND p.generation_id=g.id
          WHERE g.state='ready' AND g.writer_state='CLOSED_RECLAIMABLE' AND p.state='ready' AND p.ready_at<clock_timestamp()-interval '30 seconds'
          AND NOT EXISTS(SELECT 1 FROM share_package_read_leases r WHERE r.generation_id=g.id)
          ORDER BY p.ready_at,g.id FOR UPDATE OF p SKIP LOCKED LIMIT ${limit}`;
        for (const row of idle) {
          if (retainedBytes <= softBytes && retainedCount <= softCount) break;
          // Match reader/publication lock order explicitly: package, then generation.
          await sql`SELECT id FROM share_package_generations WHERE id=${row.id} FOR UPDATE`;
          const retired = await sql`UPDATE share_packages SET state='expired',error_code='package_cache_pressure' WHERE id=${row.package_id} AND generation_id=${row.id} AND state='ready'
            AND NOT EXISTS(SELECT 1 FROM share_package_read_leases WHERE generation_id=${row.id}) RETURNING id`;
          if (retired.length) { retainedBytes -= BigInt(row.reserved_bytes); retainedCount -= 1; }
        }
      }
      // New jobs which never obtained a generation have never opened a ZIP.
      // Legacy uncertain paths have generation rows and are excluded here.
      await sql`WITH unused AS (SELECT p.id FROM share_packages p WHERE p.generation_id IS NULL AND (p.state IN ('failed','expired') OR p.expires_at<=clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM share_package_generations g WHERE g.package_id=p.id) ORDER BY p.created_at,p.id FOR UPDATE OF p SKIP LOCKED LIMIT ${limit})
        DELETE FROM share_packages WHERE id IN (SELECT id FROM unused)`;
      const rows = await sql<Generation[]>`SELECT g.* FROM share_package_generations g JOIN share_packages p ON p.id=g.package_id
        WHERE g.writer_state='CLOSED_RECLAIMABLE' AND NOT EXISTS(SELECT 1 FROM share_package_read_leases r WHERE r.generation_id=g.id)
        AND (g.state='retired' OR g.state='ready' AND (p.state IN ('expired','failed') OR p.expires_at<=clock_timestamp())
          OR g.state='writing' AND g.writer_expires_at<=clock_timestamp() OR g.state='deleting' AND g.cleanup_expires_at<=clock_timestamp())
        ORDER BY g.created_at,g.id FOR UPDATE OF g SKIP LOCKED LIMIT ${limit}`;
      const claims: PackageCleanupClaim[] = [];
      for (const row of rows) {
        const token = randomUUID();
        // The SELECT snapshot may precede a reader's commit immediately before
        // we acquired the generation lock. Recheck with a fresh statement snapshot.
        const changed = await sql`UPDATE share_package_generations SET state='deleting',cleanup_token=${token},cleanup_expires_at=clock_timestamp()+interval '2 minutes' WHERE id=${row.id}
          AND NOT EXISTS(SELECT 1 FROM share_package_read_leases WHERE generation_id=${row.id}) RETURNING id`;
        if (changed.length) claims.push({ id: row.id, packageId: row.package_id, storagePath: row.storage_path, token });
      }
      return claims;
    });
  }

  completeCleanup(claim: PackageCleanupClaim): Promise<boolean> {
    return this.database.transaction(async sql => {
      await sql`SELECT id FROM share_packages WHERE id=${claim.packageId} FOR UPDATE`;
      const [generation] = await sql`SELECT id FROM share_package_generations WHERE id=${claim.id} AND package_id=${claim.packageId} AND storage_path=${claim.storagePath} AND state='deleting' AND cleanup_token=${claim.token} FOR UPDATE`;
      if (!generation) return false;
      await sql`UPDATE share_packages SET generation_id=NULL,state='expired' WHERE id=${claim.packageId} AND generation_id=${claim.id}`;
      await sql`DELETE FROM share_package_generations WHERE id=${claim.id}`;
      await sql`DELETE FROM share_packages WHERE id=${claim.packageId} AND state IN ('failed','expired') AND NOT EXISTS(SELECT 1 FROM share_package_generations WHERE package_id=${claim.packageId})`;
      return true;
    });
  }
}
