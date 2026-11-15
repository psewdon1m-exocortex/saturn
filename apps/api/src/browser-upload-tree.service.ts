import {BrowserTreeAuthorityIssuer} from "../../../packages/file-core/src/browser-upload-tree-authority.js";
import {BROWSER_TREE_LIMITS} from "../../../packages/file-core/src/browser-upload-tree-contract.js";
import {PostgresBrowserTreeDatabase,type BrowserTreeDatabaseOptions} from "../../../packages/file-core/src/browser-upload-tree-database.js";
import {BrowserTreeJobRunner} from "../../../packages/file-core/src/browser-upload-tree-runner.js";
import {BrowserTreeDirectoryExecutor,BrowserTreeFileExecutor} from "../../../packages/file-core/src/browser-upload-tree-executor.js";
import type {PostgresBrowserNamespaceCoordinator} from "../../../packages/file-core/src/browser-upload-namespace-context.js";
import type {StorageAdapter} from "@saturn/storage";
import type {Database} from "@saturn/database";
import type {OwnerAuthService,SessionValidationInput} from "@saturn/auth";
import type {DropService} from "@saturn/drop";
import type {SaturnConfig} from "@saturn/config";
import type {FastifyRequest} from "fastify";
import {fastifyCookie} from "@fastify/cookie";
import {UnauthorizedException} from "@nestjs/common";
import {OWNER_SESSION,ownerCookieNames,type AuthenticatedOwnerRequest} from "./owner-token.guard.js";
import {DROP_SESSION,dropCookieNames,type AuthenticatedDropRequest} from "./drop-session.guard.js";

export const BROWSER_TREE_HTTP_SERVICE=Symbol("BROWSER_TREE_HTTP_SERVICE");
export const browserTreeUnavailable=Object.freeze({schema:"saturn.browser-tree-capability.v1",available:false});
function sessionInput(request:FastifyRequest,names:{session:string;csrf:string}):SessionValidationInput{
 let cookies:Record<string,string>;try{cookies=fastifyCookie.parse(request.headers.cookie??"");}catch{throw new UnauthorizedException();}
 const token=cookies[names.session];if(!token)throw new UnauthorizedException();
 return {token,userAgent:request.headers["user-agent"]??"",isMutation:!["GET","HEAD","OPTIONS"].includes(request.method.toUpperCase()),
  ...(request.headers.origin===undefined?{}:{origin:request.headers.origin}),
  ...(cookies[names.csrf]===undefined?{}:{csrfCookie:cookies[names.csrf]}),
  ...(request.headers["x-vault-csrf"]===undefined?{}:{csrfHeader:String(request.headers["x-vault-csrf"])})};
}
/** Use this same issuer in the fixed DB adapter and HTTP service. Actual normal
 * cookie/CSRF authentication is repeated; a guard marker or actor string alone
 * cannot mint an execution proof. Bootstrap/device authority is not accepted. */
export function createBrowserTreeHttpAuthority(input:{
 readonly config:SaturnConfig;readonly database:Database;
 readonly owner:Pick<OwnerAuthService,"validateSession">;readonly drop:Pick<DropService,"validateSession">;
}):BrowserTreeAuthorityIssuer{
 return new BrowserTreeAuthorityIssuer({
  ownerSession:async value=>{
   const request=value as AuthenticatedOwnerRequest|null|undefined;if(!request?.[OWNER_SESSION])throw new UnauthorizedException();
   const session=await input.owner.validateSession(sessionInput(request,ownerCookieNames(input.config)));
   const revision=await input.database.withSql(async sql=>(await sql.unsafe<{revision:string}[]>("SELECT revision::text FROM owner_credentials WHERE owner_id='owner'"))[0]?.revision);
   if(!revision)throw new UnauthorizedException();return {id:session.id,tokenHash:session.tokenHash,credentialRevision:revision};
  },
  dropSession:async value=>{
   const request=value as AuthenticatedDropRequest|null|undefined;if(!request?.[DROP_SESSION])throw new UnauthorizedException();
   // Tree endpoints deliberately never pass allowExpiredUploadId.
   const session=await input.drop.validateSession(sessionInput(request,dropCookieNames(input.config)));
   const channel=request.headers["x-saturn-drop-channel"];
   if(typeof channel!=="string"||channel!==session.channelId)throw new UnauthorizedException();
   return {id:session.id,tokenHash:session.tokenHash,channelId:session.channelId};
  },
 });
}
export class BrowserTreeHttpService {
 constructor(private readonly dependencies:{
  readonly authority:BrowserTreeAuthorityIssuer;
  readonly database:Pick<PostgresBrowserTreeDatabase,"admit"|"inspect"|"cancelBeforeExecution">;
  readonly runner:Pick<BrowserTreeJobRunner,"run"|"close">;
 }){}
 capability(){return {schema:"saturn.browser-tree-capability.v1",available:true,limits:{items:BROWSER_TREE_LIMITS.itemsPerJob,wireBytes:BROWSER_TREE_LIMITS.wireBytes,metadataBytes:BROWSER_TREE_LIMITS.metadataBytes,smallFileBytes:BROWSER_TREE_LIMITS.smallFileBytes,activeClientJobs:2}};}
 async owner(request:AuthenticatedOwnerRequest,rootId:string){return this.dependencies.authority.ownerSession(request,rootId);}
 async drop(request:AuthenticatedDropRequest){return this.dependencies.authority.dropSession(request);}
 admit(...args:Parameters<PostgresBrowserTreeDatabase["admit"]>){return this.dependencies.database.admit(...args);}
 inspect(...args:Parameters<PostgresBrowserTreeDatabase["inspect"]>){return this.dependencies.database.inspect(...args);}
 cancel(...args:Parameters<PostgresBrowserTreeDatabase["cancelBeforeExecution"]>){return this.dependencies.database.cancelBeforeExecution(...args);}
 run(...args:Parameters<BrowserTreeJobRunner["run"]>){return this.dependencies.runner.run(...args);}
 async onModuleDestroy():Promise<void>{await this.dependencies.runner.close();}
}

/** Trusted composition entry point only. The caller must provide the qualified
 * runtime LEGACY FENCED adapter and its matching private namespace coordinator;
 * these dependencies are never extracted from HTTP bodies or configuration flags.
 * Main AppModule remains unavailable until that shared runtime is integrated. */
export function composeBrowserTreeHttpService(input:Parameters<typeof createBrowserTreeHttpAuthority>[0]&{
 readonly storage:StorageAdapter;readonly namespace:PostgresBrowserNamespaceCoordinator;readonly options:BrowserTreeDatabaseOptions;
}):BrowserTreeHttpService{
 const authority=createBrowserTreeHttpAuthority(input),database=new PostgresBrowserTreeDatabase(input.database,authority,input.options);
 const directories=new BrowserTreeDirectoryExecutor({storage:input.storage,database,namespace:input.namespace});
 const files=new BrowserTreeFileExecutor({storage:input.storage,database,namespace:input.namespace});
 const runner=new BrowserTreeJobRunner({database,directories,files});
 return new BrowserTreeHttpService({authority,database,runner});
}

