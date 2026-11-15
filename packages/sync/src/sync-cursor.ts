import { createHmac, timingSafeEqual } from "node:crypto";

// Inactive internal primitive. A signature authenticates a bounded position;
// readiness, current authorization and durable snapshot leases need DB checks.
export interface SyncCursorBinding {
  readonly serverIdentity: string;
  readonly rootId: string;
  readonly serverEpoch: string;
  readonly policyVersion: string;
  readonly bindingVersion: string;
  /** Derived by a trusted route from current actor/credential/scope state. */
  readonly authorityFingerprint: string;
}
export type SyncCursorPosition =
  | { readonly kind: "snapshot"; readonly snapshotId: string; readonly cutSeq: string; readonly lastNodeId: string | null }
  | { readonly kind: "feed"; readonly afterSeq: string };
export interface SyncCursorState {
  readonly binding: SyncCursorBinding;
  readonly position: SyncCursorPosition;
  readonly issuedAtSeconds: number;
  readonly leaseUntilSeconds: number;
  readonly absoluteUntilSeconds: number;
}
export interface SyncCursorKey { readonly id: string; readonly secret: Uint8Array }
export class SyncCursorError extends Error {
  constructor(readonly code: "invalid_input" | "invalid_cursor" | "binding_changed" | "expired") { super(code); }
}

const MAX_TOKEN_BYTES = 4096;
const MAX_PAYLOAD_BYTES = 2048;
const MAX_SECONDS = 86400;
const MAX_INT64 = 9223372036854775807n;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const HASH = /^[a-f\d]{64}$/;
const KEY_ID = /^[A-Za-z\d_-]{1,32}$/;
const failure = () => new SyncCursorError("invalid_cursor");
const object = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw failure();
  return v as Record<string, unknown>;
};
function text(v: unknown): string {
  if (typeof v !== "string" || !v.length || Buffer.byteLength(v) > 128) throw failure();
  for (let i = 0; i < v.length; i++) {
    const n = v.charCodeAt(i);
    if (n <= 0x1f || n === 0x7f) throw failure();
    if (n >= 0xd800 && n <= 0xdbff) { const next = v.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw failure(); }
    else if (n >= 0xdc00 && n <= 0xdfff) throw failure();
  }
  return v;
}
function uuid(v: unknown): string { const s = text(v); if (!UUID.test(s)) throw failure(); return s; }
function counter(v: unknown): string {
  if (typeof v !== "string" || v.length > 19 || !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) > MAX_INT64) throw failure();
  return v;
}
function second(v: unknown): number { if (!Number.isSafeInteger(v) || (v as number) < 0) throw failure(); return v as number; }
function binding(v: unknown): SyncCursorBinding {
  const b = object(v), fingerprint = text(b["authorityFingerprint"]);
  if (!HASH.test(fingerprint)) throw failure();
  return { serverIdentity: text(b["serverIdentity"]), rootId: uuid(b["rootId"]), serverEpoch: text(b["serverEpoch"]),
    policyVersion: text(b["policyVersion"]), bindingVersion: uuid(b["bindingVersion"]), authorityFingerprint: fingerprint };
}
function position(v: unknown): SyncCursorPosition {
  const p = object(v);
  if (p["kind"] === "snapshot") return { kind: "snapshot", snapshotId: uuid(p["snapshotId"]), cutSeq: counter(p["cutSeq"]),
    lastNodeId: p["lastNodeId"] === null ? null : uuid(p["lastNodeId"]) };
  if (p["kind"] === "feed") return { kind: "feed", afterSeq: counter(p["afterSeq"]) };
  throw failure();
}
function state(v: unknown): SyncCursorState {
  const s = object(v);
  const result = { binding: binding(s["binding"]), position: position(s["position"]), issuedAtSeconds: second(s["issuedAtSeconds"]),
    leaseUntilSeconds: second(s["leaseUntilSeconds"]), absoluteUntilSeconds: second(s["absoluteUntilSeconds"]) };
  if (result.leaseUntilSeconds <= result.issuedAtSeconds || result.absoluteUntilSeconds < result.leaseUntilSeconds
    || result.absoluteUntilSeconds - result.issuedAtSeconds > MAX_SECONDS) throw failure();
  return result;
}
function payload(s: SyncCursorState): Buffer {
  const bytes = Buffer.from(JSON.stringify({ protocol: "saturn.sync.cursor.v1", ...s }));
  if (bytes.length > MAX_PAYLOAD_BYTES) throw failure();
  return bytes;
}
function decode(s: string, limit: number): Buffer {
  if (!s.length || !/^[A-Za-z\d_-]+$/.test(s) || s.length > Math.ceil(limit * 4 / 3)) throw failure();
  const bytes = Buffer.from(s, "base64url");
  if (bytes.length > limit || bytes.toString("base64url") !== s) throw failure();
  return bytes;
}

export class SyncCursorCodec {
  readonly #keys = new Map<string, Buffer>();
  readonly #currentKey: string;
  readonly #clock: () => number;
  readonly #lease: number;
  readonly #absolute: number;
  #lastObservedSeconds = -1;

  constructor(options: { readonly keys: readonly SyncCursorKey[]; readonly currentKey: string; readonly nowSeconds: () => number;
    readonly leaseSeconds: number; readonly absoluteSeconds: number }) {
    if (options.keys.length < 1 || options.keys.length > 8 || !KEY_ID.test(options.currentKey)
      || !Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds <= 0
      || !Number.isSafeInteger(options.absoluteSeconds) || options.absoluteSeconds < options.leaseSeconds || options.absoluteSeconds > MAX_SECONDS) {
      throw new SyncCursorError("invalid_input");
    }
    for (const key of options.keys) {
      if (!KEY_ID.test(key.id) || !(key.secret instanceof Uint8Array) || key.secret.length !== 32 || this.#keys.has(key.id)) throw new SyncCursorError("invalid_input");
      this.#keys.set(key.id, Buffer.from(key.secret));
    }
    if (!this.#keys.has(options.currentKey)) throw new SyncCursorError("invalid_input");
    this.#currentKey = options.currentKey; this.#clock = options.nowSeconds;
    this.#lease = options.leaseSeconds; this.#absolute = options.absoluteSeconds;
  }

  #now(): number {
    let now: number; try { now = second(this.#clock()); } catch { throw new SyncCursorError("invalid_input"); }
    if (now < this.#lastObservedSeconds) throw new SyncCursorError("expired");
    this.#lastObservedSeconds = now; return now;
  }
  #sign(s: SyncCursorState): string {
    const encoded = payload(s).toString("base64url"), prefix = `sc1.${this.#currentKey}.${encoded}`;
    const key = this.#keys.get(this.#currentKey); if (!key) throw new SyncCursorError("invalid_input");
    const mac = createHmac("sha256", key).update("saturn.sync.cursor.v1\0").update(prefix).digest("base64url");
    return `${prefix}.${mac}`;
  }

  issue(currentBinding: SyncCursorBinding, start: SyncCursorPosition): string {
    const now = this.#now();
    try {
      return this.#sign(state({ binding: currentBinding, position: start, issuedAtSeconds: now,
        leaseUntilSeconds: now + this.#lease, absoluteUntilSeconds: now + this.#absolute }));
    } catch { throw new SyncCursorError("invalid_input"); }
  }

  verify(token: string, currentBinding: SyncCursorBinding): SyncCursorState {
    if (typeof token !== "string" || Buffer.byteLength(token) > MAX_TOKEN_BYTES) throw failure();
    const [version, id, encoded, signature, ...extra] = token.split(".");
    if (extra.length || version !== "sc1" || id === undefined || encoded === undefined || signature === undefined || !KEY_ID.test(id)) throw failure();
    const key = this.#keys.get(id); if (!key) throw failure();
    const prefix = [version, id, encoded].join("."), received = decode(signature, 32);
    const expected = createHmac("sha256", key).update("saturn.sync.cursor.v1\0").update(prefix).digest();
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw failure();
    const bytes = decode(encoded, MAX_PAYLOAD_BYTES);
    let verified: SyncCursorState;
    try {
      const parsed: unknown = JSON.parse(bytes.toString("utf8")); const o = object(parsed);
      if (o["protocol"] !== "saturn.sync.cursor.v1") throw failure();
      verified = state(o);
      // Exactly the server's bounded representation: duplicates, extra fields,
      // reordered keys, invalid UTF-8 and alternate JSON cannot be accepted.
      if (!payload(verified).equals(bytes)) throw failure();
    } catch { throw failure(); }
    let current: SyncCursorBinding; try { current = binding(currentBinding); } catch { throw new SyncCursorError("invalid_input"); }
    if (JSON.stringify(current) !== JSON.stringify(verified.binding)) throw new SyncCursorError("binding_changed");
    const now = this.#now();
    if (now < verified.issuedAtSeconds || now >= verified.leaseUntilSeconds || now >= verified.absoluteUntilSeconds) throw new SyncCursorError("expired");
    return verified;
  }

  renew(token: string, currentBinding: SyncCursorBinding): string {
    const current = this.verify(token, currentBinding), now = this.#now();
    return this.#sign({ ...current, leaseUntilSeconds: Math.min(now + this.#lease, current.absoluteUntilSeconds) });
  }

  advance(token: string, currentBinding: SyncCursorBinding, next: SyncCursorPosition): string {
    const current = this.verify(token, currentBinding); let p: SyncCursorPosition;
    try {
      p = position(next);
      if (current.position.kind === "feed" && p.kind === "feed") {
        if (BigInt(p.afterSeq) < BigInt(current.position.afterSeq)) throw failure();
      } else if (current.position.kind === "snapshot" && p.kind === "snapshot") {
        const old = current.position;
        if (p.snapshotId !== old.snapshotId || p.cutSeq !== old.cutSeq
          || old.lastNodeId !== null && (p.lastNodeId === null || p.lastNodeId < old.lastNodeId)) throw failure();
      } else throw failure();
    } catch { throw new SyncCursorError("invalid_input"); }
    // Caller must separately prove page commit/prefix/lease and authorize again.
    return this.#sign({ ...current, position: p });
  }
}
