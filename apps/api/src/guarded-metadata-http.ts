import { createGunzip,gzip } from "node:zlib";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseSyncJson } from "../../../packages/contracts/src/sync-protocol.js";

class MetadataHttpError extends Error { constructor(readonly code: string) { super(code); } }
let inflating = 0;
let compressing=0;
const gzipAsync=promisify(gzip);
/** Both encoded and decoded bytes are bounded. File frames never pass here. */
export function guardedMetadataParser(app: FastifyInstance, maximumBytes: number,
  enabled: (request: FastifyRequest) => Promise<boolean> = () => Promise.resolve(false), exactBytes=false): void {
  app.addHook('onRequest',request=>{
    if(request.headers['content-encoding']&&request.headers['content-encoding']!=='identity'&&!request.headers['content-type']?.startsWith('application/json'))throw new MetadataHttpError('unsupported_encoding');
    return Promise.resolve();
  });
  app.addHook("onSend",async(request,reply,payload)=>{
    if(reply.statusCode>=400||reply.getHeader("content-encoding")||!String(reply.getHeader("content-type")??"").startsWith("application/json")
      ||!(typeof payload==='string'||Buffer.isBuffer(payload))||compressing>=4)return payload;
    const bytes=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
    if(bytes.length<=16384||bytes.length>4*1024*1024||!request.headers['accept-encoding']?.split(',').some(token=>/^\s*gzip\s*(?:;\s*q=(?!0(?:\.0*)?(?:\s|$))\d(?:\.\d+)?)?\s*$/.test(token))||!await enabled(request))return payload;
    compressing++;
    try{const zipped=await gzipAsync(bytes);if(zipped.length>=bytes.length)return payload;reply.header('Content-Encoding','gzip').header('Vary','Accept-Encoding').removeHeader('Content-Length');return zipped;}finally{compressing--;}
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: maximumBytes }, (request, body, done) => {
    void (async () => {
      const encoding = request.headers["content-encoding"];
      const bytes = body as Buffer;
      if (encoding === undefined || encoding === "identity") return exactBytes?bytes:parseSyncJson(bytes, maximumBytes);
      if (encoding !== "gzip" || !await enabled(request)) throw new MetadataHttpError("unsupported_encoding");
      if (inflating >= 4) throw new MetadataHttpError("admission_full");
      inflating++;
      const parts: Buffer[] = []; let length = 0;
      try {
        await pipeline(Readable.from(bytes), createGunzip(), async source => {
          for await (const chunk of source) {
            const part = Buffer.from(chunk as Uint8Array); length += part.length;
            if (length > maximumBytes) throw new MetadataHttpError("page_limit");
            parts.push(part);
          }
        });
        const decoded=Buffer.concat(parts,length);
        return exactBytes?decoded:parseSyncJson(decoded, maximumBytes);
      } catch (error) {
        if (error instanceof MetadataHttpError || error && typeof error === "object" && "code" in error && ["invalid_contract","page_limit"].includes(String(error.code))) throw error;
        throw new MetadataHttpError("invalid_json");
      } finally { inflating--; }
    })().then(value => done(null, value), (error: unknown) => done(error as Error));
  });
}

/** Cons(error: unknown)t retry hints; callers retain original immutable operation IDs. */
export function syncRetryHint(code: string): { status: number; seconds: number } | undefined {
  return ["admission_full", "capacity"].includes(code) ? { status: 429, seconds: 1 }
    : ["backend_busy", "backend_draining"].includes(code) ? { status: 503, seconds: 2 } : undefined;
}
