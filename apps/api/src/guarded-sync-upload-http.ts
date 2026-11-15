import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { guardedMetadataParser, syncRetryHint } from "./guarded-metadata-http.js";
import { encodeSyncJson, parseSyncJson, validateSyncSnapshotReady, type SyncRootBinding } from "../../../packages/contracts/src/sync-protocol.js";
import { parseCatalogUploadPrepareInput, type CatalogUploadPrepareInput } from "../../../packages/file-core/src/catalog-upload-intent.js";
import type { CatalogFolderAuthorityIssuer } from "../../../packages/file-core/src/catalog-folder-authority.js";
import type { FileService } from "../../../packages/file-core/src/file.service.js";

export const GUARDED_UPLOAD_METADATA_BYTES = 40 * 1024;
export const GUARDED_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
export const GUARDED_UPLOAD_FRAME_TYPE = "application/vnd.saturn.sync-upload.v1";
const uuid = z.string().regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/);
const bindingKeys = ["protocol", "descriptor_schema", "server_identity", "root_id", "server_epoch", "policy_version", "binding_version"] as const;
const bindingSchema = z.object({ protocol: z.literal("neptune-sync/1"), descriptor_schema: z.literal("saturn.current-namespace.v1"),
  server_identity: z.string(), root_id: uuid, server_epoch: uuid, policy_version: z.string(), binding_version: uuid }).strict();
const baseBody = z.object({ binding: bindingSchema, input: z.unknown(), upload_id: uuid }).strict();
const prepareBody = baseBody.extend({ upload_id: uuid.optional() }).strict();
const appendBody = baseBody.extend({ offset: z.string().regex(/^(0|[1-9]\d{0,18})$/) }).strict();
class GuardedUploadHttpError extends Error { constructor(readonly code: string) { super(code); } }
export interface GuardedSyncUploadHttpRoot {
  readonly binding: SyncRootBinding;
  readonly authority: CatalogFolderAuthorityIssuer;
  readonly files: FileService;
  readonly extensions?: readonly string[];
}
export interface GuardedSyncUploadHttpOptions { readonly root: (rootId: string) => Promise<GuardedSyncUploadHttpRoot | undefined> }
function fail(reply: FastifyReply, error: unknown): FastifyReply {
  const code = error instanceof z.ZodError ? "invalid_input" : typeof error === "object" && error !== null && "code" in error ? String(error.code) : "sync_internal_error";
  const retry = syncRetryHint(code);
  if (retry) return reply.code(retry.status).header("Retry-After", String(retry.seconds)).header("Cache-Control", "no-store").send({ code, retry_after_ms: retry.seconds * 1000 });
  if (code === "unsupported_encoding") return reply.code(415).send({ code });
  const status = ["FST_ERR_CTP_BODY_TOO_LARGE", "upload_too_large"].includes(code) ? 413 : code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? 415
    : ["authority_invalid", "unauthorized"].includes(code) ? 401 : ["authorization_changed", "forbidden"].includes(code) ? 403
      : ["invalid_input", "invalid_json", "invalid_contract", "page_limit"].includes(code) ? 400
        : code === "root_unavailable" ? 410 : ["admission_full", "capacity"].includes(code) ? 429
          : ["binding_mismatch", "binding_invalid", "operation_reused", "membership_changed", "precondition_failed", "conflict", "reconciliation_required", "transfer_unresolved", "verification_failed", "projection_mismatch", "counter_exhausted"].includes(code) ? 409 : 500;
  return reply.code(status).header("Cache-Control", "no-store").send({ code: status === 500 ? "sync_internal_error" : code });
}
function modernInput(value: unknown, rootId: string): CatalogUploadPrepareInput {
  let input: CatalogUploadPrepareInput;
  try { input = parseCatalogUploadPrepareInput(value); } catch { throw new GuardedUploadHttpError("invalid_input"); }
  // Legacy routes/receipt/hash bytes are unchanged. This explicit modern wire
  // always requires the separately sealed topology and metadata CAS contract.
  if (input.intent.schema !== "saturn.upload-intent.v2" || input.intent.rootId !== rootId) throw new GuardedUploadHttpError("invalid_input");
  return input;
}
/** Fixed 4-byte unsigned BE metadata length, bounded strict UTF-8 JSON, then
 * raw data. Long ancestry proof never enters HTTP headers; decimal offsets are
 * not converted to Number. No encoded/base64 copy of file bytes is needed. */
export function readGuardedUploadFrame(raw: Buffer): { metadata: z.infer<typeof appendBody>; bytes: Buffer } {
  if (!Buffer.isBuffer(raw) || raw.length < 5 || raw.length > 4 + GUARDED_UPLOAD_METADATA_BYTES + GUARDED_UPLOAD_CHUNK_BYTES) throw new GuardedUploadHttpError("invalid_input");
  const length = raw.readUInt32BE(0), dataLength = raw.length - 4 - length;
  if (length < 1 || length > GUARDED_UPLOAD_METADATA_BYTES || dataLength < 1 || dataLength > GUARDED_UPLOAD_CHUNK_BYTES) throw new GuardedUploadHttpError("invalid_input");
  const metadata = appendBody.parse(parseSyncJson(raw.subarray(4, 4 + length), GUARDED_UPLOAD_METADATA_BYTES));
  if (BigInt(metadata.offset) > 9223372036854775807n) throw new GuardedUploadHttpError("invalid_input");
  return { metadata, bytes: raw.subarray(4 + length) };
}
/** Inactive encapsulated adapter. Trusted composition must separately qualify
 * SQL roles/functions, drain/fence old physical executors and enroll this root.
 * No WeakMap handle is exported/cached across requests: each call restores its
 * original sealed operation from SQL and obtains a fresh private device proof.
 * Historical outcomes may retain old input binding; outer binding is current. */
export const guardedSyncUploadHttp: FastifyPluginAsync<GuardedSyncUploadHttpOptions> = (app, options) => {
  app.setErrorHandler((error, _request, reply) => fail(reply, error));
  guardedMetadataParser(app, GUARDED_UPLOAD_METADATA_BYTES, async request => (await options.root((request.params as { rootId: string }).rootId))?.extensions?.includes("metadata-gzip-v1") === true);
  app.addContentTypeParser(GUARDED_UPLOAD_FRAME_TYPE, { parseAs: "buffer", bodyLimit: 4 + GUARDED_UPLOAD_METADATA_BYTES + GUARDED_UPLOAD_CHUNK_BYTES }, (_request, body, done) => done(null, body));
  const restore = async (rootId: string, binding: SyncRootBinding, inputValue: unknown, authorization: string | undefined, uploadId?: string) => {
    uuid.parse(rootId);
    const root = await options.root(rootId);
    if (!root) throw new GuardedUploadHttpError("root_unavailable");
    validateSyncSnapshotReady({ ...binding, snapshot_id: randomUUID(), state: "READY", cut_seq: "0", entries_cursor: "validation", changes_cursor: "validation", lease_seconds: 1, absolute_lifetime_seconds: 1 });
    if (bindingKeys.some(key => binding[key] !== root.binding[key])) throw new GuardedUploadHttpError("binding_mismatch");
    const proof = await root.authority.device(authorization, rootId), input = modernInput(inputValue, rootId);
    const prepared = await root.files.prepareCatalogUpload(input, proof, uploadId);
    return { root, proof, prepared };
  };
  for (const command of ["prepare", "inspect", "complete"] as const) {
    app.post<{ Params: { rootId: string } }>(`/sync/v1/roots/:rootId/catalog-uploads/${command}`, async (request, reply) => {
      try {
        const body = command === "prepare" ? prepareBody.parse(request.body) : baseBody.parse(request.body);
        const { root, proof, prepared } = await restore(request.params.rootId, body.binding, body.input, request.headers.authorization, body.upload_id);
        const current = command === "complete" ? await root.files.completeCatalogUpload(prepared, proof) : command === "inspect" ? await root.files.inspectCatalogUpload(prepared, proof) : prepared;
        return await reply.header("Content-Type", "application/json").header("Cache-Control", "no-store").send(Buffer.from(encodeSyncJson(current.status)));
      } catch (error) { return fail(reply, error); }
    });
  }
  app.patch<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/catalog-uploads/append", async (request, reply) => {
    try {
      const { metadata, bytes } = readGuardedUploadFrame(request.body as Buffer);
      const { root, proof, prepared } = await restore(request.params.rootId, metadata.binding, metadata.input, request.headers.authorization, metadata.upload_id);
      const current = await root.files.appendCatalogUpload(prepared, proof, metadata.offset, bytes);
      return await reply.header("Content-Type", "application/json").header("Cache-Control", "no-store").send(Buffer.from(encodeSyncJson(current.status)));
    } catch (error) { return fail(reply, error); }
  });
  return Promise.resolve();
};
