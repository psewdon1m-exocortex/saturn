import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Database } from "@saturn/database";
import { ensureStorageDirectory,type StorageAdapter } from "@saturn/storage";
import type { SyncStreamPrepare, SyncStreamChunk, SyncStreamSeal, SyncStreamStatus } from "../../contracts/src/sync-stream.js";
import { SyncExtensionError } from "../../contracts/src/sync-extensions.js";
import { parseCatalogUploadPrepareInput, type CatalogUploadPrepareInput } from "./catalog-upload-intent.js";
import type { CatalogFolderAuthorityIssuer, CatalogFolderAuthority } from "./catalog-folder-authority.js";
import type { FileService } from "./file.service.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function parseStreamPrepare(value: unknown): SyncStreamPrepare {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncExtensionError("invalid_input");
  const input = value as Record<string, unknown>;
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new SyncExtensionError("invalid_input");
    return v as Record<string, unknown>;
  };
  const source = object(input.source), prepare = object(input.prepare), intent = object(prepare.intent);
  if (Object.keys(input).length !== 5 || !['saturn.stream-upload.v1','saturn.stream-upload.v2'].includes(String(input.schema)) || typeof input.operationId !== "string" || !uuid.test(input.operationId) || input.chunkBytes !== 4194304
    || Object.keys(source).length !== 2 || typeof source.generation !== "string" || !/^[\x21-\x7e]{1,128}$/.test(source.generation) || typeof source.witnessSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.witnessSha256)
    || intent.sha256 !== null || intent.schema !== "saturn.upload-intent.v2") throw new SyncExtensionError("invalid_input");
  parseCatalogUploadPrepareInput({ ...prepare, intent: { ...intent, sha256: "0".repeat(64) } });
  return input as unknown as SyncStreamPrepare;
}
interface Stored { status: SyncStreamStatus; sealedPrepare: CatalogUploadPrepareInput | null }
export class CatalogStreamUpload {
  #closing = false;
  #isClosing(): boolean { return this.#closing; }
  readonly #requests = new Set<Promise<SyncStreamStatus>>();
  readonly #completions = new Map<string, { done: boolean; result: Promise<{status: SyncStreamStatus} | {error: unknown}> }>();
  // A completion request can await seal/publication before a detached job exists.
  // Namespace retry classification must cover that request lifetime as well.
  get hasPendingCompletion(): boolean { return this.#requests.size > 0 || [...this.#completions.values()].some(task => !task.done); }
  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled([...this.#requests]);
    await Promise.all([...this.#completions.values()].map(task => task.result));
  }
  constructor(private readonly writer: Database, private readonly authority: CatalogFolderAuthorityIssuer,
    private readonly storage: StorageAdapter, private readonly files: FileService) {}
  async #command(command: string, input: SyncStreamPrepare, proof: CatalogFolderAuthority, payload: Record<string, unknown> = {}): Promise<Stored> {
    const credential = this.authority.deviceCredential(proof, input.prepare.intent.rootId);
    try {
      const result = await this.writer.transaction(async sql => {
        await sql`SET LOCAL lock_timeout='2s'`; await sql`SET LOCAL statement_timeout='2s'`;
        return (await sql<{ value: Stored }[]>`SELECT public.sync_stream_command(${command},${JSON.stringify(input)}::text::jsonb,${JSON.stringify(credential)}::text::jsonb,${JSON.stringify(payload)}::text::jsonb) AS value`)[0]?.value;
      });
      if (!result || result.status.operationId !== input.operationId || result.status.chunks.length > 256 || Buffer.byteLength(JSON.stringify(result)) > 262144) throw new SyncExtensionError("projection_mismatch");
      return result;
    } catch (error) { if (error instanceof Error && /^[a-z_]{1,64}$/.test(error.message)) throw new SyncExtensionError(error.message); throw error; }
  }
  async prepare(value: unknown, proof: CatalogFolderAuthority): Promise<SyncStreamStatus> { return (await this.#command("prepare", parseStreamPrepare(value), proof)).status; }
  async status(value: unknown, proof: CatalogFolderAuthority,afterIndex=-1): Promise<SyncStreamStatus> {
    const input=parseStreamPrepare(value);if(!Number.isInteger(afterIndex)||afterIndex< -1||afterIndex>2147483647||input.schema==='saturn.stream-upload.v1'&&afterIndex!==-1)throw new SyncExtensionError('invalid_input');
    return (await this.#command("status", input, proof,input.schema==='saturn.stream-upload.v2'?{afterIndex}:{})).status;
  }
  async append(value: unknown, chunk: SyncStreamChunk, bytes: Buffer, proof: CatalogFolderAuthority): Promise<SyncStreamStatus> {
    const input = parseStreamPrepare(value);
    if (!Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index > (input.schema==='saturn.stream-upload.v2'?2147483647:255) || chunk.offset !== String(chunk.index * 4194304)
      || chunk.length !== String(bytes.length) || bytes.length < 1 || bytes.length > 4194304 || createHash("sha256").update(bytes).digest("hex") !== chunk.sha256) throw new SyncExtensionError("invalid_input");
    const current = await this.#command("chunk", input, proof, { chunk });
    if (current.status.chunks.some(c=>c.index===chunk.index)) return current.status;
    const pending=input.schema==='saturn.stream-upload.v2'?current.status.pendingChunks?.find(c=>c.index===chunk.index):current.status.pendingChunk;
    if (!pending || Object.keys(chunk).some(k => pending[k as keyof SyncStreamChunk] !== chunk[k as keyof SyncStreamChunk])) throw new SyncExtensionError("transfer_unresolved");
    try {
      if(chunk.index===0)await ensureStorageDirectory(this.storage,'_system/incoming');
      const written = await this.storage.write(`_system/incoming/${input.operationId}.part`, Readable.from(bytes), { offset: Number(chunk.offset), create: chunk.index === 0, exclusive: chunk.index === 0, truncate: false });
      if (written !== bytes.length) throw new SyncExtensionError("transfer_unresolved");
      try { return (await this.#command("ack", input, proof, { chunk })).status; }
      catch { return (await this.#command("ack", input, proof, { chunk })).status; }
    } catch (error) { await this.#command("unknown", input, proof).catch(() => undefined); throw error; }
  }
  async seal(value: unknown, seal: SyncStreamSeal, proof: CatalogFolderAuthority): Promise<SyncStreamStatus> {
    const input = parseStreamPrepare(value);
    await this.#command("seal", input, proof, { ...seal });
    return this.complete(input, proof);
  }
  async complete(value: unknown, proof: CatalogFolderAuthority): Promise<SyncStreamStatus> {
    const input = parseStreamPrepare(value), current = await this.#command("publication", input, proof);
    if (current.status.state === "PUBLISHED") return current.status;
    if (!current.sealedPrepare) throw new SyncExtensionError("verification_failed");
    const prepared = await this.files.prepareCatalogUpload(parseCatalogUploadPrepareInput(current.sealedPrepare), proof, input.operationId);
    await this.files.completeCatalogUpload(prepared, proof);
    return (await this.#command("status", input, proof)).status;
  }
  /** HTTP completion has a short response budget, not a short publication
   * lifetime. The durable original owns all effects; retries only join its
   * current completion. Failure is retained until observed, never auto-retried. */
  completeWithin(value: unknown, proof: CatalogFolderAuthority, seal?: SyncStreamSeal, waitMs = 1000): Promise<SyncStreamStatus> {
    if (this.#closing) return Promise.reject(new SyncExtensionError('backend_draining'));
    const request = this.#completeWithin(value, proof, seal, waitMs);
    this.#requests.add(request);
    void request.then(() => this.#requests.delete(request), () => this.#requests.delete(request));
    return request;
  }
  async #completeWithin(value: unknown, proof: CatalogFolderAuthority, seal?: SyncStreamSeal, waitMs = 1000): Promise<SyncStreamStatus> {
    if (this.#isClosing()) throw new SyncExtensionError('backend_draining');
    const input = parseStreamPrepare(value);
    // Revalidate exact input/credential even when joining an existing task.
    if (seal) await this.#command('seal', input, proof, {...seal});
    const current = await this.#command('publication', input, proof);
    if (current.status.state === 'PUBLISHED') return current.status;
    if (!current.sealedPrepare) throw new SyncExtensionError('verification_failed');
    if (this.#isClosing()) throw new SyncExtensionError('backend_draining');
    let task = this.#completions.get(input.operationId);
    if (!task) {
      if (this.#completions.size >= 8) throw new SyncExtensionError('admission_full');
      task = {done: false, result: Promise.resolve({status: current.status})};
      const owned = task;
      owned.result = this.writer.withDetachedSharedMaintenance(() => this.complete(input, proof)).then(status => ({status}), (error: unknown) => ({error}))
        .then(result => { owned.done = true; if ('status' in result) this.#completions.delete(input.operationId); return result; });
      this.#completions.set(input.operationId, owned);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([task.result, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs); })]);
      if (result === null) return (await this.#command('status', input, proof)).status;
      this.#completions.delete(input.operationId);
      if ('error' in result) throw result.error;
      return result.status;
    } finally { if (timer) clearTimeout(timer); }
  }
}
