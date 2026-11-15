import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { StorageAdapter, StorageReadOptions, StorageWriteOptions, StorageRenameGroupMember, StorageWrittenVerification } from "./types.js";
import { validateExactStoragePath } from "./paths.js";
import { BackendWakeup } from "./backend-wakeup.js";
import type { BackendPayloadStore, BackendPayloadReference } from "./backend-payload-store.js";

export interface BackendExecutorIdentity { readonly backendIdentity: string; readonly generation: string; readonly ownerId: string; readonly fencingToken: string }
export interface BackendDiagnostics extends Record<string,unknown>{readonly state:string;readonly ownerId:string|null;readonly fencingToken:string|null}
export type BackendCommand = ((command: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>) => Promise<unknown>) & {
  readonly submitAndClaim?: BackendSubmitAndClaim;
  readonly confirmedRollback?: (error: unknown, command: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>) => boolean;
};
interface TaskStatus { id: string; state: "QUEUED" | "RUNNING" | "DONE" | "UNKNOWN" | "REJECTED"; result?: unknown; errorCode?: string }
interface ClaimedTask { id: string; command: string; body: Record<string, unknown>; reservedBytes: string;diskReserveBytes?:string }
export interface BackendSubmitClaimResult { readonly submitted: TaskStatus; readonly task: ClaimedTask | null }
export type BackendSubmitAndClaim = ((command: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>) => Promise<unknown>) & {
  readonly confirmsNoCommit?: (error: unknown, command: string, identity: BackendExecutorIdentity, payload: Readonly<Record<string, unknown>>) => boolean;
};
interface PendingSubmission { readonly command: string; readonly payload: Readonly<Record<string, unknown>>; readonly onStarted: () => void; readonly resolve: (status: TaskStatus) => void; readonly reject: (error: unknown) => void }
export class BackendExecutorError extends Error { constructor(readonly code: string, options?: ErrorOptions) { super(code, options); } }
/** Cross-process effect queue. Only one durable owner touches the raw writer.
 * SQL timeout/lease expiry NEVER transfers ownership. Interrupted tasks remain UNKNOWN.
 * This adapter does not serialize catalog transactions or hold them over I/O. */
export class DurableBackendExecutor implements StorageAdapter {
  readonly identity: BackendExecutorIdentity;
  #owned = false; #closing = false; #pump: Promise<void> | undefined; #failure: unknown;
  #writeOnceSupported=false;
  #renameGroupSupported=false;
  #verifiedWriteSupported=false;
  #promotion:Promise<void>|undefined;
  #healthHeartbeat=false;
  #heartbeat:Promise<void>|undefined;
  #heartbeatWake=new BackendWakeup();
  #heartbeatFailure:unknown;
  #lastTaskFailure:unknown;
  #stagingFailure: BackendExecutorError | undefined;
  #closePromise:Promise<void>|undefined;
  #pendingReads = new Set<Promise<unknown>>();
  #readStreams = new Set<Readable>();
  #readClosureFailures: unknown[] = [];
  #readClosureExpired = false;
  readonly #readCloseTimeoutMs: number;
  #work = new BackendWakeup();
  #completions = new Map<string, BackendWakeup>();
  #terminalReceipts = new Map<string, TaskStatus>();
  #runningTasks = new Set<string>();
  #claimWaiters:{resolve:(task:ClaimedTask|null)=>void;reject:(error:unknown)=>void}[]=[];
  #claimPump:Promise<void>|undefined;
  #pendingSubmissions: PendingSubmission[] = [];
  #queuedHints=new Set<string>();
  #nextRemoteObservation=0;
  #emptyRevision=-1;
  #metrics={sqlCommands:0,sqlFailures:0,sqlElapsedMs:0,completionRetries:0,storageEffects:0,storageElapsedMs:0,readAdmissionWaitMs:0,metadataCalls:0,metadataAdmissionWaitMs:0,metadataElapsedMs:0};
  constructor(private readonly raw: StorageAdapter, private readonly sendCommand: BackendCommand,
    backendIdentity: string, generation: string, private readonly diskReserveBytes = 268435456,
    private readonly ownerChanged?:(identity:BackendExecutorIdentity,state:"ACTIVE"|"STOPPED")=>Promise<void>,
    private readonly options:{payloads?:BackendPayloadStore;workers?:number;groupStorageCheck?:()=>Promise<void>;readCloseTimeoutMs?:number}={}) {
    if(!Number.isInteger(options.workers??1)||(options.workers??1)<1||(options.workers??1)>4)throw new BackendExecutorError("invalid_input");
    this.#readCloseTimeoutMs=options.readCloseTimeoutMs??30000;
    if(!Number.isSafeInteger(this.#readCloseTimeoutMs)||this.#readCloseTimeoutMs<25||this.#readCloseTimeoutMs>300000)throw new BackendExecutorError("invalid_input");
    this.identity = Object.freeze({ backendIdentity, generation, ownerId: randomUUID(), fencingToken: randomUUID() });
  }
  private async command(command:string,identity:BackendExecutorIdentity,payload:Readonly<Record<string,unknown>>):Promise<unknown>{
    const started=performance.now();this.#metrics.sqlCommands++;
    try{return await this.sendCommand(command,identity,payload);}catch(error){this.#metrics.sqlFailures++;throw error;}
    finally{this.#metrics.sqlElapsedMs+=performance.now()-started;}
  }
  async start(): Promise<void> {
    if(this.#promotion)return this.#promotion;
    this.#promotion=this.#acquire();
    try{await this.#promotion;}finally{this.#promotion=undefined;}
  }
  async #acquire():Promise<void>{
    if(this.#owned||this.#closing)return;
    // Refuse an unusable staging mount before acquiring durable ownership.
    await this.options.payloads?.initialize();
    const acquired=await this.command("acquire", this.identity, {}) as {owned:boolean;writeOnce?:boolean;renameGroup?:boolean;writeVerifiedOnce?:boolean;healthHeartbeat?:boolean};
    this.#owned=acquired.owned;this.#writeOnceSupported=acquired.writeOnce===true;this.#renameGroupSupported=acquired.renameGroup===true;
    this.#verifiedWriteSupported=acquired.writeVerifiedOnce===true;
    this.#healthHeartbeat=acquired.healthHeartbeat===true;
    if (this.#owned) {
      if(this.#healthHeartbeat){await this.command('heartbeat',this.identity,{});this.#heartbeat=this.#maintainHeartbeat();}
      await this.ownerChanged?.(this.identity,"ACTIVE");this.#pump = Promise.all(Array.from({length:this.options.workers??1},()=>this.#run().catch((error: unknown) => { this.#failure = error; }))).then(()=>undefined);
    }
  }
  async #maintainHeartbeat():Promise<void>{
    // Independent of claims: all four workers can spend minutes in real I/O.
    // This is liveness only. Expiry never releases a slot, task, fence or owner.
    while(!this.#closing&&!this.#failure){
      const revision=this.#heartbeatWake.revision;
      await this.#heartbeatWake.wait(revision,5000);
      if(this.#isClosing()||this.#currentFailure())return;
      try{await this.command('heartbeat',this.identity,{});this.#heartbeatFailure=undefined;}
      catch(error){this.#heartbeatFailure=error;}
    }
  }
  async assertReady():Promise<void>{
    if(this.#closing||this.#failure||this.#heartbeatFailure||!this.#healthHeartbeat)
      throw new BackendExecutorError('backend_owner_unavailable');
    const status=await this.command('readiness',this.identity,{}) as {ready?:boolean;generation?:string}|null;
    if(status?.ready!==true||status.generation!==this.identity.generation)
      throw new BackendExecutorError('backend_owner_unavailable');
  }
  #isClosing(): boolean { return this.#closing; }
  #currentFailure(): unknown { return this.#failure; }
  #failureError(): Error | undefined {
    const failure=this.#currentFailure();
    return failure ? failure instanceof Error ? failure : new Error("Backend executor failed",{cause:failure}) : undefined;
  }

  #rejectQueuedSubmissions(error: unknown): void {
    for (const pending of this.#pendingSubmissions.splice(0)) pending.reject(error);
  }
  #queueSubmission(command: string, payload: Readonly<Record<string, unknown>>, onStarted: () => void): Promise<TaskStatus> | undefined {
    if (!this.sendCommand.submitAndClaim || !this.#owned || this.#isClosing() || this.#failure
      || !this.#claimWaiters.length || this.#pendingSubmissions.length >= 4) return;
    return new Promise<TaskStatus>((resolve, reject) => {
      this.#pendingSubmissions.push({ command, payload, onStarted, resolve, reject });
      this.#work.notify(); this.#scheduleClaims();
    });
  }
  async #submitAndClaim(pending: PendingSubmission): Promise<BackendSubmitClaimResult> {
    const send = this.sendCommand.submitAndClaim;
    if (!send || !this.#owned || !this.#claimWaiters.length || this.#isClosing()) throw new BackendExecutorError("backend_draining");
    const started = performance.now(); this.#metrics.sqlCommands++;
    try {
      pending.onStarted();
      const raw = await send(pending.command, this.identity, pending.payload);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 2
        || !("submitted" in raw) || !("task" in raw)) throw new BackendExecutorError("projection_mismatch");
      const value = raw as BackendSubmitClaimResult;
      // Wire fields remain untrusted until the checks below have completed.
      const s = raw.submitted as { id?: unknown; state?: unknown } | null | undefined;
      const t = raw.task as { [K in keyof ClaimedTask]?: unknown } | null | undefined;
      if (!s || s.id !== pending.payload.id || typeof s.state !== "string" || !["QUEUED", "RUNNING", "DONE", "UNKNOWN", "REJECTED"].includes(s.state))
        throw new BackendExecutorError("projection_mismatch");
      if (t !== null && (s.state !== "QUEUED" || !t || typeof t !== "object" || Array.isArray(t)
        || typeof t.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(t.id)
        || typeof t.command !== "string" || !["write", "truncate", "mkdir", "rename", "copy", "delete", "rename-group"].includes(t.command)
        || !t.body || typeof t.body !== "object" || Array.isArray(t.body)
        || typeof t.reservedBytes !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(t.reservedBytes)
        || t.diskReserveBytes !== undefined && (typeof t.diskReserveBytes !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(t.diskReserveBytes))))
        throw new BackendExecutorError("projection_mismatch");
      return value;
    } catch (error) { this.#metrics.sqlFailures++; throw error; }
    finally { this.#metrics.sqlElapsedMs += performance.now() - started; }
  }

  #nextTask():Promise<ClaimedTask|null>{
    const failure=this.#failureError();if(failure)return Promise.reject(failure);
    const result=new Promise<ClaimedTask|null>((resolve,reject)=>{this.#claimWaiters.push({resolve,reject});});
    this.#scheduleClaims();return result;
  }
  #scheduleClaims():void{
    if(this.#claimPump)return;
    this.#claimPump=this.#dispatchClaims().catch((error:unknown)=>{
      this.#failure=error;this.#rejectQueuedSubmissions(error);for(const waiting of this.#claimWaiters.splice(0))waiting.reject(error);
    }).finally(()=>{this.#claimPump=undefined;if(this.#claimWaiters.length)this.#scheduleClaims();});
  }
  async #dispatchClaims():Promise<void>{
    // A single observer feeds only available worker slots. SQL still performs
    // every durable claim, fence, capacity and overlap check; no task is prefetched.
    while(this.#claimWaiters.length){
      const failure=this.#failureError();if(failure)throw failure;
      const observed=this.#work.revision;
      const remaining=this.#nextRemoteObservation-Date.now();
      // A hint schedules an observation, never grants a claim. Peer work is
      // still discovered within the same 100 ms polling bound; a local submit
      // wakes this observer immediately, including a racing empty SQL reply.
      if(!this.#isClosing()&&!this.#pendingSubmissions.length&&remaining>0&&(!this.#queuedHints.size||this.#emptyRevision===observed)){
        await this.#work.wait(observed,remaining);continue;
      }
      let task: ClaimedTask | null;
      const pending = this.#isClosing() ? undefined : this.#pendingSubmissions.shift();
      if (pending) {
        try {
          const value = await this.#submitAndClaim(pending);
          // Install the hint before handing the actual returned task to a worker.
          // The producer must not re-add a hint after that task was dispatched.
          if (value.submitted.state === "QUEUED") this.#queuedHints.add(String(pending.payload.id));
          pending.resolve(value.submitted);
          task = value.task;
          // A terminal/replayed submission is not evidence of an empty peer queue.
          if (!task && value.submitted.state !== "QUEUED") { this.#nextRemoteObservation = 0; continue; }
        } catch (error) {
          const rollback = this.sendCommand.submitAndClaim?.confirmsNoCommit?.(error, pending.command, this.identity, pending.payload) === true;
          if (rollback) { pending.reject(error); continue; }
          // A lost reply can have claimed another producer's original. Status of
          // this submission cannot prove that claim absent, so never retry it.
          this.#failure = error instanceof Error ? error : new BackendExecutorError("reconciliation_required", { cause: error });
          pending.reject(error); this.#rejectQueuedSubmissions(this.#failure);
          throw this.#failure;
        }
      } else task = await this.#claimWithRecovery();
      if(task){
        // A peer-owned backlog has no local hints. A successful peer claim
        // must fill the next free worker slot without an idle polling delay.
        // After the last known local hint, retain the existing empty-poll
        // suppression; other queued hints still bypass that deadline.
        const localHint=this.#queuedHints.delete(task.id);
        this.#nextRemoteObservation=localHint?Date.now()+100:0;
        const waiting=this.#claimWaiters.shift();
        if(!waiting)throw new BackendExecutorError('reconciliation_required');
        waiting.resolve(task);continue;
      }
      this.#nextRemoteObservation=Date.now()+100;
      this.#emptyRevision=observed;
      if(this.#isClosing()){for(const waiting of this.#claimWaiters.splice(0))waiting.resolve(null);return;}
      await this.#work.wait(observed,100);
    }
  }
  async #claimWithRecovery():Promise<ClaimedTask|null>{
    const deadline=Date.now()+60000;
    for(;;){
    try{return await this.command('claim',this.identity,{}) as ClaimedTask|null;}
    catch(error){
      // PostgreSQL 55P03 is a definite statement rollback, unlike a lost
      // response. Retry only the SQL claim, never its physical effect. The
      // next claim still validates the current owner/fence in PostgreSQL.
      if(error&&typeof error==='object'&&'code' in error&&error.code==='55P03'
        &&this.#owned&&!this.#isClosing()&&Date.now()<deadline){
        await delay(250);
        if(this.#isClosing()||Date.now()>=deadline)throw error;
        continue;
      }
      // A failed SQL response can hide a successful claim. Never repeat a
      // physical effect or transfer ownership based on a reconnect or age.
      if(!isBackendDatabaseDisconnect(error)||!this.#owned||this.#runningTasks.size)throw error;
      for(;;){
        if(this.#isClosing()||Date.now()>=deadline)throw error;
        await delay(250);
        let observed:BackendDiagnostics;
        try{observed=await this.command('inspect',this.identity,{}) as BackendDiagnostics;}
        catch(next){if(isBackendDatabaseDisconnect(next))continue;throw next;}
        if(observed.state!=='RUNNING'||observed.ownerId!==this.identity.ownerId
          ||observed.fencingToken!==this.identity.fencingToken||observed.generation!==this.identity.generation)
          throw new BackendExecutorError('backend_draining');
        // Existing inspect includes all QUEUED/RUNNING/UNKNOWN work in this
        // minimum timestamp. Missing fields are not proof of an empty queue.
        if(observed.oldestPendingAt!==null||observed.queued!==0||observed.unknown!==0||this.#runningTasks.size)
          throw new BackendExecutorError('reconciliation_required');
        return null;
      }
    }
    }
  }
  async #completeWithRecovery(id:string,result:unknown):Promise<TaskStatus|null|undefined> {
    const deadline=Date.now()+60000;
    for(;;){
      try{return await this.command('complete',this.identity,{id,result}) as TaskStatus|null|undefined;}
      catch(error){
        // PostgreSQL 55P03 conclusively rolled back this receipt statement.
        // Retry only persistence of the SAME completed effect and owner fence;
        // never execute physical I/O or submit/claim a replacement task here.
        // Shutdown joins this bounded receipt attempt before releasing custody.
        if(error&&typeof error==='object'&&'code' in error&&error.code==='55P03'&&this.#owned&&Date.now()<deadline){
          this.#metrics.completionRetries++;await delay(Math.min(250,deadline-Date.now()));continue;
        }
        // Other errors may have lost an ACK. Only its exact durable DONE
        // receipt resolves that ambiguity; otherwise retain UNKNOWN as before.
        const accepted=await this.command('status',this.identity,{id}) as TaskStatus;
        if(accepted.id===id&&accepted.state==='DONE')return accepted;
        throw error instanceof Error?error:new BackendExecutorError('reconciliation_required');
      }
    }
  }
  async #run(): Promise<void> {
    for (;;) {
      if(this.#failure)return;
      const task = await this.#nextTask();
      if (!task) return;
      this.#runningTasks.add(task.id);
      let effectStarted = false;
      try {
        if (BigInt(task.reservedBytes) > 0n) {
          const capacity = await this.raw.statFs();
          if (!Number.isFinite(capacity.availableBytes)||capacity.availableBytes<0||BigInt(Math.floor(capacity.availableBytes)) < BigInt(task.reservedBytes) + BigInt(task.diskReserveBytes??this.diskReserveBytes)) throw new BackendExecutorError("capacity");
        }
        const p = task.body, source = taskPath(p.source), destination = taskPath(p.destination), target = taskPath(p.path);
        for (const entry of [source, destination, target].filter(Boolean)) validateExactStoragePath(entry,false);
        let result: unknown = null;
        if (!["write", "truncate", "mkdir", "rename", "copy", "delete", "rename-group"].includes(task.command)) throw new BackendExecutorError("invalid_input");
        const group=task.command==='rename-group'?renameGroupMembers(p):[];
        // This claimed worker already owns a physical slot. Check all targets
        // before the first mutation; do not acquire additional read slots here.
        for(const member of group){
          await this.options.groupStorageCheck?.();
          const start=performance.now();this.#metrics.metadataCalls++;
          try{if(await this.raw.exists(member.destination))throw new BackendExecutorError('backend_preimage_mismatch');}
          finally{this.#metrics.metadataElapsedMs+=performance.now()-start;}
        }
        // Verify the sealed payload before declaring that physical I/O began.
        // Legacy inline rows remain readable during an explicitly fenced update.
        const content=task.command==='write'?(p.payloadRef!==undefined
          ?await (this.options.payloads??missingPayloadStore()).read(p.payloadRef as BackendPayloadReference)
          :Buffer.from(String(p.bytes),'base64')):Buffer.alloc(0);
        const verified=task.command==='write'&&p.schema==='saturn.backend-write-verified-once.v1';
        if(verified){
          const options:unknown=p.options;
          if(content.length<1||content.length>262144||!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).length!==4)throw new BackendExecutorError('invalid_input');
          const o=options as Record<string,unknown>;
          if(o.offset!==0||o.create!==true||o.exclusive!==true||o.truncate!==false)throw new BackendExecutorError('invalid_input');
          await this.options.groupStorageCheck?.();
        }
        effectStarted = true;
        const started=performance.now();if(group.length===0)this.#metrics.storageEffects++;
        try{
        switch (task.command) {
          case "write":
            result=await this.raw.write(target,Readable.from(content),p.options as StorageWriteOptions);
            if(verified){
              if(result!==content.length)throw new BackendExecutorError('verification_failed');
              result=await this.#verifyWrittenFile(target,p.payloadRef as BackendPayloadReference);
            }
            break;
          case "truncate": await this.raw.truncate(target, Number(p.size)); break;
          case "mkdir": await this.raw.mkdir(target); break;
          case "rename": await this.raw.rename(source, destination); break;
          case "rename-group":
            // Sequential effects preserve the four-worker physical ceiling.
            // A failure after any rename retains this entire task as UNKNOWN.
            for(const member of group){
              await this.options.groupStorageCheck?.();
              const start=performance.now();this.#metrics.storageEffects++;
              try{await this.raw.rename(member.source,member.destination);}
              finally{this.#metrics.storageElapsedMs+=performance.now()-start;}
            }
            result={schema:'saturn.backend-rename-group-result.v1',operationIds:group.map(m=>m.operationId)};
            break;
          case "copy": await this.raw.copy(source, destination); break;
          case "delete":
            if (p.retention !== undefined) await this.#deleteRetainedVersion(target, p.retention);
            else await this.raw.delete(target);
            break;
        }
        }finally{if(group.length===0)this.#metrics.storageElapsedMs+=performance.now()-started;}
        // If ACK is ambiguous, inspect the same task; never execute it again.
        const receipt=await this.#completeWithRecovery(task.id,result);
        if(receipt?.id===task.id&&receipt.state==="DONE"&&this.#completions.has(task.id))this.#terminalReceipts.set(task.id,receipt);
        if(p.payloadRef!==undefined)await this.options.payloads?.remove(p.payloadRef as BackendPayloadReference).catch(()=>undefined);
      } catch (error) {
        this.#lastTaskFailure=error;
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "reconciliation_required";
        // A multi-step adapter can fail after a partial effect even for a
        // familiar filesystem error. Only failures before I/O are conclusive.
        const rejected = !effectStarted;
        await this.command(rejected ? "reject" : "unknown", this.identity, { id: task.id, errorCode: rejected ? code : "reconciliation_required" });
        if (!rejected) { this.#failure = new BackendExecutorError("reconciliation_required");this.#work.notify();return; }
      } finally {
        this.#runningTasks.delete(task.id);
        this.#completions.get(task.id)?.notify();
        this.#work.notify();
      }
    }
  }
  async #deleteRetainedVersion(path: string, value: unknown): Promise<void> {
    if (!value || typeof value !== "object") throw new BackendExecutorError("invalid_input");
    const v = value as Record<string, unknown>, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (typeof v.resourceId !== "string" || !uuid.test(v.resourceId) || typeof v.versionId !== "string" || !uuid.test(v.versionId)
      || typeof v.sizeBytes !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(v.sizeBytes)
      || typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256)) throw new BackendExecutorError("invalid_input");
    const archive = `_system/versions/${v.resourceId}/${v.versionId}`;
    if (path !== archive && !path.startsWith(archive + "/")) throw new BackendExecutorError("invalid_input");
    // The SQL original permanently expires this exact version/path. Absence is
    // idempotent only here, never for an ordinary delete or a current file.
    if (!(await this.raw.exists(path))) return;
    const stat = await this.raw.stat(path);
    if (stat.type !== "file" || String(stat.size) !== v.sizeBytes) throw new BackendExecutorError("retention_preimage_mismatch");
    const hash = createHash("sha256"); let size = 0n;
    let stream:Readable;
    try{stream=await this.raw.openRead(path);}
    catch(error){this.#readClosureFailures.push(error);throw new BackendExecutorError('read_close_unconfirmed');}
    try{
      for await (const part of stream) {
        const bytes = Buffer.from(part as Uint8Array); size += BigInt(bytes.length);
        if (size > BigInt(v.sizeBytes)) throw new BackendExecutorError("retention_preimage_mismatch");
        hash.update(bytes);
      }
    }finally{stream.destroy();await this.#joinPhysicalReadClose(stream);}
    if (size.toString() !== v.sizeBytes || hash.digest("hex") !== v.sha256) throw new BackendExecutorError("retention_preimage_mismatch");
    await this.raw.delete(path);
  }
  async #submit(command: string, body: Record<string, unknown>, reservedBytes = "0",originalTaskId?:string,onSubmitted?:(alreadyDone:boolean)=>void,onFirstRollback?:(error:unknown)=>Promise<void>,onSubmissionStarted?:()=>void): Promise<unknown> {
    if (this.#isClosing()) throw new BackendExecutorError("backend_draining");
    if (this.#failure) throw this.#failure instanceof Error ? this.#failure : new Error("Backend executor failed", { cause: this.#failure });
    if(!this.#owned){
      // acquire grants only after a durable STOPPED receipt, never on age.
      await this.start();
    }
    // Startup may have yielded while close or an owner failure became known.
    if (this.#isClosing()) throw new BackendExecutorError("backend_draining");
    const failure = this.#failureError(); if (failure) throw failure;
    const id = originalTaskId??randomUUID(),submission=originalTaskId===undefined||command==='rename-group'?'submit':'submit-once'; let status: TaskStatus;
    const completed = new BackendWakeup();
    this.#completions.set(id, completed);
    let observed = completed.revision;
    try {
    const payload = { id, command, body, reservedBytes };
    let hintHandled = false, submissionStarted = false;
    const started = () => { submissionStarted = true; onSubmissionStarted?.(); };
    const hasSubmissionStarted = () => submissionStarted;
    try {
      const queued = this.#queueSubmission(submission, payload, started);
      if (queued) { hintHandled = true; status = await queued; }
      else { started(); status = await this.command(submission, this.identity, payload) as TaskStatus; }
    } catch (error) {
      if (!hasSubmissionStarted()) throw error; // Cancelled local work never reached SQL.
      if (onFirstRollback && this.sendCommand.confirmedRollback?.(error, submission, this.identity, payload) === true) {
        await onFirstRollback(error); throw error;
      }
      if (hintHandled && this.#failureError()) {
        const accepted = this.#terminalReceipts.get(id);
        if (accepted?.state === "DONE") status = accepted;
        else throw error;
      } else {
        // A verified atomic rollback may retry only the ordinary idempotent
        // submission. An uncertain compound invocation never gets here.
        hintHandled = false;
        try { status = await this.command(submission, this.identity, payload) as TaskStatus; } catch { throw error; }
      }
    }
    onSubmitted?.(status.state==='DONE');
    if(!hintHandled&&status.state==='QUEUED')this.#queuedHints.add(id);
    this.#work.notify();
    const deadline = Date.now() + 120000;
    while (["QUEUED", "RUNNING"].includes(status.state)) {
      if (Date.now() >= deadline) throw new BackendExecutorError("operation_unknown");
      await completed.wait(observed, 50);
      observed = completed.revision;
      // Only a database-confirmed terminal receipt may replace the status read.
      // Older databases return just an id, so retain their ordinary lookup.
      status = this.#terminalReceipts.get(id) ?? await this.command("status", this.identity, { id }) as TaskStatus;
      // A peer's failed claim must release pending callers promptly, while a
      // confirmed receipt for this original still takes precedence.
      const failure=this.#failureError();if(failure&&!this.#runningTasks.has(id)&&["QUEUED","RUNNING"].includes(status.state))throw failure;
    }
    if (status.state === "UNKNOWN") throw new BackendExecutorError("reconciliation_required");
    if (status.state === "REJECTED") throw new BackendExecutorError(status.errorCode ?? "backend_busy");
    if (status.state !== "DONE") throw new BackendExecutorError("projection_mismatch");
    return status.result;
    } finally { this.#completions.delete(id);this.#terminalReceipts.delete(id);this.#queuedHints.delete(id); }
  }
  #assertStagingAdmission(): void {
    if (this.#stagingFailure) throw this.#stagingFailure;
    if (this.#isClosing()) throw new BackendExecutorError("backend_draining");
    const failure = this.#failureError();
    if (failure) throw failure;
  }
  async #stageWrite(bytes: Buffer, body: (ref: BackendPayloadReference) => Record<string, unknown>, taskId?: string, onSubmitted?: (alreadyDone: boolean) => void): Promise<{ result: unknown; payloadRef: BackendPayloadReference }> {
    this.#assertStagingAdmission();
    const payloads = this.options.payloads;
    if (!payloads) throw new BackendExecutorError("unsupported");
    const payloadRef = await payloads.put(Buffer.from(bytes));
    const discardUnadmitted = async (firstError: unknown) => {
      try { await payloads.remove(payloadRef); }
      catch (removeError) {
        // This is a local staging failure, not an UNKNOWN physical operation.
        // Accepted work still drains; only new puts from this executor close.
        this.#stagingFailure = new BackendExecutorError("payload_cleanup_failed", {
          cause: new AggregateError([firstError, removeError], "Confirmed refusal payload cleanup failed"),
        });
        throw this.#stagingFailure;
      }
    };
    const submission = { started: false };
    try {
      this.#assertStagingAdmission();
      const result = await this.#submit("write", body(payloadRef), payloadRef.size, taskId, onSubmitted, discardUnadmitted, () => { submission.started = true; });
      return { result, payloadRef };
    } catch (error) {
      // This private invocation witness is set immediately before the FIRST
      // submit command, including synchronous driver failure. Before it, no
      // SQL task can reference this fresh private ref. After it, retain the ref
      // unless that first command provides the existing attested rollback.
      if (!submission.started) await discardUnadmitted(error);
      throw error;
    }
  }
  async assertOwner(): Promise<void> {
    const current = await this.command("inspect", this.identity, {}) as { state: string; ownerId: string; fencingToken: string };
    if (!this.#owned || current.state !== "RUNNING" || current.ownerId !== this.identity.ownerId || current.fencingToken !== this.identity.fencingToken) throw new BackendExecutorError("backend_draining");
  }
  async diagnostics():Promise<BackendDiagnostics> {
    const code = (error: unknown) => {
      if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') return error ? 'backend_owner_unavailable' : null;
      return /^[a-zA-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'backend_owner_unavailable';
    };
    return {...await this.command("inspect",this.identity,{}) as BackendDiagnostics,
      process:{...this.#metrics,owned:this.#owned,closing:this.#closing,claimFailureCode:code(this.#failure),heartbeatFailureCode:code(this.#heartbeatFailure),lastTaskFailureCode:code(this.#lastTaskFailure)}};
  }
  async #trackRead<T>(action: () => Promise<T>): Promise<T> {
    const pending = action(); this.#pendingReads.add(pending);
    try { return await pending; } finally { this.#pendingReads.delete(pending); }
  }
  async #acquireRead(id: string, options: StorageReadOptions = {}, metadata = false): Promise<void> {
    if (this.#isClosing()) throw new BackendExecutorError("backend_draining");
    if (!this.#owned) await this.start();
    const deadline = Date.now() + 10000, started = performance.now();
    try {
      for (;;) {
        if (this.#isClosing()) throw new BackendExecutorError("backend_draining");
        if (options.signal?.aborted) throw new BackendExecutorError("cancelled");
        if ((await this.command("read-acquire", this.identity, { id, priority: options.priority ?? "foreground", kind: metadata ? "metadata" : "content" }) as { acquired: boolean }).acquired) {
          // Shutdown can start while SQL admission is in flight.
          if (this.#isClosing()) throw new BackendExecutorError("backend_draining");
          if (options.signal?.aborted) throw new BackendExecutorError("cancelled");
          return;
        }
        if (Date.now() >= deadline) throw new BackendExecutorError("admission_full");
        await delay(50);
      }
    } finally {
      const elapsed = performance.now() - started;
      this.#metrics.readAdmissionWaitMs += elapsed;
      if (metadata) this.#metrics.metadataAdmissionWaitMs += elapsed;
    }
  }
  /** The callback uses the raw adapter/verifier under this one slot. It must
   * not call another budgeted method on this executor (nested admission). */
  withReadBudget<T>(action: () => Promise<T>, metadata = false): Promise<T> {
    return this.#trackRead(async () => {
      const id = randomUUID();
      let closureUnconfirmed = false;
      try {
        await this.#acquireRead(id, {}, metadata);
        const started = performance.now();
        if (metadata) this.#metrics.metadataCalls++;
        try { return await action(); }
        finally { if (metadata) this.#metrics.metadataElapsedMs += performance.now() - started; }
      } catch (error) {
        closureUnconfirmed = error instanceof BackendExecutorError && error.code === 'read_close_unconfirmed';
        throw error;
      } finally { if (!closureUnconfirmed) await this.command("read-release", this.identity, { id }); }
    });
  }
  // Migration 0119 reserves one of four cross-process read slots for metadata.
  // Metadata inside a claimed writer effect already owns its slot and stays raw.
  stat(p: string) { return this.withReadBudget(() => this.raw.stat(p), true); }
  list(p: string, cursor: string | undefined, limit: number) { return this.withReadBudget(() => this.raw.list(p, cursor, limit), true); }
  openRead(p: string, options: StorageReadOptions = {}): Promise<Readable> {
    return this.#trackRead(() => this.#openRead(p, options));
  }
  async #openRead(p: string, options: StorageReadOptions): Promise<Readable> {
    const id = randomUUID();
    let physicalOpenAttempted = false;
    let physicalClosureTracked = false;
    const release = () => this.command("read-release", this.identity, { id }).then(() => undefined);
    try {
      await this.#acquireRead(id, options);
      physicalOpenAttempted = true;
      const stream = await this.raw.openRead(p, options);
      this.#readStreams.add(stream);
      stream.once("close", () => this.#readStreams.delete(stream));
      if (stream.closed) this.#readStreams.delete(stream);
      let released = false;
      const done = () => { if (!released) { released = true; options.signal?.removeEventListener("abort", abort); void release().catch(() => undefined); } };
      const abort = () => stream.destroy(new BackendExecutorError("cancelled"));
      const proof = stream.storageClosed;
      if (proof !== undefined) {
        // A Transform's logical close can precede the backend handle CLOSE.
        // Keep SQL admission and shutdown ownership until that exact proof.
        const pending = proof.then(() => {
          if (this.#readClosureExpired) throw new BackendExecutorError("read_close_unconfirmed");
          return release();
        }).catch((error: unknown) => {
          this.#readClosureFailures.push(error); stream.destroy();
        }).finally(() => {
          options.signal?.removeEventListener("abort", abort);
          this.#pendingReads.delete(pending);
        });
        this.#pendingReads.add(pending);
        physicalClosureTracked = true;
      } else {
        // Preserve the legacy adapter contract; this path does not constitute
        // physical-closure proof for custody-aware consumers.
        stream.once("close", done); stream.once("end", done);
      }
      options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
      if (this.#isClosing()) { stream.destroy(); throw new BackendExecutorError("backend_draining"); }
      return stream;
    } catch (error) {
      // A failed/late remote OPEN reply can still have created a handle. Only
      // failure before invoking the physical adapter proves no read started.
      if (physicalOpenAttempted && !physicalClosureTracked) this.#readClosureFailures.push(error);
      else if (!physicalOpenAttempted) await release().catch(() => undefined);
      throw error;
    }
  }
  exists(p: string) { return this.withReadBudget(() => this.raw.exists(p), true); }
  statFs() { return this.withReadBudget(() => this.raw.statFs(), true); }
  async supportsWriteOnce():Promise<boolean>{
    if(!this.options.payloads)return false;
    if(!this.#owned&&!this.#writeOnceSupported)await this.start();
    return this.#writeOnceSupported;
  }
  async writeOnce(taskId:string,p:string,bytes:Buffer,options:StorageWriteOptions):Promise<number>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(taskId)
      ||!Buffer.isBuffer(bytes)||bytes.length>4*1024*1024||!Number.isSafeInteger(options.offset)||options.offset<0
      ||!Number.isSafeInteger(options.offset+bytes.length)||typeof options.create!=='boolean'
      ||options.exclusive!==undefined&&typeof options.exclusive!=='boolean'||options.truncate!==undefined&&typeof options.truncate!=='boolean')throw new BackendExecutorError('invalid_input');
    validateExactStoragePath(p,false);
    if(this.#isClosing())throw new BackendExecutorError('backend_draining');
    if(!this.options.payloads)throw new BackendExecutorError('unsupported');
    this.#assertStagingAdmission();
    await this.start();
    if(!this.#writeOnceSupported)throw new BackendExecutorError('unsupported');
    const { result, payloadRef } = await this.#stageWrite(bytes, ref => ({schema:'saturn.backend-write-once.v1',path:p,
      options:{offset:options.offset,create:options.create,exclusive:options.exclusive===true,truncate:options.truncate===true},payloadRef:ref}),taskId);
    const written=typeof result==='number'?result:Number(verifiedWriteReceipt(result,payloadRef).sizeBytes);
    if(written!==bytes.length)throw new BackendExecutorError('operation_unknown');
    // A replay may have staged a new reference. Only this confirmed DONE receipt
    // permits deleting that attempt's payload; ambiguity retains it for recovery.
    await this.options.payloads.remove(payloadRef).catch(()=>undefined);
    return written;
  }
  async supportsWriteVerifiedOnce():Promise<boolean>{
    if(!this.options.payloads)return false;
    if(!this.#owned&&!this.#verifiedWriteSupported)await this.start();
    return this.#verifiedWriteSupported;
  }
  async writeVerifiedOnce(taskId:string,p:string,bytes:Buffer):Promise<StorageWrittenVerification>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(taskId)||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>262144)throw new BackendExecutorError('invalid_input');
    validateExactStoragePath(p,false);
    if(this.#isClosing())throw new BackendExecutorError('backend_draining');
    const payloads=this.options.payloads;
    this.#assertStagingAdmission();
    if(!payloads||!await this.supportsWriteVerifiedOnce())throw new BackendExecutorError('unsupported');
    const submission={alreadyDone:false};
    const { result, payloadRef } = await this.#stageWrite(bytes, ref => ({schema:'saturn.backend-write-verified-once.v1',path:p,options:{offset:0,create:true,exclusive:true,truncate:false},payloadRef:ref}),taskId,done=>{submission.alreadyDone=done;});
    let proof:StorageWrittenVerification;
    if(typeof result==='number'){
      if(result!==bytes.length)throw new BackendExecutorError('projection_mismatch');
      // An immutable older original wrote without a physical verification receipt.
      proof=verifiedWriteReceipt(await this.withReadBudget(()=>this.#verifyWrittenFile(p,payloadRef)),payloadRef);
    }else{
      proof=verifiedWriteReceipt(result,payloadRef);
      // An old DONE receipt says nothing about corruption since its first read.
      if(submission.alreadyDone)proof=verifiedWriteReceipt(await this.withReadBudget(()=>this.#verifyWrittenFile(p,payloadRef)),payloadRef);
    }
    await payloads.remove(payloadRef).catch(()=>undefined);
    return proof;
  }
  async #verifyWrittenFile(p:string,expected:Pick<BackendPayloadReference,'size'|'sha256'>):Promise<Record<string,string>>{
    await this.options.groupStorageCheck?.();
    const started=performance.now();this.#metrics.metadataCalls++;
    let stat;
    try{stat=await this.raw.stat(p);}finally{this.#metrics.metadataElapsedMs+=performance.now()-started;}
    if(stat.type!=='file'||!Number.isSafeInteger(stat.size)||String(stat.size)!==expected.size)throw new BackendExecutorError('verification_failed');
    await this.options.groupStorageCheck?.();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new BackendExecutorError('verification_failed')),30000);
    const prefix=Buffer.alloc(Math.min(512,stat.size)),hash=createHash('sha256');let size=0;
    try{
      let stream:Readable;
      try{stream=await this.raw.openRead(p,{signal:controller.signal});}
      catch(error){this.#readClosureFailures.push(error);throw new BackendExecutorError('read_close_unconfirmed');}
      const abort=()=>stream.destroy(new BackendExecutorError('verification_failed'));controller.signal.addEventListener('abort',abort,{once:true});
      if(controller.signal.aborted)abort();
      try{
        for await(const part of stream){const b=Buffer.from(part as Uint8Array);if(size+b.length>stat.size)throw new BackendExecutorError('verification_failed');if(size<prefix.length)b.copy(prefix,size,0,Math.min(b.length,prefix.length-size));size+=b.length;hash.update(b);}
      }finally{controller.signal.removeEventListener('abort',abort);stream.destroy();await this.#joinPhysicalReadClose(stream);}
      if(String(size)!==expected.size||hash.digest('hex')!==expected.sha256)throw new BackendExecutorError('verification_failed');
      return {schema:'saturn.backend-write-verified-result.v1',sizeBytes:expected.size,sha256:expected.sha256,prefixBase64:prefix.toString('base64')};
    }finally{clearTimeout(timer);}
  }
  async #joinPhysicalReadClose(stream:Readable):Promise<void>{
    const proof=(stream as Readable&{readonly storageClosed?:Promise<void>}).storageClosed;
    if(proof===undefined)return; // Legacy adapter contract, no strong closure claim.
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([proof,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BackendExecutorError('read_close_unconfirmed')),this.#readCloseTimeoutMs);})]);
    }catch(error){this.#readClosureFailures.push(error);throw new BackendExecutorError('read_close_unconfirmed');}
    finally{clearTimeout(timer);}
  }
  async write(p: string, source: Readable, options: StorageWriteOptions): Promise<number> {
    const maximum=4*1024*1024;let parts:Buffer[]=[],buffered=0,total=0,first=true;
    const flush=async()=>{
      if(!Number.isSafeInteger(options.offset+total))throw new BackendExecutorError('upload_too_large');
      const chunkOptions={...options,offset:options.offset+total,create:first&&options.create,exclusive:first&&options.exclusive===true,truncate:first&&options.truncate===true};
      const bytes=Buffer.concat(parts,buffered);
      const written=Number(this.options.payloads
        ? (await this.#stageWrite(bytes, ref => ({path:p,options:chunkOptions,payloadRef:ref}))).result
        : await this.#submit('write',{path:p,options:chunkOptions,bytes:bytes.toString('base64')},String(buffered)));
      if(written!==buffered)throw new BackendExecutorError('operation_unknown');
      total+=written;parts=[];buffered=0;first=false;
    };
    for await(const raw of source){
      const bytes=Buffer.from(raw as Uint8Array);let position=0;
      while(position<bytes.length){const count=Math.min(maximum-buffered,bytes.length-position);parts.push(bytes.subarray(position,position+count));buffered+=count;position+=count;if(buffered===maximum)await flush();}
    }
    if(buffered>0||total===0)await flush();return total;
  }
  async truncate(p: string, size: number) { await this.#submit("truncate", { path: p, size }); }
  async mkdir(p: string) { await this.#submit("mkdir", { path: p }); }
  async rename(source: string, destination: string) { await this.#submit("rename", { source, destination }); }
  async supportsRenameGroupOnce():Promise<boolean>{
    if(!this.#owned&&!this.#renameGroupSupported)await this.start();
    return this.#renameGroupSupported;
  }
  async renameGroupOnce(taskId:string,members:readonly StorageRenameGroupMember[]):Promise<void>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(taskId))throw new BackendExecutorError('invalid_input');
    const body={schema:'saturn.backend-rename-group.v1',members:renameGroupMembers({schema:'saturn.backend-rename-group.v1',members})};
    if(!await this.supportsRenameGroupOnce())throw new BackendExecutorError('unsupported');
    const result=await this.#submit('rename-group',body,'0',taskId) as {schema?:unknown;operationIds?:unknown}|null|undefined;
    if(!result||Object.keys(result).length!==2||result.schema!=='saturn.backend-rename-group-result.v1'||!Array.isArray(result.operationIds)
       ||result.operationIds.length!==body.members.length||result.operationIds.some((id,n)=>{const member=body.members[n];return member===undefined||id!==member.operationId;}))throw new BackendExecutorError('projection_mismatch');
  }
  async copy(source: string, destination: string) {
    const info = await this.stat(source); await this.#submit("copy", { source, destination }, String(info.size));
  }
  async delete(p: string) { await this.#submit("delete", { path: p }); }
  close(): Promise<void> {
    return this.#closePromise??=this.#close();
  }
  async #close(): Promise<void> {
    this.#closing = true;
    this.#rejectQueuedSubmissions(new BackendExecutorError("backend_draining"));
    this.#work.notify();
    this.#heartbeatWake.notify();
    const failures:unknown[]=[];
    try { await this.#promotion; } catch(error) { failures.push(error); }
    // No heartbeat can race with the final STOPPED receipt.
    await this.#heartbeat;
    if(this.#owned)try { await this.command("drain",this.identity,{}); } catch(error) { failures.push(error); }
    // Even when SQL admission is unavailable, terminate physical connections.
    // A failed drain/close can never become a STOPPED ownership receipt.
    try { await this.#pump; } catch(error) { failures.push(error); }
    try { await this.#claimPump; } catch(error) { failures.push(error); }
    for (const stream of this.#readStreams) stream.destroy();
    try { await this.raw.close(); } catch(error) { failures.push(error); }
    // All callbacks either finished or were interrupted by physical close;
    // pending admission observes #closing before starting any new raw I/O.
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve,reject) => {
        readTimer=setTimeout(() => { this.#readClosureExpired=true;reject(new BackendExecutorError("read_close_unconfirmed")); },this.#readCloseTimeoutMs);
        // An already admitted OPEN can return after raw.close and register its
        // physical lifetime. Join successive sets rather than one stale copy.
        void (async()=>{while(this.#pendingReads.size)await Promise.allSettled([...this.#pendingReads]);})().then(() => resolve());
      });
    } catch(error) { failures.push(error); }
    finally { if(readTimer!==undefined)clearTimeout(readTimer); }
    failures.push(...this.#readClosureFailures);
    if(this.#failure)failures.push(this.#failure);
    if(failures.length)throw new AggregateError(failures,"backend_close_unconfirmed");
    await this.command("read-close",this.identity,{connectionsClosed:true});
    if(this.#owned){
      await this.ownerChanged?.(this.identity,"STOPPED");
      await this.command("stopped",this.identity,{connectionsClosed:true});
    }
  }
}

function taskPath(value: unknown): string { if(value===undefined||value===null)return "";if(typeof value!=="string")throw new BackendExecutorError("invalid_input");return value; }
function missingPayloadStore():never{throw new BackendExecutorError('payload_store_unavailable');}

function verifiedWriteReceipt(value:unknown,expected:Pick<BackendPayloadReference,'size'|'sha256'>):StorageWrittenVerification{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new BackendExecutorError('projection_mismatch');
  const r=value as Record<string,unknown>;
  if(Object.keys(r).length!==4||r.schema!=='saturn.backend-write-verified-result.v1'||r.sizeBytes!==expected.size||r.sha256!==expected.sha256
    ||typeof r.prefixBase64!=='string'||r.prefixBase64.length>684)throw new BackendExecutorError('projection_mismatch');
  const prefix=Buffer.from(r.prefixBase64,'base64');
  if(prefix.length!==Math.min(512,Number(expected.size))||prefix.toString('base64')!==r.prefixBase64)throw new BackendExecutorError('projection_mismatch');
  return {sizeBytes:expected.size,sha256:expected.sha256,prefix};
}

function renameGroupMembers(body:Record<string,unknown>):StorageRenameGroupMember[]{
  if(Object.keys(body).length!==2||body.schema!=='saturn.backend-rename-group.v1'||!Array.isArray(body.members)||body.members.length<1||body.members.length>16)throw new BackendExecutorError('invalid_input');
  const ids=new Set<string>(),paths:string[]=[],members:StorageRenameGroupMember[]=[];
  const inputMembers:readonly unknown[]=body.members;
  for(const value of inputMembers){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3)throw new BackendExecutorError('invalid_input');
    const m=value as Record<string,unknown>;
    if(typeof m.operationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(m.operationId)||ids.has(m.operationId)
      ||typeof m.source!=='string'||typeof m.destination!=='string')throw new BackendExecutorError('invalid_input');
    ids.add(m.operationId);
    for(const p of [m.source,m.destination]){
      validateExactStoragePath(p,false);const key=p.toLowerCase();
      if(paths.some(q=>q===key||q.startsWith(key+'/')||key.startsWith(q+'/')))throw new BackendExecutorError('invalid_input');
      paths.push(key);
    }
    members.push({operationId:m.operationId,source:m.source,destination:m.destination});
  }
  return members;
}

function isBackendDatabaseDisconnect(error:unknown):boolean{
  if(!error||typeof error!=='object'||!('code' in error))return false;
  return typeof error.code==='string'&&['CONNECTION_CLOSED','CONNECTION_ENDED','CONNECTION_DESTROYED','CONNECT_TIMEOUT','CONNECTION_CONNECT_TIMEOUT','ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','57P01','57P02','57P03'].includes(error.code);
}
