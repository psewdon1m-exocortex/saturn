import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrowserTreeAuthorityIssuer, type BrowserTreeAuthority } from "./browser-upload-tree-authority.js";
import { DROP_POINT_RESOURCE_ID } from "./models.js";
it("cannot reconstruct authority from a serialized proof or a different issuer", async () => {
  const validators = { ownerSession: vi.fn(async () => ({ id: randomUUID(), tokenHash: "a".repeat(64), credentialRevision: "1" })), dropSession: vi.fn(async () => ({ id: randomUUID(), channelId: randomUUID(), tokenHash: "b".repeat(64) })) };
  const issuer = new BrowserTreeAuthorityIssuer(validators), other = new BrowserTreeAuthorityIssuer(validators);
  const proof = await issuer.ownerSession("trusted-session-input", randomUUID());
  expect(issuer.credentialsForDatabase(proof).kind).toBe("owner");
  expect(() => issuer.credentialsForDatabase(JSON.parse(JSON.stringify(proof)) as BrowserTreeAuthority)).toThrow(/authority_invalid/);
  expect(() => other.credentialsForDatabase(proof)).toThrow(/authority_invalid/);
  expect(Object.isFrozen(issuer.credentialsForDatabase(proof))).toBe(true);
});
it("separates Drop from owner authority and pins its destination independently of request fields", async () => {
  const channelId = randomUUID(), id = randomUUID();
  const issuer = new BrowserTreeAuthorityIssuer({ ownerSession: vi.fn(), dropSession: vi.fn(async () => ({ id, channelId, tokenHash: "b".repeat(64) })) });
  const proof = await issuer.dropSession({ rootId: randomUUID(), kind: "owner", actor: "owner" });
  expect(issuer.credentialsForDatabase(proof)).toEqual({ kind: "drop", scopeId: channelId, rootId: DROP_POINT_RESOURCE_ID, sessionId: id, tokenHash: "b".repeat(64) });
});
it("does not issue authority when normal authentication refuses or returns malformed identity", async () => {
  const issuer = new BrowserTreeAuthorityIssuer({ ownerSession: async () => { throw Error("revoked"); }, dropSession: async () => ({ id: "owner", channelId: randomUUID(), tokenHash: "token-not-hash" }) });
  await expect(issuer.ownerSession({}, randomUUID())).rejects.toThrow("revoked");
  await expect(issuer.dropSession({})).rejects.toThrow(/authority_invalid/);
});
