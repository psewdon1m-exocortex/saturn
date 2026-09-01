import type { FileVersion, RetentionClass } from "./models.js";

export interface VersionRetentionPolicy {
  readonly maximumCount: number;
  readonly minimumAgeMs: number;
  readonly automaticPurge: boolean;
}

export const VERSION_RETENTION: Readonly<Record<RetentionClass, VersionRetentionPolicy>> = {
  general: { maximumCount: 10, minimumAgeMs: 30 * 24 * 60 * 60 * 1_000, automaticPurge: true },
  mastermind_markdown: { maximumCount: 100, minimumAgeMs: 30 * 24 * 60 * 60 * 1_000, automaticPurge: true },
  mastermind_attachment: { maximumCount: 10, minimumAgeMs: 30 * 24 * 60 * 60 * 1_000, automaticPurge: true },
  keepass: { maximumCount: 50, minimumAgeMs: 90 * 24 * 60 * 60 * 1_000, automaticPurge: false },
  laboratory_immutable: { maximumCount: Number.MAX_SAFE_INTEGER, minimumAgeMs: Number.MAX_SAFE_INTEGER, automaticPurge: false },
};

export function archivedVersionPurgeAfter(retentionClass: RetentionClass, archivedAt: Date): Date | undefined {
  const policy = VERSION_RETENTION[retentionClass];
  return policy.automaticPurge ? new Date(archivedAt.getTime() + policy.minimumAgeMs) : undefined;
}

export function eligibleVersionIds(
  versionsNewestFirst: readonly FileVersion[],
  retentionClass: RetentionClass,
  now: Date,
  currentVersionId: string,
): readonly string[] {
  const policy = VERSION_RETENTION[retentionClass];
  if (!policy.automaticPurge) return [];
  return versionsNewestFirst
    .filter((item, index) => item.id !== currentVersionId
      && index >= policy.maximumCount
      && item.purgeAfter !== undefined
      && item.purgeAfter.getTime() <= now.getTime())
    .map((item) => item.id);
}
