import {DeviceServiceError,ReaderRangeError,readerMetadata,resourceEtag,type DeviceService} from "@saturn/sync";
import type {FastifyInstance} from "fastify";

export function registerResourceReader(instance:FastifyInstance,devices:DeviceService,
  maintenance:<T>(action:()=>Promise<T>)=>Promise<T>=(action)=>action()):void{
  for(const operation of ["resources","resource-metadata","resource-content"] as const){
    instance.get("/api/v1/neptune-reader/"+operation,async(request,reply)=>maintenance(async()=>{
      reply.header("Cache-Control","no-store").header("X-Robots-Tag","noindex, nofollow, noarchive");
      try{
        const context=await devices.authenticate(request.headers.authorization);
        const query=request.query as {path?:unknown;cursor?:unknown;limit?:unknown};
        if(typeof query.path!=="string"||query.cursor!==undefined&&typeof query.cursor!=="string")throw new DeviceServiceError("invalid_path");
        if(operation==="resources")return await reply.send(await devices.readerPage(context,query.path,query.cursor,
          query.limit===undefined?100:Number(query.limit)));
        if(operation==="resource-metadata")return await reply.send(readerMetadata(await devices.readerResolve(context,query.path),query.path));
        const condition=request.headers["if-range"];
        if(condition!==undefined&&typeof condition!=="string")throw new DeviceServiceError("invalid_path");
        const opened=await devices.readerContent(context,query.path,request.headers.range,condition);
        const stop=()=>opened.stream.destroy();reply.raw.once("close",stop);
        opened.stream.once("end",()=>reply.raw.off("close",stop));
        reply.header("Content-Type",opened.resource.mimeType??"application/octet-stream").header("Content-Length",opened.length)
          .header("ETag",resourceEtag(opened.resource)).header("Accept-Ranges","bytes")
          .header("Last-Modified",opened.resource.updatedAt.toUTCString()).header("Content-Disposition","attachment");
        if(opened.partial)reply.status(206).header("Content-Range",`bytes ${String(opened.offset)}-${String(opened.offset+opened.length-1)}/${String(opened.resource.sizeBytes)}`);
        return await reply.send(opened.stream);
      }catch(error){
        if(error instanceof ReaderRangeError)return await reply.status(416).header("Content-Range",`bytes */${String(error.size)}`).send();
        const status=error instanceof DeviceServiceError?error.code==="unauthorized"?401:error.code==="forbidden"?403:error.code==="not_found"?404:422:503;
        return await reply.status(status).send({error:"resource_reader_unavailable"});
      }
    }));
  }
}
