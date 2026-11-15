import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { encodeSyncJson, validateSyncSnapshotReady, type SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { guardedMetadataParser, syncRetryHint } from "./guarded-metadata-http.js";
import { parseCatalogFolderBatch, executeCatalogFolderBatch } from "../../../packages/file-core/src/catalog-folder-batch.js";
import { parseCatalogFolderRequestV2 } from "../../../packages/file-core/src/catalog-folder-v2-intent.js";
import type { CatalogFolderAuthorityIssuer } from "../../../packages/file-core/src/catalog-folder-authority.js";
import type { FileService } from "../../../packages/file-core/src/file.service.js";

const uuid = z.string().regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
const bindingKeys = ["protocol", "descriptor_schema", "server_identity", "root_id", "server_epoch", "policy_version", "binding_version"] as const;
const bindingSchema = z.object({ protocol: z.literal("neptune-sync/1"), descriptor_schema: z.literal("saturn.current-namespace.v1"),
  server_identity: z.string(), root_id: uuid, server_epoch: uuid, policy_version: z.string(), binding_version: uuid }).strict();
const bodySchema = z.object({ binding: bindingSchema, input: z.unknown() }).strict();
class GuardedFolderHttpError extends Error { constructor(readonly code: string) { super(code); } }
export interface GuardedSyncFolderHttpRoot {
  readonly binding: SyncRootBinding;
  readonly authority: CatalogFolderAuthorityIssuer;
  readonly files: Pick<FileService, "ensureCatalogFolderV2">;
  readonly extensions?: readonly string[];
}
export interface GuardedSyncFolderHttpOptions { readonly root: (rootId: string) => Promise<GuardedSyncFolderHttpRoot | undefined> }
function fail(reply: FastifyReply, error: unknown): FastifyReply {
  const code = error instanceof z.ZodError ? "invalid_input" : typeof error === "object" && error !== null && "code" in error ? String(error.code) : "sync_internal_error";
  const retry = syncRetryHint(code);
  if (retry) return reply.code(retry.status).header("Retry-After", String(retry.seconds)).header("Cache-Control", "no-store").send({ code, retry_after_ms: retry.seconds * 1000 });
  if (code === "unsupported_encoding") return reply.code(415).send({ code });
  const status = code === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413 : code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? 415
    : ["authority_invalid", "unauthorized"].includes(code) ? 401 : ["authorization_changed", "forbidden"].includes(code) ? 403
      : ["invalid_input", "invalid_json", "invalid_contract", "page_limit"].includes(code) ? 400
        : code === "root_unavailable" ? 410 : ["admission_full", "capacity"].includes(code) ? 429
          : ["binding_mismatch", "binding_invalid", "operation_reused", "membership_changed", "conflict", "reconciliation_required", "projection_mismatch", "counter_exhausted"].includes(code) ? 409 : 500;
  return reply.code(status).header("Cache-Control", "no-store").send({ code: status === 500 ? "sync_internal_error" : code });
}
/** Inactive trusted composition. Original input, including ancestry and its
 * binding, remains immutable on replay; the outer seven-field binding and
 * private device proof are current. SQL rechecks both before any new effect.
 * Only the public historical outcome is returned, never a physical claim. */
export const guardedSyncFolderHttp: FastifyPluginAsync<GuardedSyncFolderHttpOptions> = (app, options) => {
  app.setErrorHandler((error, _request, reply) => fail(reply, error));
  guardedMetadataParser(app, 4 * 1024 * 1024, async request => (await options.root((request.params as { rootId: string }).rootId))?.extensions?.includes("metadata-gzip-v1") === true);
  app.post<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/directories/ensure-v2", { bodyLimit: 40 * 1024 }, async (request, reply) => {
    try {
      const body = bodySchema.parse(request.body), rootId = uuid.parse(request.params.rootId);
      if (Buffer.byteLength(JSON.stringify(request.body)) > 40 * 1024) throw new GuardedFolderHttpError("page_limit");
      const root = await options.root(rootId);
      if (!root) throw new GuardedFolderHttpError("root_unavailable");
      validateSyncSnapshotReady({ ...body.binding, snapshot_id: randomUUID(), state: "READY", cut_seq: "0", entries_cursor: "validation", changes_cursor: "validation", lease_seconds: 1, absolute_lifetime_seconds: 1 });
      if (bindingKeys.some(key => root.binding[key] !== body.binding[key])) throw new GuardedFolderHttpError("binding_mismatch");
      const proof = await root.authority.device(request.headers.authorization, rootId);
      const input = parseCatalogFolderRequestV2(body.input);
      if (input.rootId !== rootId) throw new GuardedFolderHttpError("invalid_input");
      const outcome = await root.files.ensureCatalogFolderV2(input, proof);
      return await reply.header("Content-Type", "application/json").header("Cache-Control", "no-store").send(Buffer.from(encodeSyncJson(outcome)));
    } catch (error) { return fail(reply, error); }
  });
  app.post<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/directories/batch", async (request, reply) => {
    try {
      const body = z.object({ binding: bindingSchema, items: z.unknown() }).strict().parse(request.body), rootId = uuid.parse(request.params.rootId);
      const root = await options.root(rootId);
      if (!root?.extensions?.includes("folder-batch-v1")) return await reply.code(404).send({ code: "unsupported" });
      if (bindingKeys.some(key => root.binding[key] !== body.binding[key])) throw new GuardedFolderHttpError("binding_mismatch");
      const proof = await root.authority.device(request.headers.authorization, rootId), items = parseCatalogFolderBatch(body.items);
      if (items.some(item => item.input.rootId !== rootId || item.input.epoch !== body.binding.server_epoch || item.input.bindingVersion !== body.binding.binding_version)) throw new GuardedFolderHttpError("binding_mismatch");
      const results = await executeCatalogFolderBatch(items, input => root.files.ensureCatalogFolderV2(input, proof));
      return await reply.header("Content-Type", "application/json").header("Cache-Control", "no-store").send(Buffer.from(encodeSyncJson({ schema: "saturn.folder-batch-result.v1", items: results })));
    } catch (error) { return fail(reply, error); }
  });
  return Promise.resolve();
};
