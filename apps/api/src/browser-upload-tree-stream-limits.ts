import type {FastifyInstance,FastifyRequest,FastifyReply} from "fastify";
import {BROWSER_TREE_STREAM_LIMITS} from "../../../packages/file-core/src/browser-upload-tree-stream-contract.js";

/** Register before Nest routes together with registerRawBodyParsers. Chunk
 * bodies remain paused Readables: the service acquires a lane before reading.
 * Fastify's ordinary JSON parser enforces the separate64KiB metadata bound. */
export function registerBrowserTreeStreamLimits(server:FastifyInstance):void{
 server.addHook("onRoute",options=>{
  const mode=(options.config as {browserTreeStream?:unknown}|undefined)?.browserTreeStream;
  if(mode!=="metadata"&&mode!=="chunk")return;
  options.bodyLimit=mode==="chunk"?BROWSER_TREE_STREAM_LIMITS.chunkBytes:BROWSER_TREE_STREAM_LIMITS.metadataBytes;
  const previous=options.onRequest;
  const check=async(request:FastifyRequest,reply:FastifyReply)=>{
   reply.header("Cache-Control","no-store");
   const encoding=request.headers["content-encoding"],type=request.headers["content-type"];
   if(encoding!==undefined&&encoding!=="identity")return reply.code(415).send({code:"unsupported_content_encoding"});
   if(mode==="chunk"&&type!=="application/offset+octet-stream"||mode==="metadata"&&request.method==="POST"&&(!type||!/^application\/json(?:\s*;.*)?$/i.test(type)))return reply.code(415).send({code:"unsupported_content_type"});
  };
  options.onRequest=[check,...(Array.isArray(previous)?previous:previous?[previous]:[])];
 });
}
