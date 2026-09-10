import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { OutgoingHttpHeaders } from "node:http";
import { LaboratoryServiceError, type LaboratoryAssetMode, type LaboratoryService } from "@saturn/laboratory";
import type { ShareService } from "@saturn/shares";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LaboratoryApiExceptionFilter } from "./laboratory-api-exception.filter.js";
import { OwnerTokenGuard, RequireRecentReauthentication } from "./owner-token.guard.js";
import { LABORATORY_SERVICE, SHARE_SERVICE } from "./tokens.js";
import { TransferMonitorService } from "./transfer-monitor.service.js";

const mode=z.enum(["private","public_immutable","public_alias"]);const disposition=z.enum(["inline","attachment"]);
const createAsset=z.object({resourceId:z.uuid(),mode,label:z.string().min(1).max(240).optional(),disposition:disposition.optional()}).strict();
const updateAsset=z.object({mode:mode.optional(),label:z.string().min(1).max(240).optional(),disposition:disposition.optional()}).strict();
const createClient=z.object({name:z.string().min(1).max(100)}).strict();
const sharedImport=z.object({
  shareToken:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  files:z.array(z.object({resourceId:z.uuid(),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/),path:z.string().min(1).max(240),label:z.string().min(1).max(240).optional(),disposition:disposition.optional()}).strict()).min(1).max(255),
}).strict();
function contentDisposition(kind:"inline"|"attachment",name:string):string{const fallback=name.replace(/[^A-Za-z0-9._-]/g,"_").slice(0,180)||"asset";return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;}

@Controller("laboratory/clients") @UseGuards(OwnerTokenGuard) @UseFilters(LaboratoryApiExceptionFilter)
export class LaboratoryClientController {
  constructor(@Inject(LABORATORY_SERVICE)private readonly laboratory:LaboratoryService){}
  @Post() @RequireRecentReauthentication() create(@Body()body:unknown){return this.laboratory.createClient(createClient.parse(body).name);}
  @Get() list(@Query("offset")offset?:string,@Query("limit")limit?:string){return this.laboratory.listClients(offset===undefined?0:Number(offset),limit===undefined?100:Number(limit));}
  @Post(":id/rotate-token") @RequireRecentReauthentication() rotate(@Param("id")id:string){return this.laboratory.rotateClient(id);}
  @Delete(":id") @RequireRecentReauthentication() revoke(@Param("id")id:string){return this.laboratory.revokeClient(id);}
}

@Controller("laboratory/assets") @UseGuards(OwnerTokenGuard) @UseFilters(LaboratoryApiExceptionFilter)
export class LaboratoryAssetController {
  constructor(@Inject(LABORATORY_SERVICE)private readonly laboratory:LaboratoryService){}
  @Post() @RequireRecentReauthentication() create(@Body()body:unknown){return this.laboratory.createAsset(createAsset.parse(body) as {readonly resourceId:string;readonly mode:LaboratoryAssetMode;readonly label?:string;readonly disposition?:"inline"|"attachment"});}
  @Get() list(@Query("offset")offset?:string,@Query("limit")limit?:string){return this.laboratory.listAssets(offset===undefined?0:Number(offset),limit===undefined?100:Number(limit));}
  @Get(":id") get(@Param("id")id:string){return this.laboratory.getAsset(id);}
  @Patch(":id") @RequireRecentReauthentication() update(@Param("id")id:string,@Body()body:unknown){return this.laboratory.updateAsset(id,updateAsset.parse(body) as {readonly mode?:LaboratoryAssetMode;readonly label?:string;readonly disposition?:"inline"|"attachment"});}
  @Delete(":id") @RequireRecentReauthentication() disable(@Param("id")id:string){return this.laboratory.disableAsset(id);}
  @Get(":id/fragment") fragment(@Param("id")id:string){return this.laboratory.fragment(id);}
}

@Controller("laboratory/imports") @UseFilters(LaboratoryApiExceptionFilter)
export class LaboratoryImportController {
  constructor(@Inject(LABORATORY_SERVICE)private readonly laboratory:LaboratoryService,@Inject(SHARE_SERVICE)private readonly shares:ShareService){}
  @Post("from-share") async fromShare(@Headers("authorization")authorization:string|undefined,@Body()body:unknown,@Req()request:FastifyRequest){
    const input=sharedImport.parse(body);const access={sourceIp:request.ip,userAgent:request.headers["user-agent"]??""};
    const opened=await this.shares.metadata(input.shareToken,access);
    if(opened.share.locked||opened.share.state!=="active"||opened.share.resourceType!=="folder"||!["browse","download_folder"].includes(opened.share.mode))throw new LaboratoryServiceError("invalid");
    const sessionAccess={...access,...(opened.session===undefined?{}:{sessionToken:opened.session.token})};const files=[];
    for(const requested of input.files){
      const selected=await this.shares.childMetadata(input.shareToken,requested.resourceId,sessionAccess);
      if(selected.resource.type!=="file"||selected.resource.status!=="active")throw new LaboratoryServiceError("invalid");
      const created=await this.laboratory.createSharedImmutableAsset({...(authorization===undefined?{}:{authorization}),resourceId:selected.resource.id,sourceShareId:selected.share.id,expectedSha256:requested.expectedSha256,...(requested.label===undefined?{}:{label:requested.label}),...(requested.disposition===undefined?{}:{disposition:requested.disposition})});
      files.push({path:requested.path,resourceId:selected.resource.id,...created});
    }
    return{schema:"saturn.laboratory.snapshot.v1",snapshotId:opened.share.id,files};
  }
}

@Controller("a") @UseFilters(LaboratoryApiExceptionFilter)
export class LaboratoryDeliveryController {
  constructor(@Inject(LABORATORY_SERVICE)private readonly laboratory:LaboratoryService,@Inject(TransferMonitorService)private readonly transfers:TransferMonitorService){}
  @Get(":assetId/:filename") content(@Param("assetId")assetId:string,@Param("filename")filename:string,@Headers("authorization")authorization:string|undefined,@Headers("range")range:string|undefined,@Headers("if-none-match")ifNoneMatch:string|undefined,@Req()request:FastifyRequest,@Res()reply:FastifyReply){return this.serve({assetId,filename,...(authorization===undefined?{}:{authorization}),...(range===undefined?{}:{range}),...(ifNoneMatch===undefined?{}:{ifNoneMatch}),head:request.method==="HEAD"},reply);}
  async serve(input:{readonly assetId:string;readonly filename:string;readonly authorization?:string;readonly range?:string;readonly ifNoneMatch?:string;readonly head:boolean},reply:FastifyReply):Promise<void>{
    const opened=await this.laboratory.deliver(input);reply.header("Accept-Ranges","bytes").header("Content-Type",opened.mimeType).header("Content-Disposition",contentDisposition(opened.asset.disposition,opened.asset.publicFilename)).header("ETag",opened.etag).header("Last-Modified",opened.lastModified.toUTCString()).header("Cache-Control",opened.cacheControl).header("X-Robots-Tag","noindex, nofollow, noarchive");
    if(opened.asset.mode==="private")reply.header("Vary","Authorization");else reply.header("Access-Control-Allow-Origin","*").header("Cross-Origin-Resource-Policy","cross-origin");
    if(opened.notModified){opened.release();reply.status(304).send();return;}reply.header("Content-Length",opened.length);if(opened.partial)reply.status(206).header("Content-Range",`bytes ${String(opened.offset)}-${String(opened.offset+opened.length-1)}/${String(opened.sizeBytes)}`);
    if(input.head){opened.release();reply.hijack();reply.raw.writeHead(reply.statusCode,reply.getHeaders() as OutgoingHttpHeaders);reply.raw.end();return;}const stream=opened.stream;if(stream===undefined){opened.release();throw new Error("Laboratory content stream is missing");}for(const event of ["end","close","error"] as const)stream.once(event,opened.release);reply.send(this.transfers.trackDownload(stream,{filename:opened.asset.publicFilename,totalBytes:opened.length}));
  }
}
