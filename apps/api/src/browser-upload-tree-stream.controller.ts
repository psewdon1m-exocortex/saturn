import {Body,Controller,Delete,Get,HttpCode,Inject,Param,Patch,Post,Req,Res,ServiceUnavailableException,UnauthorizedException,UseFilters,UseGuards} from "@nestjs/common";
import {RouteConfig} from "@nestjs/platform-fastify";
import type {FastifyReply,FastifyRequest} from "fastify";
import {BROWSER_TREE_STREAM_HTTP_SERVICE,BrowserTreeStreamHttpService,browserTreeStreamUnavailable} from "./browser-upload-tree-stream.service.js";
import {BrowserTreeApiExceptionFilter,withBrowserTreeRequest} from "./browser-upload-tree.controller.js";
import {OWNER_SESSION,OwnerTokenGuard,type AuthenticatedOwnerRequest} from "./owner-token.guard.js";
import {DROP_SESSION,DropSessionGuard,type AuthenticatedDropRequest} from "./drop-session.guard.js";

function requireService(service:BrowserTreeStreamHttpService|null):BrowserTreeStreamHttpService{
 if(!service)throw new ServiceUnavailableException({code:"browser_tree_stream_unavailable"});return service;
}
function chunkHeaders(request:FastifyRequest){return {contentType:request.headers["content-type"],contentEncoding:request.headers["content-encoding"],contentLength:request.headers["content-length"],offset:request.headers["upload-offset"],sha256:request.headers["x-saturn-chunk-sha256"]};}

@Controller("upload-trees")
@UseGuards(OwnerTokenGuard)
@UseFilters(BrowserTreeApiExceptionFilter)
export class OwnerBrowserTreeStreamController{
 constructor(@Inject(BROWSER_TREE_STREAM_HTTP_SERVICE) private readonly service:BrowserTreeStreamHttpService|null){}
 @Get("stream-capabilities") @RouteConfig({browserTreeStream:"metadata"})
 capability(@Req() request:AuthenticatedOwnerRequest){if(!request[OWNER_SESSION])throw new UnauthorizedException();return this.service?.capability()??browserTreeStreamUnavailable;}
 @Post(":rootId/:treeId/stream-jobs") @HttpCode(200) @RouteConfig({browserTreeStream:"metadata"})
 async admit(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Body() body:unknown,@Req() request:AuthenticatedOwnerRequest){
  const service=requireService(this.service);return service.admit(await service.owner(request,rootId),treeId,body);
 }
 @Get(":rootId/:treeId/stream-jobs/:jobId") @RouteConfig({browserTreeStream:"metadata"})
 async inspect(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Req() request:AuthenticatedOwnerRequest){
  const service=requireService(this.service);return service.inspect(await service.owner(request,rootId),treeId,jobId);
 }
 @Patch(":rootId/:treeId/stream-jobs/:jobId/chunks") @HttpCode(200) @RouteConfig({browserTreeStream:"chunk"})
 async append(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Body() body:unknown,@Req() request:AuthenticatedOwnerRequest,@Res({passthrough:true}) reply:FastifyReply){
  const service=requireService(this.service),proof=await service.owner(request,rootId);
  return withBrowserTreeRequest(request,reply,signal=>service.append(proof,treeId,jobId,chunkHeaders(request),body,signal));
 }
 @Post(":rootId/:treeId/stream-jobs/:jobId/seal") @HttpCode(200) @RouteConfig({browserTreeStream:"metadata"})
 async seal(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Body() body:unknown,@Req() request:AuthenticatedOwnerRequest,@Res({passthrough:true}) reply:FastifyReply){
  const service=requireService(this.service),proof=await service.owner(request,rootId);
  return withBrowserTreeRequest(request,reply,signal=>service.seal(proof,treeId,jobId,body,signal));
 }
 @Post(":rootId/:treeId/stream-jobs/:jobId/execute") @HttpCode(200) @RouteConfig({browserTreeStream:"metadata"})
 async execute(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Body() body:unknown,@Req() request:AuthenticatedOwnerRequest){
  const service=requireService(this.service);return service.execute(await service.owner(request,rootId),treeId,jobId,body);
 }
 @Delete(":rootId/:treeId/stream-jobs/:jobId") @HttpCode(200) @RouteConfig({browserTreeStream:"metadata"})
 async cancel(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Req() request:AuthenticatedOwnerRequest){
  const service=requireService(this.service);return service.cancel(await service.owner(request,rootId),treeId,jobId);
 }
}
@Controller("drop/upload-trees")
@UseGuards(DropSessionGuard)
@UseFilters(BrowserTreeApiExceptionFilter)
export class DropBrowserTreeStreamController{
 constructor(@Inject(BROWSER_TREE_STREAM_HTTP_SERVICE) private readonly service:BrowserTreeStreamHttpService|null){}
 @Get("stream-capabilities") @RouteConfig({browserTreeStream:"metadata"})
 capability(@Req() request:AuthenticatedDropRequest){if(!request[DROP_SESSION])throw new UnauthorizedException();return this.service?.capability()??browserTreeStreamUnavailable;}
 @Post(":treeId/stream-jobs") @HttpCode(200) @RouteConfig({browserTreeStream:"metadata"})
 async admit(@Param("treeId") treeId:string,@Body() body:unknown,@Req() request:AuthenticatedDropRequest){
  const service=requireService(this.service);return service.admit(await service.drop(request),treeId,body);
 }
 @Get(":treeId/stream-jobs/:jobId") @RouteConfig({browserTreeStream:"metadata"})
 async inspect(@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Req() request:AuthenticatedDropRequest){
  const service=requireService(this.service);return service.inspect(await service.drop(request),treeId,jobId);
 }
 @Patch(":treeId/stream-jobs/:jobId/chunks") @HttpCode(200) @RouteConfig({browserTreeStream:"chunk"})
 async append(@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Body() body:unknown,@Req() request:AuthenticatedDropRequest,@Res({passthrough:true}) reply:FastifyReply){
  const service=requireService(this.service),proof=await service.drop(request);
  return withBrowserTreeRequest(request,reply,signal=>service.append(proof,treeId,jobId,chunkHeaders(request),body,signal));
 }
 @Post(":treeId/stream-jobs/:jobId/seal") @HttpCode(200) @RouteConfig({browserTreeStream:"metadata"})
 async seal(@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Body() body:unknown,@Req() request:AuthenticatedDropRequest,@Res({passthrough:true}) reply:FastifyReply){
  const service=requireService(this.service),proof=await service.drop(request);
  return withBrowserTreeRequest(request,reply,signal=>service.seal(proof,treeId,jobId,body,signal));
 }
 @Post(":treeId/stream-jobs/:jobId/execute") @HttpCode(200) @RouteConfig({browserTreeStream:"metadata"})
 async execute(@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Body() body:unknown,@Req() request:AuthenticatedDropRequest){
  const service=requireService(this.service);return service.execute(await service.drop(request),treeId,jobId,body);
 }
 @Delete(":treeId/stream-jobs/:jobId") @HttpCode(200) @RouteConfig({browserTreeStream:"metadata"})
 async cancel(@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Req() request:AuthenticatedDropRequest){
  const service=requireService(this.service);return service.cancel(await service.drop(request),treeId,jobId);
 }
}
