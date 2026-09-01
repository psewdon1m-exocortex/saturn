import { describe, expect, it } from "vitest";
import { redact } from "./redactor.js";

describe("recursive audit redaction", () => {
  it("redacts secret keys, known values, bearer tokens and URI credentials at any depth", () => {
    const secret = "known-secret-value";
    const result = JSON.stringify(redact({
      authorization: "Bearer raw-token",
      nested: [{ password: "raw-password", note: `prefix ${secret} suffix` }],
      database: "postgres://vault:database-password@db/vault",
    }, [secret]));
    expect(result).not.toContain("raw-token");
    expect(result).not.toContain("raw-password");
    expect(result).not.toContain(secret);
    expect(result).not.toContain("database-password");
    expect(result).toContain("[REDACTED]");
  });

  it("bounds recursion, arrays, object keys and string length", () => {
    const result = redact({ values: Array.from({ length: 1_001 }, (_, index) => index), text: "x".repeat(20_000) });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("[TRUNCATED]");
    expect(serialized.length).toBeLessThan(30_000);
  });
});
