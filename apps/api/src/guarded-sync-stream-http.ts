import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { encodeSyncJson, parseSyncJson } from "../../../packages/contracts/src/sync-protocol.js";
import { parseStreamPrepare } from "../../../packages/file-core/src/catalog-stream-upload.js";
import type { SyncStreamChunk, SyncStreamSeal } from "../../../packages/contracts/src/sync-stream.js";
import type { GuardedRuntimeScope } from "../../../packages/sync/src/guarded-runtime.js";
import { guardedMetadataParser, syncRetryHint } from "./guarded-metadata-http.js";

const envelope = z.object({ binding: z.object({ protocol: z.literal("neptune-sync/1"), descriptor_schema: z.literal("saturn.current-namespace.v1"), server_identity: z.string(), root_id: z.uuid(), server_epoch: z.uuid(), policy_version: z.string(), binding_version: z.uuid() }).strict(), input: z.unknown() }).strict();
const frameType = "application/vnd.saturn.sync-stream.v1";
function fail(reply: FastifyReply, error: unknown) {
  const code = error instanceof z.ZodError ? "invalid_input" : error && typeof error === "object" && "code" in error ? String(error.code) : "sync_internal_error";
  const retry = syncRetryHint(code);
  if (retry) return reply.code(retry.status).header("Retry-After", String(retry.seconds)).send({ code, retry_after_ms: retry.seconds * 1000 });
  const status = ["authority_invalid", "unauthorized"].includes(code) ? 401 : ["authorization_changed", "forbidden"].includes(code) ? 403 : code === "unsupported" ? 404
    : ["unsupported_encoding", "FST_ERR_CTP_INVALID_MEDIA_TYPE"].includes(code) ? 415 : code === "precondition_failed" ? 412
      : ["page_limit", "upload_too_large", "FST_ERR_CTP_BODY_TOO_LARGE"].includes(code) ? 413 : ["invalid_input", "invalid_json", "invalid_contract"].includes(code) ? 400
        : ["binding_invalid", "binding_mismatch", "operation_reused", "transfer_unresolved", "reconciliation_required", "verification_failed", "operation_unknown", "membership_changed"].includes(code) ? 409 : 500;
  return reply.code(status).header("Cache-Control", "no-store").send({ code: status === 500 ? "sync_internal_error" : code });
}
export const guardedSyncStreamHttp: FastifyPluginAsync<{ root: (id: string) => Promise<GuardedRuntimeScope | undefined> }> = (app, options) => {
  app.setErrorHandler((error, _request, reply) => fail(reply, error));
  guardedMetadataParser(app, 40 * 1024, async request => (await options.root((request.params as { rootId: string }).rootId))?.extensions?.includes("metadata-gzip-v1") === true);
  app.addContentTypeParser(frameType, { parseAs: "buffer", bodyLimit: 4 + 40 * 1024 + 4194304 }, (_request, bytes, done) => done(null, bytes));
  const resolve = async (rootId: string, body: z.infer<typeof envelope>, authorization: string | undefined) => {
    const root = await options.root(rootId), input = parseStreamPrepare(body.input);
    if (!root?.streams || !root.extensions?.includes("stream-upload-v1")) throw Object.assign(new Error("unsupported"), { code: "unsupported" });
    if(input.schema==='saturn.stream-upload.v2'&&!root.extensions.includes('scale-transfer-v2'))throw Object.assign(new Error('unsupported'),{code:'unsupported'});
    if (rootId !== input.prepare.intent.rootId || rootId !== body.binding.root_id || (Object.keys(body.binding) as (keyof typeof body.binding)[]).some(k => root.binding[k] !== body.binding[k])) throw Object.assign(new Error("binding_mismatch"), { code: "binding_mismatch" });
    return { input, streams: root.streams, proof: await root.authority.device(authorization, rootId) };
  };
  for (const command of ["prepare", "status", "seal", "complete"] as const) app.post<{ Params: { rootId: string } }>(`/sync/v1/roots/:rootId/stream-uploads/${command}`, async (request, reply) => {
    try {
      const body = (command === "seal" ? envelope.extend({ seal: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), sourceGeneration: z.string(), sourceWitnessSha256: z.string() }).strict() }) : command==='status'?envelope.extend({afterIndex:z.number().int().min(-1).max(2147483647).optional()}):envelope).parse(request.body);
      const { input, streams, proof } = await resolve(request.params.rootId, body, request.headers.authorization);
      const result = command === "seal" && "seal" in body ? await streams.completeWithin(input, proof, body.seal as SyncStreamSeal) : command==='complete'?await streams.completeWithin(input,proof):command==='status'?await streams.status(input,proof,'afterIndex' in body?body.afterIndex as number:undefined):await streams.prepare(input, proof);
      return await reply.header("Content-Type", "application/json").header("Cache-Control", "no-store").send(Buffer.from(encodeSyncJson(result)));
    } catch (error) { return fail(reply, error); }
  });
  app.patch<{ Params: { rootId: string } }>("/sync/v1/roots/:rootId/stream-uploads/chunk", async (request, reply) => {
    try {
      const bytes = request.body as Buffer;
      if (!Buffer.isBuffer(bytes) || bytes.length < 5) throw Object.assign(new Error("invalid_input"), { code: "invalid_input" });
      const length = bytes.readUInt32BE(0);
      if (length < 1 || length > 40 * 1024 || bytes.length <= length + 4) throw Object.assign(new Error("invalid_input"), { code: "invalid_input" });
      const body = envelope.extend({ chunk: z.object({ index: z.number().int().min(0).max(2147483647), offset: z.string(), length: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).parse(parseSyncJson(bytes.subarray(4, length + 4), 40 * 1024));
      const { input, streams, proof } = await resolve(request.params.rootId, body, request.headers.authorization);
      return await reply.header("Content-Type", "application/json").header("Cache-Control", "no-store").send(Buffer.from(encodeSyncJson(await streams.append(input, body.chunk as SyncStreamChunk, bytes.subarray(length + 4), proof))));
    } catch (error) { return fail(reply, error); }
  });
  return Promise.resolve();
};
