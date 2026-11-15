import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { encodeSyncJson, validateSyncSnapshotReady, type SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { guardedMetadataParser,syncRetryHint } from "./guarded-metadata-http.js";
import { SMALL_BATCH_MAX_MANIFEST_BYTES } from "../../../packages/contracts/src/sync-small-batch.js";
import type { SmallBatchRegistry } from "../../../packages/file-core/src/small-batch-registry.js";
import type { CatalogFolderAuthority } from "../../../packages/file-core/src/catalog-folder-authority.js";
import type { CatalogRootAdmission } from "../../../packages/file-core/src/catalog-root-admission.js";
import { SmallBatchPlanError } from "../../../packages/file-core/src/small-batch-plan.js";
import type { GuardedSyncUploadHttpRoot } from "./guarded-sync-upload-http.js";
import { SmallBatchExecutor } from "./sync-small-batch-executor.js";
import { SmallBatchPublicationBudget } from "./small-batch-publication-budget.js";
import {SmallExecutionJobExecutor} from './sync-small-execution-job-executor.js';

export interface GuardedSmallBatchRoot extends GuardedSyncUploadHttpRoot { readonly batches: SmallBatchRegistry; readonly admission?: CatalogRootAdmission }
export interface GuardedSmallBatchOptions {
  /** Trusted composition must separately qualify the new fixed SQL function.
   * This plugin does not change capabilities or select client batching. */
  readonly root: (rootId: string) => Promise<GuardedSmallBatchRoot | undefined>;
  readonly requestDeadlineMs?: number;
  readonly executionJobs?: boolean;
  readonly requests?: {active:number};
}
const bindingKeys = ["protocol", "descriptor_schema", "server_identity", "root_id", "server_epoch", "policy_version", "binding_version"] as const;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const statusInput = z.object({ binding: z.object({ protocol: z.literal("neptune-sync/1"), descriptor_schema: z.literal("saturn.current-namespace.v1"),
  server_identity: z.string(), root_id: z.string().regex(uuid), server_epoch: z.string().regex(uuid), policy_version: z.string(), binding_version: z.string().regex(uuid) }).strict(),
batch_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) }).strict();
function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AggregateError && error.errors.length) return fail(reply, error.errors[0]);
  const code = error instanceof z.ZodError ? "invalid_input" : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "sync_internal_error";
  const retry=syncRetryHint(code);
  if(retry)return reply.code(retry.status).header("Retry-After",String(retry.seconds)).header("Cache-Control","no-store").send({code,retry_after_ms:retry.seconds*1000});
  if(code==='unsupported_encoding')return reply.code(415).send({code});
  const status = ["FST_ERR_CTP_BODY_TOO_LARGE", "batch_limit", "page_limit"].includes(code) ? 413
    : ["authority_invalid", "unauthorized"].includes(code) ? 401 : ["authorization_changed", "forbidden"].includes(code) ? 403
      : ["invalid_input", "invalid_json", "invalid_contract", "invalid_batch", "incomplete_part", "hash_mismatch"].includes(code) ? 400
        : code === "batch_missing" ? 404 : code === "root_unavailable" ? 410 : code === "admission_full" ? 429
          : ["binding_invalid", "binding_mismatch", "operation_reused", "projection_mismatch"].includes(code) ? 409 : code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? 415 : 500;
  if (status === 429) reply.header("Retry-After", "1");
  return reply.code(status).header("Cache-Control", "no-store").send({ code: status === 500 ? "sync_internal_error" : code });
}
interface RequestLease {
  readonly signal: AbortSignal;
  running: boolean;
  context?: { readonly root: GuardedSmallBatchRoot; readonly proof: CatalogFolderAuthority };
  release(): void;
}

/** Inactive, separately composed bounded HTTP adapter. Admission precedes JSON
 * parsing; a finite deadline destroys stalled input and the handler joins any
 * already-started guarded operation before releasing its slot. */
export const guardedSyncSmallBatchHttp: FastifyPluginAsync<GuardedSmallBatchOptions> = (app, options) => {
  const deadline = options.requestDeadlineMs ?? 120000;
  if (!Number.isSafeInteger(deadline) || deadline < 25 || deadline > 300000) throw new SmallBatchPlanError();
  const leases = new Map<FastifyRequest, RequestLease>();
  const requests=options.requests??{active:0};
  // The guarded transfer executor and durable root admission both allow four
  // publications. Overlapping scaled requests must share that same ceiling;
  // eight here turns ordinary pipeline overlap into admission_full responses.
  const publications = new SmallBatchPublicationBudget(4), compatibleBudget=new SmallBatchPublicationBudget(4);
  const compatiblePublications={run:(action:()=>Promise<void>,signal?:AbortSignal)=>compatibleBudget.run(()=>publications.run(action,signal),signal)};
  // Older append-only roots have no per-root catalog command admission and
  // deliberately reject concurrent transactions. Keep that contract serial.
  const legacyPublications = new SmallBatchPublicationBudget(1);
  app.setErrorHandler((error, _request, reply) => fail(reply, error));
  app.addHook("onRequest", async (request, reply) => {
    if (requests.active >= 4) return fail(reply.header("Connection", "close"), new SmallBatchPlanError("admission_full"));
    requests.active++;
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Small batch request interrupted"));
    request.raw.once("aborted", abort);
    const timer = setTimeout(() => { abort(); request.raw.destroy(new Error("Small batch request deadline exceeded")); }, deadline);
    timer.unref();
    const lease: RequestLease = { signal: controller.signal, running: true, release: () => {
      clearTimeout(timer); request.raw.removeListener("aborted", abort); if(leases.delete(request))requests.active--;
    } };
    leases.set(request, lease);
    try {
      const rootId = (request.params as { rootId?: unknown }).rootId;
      if (typeof rootId !== "string" || !uuid.test(rootId)) throw new SmallBatchPlanError();
      const root = await options.root(rootId); if (!root) throw new SmallBatchPlanError("root_unavailable");
      const proof = await root.authority.device(request.headers.authorization, rootId);
      controller.signal.throwIfAborted();
      lease.context = { root, proof }; lease.running = false;
    } catch (error) {
      try {
        if (reply.raw.destroyed) { reply.hijack(); return; }
        return await fail(reply.header("Connection", "close"), error);
      } finally { request.raw.destroy(); lease.release(); }
    }
  });
  app.addHook("onError", request => { const lease = leases.get(request); if (lease && !lease.running) lease.release(); return Promise.resolve(); });
  app.addHook("onResponse", request => { leases.get(request)?.release(); return Promise.resolve(); });
  app.addHook("onRequestAbort", request => { const lease = leases.get(request); if (lease && !lease.running) lease.release(); return Promise.resolve(); });
  guardedMetadataParser(app,options.executionJobs?1048576:SMALL_BATCH_MAX_MANIFEST_BYTES,request=>Promise.resolve(leases.get(request)?.context?.root.extensions?.includes("metadata-gzip-v1")===true),options.executionJobs===true);
  app.addContentTypeParser("multipart/related", (_request, body, done) => { done(null, body); });
  const execute = async (request: FastifyRequest<{ Params: { rootId: string } }>, reply: FastifyReply, command: "prepare" | "status" | "data" | "execute") => {
    const lease = leases.get(request);
    if (!lease) return fail(reply, new SmallBatchPlanError("admission_full"));
    lease.running = true;
    let failedBody = false;
    try {
      lease.signal.throwIfAborted();
      if (!lease.context) throw new SmallBatchPlanError("authority_invalid");
      const { root, proof } = lease.context, executor = new SmallBatchExecutor(root.batches, root.files, root.binding, proof, root.admission ? root.extensions?.includes('scale-transfer-v2')?publications:compatiblePublications : legacyPublications);
      lease.signal.throwIfAborted();
      let result;
      if(options.executionJobs){
        if((command==='prepare'||command==='execute')&&!root.extensions?.includes('small-execution-job-v1'))throw new SmallBatchPlanError('batch_missing');
        const jobs=new SmallExecutionJobExecutor(root.files,root.binding,proof);
        if(command==='data'||command==='execute'){
          const body=request.body as Readable;
          result=await jobs.receive({[Symbol.asyncIterator]:()=>body.iterator({destroyOnReturn:false})},request.headers['content-type']??'',lease.signal,command==='execute');
        }else result=await jobs.metadata(request.body as Buffer,command);
      } else if (command === "data") {
        const body = request.body as Readable;
        result = await executor.receive({ [Symbol.asyncIterator]: () => body.iterator({ destroyOnReturn: false }) }, request.headers["content-type"] ?? "", lease.signal);
      } else if (command === "prepare") {
        const record = await root.batches.register(request.body, root.binding, proof);
        result = await executor.status(record, lease.signal);
      } else {
        const body = statusInput.parse(request.body), binding: SyncRootBinding = body.binding;
        validateSyncSnapshotReady({ ...binding, snapshot_id: randomUUID(), state: "READY", cut_seq: "0", entries_cursor: "validation", changes_cursor: "validation", lease_seconds: 1, absolute_lifetime_seconds: 1 });
        if (bindingKeys.some(key => binding[key] !== root.binding[key])) throw new SmallBatchPlanError("binding_mismatch");
        const record = await root.batches.status(body.batch_id, root.binding, proof);
        if (!record) throw new SmallBatchPlanError("batch_missing");
        result = await executor.status(record, lease.signal);
      }
      const encoded = encodeSyncJson(result);
      if (encoded.byteLength > SMALL_BATCH_MAX_MANIFEST_BYTES) throw new SmallBatchPlanError("page_limit");
      return await reply.code(command === "status" ? 200 : 202).header("Cache-Control", "no-store").header("Content-Type", "application/json").send(Buffer.from(encoded));
    } catch (error) {
      failedBody = true;
      if (reply.raw.destroyed) { reply.hijack(); return; }
      return await fail(reply.header("Connection", "close"), error);
    } finally {
      if (failedBody || !request.raw.complete) request.raw.destroy();
      lease.release();
    }
  };
  for (const command of ["prepare", "status", "data"] as const) app.post<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/"+(options.executionJobs?'small-jobs/':'small-batches/') + command, (request, reply) => execute(request, reply, command));
  if(options.executionJobs)app.post<{Params:{rootId:string}}>('/sync/v1/roots/:rootId/small-jobs/execute',(request,reply)=>execute(request,reply,'execute'));
  return Promise.resolve();
};
