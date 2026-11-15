import { SYNC_METADATA_MAX_BYTES } from "@saturn/file-core";
import type { FastifyInstance } from "fastify";

/** Register before Nest routes: RouteConfig is config, not a Fastify bodyLimit. */
export function registerSyncMetadataLimits(server: FastifyInstance): void {
  server.addHook("onRoute", options => {
    if ((options.config as { syncMetadata?: boolean } | undefined)?.syncMetadata !== true) return;
    options.bodyLimit = SYNC_METADATA_MAX_BYTES;
    options.onRequest = [async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const encoding = request.headers["content-encoding"];
      if (encoding !== undefined && encoding !== "identity") {
        await reply.status(415).send({ code: "unsupported_content_encoding" });
      }
    }];
  });
}
