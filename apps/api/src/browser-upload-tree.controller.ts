import {Body,Controller,Delete,Get,HttpCode,Inject,Param,Post,Req,Res,ServiceUnavailableException,UnauthorizedException,UseFilters,UseGuards, type ArgumentsHost,Catch,HttpException,type ExceptionFilter,BadRequestException} from "@nestjs/common";
import type {FastifyReply,FastifyRequest} from "fastify";
import {BROWSER_TREE_HTTP_SERVICE,BrowserTreeHttpService,browserTreeUnavailable} from "./browser-upload-tree.service.js";
import {OWNER_SESSION,OwnerTokenGuard,type AuthenticatedOwnerRequest} from "./owner-token.guard.js";
import {DROP_SESSION,DropSessionGuard,type AuthenticatedDropRequest} from "./drop-session.guard.js";
import {BrowserTreeInputError} from "../../../packages/file-core/src/browser-upload-tree-contract.js";

export function browserTreeHttpError(error:unknown):{status:number;code:string}{
 if(error instanceof BrowserTreeInputError)return {status:400,code:"browser_tree_input_invalid"};
 if(error instanceof Error&&"code"in error&&error.code==="55P03"&&error.message==="browser_spool_quota_busy")return {status:429,code:"browser_spool_quota_busy"};
 const code=error instanceof Error?("code"in error?String(error.code):error.message):"";
 if(["browser_tree_spool_custody_retained","browser_tree_spool_custody_changed","browser_tree_spool_close_unconfirmed"].includes(code))return {status:409,code:"browser_tree_reconciliation_required"};
 if(["browser_tree_authority_invalid","browser_tree_authorization_changed","invalid_session"].includes(code))return {status:401,code:"browser_tree_authorization_changed"};
 if(code==="csrf_rejected")return {status:403,code};
 if(["browser_tree_capacity","browser_tree_execution_capacity","browser_tree_stream_busy","browser_spool_quota_busy","admission_full","capacity"].includes(code))return {status:429,code};
 if(["browser_tree_backend_unavailable","browser_tree_runtime_draining","backend_draining","backend_busy"].includes(code))return {status:503,code};
 if(["browser_tree_file_too_large","browser_tree_quota_exhausted"].includes(code))return {status:413,code};
 if(["browser_tree_not_found","browser_tree_directory_not_found","browser_tree_file_not_found","browser_tree_stream_not_found"].includes(code))return {status:404,code:"browser_tree_not_found"};
 if(["browser_tree_stream_chunk_invalid","browser_tree_stream_chunk_mismatch","browser_tree_stream_offset_invalid"].includes(code))return {status:400,code};
 if(["browser_tree_identity_invalid","browser_tree_parent_invalid","browser_tree_reserved_root","browser_tree_root_files_forbidden"].includes(code))return {status:400,code};
 if(["browser_tree_original_reused","browser_tree_item_reused","browser_tree_binding_changed","browser_tree_children_pending","browser_tree_parent_pending",
 "browser_tree_destination_unavailable","browser_tree_reconciliation_required","browser_tree_physical_target_exists","browser_tree_stream_chunk_reused","browser_tree_stream_seal_reused","browser_tree_stream_incomplete","browser_tree_spool_binding_changed","browser_tree_spool_identity_changed","browser_tree_drop_original_changed","namespace_conflict","namespace_original_exists"].includes(code))return {status:409,code};
 return {status:500,code:"browser_tree_internal_error"};
}
@Catch()
export class BrowserTreeApiExceptionFilter implements ExceptionFilter {
 catch(error:unknown,host:ArgumentsHost):void{
  const reply=host.switchToHttp().getResponse<FastifyReply>();
  if(error instanceof HttpException){reply.status(error.getStatus()).send(error.getResponse());return;}
  const result=browserTreeHttpError(error);if(result.status===429||result.status===503)reply.header("Retry-After","1");
  reply.status(result.status).send({code:result.code});
 }
}
function requireService(service:BrowserTreeHttpService|null):BrowserTreeHttpService{
 if(!service)throw new ServiceUnavailableException({code:"browser_tree_unavailable"});return service;
}
function emptyBody(body:unknown):void{if(body!==undefined&&body!==null&&(typeof body!=="object"||Array.isArray(body)||Object.keys(body).length!==0))throw new BadRequestException({code:"browser_tree_input_invalid"});}
export async function withBrowserTreeRequest<T>(request:FastifyRequest,reply:FastifyReply,action:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const controller=new AbortController(),abort=()=>controller.abort(Error("client_disconnected")),closed=()=>{if(!reply.raw.writableFinished)abort();};
 request.raw.once("aborted",abort);reply.raw.once("close",closed);
 if(request.raw.destroyed&&!request.raw.complete||reply.raw.destroyed)abort();
 // The runner joins all started effects even after the HTTP client disconnects.
 try{return await action(controller.signal);}finally{request.raw.removeListener("aborted",abort);reply.raw.removeListener("close",closed);}
}

@Controller("upload-trees")
@UseGuards(OwnerTokenGuard)
@UseFilters(BrowserTreeApiExceptionFilter)
export class OwnerBrowserTreeController{
 constructor(@Inject(BROWSER_TREE_HTTP_SERVICE) private readonly service:BrowserTreeHttpService|null){}
 @Get("capabilities")
 capability(@Req() request:AuthenticatedOwnerRequest){if(!request[OWNER_SESSION])throw new UnauthorizedException();return this.service?.capability()??browserTreeUnavailable;}
 @Post(":rootId/:treeId/jobs") @HttpCode(200)
 async admit(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Body() body:unknown,@Req() request:AuthenticatedOwnerRequest){
  const service=requireService(this.service);return service.admit(await service.owner(request,rootId),treeId,body);
 }
 @Get(":rootId/:treeId/jobs/:jobId")
 async inspect(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Req() request:AuthenticatedOwnerRequest){
  const service=requireService(this.service);return service.inspect(await service.owner(request,rootId),treeId,jobId);
 }
 @Post(":rootId/:treeId/jobs/:jobId/execute") @HttpCode(200)
 async execute(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Body() body:unknown,@Req() request:AuthenticatedOwnerRequest,@Res({passthrough:true}) reply:FastifyReply){
  emptyBody(body);const service=requireService(this.service),proof=await service.owner(request,rootId);
  return withBrowserTreeRequest(request,reply,signal=>service.run(proof,treeId,jobId,signal));
 }
 @Delete(":rootId/:treeId/jobs/:jobId") @HttpCode(200)
 async cancel(@Param("rootId") rootId:string,@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Req() request:AuthenticatedOwnerRequest){
  const service=requireService(this.service);return service.cancel(await service.owner(request,rootId),treeId,jobId);
 }
}
@Controller("drop/upload-trees")
@UseGuards(DropSessionGuard)
@UseFilters(BrowserTreeApiExceptionFilter)
export class DropBrowserTreeController{
 constructor(@Inject(BROWSER_TREE_HTTP_SERVICE) private readonly service:BrowserTreeHttpService|null){}
 @Get("capabilities")
 capability(@Req() request:AuthenticatedDropRequest){if(!request[DROP_SESSION])throw new UnauthorizedException();return this.service?.capability()??browserTreeUnavailable;}
 @Post(":treeId/jobs") @HttpCode(200)
 async admit(@Param("treeId") treeId:string,@Body() body:unknown,@Req() request:AuthenticatedDropRequest){
  const service=requireService(this.service);return service.admit(await service.drop(request),treeId,body);
 }
 @Get(":treeId/jobs/:jobId")
 async inspect(@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Req() request:AuthenticatedDropRequest){
  const service=requireService(this.service);return service.inspect(await service.drop(request),treeId,jobId);
 }
 @Post(":treeId/jobs/:jobId/execute") @HttpCode(200)
 async execute(@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Body() body:unknown,@Req() request:AuthenticatedDropRequest,@Res({passthrough:true}) reply:FastifyReply){
  emptyBody(body);const service=requireService(this.service),proof=await service.drop(request);
  return withBrowserTreeRequest(request,reply,signal=>service.run(proof,treeId,jobId,signal));
 }
 @Delete(":treeId/jobs/:jobId") @HttpCode(200)
 async cancel(@Param("treeId") treeId:string,@Param("jobId") jobId:string,@Req() request:AuthenticatedDropRequest){
  const service=requireService(this.service);return service.cancel(await service.drop(request),treeId,jobId);
 }
}
