import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Database } from "@saturn/database";
import { ensureStorageDirectory,validateExactStoragePath, type StorageAdapter } from "@saturn/storage";
import { parseSyncDeletePlan,parseSyncMutationInput, parseSyncNamespacePolicy, syncNameKey, SyncExtensionError, type SyncDeletePlan,type SyncMutationInput, type SyncNamespacePolicy, type SyncMutationStatus, type SyncContentReference } from "../../contracts/src/sync-extensions.js";
import { validateSyncDescriptor, type SyncNodeDescriptor } from "../../contracts/src/sync-protocol.js";
import type { CatalogFolderAuthority, CatalogFolderAuthorityIssuer } from "./catalog-folder-authority.js";
import type { CatalogRootAdmission } from "./catalog-root-admission.js";

interface Execution {
  nodeId: string; versionId: string | null; before: SyncNodeDescriptor | null;
  sourcePath: string | null; targetPath: string | null; tempPath: string;
  sizeBytes: string; sha256: string | null; sourceContentVersionId: string | null;
  oldAncestors: readonly string[]; newAncestors: readonly string[];
}
interface Stored { status: SyncMutationStatus; execution: Execution; claimToken: string | null }
type Credential = Readonly<Record<string, unknown>>;
/** A physical claim reserves the entire root conflict set in the original
 * journal. Catalog effects/feed/receipt are one transaction, after I/O. */
export class CatalogNamespaceMutations {
  constructor(private readonly writer: Database, private readonly authority: CatalogFolderAuthorityIssuer,
    private readonly storage: StorageAdapter, private readonly admission: CatalogRootAdmission) {}
  #credential(proof: CatalogFolderAuthority, root: string): Credential {
    return this.authority.actor(proof, root).type === "device_token" ? this.authority.deviceCredential(proof, root) : this.authority.ownerCredential(proof, root);
  }
  async #command(command: string, input: SyncMutationInput, namespace: SyncNamespacePolicy, credential: Credential, payload: Record<string, unknown> = {}): Promise<Stored> {
    try {
      const result = await this.writer.transaction(async sql => {
        await sql<Record<string, unknown>[]>`SET LOCAL lock_timeout='2s'`; await sql<Record<string, unknown>[]>`SET LOCAL statement_timeout='5s'`; await sql<Record<string, unknown>[]>`SET LOCAL idle_in_transaction_session_timeout='2s'`;
        return (await sql<{ value: Stored }[]>`SELECT public.sync_namespace_command(${command},${JSON.stringify({ input, namespace })}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]?.value;
      });
      if (!result || result.status.operationId !== input.operationId || !/^[a-f0-9]{64}$/.test(result.status.intentHash)
        || !["PREPARED", "PHYSICAL_PENDING", "UNKNOWN", "PUBLISHED"].includes(result.status.state) || Buffer.byteLength(JSON.stringify(result)) > 65536) throw new SyncExtensionError("projection_mismatch");
      for (const p of [result.execution.sourcePath, result.execution.targetPath, result.execution.tempPath].filter((x): x is string => x !== null)) {
        if (typeof p !== "string" || validateExactStoragePath(p,false)!==p) throw new SyncExtensionError("projection_mismatch");
      }
      if (result.execution.before) validateSyncDescriptor(result.execution.before);
      if (result.status.result) validateSyncDescriptor(result.status.result.description);
      return result;
    } catch (error) {
      if (error instanceof SyncExtensionError) throw error;
      if (error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)) throw new SyncExtensionError(error.message);
      throw error;
    }
  }
  async status(value: SyncMutationInput, policy: SyncNamespacePolicy, proof: CatalogFolderAuthority): Promise<SyncMutationStatus> {
    const input = parseSyncMutationInput(value), namespace = parseSyncNamespacePolicy(policy);
    return (await this.#command("status", input, namespace, this.#credential(proof, input.rootId))).status;
  }
  async approveDeletePlan(rootId:string,epoch:string,bindingVersion:string,value:SyncDeletePlan,policy:SyncNamespacePolicy,proof:CatalogFolderAuthority){
    const plan=parseSyncDeletePlan(value),namespace=parseSyncNamespacePolicy(policy),credential=this.#credential(proof,rootId);
    try{return await this.writer.transaction(async sql=>{
      await sql<Record<string, unknown>[]>`SET LOCAL lock_timeout='2s'`;await sql<Record<string, unknown>[]>`SET LOCAL statement_timeout='5s'`;
      const result=(await sql<{value:{schema:string;planId:string;planDigest:string;itemCount:number}}[]>`SELECT public.sync_namespace_command('approve-delete-plan',${JSON.stringify({input:{...plan,rootId,epoch,bindingVersion,kind:'quarantine-delete'},namespace})}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,'{}'::jsonb) AS value`)[0]?.value;
      if(!result||result.schema!=='saturn.delete-plan-approved.v1'||result.planId!==plan.planId||result.planDigest!==plan.planDigest||result.itemCount!==plan.items.length)throw new SyncExtensionError('projection_mismatch');
      return result;
    });}catch(error){if(error instanceof Error&&/^[a-z_]{1,64}$/.test(error.message))throw new SyncExtensionError(error.message);throw error;}
  }
  async execute(value: SyncMutationInput, policy: SyncNamespacePolicy, proof: CatalogFolderAuthority): Promise<SyncMutationStatus> {
    const input = parseSyncMutationInput(value), namespace = parseSyncNamespacePolicy(policy);
    if (input.kind === "availability") throw new SyncExtensionError("forbidden");
    if ("name" in input) syncNameKey(input.name, namespace.codec);
    return this.#execute(input, namespace, this.#credential(proof, input.rootId));
  }
  /** Only trusted worker composition has this method; it has no HTTP route. */
  markUnavailable(input: SyncMutationInput & { kind: "availability" }, policy: SyncNamespacePolicy): Promise<SyncMutationStatus> {
    return this.#execute(parseSyncMutationInput(input), parseSyncNamespacePolicy(policy), { type: "maintenance" });
  }
  async #hash(path: string, expectedSize: string, expectedHash: string | null): Promise<void> {
    if (!expectedHash) throw new SyncExtensionError("verification_failed");
    const stat = await this.storage.stat(path);
    if (stat.type !== "file" || String(stat.size) !== expectedSize) throw new SyncExtensionError("verification_failed");
    const hash = createHash("sha256"); let count = 0n;
    for await (const raw of await this.storage.openRead(path)) {
      const bytes = Buffer.from(raw as Uint8Array); count += BigInt(bytes.length);
      if (count > BigInt(expectedSize)) throw new SyncExtensionError("verification_failed"); hash.update(bytes);
    }
    if (count.toString() !== expectedSize || hash.digest("hex") !== expectedHash) throw new SyncExtensionError("verification_failed");
  }
  async #execute(input: SyncMutationInput, namespace: SyncNamespacePolicy, credential: Credential): Promise<SyncMutationStatus> {
    return this.admission.run(input.rootId, async () => {
      let current = await this.#command("reserve", input, namespace, credential);
      if (current.status.state === "PUBLISHED") return current.status;
      if (current.status.state !== "PREPARED") throw new SyncExtensionError("operation_unknown");
      const claimToken = randomUUID();
      try { current = await this.#command("claim", input, namespace, credential, { claimToken }); }
      catch (error) {
        const accepted = await this.#command("status", input, namespace, credential).catch(() => undefined);
        if (accepted?.status.state === "PUBLISHED") return accepted.status;
        if (accepted?.claimToken === claimToken) await this.#command("unknown", input, namespace, credential, { claimToken }).catch(() => undefined);
        throw error;
      }
      if (current.claimToken !== claimToken || current.status.state !== "PHYSICAL_PENDING") throw new SyncExtensionError("operation_unknown");
      try {
        const e = current.execution;
        if (["create-empty", "clone-content"].includes(input.kind)) {
          if (!e.targetPath || await this.storage.exists(e.targetPath) || await this.storage.exists(e.tempPath)) throw new SyncExtensionError("backend_preimage_mismatch");
          await ensureStorageDirectory(this.storage,e.tempPath.slice(0,e.tempPath.lastIndexOf("/")));
          if (input.kind === "clone-content") {
            if (!e.sourcePath) throw new SyncExtensionError("projection_mismatch");
            const source=await this.storage.stat(e.sourcePath);
            if(source.type!=='file'||String(source.size)!==e.sizeBytes)throw new SyncExtensionError('backend_preimage_mismatch');
            // The destination must independently hash to the sealed content
            // reference. A second pre-copy full read proves nothing extra.
            await this.storage.copy(e.sourcePath, e.tempPath);
          } else await this.storage.write(e.tempPath, Readable.from(Buffer.alloc(0)), { offset: 0, create: true, exclusive: true, truncate: false });
          await this.#hash(e.tempPath, e.sizeBytes, e.sha256);
          await this.storage.rename(e.tempPath, e.targetPath);
        } else if (["move", "restore", "quarantine-delete"].includes(input.kind)) {
          if (!e.sourcePath || !e.targetPath || !e.before) throw new SyncExtensionError("projection_mismatch");
          const source = await this.storage.stat(e.sourcePath);
          if (source.type !== (e.before.type === "folder" ? "directory" : "file")) throw new SyncExtensionError("backend_preimage_mismatch");
          if (e.before.type === "file") await this.#hash(e.sourcePath, e.sizeBytes, e.sha256);
          // Case-only changes on case-insensitive backends need a private intermediate.
          if (e.sourcePath.toLowerCase() === e.targetPath.toLowerCase() && e.sourcePath !== e.targetPath) {
            if (await this.storage.exists(e.tempPath)) throw new SyncExtensionError("backend_preimage_mismatch");
            await ensureStorageDirectory(this.storage,e.tempPath.slice(0,e.tempPath.lastIndexOf('/')));
            await this.storage.rename(e.sourcePath, e.tempPath);
            await this.storage.rename(e.tempPath, e.targetPath);
          } else if (e.sourcePath !== e.targetPath) {
            if (await this.storage.exists(e.targetPath)) throw new SyncExtensionError("backend_preimage_mismatch");
            if (input.kind === "quarantine-delete") await ensureStorageDirectory(this.storage, e.targetPath.slice(0, e.targetPath.lastIndexOf("/")));
            await this.storage.rename(e.sourcePath, e.targetPath);
          }
        }
        return (await this.#command("commit", input, namespace, credential, { claimToken })).status;
      } catch {
        const accepted = await this.#command("status", input, namespace, credential).catch(() => undefined);
        if (accepted?.status.state === "PUBLISHED") return accepted.status;
        await this.#command("unknown", input, namespace, credential, { claimToken }).catch(() => undefined);
        throw new SyncExtensionError("reconciliation_required");
      }
    });
  }
  async lookup(rootId: string, epoch: string, bindingVersion: string, sizeBytes: string, sha256: string, proof: CatalogFolderAuthority): Promise<{ reference: SyncContentReference | null }> {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(sizeBytes) || BigInt(sizeBytes) > 1073741824n || !/^[a-f0-9]{64}$/.test(sha256)) throw new SyncExtensionError("invalid_input");
    const credential = this.#credential(proof, rootId);
    return this.writer.transaction(async sql => {
      await sql<Record<string, unknown>[]>`SET LOCAL statement_timeout='2s'`;
      const result = (await sql<{ value: { reference: SyncContentReference | null } }[]>`SELECT public.sync_namespace_command('lookup',${JSON.stringify({ input: { rootId, epoch, bindingVersion, sizeBytes, sha256, kind: "clone-content" } })}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,'{}'::jsonb) AS value`)[0]?.value;
      if (!result) throw new SyncExtensionError("projection_mismatch"); return result;
    }).catch((error: unknown)=>{if(error instanceof Error&&/^[a-z_]{1,64}$/.test(error.message))throw new SyncExtensionError(error.message);throw error;});
  }
}
