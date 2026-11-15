import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { StorageVerifyError, type StorageVerifyRequest } from "../../contracts/src/storage-verifier.js";
import { readProtected } from "./secure-files.js";

export interface RootAuthority {
  readonly rootId: string;
  readonly backendIdentity: string;
  readonly directory: string;
  readonly prefixes: readonly string[];
}
export interface HostConfig {
  readonly schema: "saturn.storage-verifier-host.v1";
  readonly listenHost: string;
  readonly port: number;
  readonly secretFile: string;
  readonly registryDirectory: string;
  readonly roots: readonly RootAuthority[];
  readonly maximumActive: number;
  readonly maximumBytes: string;
  readonly tls?: { readonly certificateFile: string; readonly keyFile: string };
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function parseHostConfig(value: unknown): HostConfig {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new StorageVerifyError("invalid_input");
    return v as Record<string, unknown>;
  };
  const hostPath = (v: unknown): string => {
    if (typeof v !== "string" || !isAbsolute(v) || v === "/" || v.split("/").slice(1).some(s => !s || s === "." || s === "..")) throw new StorageVerifyError("invalid_input");
    return v;
  };
  const c = object(value);
  if (c.schema !== "saturn.storage-verifier-host.v1" || typeof c.listenHost !== "string" || !["127.0.0.1", "::1"].includes(c.listenHost) && !c.tls
    || typeof c.port !== "number" || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535
    || typeof c.maximumActive !== "number" || !Number.isInteger(c.maximumActive) || c.maximumActive < 1 || c.maximumActive > 4
    || typeof c.maximumBytes !== "string" || !/^[1-9][0-9]{0,15}$/.test(c.maximumBytes) || BigInt(c.maximumBytes) > 9007199254740991n
    || !Array.isArray(c.roots) || !c.roots.length || c.roots.length > 128) throw new StorageVerifyError("invalid_input");
  const secretFile=hostPath(c.secretFile), registryDirectory=hostPath(c.registryDirectory);
  const tlsInput=c.tls===undefined?undefined:object(c.tls);
  const tls=tlsInput?{certificateFile:hostPath(tlsInput.certificateFile),keyFile:hostPath(tlsInput.keyFile)}:undefined;
  const ids = new Set<string>(), roots: RootAuthority[] = [];
  const entries: unknown[] = c.roots;
  for (const entry of entries) {
    const r=object(entry);
    if (typeof r.rootId !== "string" || !uuid.test(r.rootId) || ids.has(r.rootId)
      || typeof r.backendIdentity !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(r.backendIdentity)
      || !Array.isArray(r.prefixes) || !r.prefixes.length || r.prefixes.length > 128) throw new StorageVerifyError("invalid_input");
    const prefixes: unknown[]=r.prefixes;
    if (!prefixes.every((p): p is string => typeof p === "string" && p.length <= 4096 && !/[\\\p{Cc}\p{Cs}]/u.test(p) && !p.split("/").some(s => !s || s === "." || s === ".."))) throw new StorageVerifyError("invalid_input");
    ids.add(r.rootId);roots.push({rootId:r.rootId,backendIdentity:r.backendIdentity,directory:hostPath(r.directory),prefixes});
  }
  const protectedPaths = [registryDirectory, secretFile, ...(tls ? [tls.certificateFile, tls.keyFile] : [])];
  if (roots.some(r => protectedPaths.some(p => p === r.directory || p.startsWith(r.directory + "/") || r.directory.startsWith(p + "/")))) throw new StorageVerifyError("scope_denied");
  return {schema:c.schema,listenHost:c.listenHost,port:c.port,secretFile,registryDirectory,roots,maximumActive:c.maximumActive,maximumBytes:c.maximumBytes,...(tls?{tls}:{})};
}

// Registry entries are written by the backend owner through an independent,
// protected host channel. An HTTP request can neither grant nor renew a fence.
export class RegistryAuthority {
  constructor(readonly config: HostConfig) {}
  async authorize(request: StorageVerifyRequest): Promise<{ root: RootAuthority; witness: string }> {
    const root = this.config.roots.find(r => r.rootId === request.rootId && r.backendIdentity === request.backendIdentity);
    if (!root || !root.prefixes.some(p => request.relativePath === p || request.relativePath.startsWith(p + "/"))) throw new StorageVerifyError("scope_denied");
    const key = createHash("sha256").update(request.backendIdentity).digest("hex");
    const owner = await readProtected(`${this.config.registryDirectory}/owners/${key}.json`);
    const operation = await readProtected(`${this.config.registryDirectory}/operations/${request.operationId}.json`);
    const o = JSON.parse(owner.bytes.toString("utf8")) as Record<string, unknown>;
    const p = JSON.parse(operation.bytes.toString("utf8")) as Record<string, unknown>;
    if (o.schema !== "saturn.storage-verifier-owner.v1" || o.state !== "ACTIVE" || p.schema !== "saturn.storage-verifier-operation.v1" || p.state !== "SEALED") throw new StorageVerifyError("identity_mismatch");
    for (const field of ["backendIdentity", "backendGeneration", "ownerId", "fencingToken"] as const) if (o[field] !== request[field] || p[field] !== request[field]) throw new StorageVerifyError("identity_mismatch");
    for (const field of ["rootId", "operationId", "intentSha256"] as const) if (p[field] !== request[field]) throw new StorageVerifyError("identity_mismatch");
    // One sealed operation may authorize its incoming object and exact preimage.
    // Preserve the v1 single-object registry form; HTTP K4 remains unchanged.
    const objects: unknown[] = p.objects === undefined ? [p] : Array.isArray(p.objects) ? p.objects : [];
    if (!objects.length || objects.length > 16) throw new StorageVerifyError("identity_mismatch");
    let matches = 0;
    for (const value of objects) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new StorageVerifyError("identity_mismatch");
      const object = value as Record<string, unknown>;
      if (["contentVersionId", "relativePath", "sizeBytes", "sha256"].every(field => object[field] === request[field as keyof StorageVerifyRequest])) matches++;
    }
    if (matches !== 1) throw new StorageVerifyError("identity_mismatch");
    return { root, witness: owner.digest + operation.digest };
  }
}
