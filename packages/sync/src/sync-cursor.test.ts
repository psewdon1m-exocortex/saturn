import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SyncCursorCodec, SyncCursorError, type SyncCursorBinding, type SyncCursorPosition, type SyncCursorKey } from "./sync-cursor.js";

const ROOT = "00000000-0000-0000-0000-000000000001", BINDING = "00000000-0000-0000-0000-000000000002";
const SNAPSHOT = "00000000-0000-0000-0000-000000000003";
const auth: SyncCursorBinding = { serverIdentity: "instance-1", rootId: ROOT, serverEpoch: "epoch-1", policyVersion: "policy-1",
  bindingVersion: BINDING, authorityFingerprint: "a".repeat(64) };
const start: SyncCursorPosition = { kind: "snapshot", snapshotId: SNAPSHOT, cutSeq: "9007199254740993", lastNodeId: null };
const keys = [{ id: "old", secret: Buffer.alloc(32, 1) }, { id: "new", secret: Buffer.alloc(32, 2) }] as const;
function fixture(currentKey = "old", selected: readonly SyncCursorKey[] = keys) {
  let now = 1000;
  const codec = new SyncCursorCodec({ keys: selected, currentKey, nowSeconds: () => now, leaseSeconds: 60, absoluteSeconds: 180 });
  return { codec, set: (value: number) => { now = value; } };
}
function resign(raw: Buffer | string, keyId = "old"): string {
  const prefix = `sc1.${keyId}.${Buffer.from(raw).toString("base64url")}`;
  const key = keys.find(k => k.id === keyId); if (!key) throw new Error("Unknown fixture key");
  return prefix + "." + createHmac("sha256", key.secret).update("saturn.sync.cursor.v1\0").update(prefix).digest("base64url");
}
function body(token: string): string {
  const encoded = token.split(".")[2]; if (encoded === undefined) throw new Error("Invalid fixture token");
  return Buffer.from(encoded, "base64url").toString("utf8");
}

describe("inactive authenticated sync cursor", () => {
  it("roundtrips exact >2^53 counters and returns independently owned data", () => {
    const { codec } = fixture(), token = codec.issue(auth, start), s = codec.verify(token, auth);
    expect(s.position).toEqual(start); expect(s.leaseUntilSeconds).toBe(1060);
    (s.binding as { policyVersion: string }).policyVersion = "changed";
    expect(codec.verify(token, auth).binding.policyVersion).toBe("policy-1");
    expect(token.length).toBeLessThan(4096);
  });
  it.each(Object.keys(auth) as (keyof SyncCursorBinding)[])("refuses a stale current authorization/binding: %s", field => {
    const { codec } = fixture(), token = codec.issue(auth, start);
    const changed = { ...auth, [field]: field === "rootId" || field === "bindingVersion" ? SNAPSHOT : field === "authorityFingerprint" ? "b".repeat(64) : "changed" };
    expect(() => codec.verify(token, changed)).toThrow(new SyncCursorError("binding_changed"));
  });
  it("expires at the idle and absolute boundary; renewal never creates a new absolute lifetime", () => {
    const f = fixture(); let token = f.codec.issue(auth, start);
    f.set(1059); token = f.codec.renew(token, auth); expect(f.codec.verify(token, auth).absoluteUntilSeconds).toBe(1180);
    f.set(1118); token = f.codec.renew(token, auth); f.set(1177); token = f.codec.renew(token, auth);
    expect(f.codec.verify(token, auth).leaseUntilSeconds).toBe(1180);
    f.set(1180); expect(() => f.codec.renew(token, auth)).toThrow(new SyncCursorError("expired"));
    const g = fixture(), idle = g.codec.issue(auth, start); g.set(1060);
    expect(() => g.codec.verify(idle, auth)).toThrow(new SyncCursorError("expired"));
  });
  it("refuses clock reversal and invalid trusted clock values", () => {
    const f = fixture(), token = f.codec.issue(auth, start); f.set(999);
    expect(() => f.codec.verify(token, auth)).toThrow(new SyncCursorError("expired"));
    f.set(Number.NaN); expect(() => f.codec.issue(auth, start)).toThrow(new SyncCursorError("invalid_input"));
    const g = fixture(), later = g.codec.issue(auth, start); g.set(1050); g.codec.verify(later, auth); g.set(1049);
    expect(() => g.codec.verify(later, auth)).toThrow(new SyncCursorError("expired"));
  });
  it("rotates signing keys without extending the prior lease and refuses retired keys", () => {
    const old = fixture(), next = fixture("new"), retired = fixture("new", [keys[1]]);
    const token = old.codec.issue(auth, start), renewed = next.codec.renew(token, auth);
    expect(renewed.startsWith("sc1.new.")).toBe(true); expect(next.codec.verify(token, auth).position).toEqual(start);
    expect(() => retired.codec.verify(token, auth)).toThrow(new SyncCursorError("invalid_cursor"));
    expect(retired.codec.verify(renewed, auth).absoluteUntilSeconds).toBe(1180);
  });
  it("copies configured key bytes and rejects duplicate IDs, weak keys and excessive lifetimes", () => {
    const key = { id: "test", secret: Buffer.alloc(32, 7) };
    const codec = new SyncCursorCodec({ keys: [key], currentKey: "test", nowSeconds: () => 1, leaseSeconds: 1, absoluteSeconds: 2 });
    const token = codec.issue(auth, start); key.secret.fill(0); expect(codec.verify(token, auth).position).toEqual(start);
    for (const selected of [[keys[0], keys[0]], [{ id: "weak", secret: Buffer.alloc(31) }]]) {
      const first = selected[0]; if (first === undefined) throw new Error("Empty fixture keys");
      expect(() => new SyncCursorCodec({ keys: selected, currentKey: first.id, nowSeconds: () => 1, leaseSeconds: 1, absoluteSeconds: 2 })).toThrow(new SyncCursorError("invalid_input"));
    }
    expect(() => new SyncCursorCodec({ keys, currentKey: "old", nowSeconds: () => 1, leaseSeconds: 1, absoluteSeconds: 86401 })).toThrow();
  });
  it("detects all signed token segment mutations and rejects alternate base64 representation", () => {
    const { codec } = fixture(), token = codec.issue(auth, start);
    for (let i = 0; i < token.length; i++) {
      const changed = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
      expect(() => codec.verify(changed, auth)).toThrow();
    }
    expect(() => codec.verify(token + "=", auth)).toThrow();
    expect(() => codec.verify(" ".repeat(4097), auth)).toThrow();
  });
  it("rejects correctly MACed noncanonical, duplicate, surplus and invalid UTF8 JSON", () => {
    const { codec } = fixture(), original = body(codec.issue(auth, start));
    for (const raw of [original.replace('"protocol":', '"protocol":"saturn.sync.cursor.v1","protocol":'),
      original.replace("{", '{"future":0,'), " " + original, original.replace('"9007199254740993"', "9007199254740993"),
      Buffer.concat([Buffer.from(original.slice(0, -1)), Buffer.from([0xff]), Buffer.from("}")])])
      expect(() => codec.verify(resign(raw), auth)).toThrow(new SyncCursorError("invalid_cursor"));
  });
  it("refuses rebinding snapshot/cut/kind and rewinding either independent position", () => {
    const { codec } = fixture(), token = codec.issue(auth, start);
    const next = { ...start, lastNodeId: BINDING }; const advanced = codec.advance(token, auth, next);
    expect(codec.verify(advanced, auth).position).toEqual(next);
    for (const p of [{ ...next, snapshotId: ROOT }, { ...next, cutSeq: "0" }, { ...next, lastNodeId: ROOT },
      { ...next, lastNodeId: null }, { kind: "feed" as const, afterSeq: "0" }])
      expect(() => codec.advance(advanced, auth, p)).toThrow(new SyncCursorError("invalid_input"));
    const feed = codec.issue(auth, { kind: "feed", afterSeq: "9223372036854775806" });
    expect(codec.verify(codec.advance(feed, auth, { kind: "feed", afterSeq: "9223372036854775807" }), auth).position)
      .toEqual({ kind: "feed", afterSeq: "9223372036854775807" });
    expect(() => codec.advance(feed, auth, { kind: "feed", afterSeq: "0" })).toThrow();
  });
  it("rejects malformed exact counters and scalar authority fields before minting", () => {
    const { codec } = fixture();
    for (const value of ["01", "-1", "1.0", "1e3", " 1", "9223372036854775808", 1, ["1"]])
      expect(() => codec.issue(auth, { kind: "feed", afterSeq: value as string })).toThrow(new SyncCursorError("invalid_input"));
    for (const value of ["bad\ud800", "bad\udfff", "x\u0000", "x".repeat(129)])
      expect(() => codec.issue({ ...auth, serverIdentity: value }, start)).toThrow(new SyncCursorError("invalid_input"));
  });
});
