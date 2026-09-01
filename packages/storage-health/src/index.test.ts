import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHostVerifier, fingerprintForKey } from "./index.js";

describe("SFTP host identity", () => {
  it("accepts only the exact configured SHA-256 fingerprint", () => {
    const key = Buffer.from("local-test-host-key");
    const expected = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
    expect(fingerprintForKey(key)).toBe(expected);
    expect(createHostVerifier(expected)(key)).toBe(true);
    expect(createHostVerifier(`SHA256:${"A".repeat(43)}`)(key)).toBe(false);
  });
});
