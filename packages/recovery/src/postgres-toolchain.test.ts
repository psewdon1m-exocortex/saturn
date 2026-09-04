import { describe, expect, it } from "vitest";
import { RECOVERY_TRANSIENT_TABLES } from "./postgres-toolchain.js";

describe("PostgresCommandToolchain recovery dump policy", () => {
  it("excludes a transient upload journal together with its upload sessions", () => {
    expect(RECOVERY_TRANSIENT_TABLES).toContain("upload_sessions");
    expect(RECOVERY_TRANSIENT_TABLES).toContain("operation_journal");
    expect(new Set(RECOVERY_TRANSIENT_TABLES).size).toBe(RECOVERY_TRANSIENT_TABLES.length);
  });
});
