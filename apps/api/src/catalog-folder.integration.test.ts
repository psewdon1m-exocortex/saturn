import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify from "fastify";
import { Database,migrate,listMigrationPairs } from "@saturn/database";
import { CatalogFolderAuthorityIssuer,CatalogFolderCommitCoordinator,FileService,PostgresFileRepository,PostgresRootJournal,PostgresCurrentNamespace,SYNC_RESOURCE_ID,type CatalogFolderRequest,type CatalogFolderOutcome } from "@saturn/file-core";
import { LocalStorageAdapter,SftpStorageAdapter,type StorageAdapter } from "@saturn/storage";
import type { SaturnConfig } from "@saturn/config";
import { DeviceService,PostgresDeviceRepository } from "@saturn/sync";
import { OwnerAuthService,PostgresOwnerAuthRepository,type SessionValidationInput } from "@saturn/auth";
import { DatabaseMetadataExporter,PostgresCommandToolchain,guardRecoveryMutation } from "@saturn/recovery";
import { inspectJournal } from "../../../packages/recovery/src/consistent-snapshot.js";
import { expect,it,vi } from "vitest";
const fixturePath=process.env.SYNC_CATALOG_FOLDER_FIXTURE,exec=promisify(execFile);
type TransactionSql=Parameters<Parameters<Database["transaction"]>[0]>[0];
class FaultDatabase extends Database {
  loseCommitAck=false;
  recording=false;statements=0;queries:{strings:TemplateStringsArray;parameters:readonly unknown[]}[]=[];
  override async transaction<T>(action:(sql:TransactionSql)=>Promise<T>):Promise<T> {
    const result=await super.transaction(sql=>action(new Proxy(sql,{apply:(target,thisArg,args:unknown[])=>{
      if(this.recording){const strings=args[0] as TemplateStringsArray;this.statements++;if(typeof strings[0]==="string")this.queries.push({strings,parameters:args.slice(1)});}
      return Reflect.apply(target,thisArg,args) as unknown;
    }})));
    if(this.loseCommitAck&&typeof result==="object"&&result!==null&&("result" in result||("outcome" in result&&typeof result.outcome==="object"))) {this.loseCommitAck=false;throw new Error("fixture lost SQL commit acknowledgment");}
    return result;
  }
}

it.skipIf(!fixturePath)("qualifies inactive durable folder ensure with real PG, route authentication, HTTP, exclusive backend and failure outcomes",async()=>{
  if(!fixturePath)throw new Error("Explicit owned fixture required");
  const fixture=JSON.parse(await fs.readFile(fixturePath,"utf8")) as {containerId:string;runId:string;databaseUrl:string;fixtureDirectory:string};
  const owned=JSON.parse((await exec("docker",["inspect",fixture.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>};HostConfig:{NanoCpus:number;Memory:number};State:{Running:boolean}}[];
  expect(owned[0]?.Id).toBe(fixture.containerId);expect(owned[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);expect(owned[0]?.State.Running).toBe(true);expect(owned[0]?.HostConfig.NanoCpus).toBeLessThanOrEqual(1e9);expect(owned[0]?.HostConfig.Memory).toBeLessThanOrEqual(512*1024*1024);
  const directory=path.join(fixture.fixtureDirectory,randomUUID().replaceAll("-",""));await fs.mkdir(directory);
  let storage:StorageAdapter=new LocalStorageAdapter(path.join(directory,"storage"));
  let borrowedSftp:{containerId:string;runId:string;root:string}|undefined;
  const sftpPath=process.env.SYNC_CATALOG_FOLDER_SFTP_FIXTURE,backendIdentity=sftpPath?"fixture-sftp":"fixture-local";
  if(sftpPath){
    const sftp=JSON.parse(await fs.readFile(sftpPath,"utf8")) as {containerId:string;runId:string;storage:SaturnConfig["storage"]};
    const state=JSON.parse((await exec("docker",["inspect",sftp.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>};HostConfig:{NanoCpus:number;Memory:number};State:{Running:boolean}}[];
    expect(state[0]?.Id).toBe(sftp.containerId);expect(state[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(sftp.runId);expect(state[0]?.State.Running).toBe(true);expect(state[0]?.HostConfig.NanoCpus).toBeLessThanOrEqual(1e9);
    expect(sftp.storage.host).toBe("127.0.0.1");expect(sftp.storage.root).toBe("/data");expect(sftp.storage.maxConnections).toBe(4);expect(sftp.storage.hostFingerprint).toMatch(/^SHA256:/);
    const prefix="cj03-a1-"+randomUUID().replaceAll("-",""),base=new SftpStorageAdapter(sftp.storage);try{await base.mkdir(prefix);}finally{await base.close();}
    borrowedSftp={containerId:sftp.containerId,runId:sftp.runId,root:"/data/"+prefix};storage=new SftpStorageAdapter({...sftp.storage,root:borrowedSftp.root});await fs.writeFile(path.join(directory,"sftp-owned-subroot.json"),JSON.stringify({...borrowedSftp,cpu:1,connections:4,strictFingerprint:true}));
  }
  const name="folder_"+randomUUID().replaceAll("-",""),admin=new Database(fixture.databaseUrl,{max:2});await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${name}`));
  const url=new URL(fixture.databaseUrl);url.pathname="/"+name;const db=new FaultDatabase(url.toString(),{max:8}),http=Fastify();
  const checks:string[]=[],failures:{phase:string;message:string;code?:string}[]=[],backend:Record<string,number>={};let passed=false;
  const spies=(["mkdir","delete","stat","exists"] as const).map(method=>{const original=storage[method].bind(storage);return vi.spyOn(storage,method).mockImplementation((...args:unknown[])=>{backend[method]=(backend[method]??0)+1;return Reflect.apply(original,storage,args) as Promise<never>;});});
  const reject=async(phase:string,action:()=>Promise<unknown>,code?:string)=>{try{await action();throw new Error("Missing expected failure "+phase);}catch(error){if(!(error instanceof Error)||error.message.startsWith("Missing expected"))throw error;if(code)expect(error).toMatchObject({code});failures.push({phase,message:error.message,...("code" in error?{code:String(error.code)}:{})});}};
  const migrationSource=fileURLToPath(new URL("../../../packages/database/migrations/",import.meta.url)),migrations=path.join(directory,"qualified-0051-migrations"),prior=path.join(directory,"prior-migrations");
  try {
    await fs.mkdir(prior);await fs.mkdir(migrations);
    for(const pair of await listMigrationPairs(migrationSource))if(pair.name.slice(0,4)<="0051")for(const file of [pair.up,pair.down]) {
      await fs.copyFile(file,path.join(migrations,path.basename(file)));if(pair.name.slice(0,4)<="0050")await fs.copyFile(file,path.join(prior,path.basename(file)));
    }
    await migrate(url.toString(),prior);if(storage instanceof LocalStorageAdapter)await storage.initialize();const repository=new PostgresFileRepository(db),legacy=new FileService(repository,storage);await legacy.initializeStorage();
    const devices=new DeviceService({repository:new PostgresDeviceRepository(db),files:legacy,pepper:"cj03-folder-pepper-123456789012345678",options:{enabled:true,publicOrigin:"https://fixture.invalid",uploadChunkMaxBytes:1048576,propfindMaxItems:100,deleteMaxItems:10,deleteWindowMs:10000}});
    const enrolled=await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment("CJ03 folder")).code,"fixture"),peer=await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment("CJ03 peer")).code,"fixture");
    const pluto=await devices.redeemPlutoEnrollment((await devices.createPlutoEnrollment("CJ03 Pluto")).code,"fixture");
    const rootId=enrolled.device.syncRootId,peerRoot=peer.device.syncRootId,plutoRoot=pluto.device.syncRootId;if(!rootId||!peerRoot||!plutoRoot)throw new Error("Missing scoped roots");
    const parent=await legacy.createFolder(rootId,"parent"),legacyBefore=await db.withSql(sql=>sql`SELECT * FROM resources ORDER BY id`),devicesBefore=await db.withSql(sql=>sql`SELECT * FROM devices ORDER BY id`);
    const oldKey=randomUUID();await db.withSql(sql=>sql`INSERT INTO operation_journal(id,operation_type,state,idempotency_key)VALUES(${oldKey},'fixture','failed_retryable',${oldKey})`);
    const journalBefore=await db.withSql(sql=>sql`SELECT * FROM operation_journal ORDER BY id`);
    expect(await migrate(url.toString(),migrations)).toBe(1);
    expect(await db.withSql(sql=>sql`SELECT * FROM resources ORDER BY id`)).toEqual(legacyBefore);expect(await db.withSql(sql=>sql`SELECT * FROM devices ORDER BY id`)).toEqual(devicesBefore);
    const journalAfter=await db.withSql(sql=>sql`SELECT * FROM operation_journal ORDER BY id`);expect(journalAfter.map(({catalog_intent:_,catalog_effect_state:__,...r})=>{void _;void __;return r;})).toEqual(journalBefore);
    const down=await fs.readFile(path.join(migrations,"0051_catalog_folder_intent.down.sql"),"utf8"),up=await fs.readFile(path.join(migrations,"0051_catalog_folder_intent.up.sql"),"utf8");
    await db.transaction(sql=>sql.unsafe(down));await db.transaction(sql=>sql.unsafe(up));expect(await db.withSql(sql=>sql`SELECT * FROM resources ORDER BY id`)).toEqual(legacyBefore);
    checks.push("0050→0051 nullable additive migration and unused downgrade/up preserve catalogue, device/token identities and legacy operation keys without backfill");
    const journal=new PostgresRootJournal(db),clock=await journal.registerRoot(rootId),plutoClock=await journal.registerRoot(plutoRoot),namespace=new PostgresCurrentNamespace(db),binding=await namespace.qualifyFixture(rootId,[rootId,parent.id]),plutoBinding=await namespace.qualifyFixture(plutoRoot,[plutoRoot]);
    const ownerRepository=new PostgresOwnerAuthRepository(db),owner=new OwnerAuthService({repository:ownerRepository,ownerAccessKey:"fixture-owner-key",pepper:"cj03-owner-pepper-1234567890123456789",options:{publicOrigin:"https://fixture.invalid",sessionIdleTtlMs:3600000,sessionAbsoluteTtlMs:7200000,reauthTtlMs:600000,failureLimit:20,failureWindowMs:10000}});await owner.initialize();
    const issuer=new CatalogFolderAuthorityIssuer(db,{authenticateDevice:authorization=>devices.authenticate(authorization),validateOwnerSession:input=>owner.validateSession(input as SessionValidationInput)});
    const roots=[{rootId,epoch:clock.epoch,backendIdentity,namespaceBindingVersion:binding},{rootId:plutoRoot,epoch:plutoClock.epoch,backendIdentity,namespaceBindingVersion:plutoBinding}],coordinator=new CatalogFolderCommitCoordinator(db,issuer,roots),files=new FileService(repository,storage,{catalogBackendIdentity:backendIdentity,catalogFolderCoordinator:coordinator});
    const proof=await issuer.device("Bearer "+enrolled.token,rootId),plutoProof=await issuer.device("Bearer "+pluto.token,plutoRoot);
    const request=(name:string,mode:"ensure"|"create"="ensure"):CatalogFolderRequest=>({operationId:randomUUID(),idempotencyKey:randomUUID(),rootId,epoch:clock.epoch,bindingVersion:binding,parentId:parent.id,name,mode});
    http.post("/fixture/catalog-folder",async(req,reply)=>{try{const r=req.body as CatalogFolderRequest,p=await issuer.device(req.headers.authorization,r.rootId);return await files.ensureCatalogFolder(r,p);}catch(error){reply.code(409);return {code:error instanceof Error&&"code" in error?error.code:"failed"};}});
    await http.listen({host:"127.0.0.1",port:0});const address=http.server.address();if(!address||typeof address==="string")throw new Error("No fixture HTTP port");const endpoint=`http://127.0.0.1:${String(address.port)}/fixture/catalog-folder`;
    const call=async(r:CatalogFolderRequest,token=enrolled.token)=>{const response=await fetch(endpoint,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(r)});const result=await response.json() as CatalogFolderOutcome&{code?:string};return {status:response.status,result};};
    const beforeCounts={...backend},beforeAncestors=await db.withSql(sql=>sql`SELECT id,size_bytes::text,metadata_version,updated_at FROM resources WHERE id IN (${rootId},${parent.id}) ORDER BY id`),first=request("first"),created=await call(first);
    expect(created.status).toBe(200);expect(created.result.result).toMatchObject({status:"CREATED",description:{type:"folder",size_bytes:"0",availability:"AVAILABLE"}});expect(backend.mkdir).toBe((beforeCounts.mkdir??0)+1);
    expect(await db.withSql(sql=>sql`SELECT id,size_bytes::text,metadata_version,updated_at FROM resources WHERE id IN (${rootId},${parent.id}) ORDER BY id`)).toEqual(beforeAncestors);
    const seq=await db.withSql(sql=>sql`SELECT published_seq::text FROM sync_root_clock WHERE root_id=${rootId}`),noop=request("FIRST");const existing=await call(noop);expect(existing.status).toBe(200);expect(existing.result.result.status).toBe("EXISTING");expect(await db.withSql(sql=>sql`SELECT published_seq::text FROM sync_root_clock WHERE root_id=${rootId}`)).toEqual(seq);
    expect((await db.withSql(sql=>sql`SELECT sync_first_seq,sync_last_seq,catalog_effect_state FROM operation_journal WHERE id=${noop.operationId}`))[0]).toMatchObject({sync_first_seq:null,sync_last_seq:null,catalog_effect_state:"not_required"});
    expect(backend.mkdir).toBe((beforeCounts.mkdir??0)+1);expect(await call(first)).toEqual({...created,result:{...created.result,replayed:true}});
    checks.push("real HTTP authenticated create commits one AVAILABLE descriptor/event/result; existing ensure commits typed NOOP result with NULL range; no zero-delta ancestor UPDATE and no repeat backend effect");
    const concurrent=Array.from({length:100},()=>request("same-name")),outcomes:CatalogFolderOutcome[]=[];const mkdirBefore=backend.mkdir??0;
    let busy=0;const concurrencyResults=await Promise.allSettled(concurrent.map(async(r,index)=>{
      for(let attempt=0;attempt<100;attempt++){try{outcomes.push(await files.ensureCatalogFolder(r,proof));return;}catch(error){if(!(error instanceof Error)||!("code" in error)||error.code!=="admission_full")throw error;busy++;await new Promise(resolve=>setTimeout(resolve,Math.min(500,20*2**Math.min(attempt,5))+index%49));}}
      throw new Error("Concurrent fixture retry bound exceeded");
    }));for(const result of concurrencyResults)if(result.status==="rejected")throw result.reason;
    expect(outcomes.filter(o=>o.result.status==="CREATED")).toHaveLength(1);expect(outcomes.filter(o=>o.result.status==="EXISTING")).toHaveLength(99);expect(backend.mkdir).toBe(mkdirBefore+1);expect(new Set(outcomes.map(o=>o.result.description.node_id)).size).toBe(1);
    expect(busy).toBeGreaterThan(0);await fs.writeFile(path.join(directory,"same-name-concurrency.json"),JSON.stringify({callers:100,maximumServerInstanceAdmission:4,busyResponses:busy,created:1,existing:99,stableOriginalKeys:true,backendMkdirDelta:1}));
    checks.push("100 concurrent same-name callers with bounded4 server admission and explicit same-key busy backoff: one exclusive mkdir/catalog/event and99 durable NOOPs");
    const lostNoop=request("first"),noopMkdirBefore=backend.mkdir??0,noopSeqBefore=await db.withSql(sql=>sql`SELECT published_seq::text FROM sync_root_clock WHERE root_id=${rootId}`);db.loseCommitAck=true;
    await reject("NOOP committed SQL acknowledgment lost",()=>files.ensureCatalogFolder(lostNoop,proof));
    const recoveredNoop=await files.ensureCatalogFolder(lostNoop,proof);expect(recoveredNoop).toMatchObject({replayed:true,result:{status:"EXISTING",description:{node_id:created.result.result.description.node_id}}});expect(backend.mkdir??0).toBe(noopMkdirBefore);expect(await db.withSql(sql=>sql`SELECT published_seq::text FROM sync_root_clock WHERE root_id=${rootId}`)).toEqual(noopSeqBefore);
    checks.push("actual committed EXISTING NOOP with lost SQL ACK replays its original typed NULL-range result under the same key, with no mkdir/event/ancestor change");
    const dotted=request("İ");expect((await files.ensureCatalogFolder(dotted,proof)).result.status).toBe("CREATED");
    expect((await files.ensureCatalogFolder(request("i"),proof)).result).toMatchObject({status:"EXISTING",description:{name:"İ"}});
    checks.push("existing PostgreSQL Unicode lower/collation semantics preserved; no JavaScript case-fold substitution or namespace migration");
    const lost=request("lost-sql-ack"),mkdirOriginal=storage.mkdir.bind(storage);vi.spyOn(storage,"mkdir").mockImplementationOnce(async p=>{await mkdirOriginal(p);db.loseCommitAck=true;});
    const recovered=await files.ensureCatalogFolder(lost,proof);expect(recovered.replayed).toBe(true);expect(recovered.result.status).toBe("CREATED");expect((await files.ensureCatalogFolder(lost,proof)).result).toEqual(recovered.result);
    checks.push("actual commit succeeds then synthetic SQL acknowledgment loss: original immutable lookup returns accepted result, no compensation or duplicate publication");
    const snapshot={...backend};await reject("changed name key reuse",()=>files.ensureCatalogFolder({...first,name:"changed"},proof),"operation_reused");await reject("changed mode key reuse",()=>files.ensureCatalogFolder({...first,mode:"create"},proof),"operation_reused");await reject("changed operation UUID same key",()=>files.ensureCatalogFolder({...first,operationId:randomUUID()},proof),"operation_reused");await reject("serialized audit authority",()=>files.ensureCatalogFolder(request("fake-actor"),JSON.parse(JSON.stringify(proof)) as typeof proof),"authority_invalid");expect(backend).toEqual(snapshot);
    await reject("peer scoped token",()=>issuer.device("Bearer "+peer.token,rootId),"authority_invalid");expect((await call(request("peer-http"),peer.token)).status).toBe(409);
    const plutoCreated=await files.ensureCatalogFolder({...request("pluto-child"),rootId:plutoRoot,epoch:plutoClock.epoch,bindingVersion:plutoBinding,parentId:plutoRoot},plutoProof);expect(plutoCreated.result.status).toBe("CREATED");
    const wrongParent=request("outside-parent");await reject("outside parent",()=>files.ensureCatalogFolder({...wrongParent,parentId:peerRoot},proof),"membership_changed");
    checks.push("exact sealed key/conditions/actor reused only unchanged; serialized actor and peer/outside root rejected before backend; current Pluto scoped principal qualified by same internal boundary");
    const session=await owner.authenticate("fixture-owner-key","127.0.0.1","fixture"),sessionProof=await issuer.ownerSession({token:session.token,userAgent:"fixture",isMutation:true,origin:"https://fixture.invalid",csrfCookie:session.csrfToken,csrfHeader:session.csrfToken},rootId);
    expect((await files.ensureCatalogFolder(request("owner-session"),sessionProof)).result.status).toBe("CREATED");await ownerRepository.revokeSession(session.session.tokenHash,new Date());await reject("revoked owner session proof",()=>files.ensureCatalogFolder(request("revoked-owner-session"),sessionProof),"authorization_changed");
    const bootstrap=await issuer.ownerBootstrap("fixture-owner-key",rootId);expect((await files.ensureCatalogFolder(request("owner-bootstrap"),bootstrap)).result.status).toBe("CREATED");
    await db.withSql(sql=>sql`UPDATE owner_credentials SET revision=revision+1 WHERE owner_id='owner'`);await reject("rotated owner credential proof",()=>files.ensureCatalogFolder(request("old-owner-proof"),bootstrap),"authorization_changed");
    const node=created.result.result.description.node_id;await db.withSql(sql=>sql`UPDATE resources SET name='moved-first',parent_id=${rootId},status='trashed' WHERE id=${node}`);
    const historical=await files.ensureCatalogFolder(first,proof);expect(historical.result).toEqual(created.result.result);
    await db.withSql(sql=>sql`UPDATE devices SET can_write=false WHERE id=${enrolled.device.id}`);await reject("revoked write authority replay",()=>files.ensureCatalogFolder(first,proof),"authorization_changed");await db.withSql(sql=>sql`UPDATE devices SET can_write=true WHERE id=${enrolled.device.id}`);
    const originalHash=(await devices.authenticate("Bearer "+enrolled.token)).device.tokenHash;
    await db.withSql(sql=>sql`UPDATE devices SET token_hash=repeat('f',64) WHERE id=${enrolled.device.id}`);await reject("rebound token replay",()=>files.ensureCatalogFolder(first,proof),"authorization_changed");await db.withSql(sql=>sql`UPDATE devices SET token_hash=${originalHash} WHERE id=${enrolled.device.id}`);
    const reboundRoot=await legacy.createFolder(SYNC_RESOURCE_ID,"rebound unassigned");
    await db.withSql(sql=>sql`UPDATE devices SET sync_root_id=${reboundRoot.id},scope_ids=ARRAY[${reboundRoot.id}::uuid] WHERE id=${enrolled.device.id}`);await reject("rebound assigned root replay",()=>files.ensureCatalogFolder(first,proof),"authorization_changed");await db.withSql(sql=>sql`UPDATE devices SET sync_root_id=${rootId},scope_ids=ARRAY[${rootId}::uuid] WHERE id=${enrolled.device.id}`);
    checks.push("owner bootstrap verifies fresh DB credential revision outside SQL clock; historical result survives move/trash but current revoked/rebound write authority blocks replay");
    // Remainder uses current owner proof so the intentionally rebound device cannot affect checks.
    const currentOwner=await issuer.ownerBootstrap("fixture-owner-key",rootId);
    const freshRoot=async(label:string)=>{
      const e=await devices.redeemWindowsEnrollment((await devices.createWindowsEnrollment("A1 "+label+" "+randomUUID().slice(0,8))).code,"fixture"),id=e.device.syncRootId;if(!id)throw new Error("Missing fresh root");
      const c=await journal.registerRoot(id),b=await namespace.qualifyFixture(id,[id]),p=await issuer.device("Bearer "+e.token,id),r=await legacy.getResource(id),co=new CatalogFolderCommitCoordinator(db,issuer,[{rootId:id,epoch:c.epoch,namespaceBindingVersion:b,backendIdentity}]);
      return {device:e.device,proof:p,root:r,coordinator:co,files:new FileService(repository,storage,{catalogBackendIdentity:backendIdentity,catalogFolderCoordinator:co}),request:{operationId:randomUUID(),idempotencyKey:randomUUID(),rootId:id,epoch:c.epoch,bindingVersion:b,parentId:id,name:"child",mode:"ensure" as const}};
    };
    const physical=await freshRoot("physical-wait"),independent=await freshRoot("independent"),physicalCancel=new AbortController();let enterPhysical:()=>void=()=>{},releasePhysical:()=>void=()=>{};
    const physicalEntered=new Promise<void>(resolve=>{enterPhysical=resolve;}),physicalRelease=new Promise<void>(resolve=>{releasePhysical=resolve;}),physicalMkdir=storage.mkdir.bind(storage);
    vi.spyOn(storage,"mkdir").mockImplementationOnce(async p=>{enterPhysical();await physicalRelease;await physicalMkdir(p);});
    const physicalPending=physical.files.ensureCatalogFolder(physical.request,physical.proof,physicalCancel.signal).then(value=>({value}),(error:unknown)=>({error}));
    await physicalEntered;
    try {await db.transaction(async sql=>{await sql`SET LOCAL lock_timeout='100ms'`;await sql`SELECT root_id FROM sync_root_clock WHERE root_id=${physical.root.id} FOR UPDATE`;});
      expect((await independent.files.ensureCatalogFolder(independent.request,independent.proof)).result.status).toBe("CREATED");physicalCancel.abort();
    } finally {releasePhysical();}
    expect(await physicalPending).toMatchObject({error:{code:"reconciliation_required"}});expect((await storage.stat(physical.root.storagePath+"/child")).type).toBe("directory");
    expect((await db.withSql(sql=>sql`SELECT catalog_effect_state,sync_result FROM operation_journal WHERE id=${physical.request.operationId}`))[0]).toMatchObject({catalog_effect_state:"reconciliation_required",sync_result:null});
    checks.push("exclusive physical mkdir wait holds no SQL clock lock (actual100ms lock probe); another root publishes; cancellation after physical work retains UNKNOWN without late SQL commit or compensation");
    const admission=await freshRoot("admission"),cancel=new AbortController();let releaseClock:()=>void=()=>{};let notifyClock:()=>void=()=>{};
    const clockHeld=new Promise<void>(resolve=>{notifyClock=resolve;}),clockRelease=new Promise<void>(resolve=>{releaseClock=resolve;});
    const holdClock=db.transaction(async sql=>{await sql`SELECT root_id FROM sync_root_clock WHERE root_id=${admission.root.id} FOR UPDATE`;notifyClock();await clockRelease;});
    await clockHeld;
    const admitted=Array.from({length:4},(_,index)=>admission.coordinator.prepare({...admission.request,operationId:randomUUID(),idempotencyKey:randomUUID(),name:"waiting-"+String(index)},admission.proof,backendIdentity,index===0?cancel.signal:undefined));
    const settled=Promise.allSettled(admitted);cancel.abort();
    await reject("coordinator fifth admission bounded before SQL",()=>admission.coordinator.prepare(admission.request,admission.proof,backendIdentity),"admission_full");
    const waiting=await settled;releaseClock();await holdClock;
    expect(waiting.every(value=>value.status==="rejected")).toBe(true);expect(waiting[0]).toMatchObject({status:"rejected",reason:{code:"cancelled"}});
    expect(await db.withSql(sql=>sql`SELECT id FROM operation_journal WHERE sync_root_id=${admission.root.id}`)).toHaveLength(0);
    expect((await admission.coordinator.prepare(admission.request,admission.proof,backendIdentity)).outcome).toBeUndefined();
    await fs.writeFile(path.join(directory,"admission-timeout.json"),JSON.stringify({maximumConcurrentSqlAdmission:4,noWaitQueue:true,cancelAfterSettledSql:true,rejections:waiting.map(value=>value.status==="rejected"?{code:value.reason instanceof Error&&"code" in value.reason?String(value.reason.code):"unknown",message:value.reason instanceof Error?value.reason.message:"unknown"}:null),noUncommittedOperation:true,nextRequestWorks:true},null,2));
    checks.push("four admitted SQL callers terminate at2s clock lock/statement bound; fifth fails before lookup; cancelled caller cannot commit, no late queries/result, admission released for next request");
    const foreign=await freshRoot("foreign-directory");await storage.mkdir(foreign.root.storagePath+"/child");const noDelete=backend.delete??0;
    await reject("foreign uncatalogued directory never adopted",()=>foreign.files.ensureCatalogFolder(foreign.request,foreign.proof),"reconciliation_required");expect((await storage.stat(foreign.root.storagePath+"/child")).type).toBe("directory");expect(await db.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${foreign.root.id} AND name='child'`)).toHaveLength(0);expect(backend.delete??0).toBe(noDelete);
    const foreignFile=await freshRoot("foreign-file");await storage.write(foreignFile.root.storagePath+"/child",Readable.from([Buffer.from("foreign fixture bytes")]),{offset:0,create:true,exclusive:true,truncate:true});await reject("foreign uncatalogued file never deleted",()=>foreignFile.files.ensureCatalogFolder(foreignFile.request,foreignFile.proof),"reconciliation_required");expect((await storage.stat(foreignFile.root.storagePath+"/child")).type).toBe("file");expect(backend.delete??0).toBe(noDelete);
    const lateAuth=await freshRoot("late-auth"),actualMkdir=storage.mkdir.bind(storage);vi.spyOn(storage,"mkdir").mockImplementationOnce(async p=>{await actualMkdir(p);await db.withSql(sql=>sql`UPDATE devices SET state='revoked' WHERE id=${lateAuth.device.id}`);});
    await reject("current auth revoked after physical mkdir",()=>lateAuth.files.ensureCatalogFolder(lateAuth.request,lateAuth.proof),"reconciliation_required");expect((await db.withSql(sql=>sql`SELECT catalog_effect_state,sync_result FROM operation_journal WHERE id=${lateAuth.request.operationId}`))[0]).toMatchObject({catalog_effect_state:"reconciliation_required",sync_result:null});expect((await storage.stat(lateAuth.root.storagePath+"/child")).type).toBe("directory");expect(backend.delete??0).toBe(noDelete);
    const latePath=await freshRoot("late-path"),pathMkdir=storage.mkdir.bind(storage);vi.spyOn(storage,"mkdir").mockImplementationOnce(async p=>{await pathMkdir(p);await db.withSql(sql=>sql`UPDATE resources SET storage_path=storage_path||'-changed' WHERE id=${latePath.root.id}`);});
    await reject("current path changed after physical mkdir",()=>latePath.files.ensureCatalogFolder(latePath.request,latePath.proof),"reconciliation_required");expect((await storage.stat(latePath.root.storagePath+"/child")).type).toBe("directory");expect(backend.delete??0).toBe(noDelete);
    if(borrowedSftp){
      const denied=await freshRoot("denied");const absolute="/home/qa"+borrowedSftp.root+"/"+denied.root.storagePath;
      const proofState=JSON.parse((await exec("docker",["inspect",borrowedSftp.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>}}[];expect(proofState[0]?.Id).toBe(borrowedSftp.containerId);expect(proofState[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(borrowedSftp.runId);expect(absolute.startsWith("/home/qa/data/cj03-a1-")).toBe(true);
      await exec("docker",["exec",borrowedSftp.containerId,"chmod","0555",absolute],{windowsHide:true});try{await reject("actual SFTP permission denial",()=>denied.files.ensureCatalogFolder(denied.request,denied.proof),"reconciliation_required");expect(await db.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${denied.root.id} AND name='child'`)).toHaveLength(0);}finally{await exec("docker",["exec",borrowedSftp.containerId,"chmod","0755",absolute],{windowsHide:true});}
    }
    checks.push("actual foreign physical directory/file stay unadopted and undeleted; revoke/private-path change after mkdir retains UNKNOWN and bytes; SFTP run separately includes real permission denial");
    const limits=await freshRoot("bounds"),deep=Array.from({length:129},()=>randomUUID());
    const planFixture=await freshRoot("plan");
    await db.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
      SELECT id,'folder',CASE WHEN ordinal=1 THEN ${limits.root.id}::uuid ELSE (${deep}::uuid[])[ordinal::int-1] END,'depth-'||ordinal,'fixture-only/depth-'||ordinal,'active' FROM unnest(${deep}::uuid[])WITH ORDINALITY AS e(id,ordinal)`);
    const depth128=deep[127],depth129=deep[128];if(!depth128||!depth129)throw new Error("Missing depth fixture");
    db.recording=true;db.statements=0;expect((await limits.coordinator.prepare({...limits.request,parentId:depth128},limits.proof,backendIdentity)).outcome).toBeUndefined();expect(db.statements).toBeLessThanOrEqual(16);db.recording=false;
    await reject("depth129 membership",()=>limits.coordinator.prepare({...limits.request,operationId:randomUUID(),idempotencyKey:randomUUID(),parentId:depth129},limits.proof,backendIdentity),"membership_changed");
    await db.withSql(sql=>sql`UPDATE resources SET parent_id=${depth129} WHERE id=${depth129}`);await reject("cycle membership",()=>limits.coordinator.prepare({...limits.request,operationId:randomUUID(),idempotencyKey:randomUUID(),parentId:depth129},limits.proof,backendIdentity),"membership_changed");
    const inactive=deep[0];if(!inactive)throw new Error("Missing inactive fixture");await db.withSql(sql=>sql`UPDATE resources SET status='trashed' WHERE id=${inactive}`);await reject("inactive ancestor membership",()=>limits.coordinator.prepare({...limits.request,operationId:randomUUID(),idempotencyKey:randomUUID(),parentId:depth128},limits.proof,backendIdentity),"membership_changed");
    await db.withSql(sql=>sql`UPDATE resources SET status='active' WHERE id=${inactive}`);await journal.registerRoot(inactive);await reject("nested registered root membership",()=>limits.coordinator.prepare({...limits.request,operationId:randomUUID(),idempotencyKey:randomUUID(),parentId:depth128},limits.proof,backendIdentity),"membership_changed");
    checks.push("actual128/129 hops, cycle/inactive/nested-root rejection; depth128 prepare stays ≤16 statements via one bounded ancestor preimage projection, no per-node ACL/listing");
    const immutable=await db.withSql(sql=>sql`SELECT sync_result FROM operation_journal WHERE id=${first.operationId}`);
    await reject("final result mutation",()=>db.withSql(sql=>sql`UPDATE operation_journal SET sync_result=sync_result||'{"spoof":true}'::jsonb WHERE id=${first.operationId}`));
    await reject("arbitrary NOOP spoof",()=>db.withSql(sql=>sql`UPDATE operation_journal SET sync_result='{"status":"EXISTING"}'::jsonb,state='active',sync_first_seq=NULL,sync_last_seq=NULL WHERE id=${oldKey}`));
    expect((await db.withSql(sql=>sql`SELECT catalog_folder_shape(jsonb_populate_record(NULL::operation_journal,to_jsonb(j)||jsonb_build_object(
      'catalog_intent',catalog_intent||'{"name":"123"}'::jsonb,
      'sync_result',sync_result||jsonb_build_object('description',(sync_result->'description')||'{"name":123}'::jsonb)))) AS valid
      FROM operation_journal j WHERE id=${noop.operationId}`))[0]?.valid).toBe(false);
    await reject("accepted key delete",()=>db.withSql(sql=>sql`DELETE FROM operation_journal WHERE id=${noop.operationId}`));
    await reject("accepted truncate",()=>db.withSql(sql=>sql.unsafe("TRUNCATE operation_journal CASCADE")));await reject("accepted downgrade",()=>db.transaction(sql=>sql.unsafe(down)));
    await db.withSql(sql=>sql`DELETE FROM operation_journal WHERE id=${oldKey}`);expect(await db.withSql(sql=>sql`SELECT sync_result FROM operation_journal WHERE id=${first.operationId}`)).toEqual(immutable);
    const state=await db.withSql(sql=>inspectJournal(sql));expect(state.catalogIntents).toBeDefined();expect(BigInt(state.catalogResults??"0")).toBeGreaterThan(100n);await reject("registered reset guard",()=>db.transaction(sql=>guardRecoveryMutation(sql)));
    const metadata=await new DatabaseMetadataExporter(db).exportTo(path.join(directory,"metadata-before"));expect(metadata.some(m=>m.path==="metadata/operation_journal.jsonl")).toBe(true);
    await reject("partial catalog schema",()=>db.transaction(async sql=>{await sql`ALTER TABLE operation_journal RENAME COLUMN catalog_effect_state TO broken_catalog_effect_state`;await inspectJournal(sql);}));
    await reject("disabled catalog shape guard",()=>db.transaction(async sql=>{await sql`ALTER TABLE operation_journal DISABLE TRIGGER operation_catalog_folder_guard`;await inspectJournal(sql);}));
    await db.withSql(sql=>sql`UPDATE sync_root_clock SET published_seq=9007199254740993,retained_after_seq=9007199254740993 WHERE root_id=${rootId}`);
    const big=request("bigint-sequence");expect((await files.ensureCatalogFolder(big,currentOwner)).result.status).toBe("CREATED");expect((await db.withSql(sql=>sql`SELECT sync_first_seq::text,sync_last_seq::text FROM operation_journal WHERE id=${big.operationId}`))[0]).toMatchObject({sync_first_seq:"9007199254740994",sync_last_seq:"9007199254740994"});
    checks.push("DB typed NOOP shape rejects arbitrary spoof; final identity/result immutable; mixed legacy deletion succeeds; used downgrade/TRUNCATE/reset blocked; coherent metadata includes sealed catalog intents/results");
    const rollback=request("rollback-after-mkdir");await db.withSql(sql=>sql.unsafe("CREATE FUNCTION fixture_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback after catalog insert'; END $$; CREATE TRIGGER fixture_event_failure BEFORE INSERT ON sync_root_changes FOR EACH ROW EXECUTE FUNCTION fixture_event_failure()"));
    const deleteBefore=backend.delete??0,statBefore=backend.stat??0,existsBefore=backend.exists??0;await reject("event failure rolls catalog/result/clock back after physical mkdir",()=>files.ensureCatalogFolder(rollback,currentOwner),"reconciliation_required");
    expect((await db.withSql(sql=>sql`SELECT catalog_effect_state,sync_result FROM operation_journal WHERE id=${rollback.operationId}`))[0]).toMatchObject({catalog_effect_state:"reconciliation_required",sync_result:null});expect(await db.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${parent.id} AND name=${rollback.name}`)).toHaveLength(0);
    expect(backend.delete??0).toBe(deleteBefore);expect(backend.stat??0).toBe(statBefore);expect(backend.exists??0).toBe(existsBefore);expect((await storage.stat(parent.storagePath+"/"+rollback.name)).type).toBe("directory");
    expect((await db.withSql(sql=>sql`SELECT namespace_state,binding_version FROM sync_root_clock WHERE root_id=${rootId}`))[0]).toMatchObject({namespace_state:"BACKEND_UNCERTAIN"});
    await reject("UNKNOWN same key never fresh mkdir",()=>files.ensureCatalogFolder(rollback,currentOwner),"reconciliation_required");
    const unknownState=await db.withSql(sql=>sql`SELECT catalog_intent,catalog_effect_state,sync_result FROM operation_journal WHERE id=${rollback.operationId}`);
    await db.withSql(sql=>sql`UPDATE operation_journal SET state='failed_retryable',error_code='legacy-maintenance' WHERE id=${rollback.operationId}`);await db.withSql(sql=>sql`UPDATE operation_journal SET state='abandoned',error_code='cleanup_pending' WHERE id=${rollback.operationId}`);
    expect(await db.withSql(sql=>sql`SELECT catalog_intent,catalog_effect_state,sync_result FROM operation_journal WHERE id=${rollback.operationId}`)).toEqual(unknownState);
    await reject("UNKNOWN downgrade to prepared phase",()=>db.withSql(sql=>sql`UPDATE operation_journal SET catalog_effect_state='prepared' WHERE id=${rollback.operationId}`));
    await reject("UNKNOWN key delete",()=>db.withSql(sql=>sql`DELETE FROM operation_journal WHERE id=${rollback.operationId}`));
    checks.push("actual PostgreSQL event failure rolls catalogue/result/counter back; exclusive physical directory retained with durable UNKNOWN and whole binding invalidated; no stat ownership, deletion or blind retry");
    const uncertain=request("mkdir-response-lost");await db.withSql(sql=>sql.unsafe("DROP TRIGGER fixture_event_failure ON sync_root_changes; DROP FUNCTION fixture_event_failure()"));
    const plutoRequest={...uncertain,rootId:plutoRoot,epoch:plutoClock.epoch,bindingVersion:plutoBinding,parentId:plutoRoot},physicalOriginal=storage.mkdir.bind(storage);
    vi.spyOn(storage,"mkdir").mockImplementationOnce(async p=>{await physicalOriginal(p);throw new Error("fixture successful exclusive mkdir response lost");});
    await reject("mkdir successful but response lost",()=>files.ensureCatalogFolder(plutoRequest,plutoProof),"reconciliation_required");expect((await db.withSql(sql=>sql`SELECT catalog_effect_state,sync_result FROM operation_journal WHERE id=${plutoRequest.operationId}`))[0]).toMatchObject({catalog_effect_state:"reconciliation_required",sync_result:null});
    expect(await db.withSql(sql=>sql`SELECT id FROM resources WHERE parent_id=${plutoRoot} AND name=${plutoRequest.name}`)).toHaveLength(0);expect(backend.delete??0).toBe(deleteBefore);
    checks.push("successful exclusive mkdir with lost response remains UNKNOWN without adoption or deletion; pending legacy fail/abandon retains immutable key and cannot reset effect phase");
    const tool=(database:Database,databaseUrl:string)=>new PostgresCommandToolchain({database,databaseUrl,maximumDumpBytes:32*1024*1024,commandTimeoutMs:15000,snapshotTimeoutMs:15000,pgDumpExecutable:"docker",pgRestoreExecutable:"docker",pgDumpPrefixArgs:["exec",fixture.containerId,"pg_dump"],pgRestorePrefixArgs:["exec","-i",fixture.containerId,"pg_restore"],commandConnectionArgs:["--username","postgres","--dbname",new URL(databaseUrl).pathname.slice(1)]});
    const ownedAgain=JSON.parse((await exec("docker",["inspect",fixture.containerId],{windowsHide:true})).stdout) as {Id:string;Config:{Labels:Record<string,string>}}[];expect(ownedAgain[0]?.Id).toBe(fixture.containerId);expect(ownedAgain[0]?.Config.Labels["exocortex.sync-performance.run"]).toBe(fixture.runId);
    const dump=path.join(directory,"folders.dump"),coherentMetadata=path.join(directory,"coherent-metadata");await tool(db,url.toString()).createCoherentBackup(dump,coherentMetadata,new DatabaseMetadataExporter(db));
    const manifest=JSON.parse(await fs.readFile(path.join(coherentMetadata,"coherence.json"),"utf8")) as {journal:object};expect(manifest.journal).toEqual(await db.withSql(sql=>inspectJournal(sql)));
    const exported=(await fs.readFile(path.join(coherentMetadata,"operation_journal.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line) as {id:string;sync_first_seq:string;catalog_intent:object;catalog_effect_state:string;sync_result:object|null});
    expect(exported.find(row=>row.id===big.operationId)?.sync_first_seq).toBe("9007199254740994");expect(exported.find(row=>row.id===rollback.operationId)?.catalog_effect_state).toBe("reconciliation_required");expect(exported.find(row=>row.id===first.operationId)?.sync_result).toEqual(created.result.result);
    const restoredName="folder_restore_"+randomUUID().replaceAll("-","");await admin.withSql(sql=>sql.unsafe(`CREATE DATABASE ${restoredName}`));const restoredUrl=new URL(fixture.databaseUrl);restoredUrl.pathname="/"+restoredName;const restored=new Database(restoredUrl.toString(),{max:2});
    try {const restoredTool=tool(restored,restoredUrl.toString());await restoredTool.restoreDump(dump,"clean");expect(await restored.withSql(sql=>inspectJournal(sql))).toEqual(await db.withSql(sql=>inspectJournal(sql)));expect(await restored.withSql(sql=>sql`SELECT catalog_intent,catalog_effect_state,sync_result FROM operation_journal WHERE id=${rollback.operationId}`)).toEqual(unknownState);
      await reject("restored registered folders cannot be ready",()=>restoredTool.verifyRestoredDatabase());await reject("restart cannot bypass registered restore inspection",()=>tool(restored,restoredUrl.toString()).checkReady());await restoredTool.rollbackReplacement();
    } finally {await restored.close();await admin.withSql(sql=>sql.unsafe(`DROP DATABASE ${restoredName} WITH (FORCE)`));}
    checks.push("real same-cut pg_dump/export/restore retain CREATED/NOOP/UNKNOWN identities, immutable historic result and >2^53 sequence strings; partial/disabled schema fail closed and registered restore/restart require reconciliation");
    await db.withSql(sql=>sql`INSERT INTO resources(id,type,parent_id,name,storage_path,status)
      SELECT md5('a1-plan-'||n)::uuid,'folder',${peerRoot}::uuid,'plan-'||n,'fixture-only/a1-plan-'||n,'active' FROM generate_series(1,100000)n`);
    await db.withSql(sql=>sql`ANALYZE resources`);db.recording=true;db.statements=0;db.queries=[];
    const planRequest={...planFixture.request,name:"indexed-probe"},planStart=performance.now();await planFixture.coordinator.prepare(planRequest,planFixture.proof,backendIdentity);const planMs=performance.now()-planStart;db.recording=false;
    const captured=db.queries.filter(q=>q.strings.join("?").includes("WITH RECURSIVE chain")||q.strings.join("?").includes("lower(name)=lower(")||q.strings.join("?").includes("catalog_intent->>'parentId'"));
    expect(captured.length).toBeGreaterThanOrEqual(4);const plans:unknown[]=[];
    const hasResourcesSeqScan=(value:unknown):boolean=>{if(Array.isArray(value))return value.some(hasResourcesSeqScan);if(typeof value!=="object"||value===null)return false;const o=value as Record<string,unknown>;return o["Node Type"]==="Seq Scan"&&o["Relation Name"]==="resources"||Object.values(o).some(hasResourcesSeqScan);};
    for(const q of captured){const strings=[...q.strings];strings[0]="EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+(strings[0]??"");const template=Object.assign(strings,{raw:[...strings]}) as unknown as TemplateStringsArray;
      const plan=await db.withSql(sql=>Reflect.apply(sql,sql,[template,...q.parameters]) as Promise<unknown>);plans.push(plan);expect(hasResourcesSeqScan(plan)).toBe(false);}
    await fs.writeFile(path.join(directory,"indexed-plans.json"),JSON.stringify({addedSyntheticRows:100000,queries:captured.map(q=>q.strings.join("?")),plans,prepareStatements:db.statements,prepareMs:planMs,scope:"DB-only exact sibling/PK ancestry query-plan qualification; not SFTP/production throughput"},null,2));
    const fkInventory=await db.withSql(sql=>sql`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='resources'::regclass AND contype='f'`),indexes=await db.withSql(sql=>sql`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='resources' ORDER BY indexname`);
    const fkPlan=await db.withSql(sql=>sql`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON)SELECT 1 FROM ONLY public.resources x WHERE ${planFixture.root.id}::uuid OPERATOR(pg_catalog.=) x.trashed_from_parent_id FOR KEY SHARE OF x`);
    await fs.writeFile(path.join(directory,"trashed-parent-fk-evidence.json"),JSON.stringify({scope:"separate future purge/FK index qualification; A1 adds no indexes or row-delete cleanup",cancelledOriginalSql:"DELETE FROM resources WHERE parent_id=$1 AND starts_with(storage_path,'fixture-only/a1-plan-')",referencingLookup:"SELECT 1 FROM ONLY public.resources x WHERE $1 OPERATOR(pg_catalog.=) trashed_from_parent_id FOR KEY SHARE OF x",fkInventory,indexes,fkPlan},null,2));
    checks.push("actual captured prepare SQL on100k wide catalogue: bounded exact sibling index/recursive LATERAL primary-key ancestry with no resources Seq Scan; no listing/OFFSET or per-ancestor projection queries");
    passed=true;
  } finally {
    for(const spy of spies)spy.mockRestore();await http.close();
    await fs.writeFile(path.join(directory,"results.json"),JSON.stringify({passed,checks,failures,backend,backendIdentity,scope:"inactive explicit QUALIFYING backend and fixture-only HTTP; no public feed/all-writer activation"},null,2));
    await storage.close();await db.close();await admin.withSql(sql=>sql.unsafe(`DROP DATABASE ${name} WITH (FORCE)`));await admin.close();
  }
},120000);
