import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { guardedMetadataParser, syncRetryHint } from "./guarded-metadata-http.js";
import { encodeSyncJson, validateSyncSnapshotReady, type SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import type { CatalogFolderAuthority, CatalogFolderAuthorityIssuer } from "../../../packages/file-core/src/catalog-folder-authority.js";
import type { CatalogFolderOutcome, CatalogFolderRequest } from "../../../packages/file-core/src/catalog-folder-intent.js";
import type { PostgresSyncSnapshotStage } from "../../../packages/sync/src/sync-snapshot-stage.js";
import type { PostgresSyncSnapshotReader } from "../../../packages/sync/src/sync-snapshot-read.js";
import { SyncCursorError } from "../../../packages/sync/src/sync-cursor.js";
import type { CatalogRootAdmission } from "../../../packages/file-core/src/catalog-root-admission.js";
import type { CatalogStreamUpload } from "../../../packages/file-core/src/catalog-stream-upload.js";

const bindingKeys = ["protocol", "descriptor_schema", "server_identity", "root_id", "server_epoch", "policy_version", "binding_version"] as const;
const bindingSchema = z.object({
  protocol: z.literal("neptune-sync/1"), descriptor_schema: z.literal("saturn.current-namespace.v1"),
  server_identity: z.string(), root_id: z.string(), server_epoch: z.string(), policy_version: z.string(), binding_version: z.string(),
}).strict();
const uuid = z.string().regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
const snapshotBody = z.object({ binding: bindingSchema, snapshot_id: uuid }).strict();
const cursorBody = z.object({ binding: bindingSchema, cursor: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/) }).strict();
const changesBody = cursorBody.extend({ wait_ms: z.number().int().min(0).max(25000).optional() }).strict();
const folderBody = z.object({ binding: bindingSchema, operation_id: uuid,
  idempotency_key: z.string().regex(/^[A-Za-z\d._:-]{8,128}$/), parent_id: uuid,
  name: z.string().min(1).max(255), mode: z.enum(["create", "ensure"]),
}).strict();

/** Trusted composition only: the scope and private proof issuer never come
 * from request JSON. The provider must refuse unenrolled/unqualified roots. */
export interface GuardedSyncHttpRoot {
  readonly binding: SyncRootBinding;
  readonly authority: CatalogFolderAuthorityIssuer;
  readonly stage: PostgresSyncSnapshotStage;
  readonly reader: PostgresSyncSnapshotReader;
  /** The same bounded FIFO used by this runtime's public writers. SQL still
   * refuses unresolved/foreign writers; a local queue never grants authority. */
  readonly admission?: CatalogRootAdmission;
  /** Liveness changes only a refused read's retry classification. It never
   * grants namespace authority or bypasses the SQL read guard. */
  readonly streams?: Pick<CatalogStreamUpload, "hasPendingCompletion">;
  readonly extensions?: readonly string[];
  readonly ensureFolder: (request: CatalogFolderRequest, proof: CatalogFolderAuthority) => Promise<CatalogFolderOutcome>;
}
export interface GuardedSyncHttpOptions {
  readonly root: (rootId: string) => Promise<GuardedSyncHttpRoot | undefined>;
}
class GuardedSyncHttpRequestError extends Error {
  constructor(readonly code: "invalid_input" | "binding_mismatch" | "root_unavailable") { super(code); }
}
function failure(reply: FastifyReply, error: unknown): FastifyReply {
  const candidate = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  // A stage can remain leased while its original signed cursor has expired.
  // Preserve the typed cursor failure so clients can qualify a new read.
  const code = error instanceof z.ZodError ? "invalid_input"
    : error instanceof SyncCursorError && error.code === "expired" ? "cursor_expired" : candidate;
  const retry = syncRetryHint(code ?? "");
  if (retry) return reply.code(retry.status).header("Retry-After", String(retry.seconds)).header("Cache-Control", "no-store").send({ code, retry_after_ms: retry.seconds * 1000 });
  if (code === "unsupported_encoding") return reply.code(415).send({ code });
  const status = code === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413 : code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? 415
    : ["authority_invalid", "unauthorized"].includes(code ?? "") ? 401 : ["authorization_changed", "forbidden"].includes(code ?? "") ? 403
    : ["invalid_input", "invalid_json", "invalid_contract", "page_limit", "invalid_cursor"].includes(code ?? "") ? 400
      : ["root_unavailable", "stage_unavailable", "cursor_expired"].includes(code ?? "") ? 410
        : ["admission_full", "capacity"].includes(code ?? "") ? 429
          : ["binding_mismatch", "binding_invalid", "operation_reused", "membership_changed", "conflict", "reconciliation_required", "journal_gap", "projection_unqualified", "projection_mismatch", "counter_exhausted"].includes(code ?? "") ? 409 : 500;
  return reply.code(status).header("Cache-Control", "no-store").send({ code: status === 500 ? "sync_internal_error" : code });
}
function assertBinding(actual: SyncRootBinding, expected: SyncRootBinding): void {
  // Use the shared validator as well as exact equality. A syntactically valid
  // object alone is never enrollment or a current namespace authority.
  validateSyncSnapshotReady({ ...expected, snapshot_id: randomUUID(), state: "READY", cut_seq: "0", entries_cursor: "validation", changes_cursor: "validation", lease_seconds: 1, absolute_lifetime_seconds: 1 });
  if (bindingKeys.some(key => expected[key] !== actual[key])) throw new GuardedSyncHttpRequestError("binding_mismatch");
}

/** Explicit, inactive application adapter; not registered by the normal API
 * bootstrap or capabilities. All bodies are bounded raw bytes before JSON
 * parsing (duplicates/invalid UTF-8/depth rejected). Every call obtains a fresh
 * private proof and SQL rechecks current permissions/guard/lease. Sessions and
 * operation UUIDs are durable; no unbounded process-local handle map is used. */
export const guardedSyncHttp: FastifyPluginAsync<GuardedSyncHttpOptions> = (app, options) => {
  app.setErrorHandler((error, _request, reply) => failure(reply, error));
  guardedMetadataParser(app, 16 * 1024, async request => (await options.root((request.params as { rootId: string }).rootId))?.extensions?.includes("metadata-gzip-v1") === true);
  let waiting = 0;
  const scope = async (rootId: string, binding: SyncRootBinding, authorization: string | undefined) => {
    uuid.parse(rootId);
    const root = await options.root(rootId);
    if (!root) throw new GuardedSyncHttpRequestError("root_unavailable");
    assertBinding(root.binding, binding);
    return { root, proof: await root.authority.device(authorization, rootId) };
  };
  const read = async <T>(request: FastifyRequest, reply: FastifyReply, binding: SyncRootBinding,
    action: (current: Awaited<ReturnType<typeof scope>>) => Promise<T>): Promise<T> => {
    const rootId = (request.params as { rootId: string }).rootId;
    const initial = await scope(rootId, binding, request.headers.authorization);
    const admission = initial.root.admission;
    const runAction = async (current: Awaited<ReturnType<typeof scope>>): Promise<T> => {
      const publicationWasPending = current.root.streams?.hasPendingCompletion === true;
      try { return await action(current); }
      catch (error) {
        // The transaction still refuses the read. Retain the retry hint if
        // publication finishes while that refusal is being delivered.
        if (error instanceof Error && "code" in error && error.code === "reconciliation_required"
          && (publicationWasPending || current.root.streams?.hasPendingCompletion))
          throw Object.assign(new Error("publication_pending"), { code: "publication_pending" });
        throw error;
      }
    };
    if (!admission) return runAction(initial);
    const abort = new AbortController(), stop = () => abort.abort();
    request.raw.once("aborted", stop); reply.raw.once("close", stop);
    if (request.raw.destroyed && !request.raw.complete || reply.raw.destroyed) stop();
    try {
      return await admission.run(rootId, async () => {
        // A caller may have waited behind a publication. Recheck both private
        // authority and current composition after waiting, before any SQL read.
        const current = await scope(rootId, binding, request.headers.authorization);
        if (current.root.admission !== admission) throw new GuardedSyncHttpRequestError("root_unavailable");
        return runAction(current);
      }, abort.signal);
    } finally { request.raw.removeListener("aborted", stop); reply.raw.removeListener("close", stop); }
  };
  app.post<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/snapshots/start", async (request, reply) => {
    try {
      const body = snapshotBody.parse(request.body);
      return await reply.header("Cache-Control", "no-store").send(await read(request, reply, body.binding, ({root,proof}) => root.stage.start(proof, body.snapshot_id)));
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/snapshots/step", async (request, reply) => {
    try {
      const body = snapshotBody.parse(request.body);
      return await reply.header("Cache-Control", "no-store").send(await read(request, reply, body.binding, ({root,proof}) => root.stage.step(body.snapshot_id, proof)));
    } catch (error) { return failure(reply, error); }
  });
  app.post<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/snapshots/ready", async (request, reply) => {
    try {
      const body = snapshotBody.parse(request.body);
      return await reply.header("Content-Type", "application/json").header("Cache-Control", "no-store").send(Buffer.from(encodeSyncJson(await read(request, reply, body.binding, ({root,proof}) => root.reader.ready(body.snapshot_id, proof)))));
    } catch (error) { return failure(reply, error); }
  });
  for (const kind of ["entries", "changes"] as const) {
    app.post<{ Params: { rootId: string } }>(`/sync/v1/roots/:rootId/${kind}`, async (request, reply) => {
      try {
        const body = (kind === "changes" ? changesBody : cursorBody).parse(request.body), { root } = await scope(request.params.rootId, body.binding, request.headers.authorization);
        const waitMs = kind === "changes" && "wait_ms" in body ? Number(body.wait_ms ?? 0) : 0;
        if (waitMs && root.extensions?.includes("changes-wait-v1")) {
          if (waiting >= 64) throw Object.assign(new Error("admission_full"), { code: "admission_full" });
          waiting++;
          const abort = new AbortController(), stop = () => abort.abort(), deadline = Date.now() + waitMs;
          request.raw.once("aborted", stop); reply.raw.once("close", stop);
          try {
            // Queue only each bounded SQL observation, never the long-poll sleep.
            while (!abort.signal.aborted && Date.now() < deadline && !await read(request, reply, body.binding, ({root,proof}) => root.reader.changesAvailable(body.cursor,proof))) {
              await delay(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal: abort.signal });
            }
          } finally { waiting--; request.raw.removeListener("aborted", stop); reply.raw.removeListener("close", stop); }
        }
        const bytes = await read(request, reply, body.binding, ({root,proof}) => root.reader[kind](body.cursor, proof));
        return await reply.header("Content-Type", "application/json").header("Cache-Control", "no-store").send(Buffer.from(bytes));
      } catch (error) { return failure(reply, error); }
    });
  }
  app.post<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/directories/ensure", async (request, reply) => {
    try {
      const body = folderBody.parse(request.body), { root, proof } = await scope(request.params.rootId, body.binding, request.headers.authorization);
      const operation: CatalogFolderRequest = { operationId: body.operation_id, idempotencyKey: body.idempotency_key, rootId: root.binding.root_id,
        epoch: root.binding.server_epoch, bindingVersion: root.binding.binding_version, parentId: body.parent_id, name: body.name, mode: body.mode };
      return await reply.header("Cache-Control", "no-store").send(await root.ensureFolder(operation, proof));
    } catch (error) { return failure(reply, error); }
  });
  return Promise.resolve();
};
