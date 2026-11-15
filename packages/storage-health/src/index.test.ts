import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AdapterStorageHealthProbe, createHostVerifier, fingerprintForKey } from "./index.js";
import type { StorageAdapter } from "@saturn/storage";

describe("SFTP host identity", () => {
  it("accepts only the exact configured SHA-256 fingerprint", () => {
    const key = Buffer.from("local-test-host-key");
    const expected = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
    expect(fingerprintForKey(key)).toBe(expected);
    expect(createHostVerifier(expected)(key)).toBe(true);
    expect(createHostVerifier(`SHA256:${"A".repeat(43)}`)(key)).toBe(false);
  });
});

describe("storage writer readiness", () => {
  it("refuses a readable root when the durable writer is unavailable", async () => {
    const storage = {
      stat: async () => ({ type: "directory" }),
      assertReady: async () => { throw new Error("backend_owner_unavailable"); },
    } as unknown as StorageAdapter;
    expect(await new AdapterStorageHealthProbe(storage).check()).toMatchObject({state: "fail", detail: "storage_unavailable"});
  });
});
