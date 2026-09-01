import "dotenv/config";
import "reflect-metadata";
import { Transform } from "node:stream";
import { fastifyCookie } from "@fastify/cookie";
import { RequestMethod } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { loadEnvironment } from "@saturn/config";
import type { FastifyPluginCallback, FastifyRequest } from "fastify";
import { AppModule } from "./app.module.js";
import type { DeviceService } from "@saturn/sync";
import { DEVICE_SERVICE } from "./tokens.js";
import { registerWebDav } from "./webdav.js";

const config = loadEnvironment();
const adapter = new FastifyAdapter({
  logger: config.logLevel === "silent" ? false : {
    level: config.logLevel,
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: request.url.replace(/(\/public\/shares\/|\/s\/)[A-Za-z0-9_-]{20,}/g, "$1[redacted]"),
          hostname: request.hostname,
          remoteAddress: request.ip,
        };
      },
    },
  },
  bodyLimit: config.limits.uploadChunkMaxBytes,
  trustProxy: config.environment === "production" ? 1 : false,
});
for (const method of ["PROPFIND", "MKCOL", "MOVE", "COPY"]) {
  adapter.getInstance().addHttpMethod(method);
}
await adapter.getInstance().register(fastifyCookie as unknown as FastifyPluginCallback);
adapter.getInstance().addContentTypeParser(
  ["application/offset+octet-stream", "application/octet-stream", "text/plain", "application/xml", "text/xml"],
  (request, payload, done) => {
    void request;
    done(null, payload);
  },
);
adapter.getInstance().addHook("preParsing", (request, _reply, payload, done) => {
  if (!request.url.startsWith("/internal/telegram/webhook")) { done(null, payload); return; }
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > config.telegram.webhookMaxBytes) {
        const error = Object.assign(new Error("Telegram webhook body exceeds its configured limit"), { statusCode: 413 });
        callback(error);
      } else callback(null, chunk);
    },
  });
  Object.defineProperty(limiter, "receivedEncodedLength", { get: () => received });
  payload.pipe(limiter);
  done(null, limiter);
});
const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });
app.enableShutdownHooks();
app.setGlobalPrefix("api/v1", { exclude: ["health/live", "health/ready", "internal/telegram/webhook", { path: "a/:assetId/:filename", method: RequestMethod.ALL }] });
registerWebDav(adapter.getInstance(), app.get<DeviceService>(DEVICE_SERVICE), config);
adapter.getInstance().addHook("onSend", (request, reply, payload, done) => {
  reply
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Robots-Tag", "noindex, nofollow, noarchive")
    .header("X-Frame-Options", request.url.includes("/preview") ? "SAMEORIGIN" : "DENY")
    .header("Content-Security-Policy", request.url.includes("/preview")
      ? "default-src 'none'; sandbox; frame-ancestors 'self'; base-uri 'none'"
      : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (request.url.startsWith("/api/v1/") || request.url.startsWith("/internal/telegram/")) reply.header("Cache-Control", "no-store");
  done(null, payload);
});
await app.listen(config.api.port, config.api.host);
