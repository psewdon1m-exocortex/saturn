import { requireTestValue } from "../../contracts/src/test-support.js";
import { describe, expect, it } from "vitest";
import type { FileVersion } from "./models.js";
import { archivedVersionPurgeAfter, eligibleVersionIds, VERSION_RETENTION } from "./retention.js";

function fixture(id: string, daysOld: number, purgeDaysAgo: number): FileVersion {
  const now = Date.UTC(2026, 7, 26);
  return {
    id,
    resourceId: "resource",
    storagePath: `versions/${id}`,
    sha256: "a".repeat(64),
    sizeBytes: 1,
    mimeType: "application/octet-stream",
    reason: "overwrite",
    state: "active",
    purgeAfter: new Date(now - purgeDaysAgo * 24 * 60 * 60 * 1_000),
    createdAt: new Date(now - daysOld * 24 * 60 * 60 * 1_000),
  };
}

describe("version retention", () => {
  it.each(["general", "mastermind_markdown", "mastermind_attachment"] as const)("preserves exact age/count/current boundaries for %s", retentionClass => {
    const archivedAt = new Date("2026-01-01T00:00:00.000Z");
    const policy = VERSION_RETENTION[retentionClass];
    const purgeAfter = requireTestValue(archivedVersionPurgeAfter(retentionClass, archivedAt));
    expect(purgeAfter.getTime() - archivedAt.getTime()).toBe(policy.minimumAgeMs);
    const protectedVersions = Array.from({ length: policy.maximumCount }, (_, i) => ({ ...fixture(`newer-${String(i)}`, 400, 300), archivedAt, purgeAfter }));
    const current = { ...fixture("current", 400, 300), archivedAt, purgeAfter };
    const old = { ...fixture("old", 400, 300), archivedAt, purgeAfter };
    // Current is protected even when supplied beyond the count boundary.
    const versions = [...protectedVersions, current, old];
    expect(eligibleVersionIds(versions, retentionClass, new Date(purgeAfter.getTime() - 1), current.id)).toEqual([]);
    expect(eligibleVersionIds(versions, retentionClass, purgeAfter, current.id)).toEqual(["old"]);
  });

  it("requires both the count and age boundaries for general versions", () => {
    const now = new Date(Date.UTC(2026, 7, 26));
    const versions = Array.from({ length: 12 }, (_, index) => fixture(`v${String(index)}`, 40 + index, 1));
    expect(eligibleVersionIds(versions, "general", now, "v0")).toEqual(["v10", "v11"]);
  });

  it("never automatically purges KeePass or immutable versions", () => {
    const now = new Date(Date.UTC(2026, 7, 26));
    const versions = Array.from({ length: 60 }, (_, index) => fixture(`v${String(index)}`, 200, 100));
    expect(eligibleVersionIds(versions, "keepass", now, "v0")).toEqual([]);
    expect(eligibleVersionIds(versions, "laboratory_immutable", now, "v0")).toEqual([]);
    expect(archivedVersionPurgeAfter("keepass", now)).toBeUndefined();
    expect(archivedVersionPurgeAfter("laboratory_immutable", now)).toBeUndefined();
  });
});
