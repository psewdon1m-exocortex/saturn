import type { FastifyInstance } from "fastify";

export function registerRawBodyParsers(server: FastifyInstance): void {
  server.addContentTypeParser(
    ["application/offset+octet-stream", "application/octet-stream", "text/plain", "application/xml", "text/xml"],
    (_request, payload, done) => done(null, payload),
  );
}
