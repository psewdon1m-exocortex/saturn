import type { BackupRetentionPolicy, BackupRunRecord } from "./types.js";

function day(value: Date): string { return value.toISOString().slice(0, 10); }
function month(value: Date): string { return value.toISOString().slice(0, 7); }
function year(value: Date): string { return value.toISOString().slice(0, 4); }
function week(value: Date): string {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return `${String(date.getUTCFullYear())}-W${String(Math.ceil((((date.getTime() - first.getTime()) / 86_400_000) + 1) / 7)).padStart(2, "0")}`;
}

export function retentionCandidates(runs: readonly BackupRunRecord[], policy: BackupRetentionPolicy): readonly BackupRunRecord[] {
  const complete = runs.filter((item) => item.state === "complete" && item.committedAt !== undefined)
    .sort((left, right) => (right.committedAt?.getTime() ?? 0) - (left.committedAt?.getTime() ?? 0) || right.id.localeCompare(left.id));
  const retained = new Set<string>();
  for (const [limit, bucket] of [[policy.daily, day], [policy.weekly, week], [policy.monthly, month], [policy.yearly, year]] as const) {
    const seen = new Set<string>();
    for (const run of complete) {
      const committedAt = run.committedAt;
      if (committedAt === undefined) continue;
      const key = bucket(committedAt);
      if (seen.has(key)) continue;
      if (seen.size >= limit) break;
      seen.add(key);
      retained.add(run.id);
    }
  }
  return complete.filter((item) => !retained.has(item.id));
}
