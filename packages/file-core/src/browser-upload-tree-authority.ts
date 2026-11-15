import { DROP_POINT_RESOURCE_ID } from "./models.js";

export interface BrowserTreeAuthority { readonly proof: "saturn.browser-tree-authority.v1" }
export type BrowserTreePrincipal = {
  readonly kind: "owner"; readonly scopeId: "owner"; readonly rootId: string;
  readonly sessionId: string; readonly tokenHash: string; readonly credentialRevision: string;
} | {
  readonly kind: "drop"; readonly scopeId: string; readonly rootId: typeof DROP_POINT_RESOURCE_ID;
  readonly sessionId: string; readonly tokenHash: string;
};
export interface BrowserTreeAuthorityValidators {
  /** Normal authenticated session + current credential revision, from trusted composition. */
  readonly ownerSession: (input: unknown) => Promise<{ readonly id: string; readonly tokenHash: string; readonly credentialRevision: string }>;
  /** Normal Drop cookie/CSRF/channel authentication. Destination is never caller supplied. */
  readonly dropSession: (input: unknown) => Promise<{ readonly id: string; readonly channelId: string; readonly tokenHash: string }>;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
function validIdentity(id: string, tokenHash: string): void {
  if (!uuid.test(id) || !hash.test(tokenHash)) throw new Error("browser_tree_authority_invalid");
}

/** A proof is process-local issuance evidence, NOT cached current permission.
 * The fixed database adapter must lock/recheck session, revision/channel,
 * expiry, namespace and backend at admission, execution and publication. */
export class BrowserTreeAuthorityIssuer {
  readonly #proofs = new WeakMap<object, BrowserTreePrincipal>();
  constructor(private readonly validators: BrowserTreeAuthorityValidators) {}
  #seal(principal: BrowserTreePrincipal): BrowserTreeAuthority {
    const proof = Object.freeze({ proof: "saturn.browser-tree-authority.v1" as const });
    this.#proofs.set(proof, Object.freeze(principal)); return proof;
  }
  async ownerSession(input: unknown, rootId: string): Promise<BrowserTreeAuthority> {
    if (!uuid.test(rootId)) throw new Error("browser_tree_authority_invalid");
    const session = await this.validators.ownerSession(input); validIdentity(session.id, session.tokenHash);
    if (!/^[1-9][0-9]*$/.test(session.credentialRevision)) throw new Error("browser_tree_authority_invalid");
    return this.#seal({ kind: "owner", scopeId: "owner", rootId, sessionId: session.id, tokenHash: session.tokenHash, credentialRevision: session.credentialRevision });
  }
  async dropSession(input: unknown): Promise<BrowserTreeAuthority> {
    const session = await this.validators.dropSession(input); validIdentity(session.id, session.tokenHash);
    if (!uuid.test(session.channelId)) throw new Error("browser_tree_authority_invalid");
    return this.#seal({ kind: "drop", scopeId: session.channelId, rootId: DROP_POINT_RESOURCE_ID, sessionId: session.id, tokenHash: session.tokenHash });
  }
  /** Internal fixed adapter only. Do not expose these credentials in a response,
   * audit payload, persisted job body or user-provided SQL callback. */
  credentialsForDatabase(proof: BrowserTreeAuthority): BrowserTreePrincipal {
    const principal = this.#proofs.get(proof);
    if (principal === undefined) throw new Error("browser_tree_authority_invalid");
    return principal;
  }
}
