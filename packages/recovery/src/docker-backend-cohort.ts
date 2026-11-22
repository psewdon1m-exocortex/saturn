import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ManagedBackendIdentity } from './backend-owner-process.js';

export interface DockerCohortControl {
  executable: string; executableSha256: string; endpoint: string; engineId: string;
  ownershipLabel: { key: string; value: string };
  writerVolumes: readonly string[];
  registration?: { fileName:string; nonce:string; parentScriptSHA256:string };
}
export interface DockerCohortMember { id: string; created: string; image: string; role: 'api' | 'worker' }
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('cohort_engine_response_invalid'); return v as ObjectValue; };
function canonical(v:unknown):unknown { if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)]));return v; }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const creationKey = Symbol('authenticated-engine-fence');
const liveFences = new WeakSet<EngineFencedBackendOwner>();
function immutable(c:ObjectValue){if(!Array.isArray(c.Mounts))throw Error('cohort_engine_response_invalid');const mounts=c.Mounts.map(object).sort((a,b)=>String(a.Destination)<String(b.Destination)?-1:String(a.Destination)>String(b.Destination)?1:0);return{Id:c.Id,Created:c.Created,Image:c.Image,Name:c.Name,Config:c.Config,HostConfig:c.HostConfig,StartedAt:object(c.State).StartedAt,Mounts:mounts};}
export function dockerCohortConfigurationSha256(value:unknown){return hash(immutable(object(value)));}

/** Operator-side authenticated LOCAL engine client. It is never provided to a
 * runtime HTTP handler. A PID, heartbeat, parsed receipt or caller callback is
 * not a fence. The captured old container IDs are permanently removed before
 * SQL custody can change; their named volumes and evidence remain intact. */
export class DockerBackendCohort {
  readonly recoveryId = randomUUID();
  readonly #environment: NodeJS.ProcessEnv;
  readonly #registration: NonNullable<DockerCohortControl["registration"]>;
  readonly #snapshots = new Map<string, ObjectValue>();
  readonly #fingerprints = new Map<string, string>();
  #fenced?: EngineFencedBackendOwner;
  #ownerRegistration: ObjectValue | undefined;
  private constructor(readonly control: DockerCohortControl, readonly members: readonly DockerCohortMember[], readonly identity: ManagedBackendIdentity,
    readonly record: (event: ObjectValue) => Promise<void>) {
    const registration=control.registration;
    if (!path.isAbsolute(control.executable) || !/^[a-f0-9]{64}$/.test(control.executableSha256)
      || !/^(?:unix:\/\/\/[^\r\n]+|npipe:\/\/\/\/\.\/pipe\/[^\r\n]+)$/.test(control.endpoint)
      || !registration || registration.fileName!=='backend-owner-registration.json' || !/^[a-f0-9]{64}$/.test(registration.nonce) || !/^[a-f0-9]{64}$/.test(registration.parentScriptSHA256)
      || !control.engineId || !control.ownershipLabel.key || !control.ownershipLabel.value
      || !control.writerVolumes.length || control.writerVolumes.some(x => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(x))
      || !identity.backendIdentity || ![identity.generation,identity.ownerId,identity.fencingToken].every(x => uuid.test(x))
      || members.length !== 2 || new Set(members.map(x => x.role)).size !== 2
      || new Set(members.map(x => x.id)).size !== members.length
      || members.some(x => !['api','worker'].includes(x.role) || !/^[a-f0-9]{64}$/.test(x.id) || !/^sha256:[a-f0-9]{64}$/.test(x.image) || !x.created)) throw Error('cohort_configuration_invalid');
    this.#registration=Object.freeze({...registration});
    this.#environment = { ...process.env, DOCKER_HOST:control.endpoint };
    delete this.#environment.DOCKER_CONTEXT;
  }
  static async observe(control: DockerCohortControl, members: readonly DockerCohortMember[], identity: ManagedBackendIdentity,
    record: (event: ObjectValue) => Promise<void>) {
    const cohort = new DockerBackendCohort(structuredClone(control), structuredClone(members), Object.freeze({...identity}), record);
    cohort.assertEngine();
    for (const m of cohort.members) {
      const c=cohort.inspect(m.id);cohort.assertMember(m,c);
      const state=object(c.State);if(state.Running!==true||Number(state.Pid)<=0||state.OOMKilled!==false) throw Error('cohort_live_observation_required');
      cohort.#snapshots.set(m.id,structuredClone(c));cohort.#fingerprints.set(m.id,dockerCohortConfigurationSha256(c));
    }
    cohort.assertNoOtherWriters();
    cohort.#ownerRegistration=cohort.readOwnerRegistration();
    await record({schema:'saturn.engine-cohort-observed.v1',at:new Date().toISOString(),recoveryId:cohort.recoveryId,engineId:control.engineId,identity:cohort.identity,members:cohort.members,ownerRegistrationSHA256:hash(cohort.#ownerRegistration)});
    return cohort;
  }
  command(args: readonly string[]) {
    if(sha(fs.readFileSync(this.control.executable))!==this.control.executableSha256) throw Error('cohort_engine_client_changed');
    return execFileSync(this.control.executable,[...args],{env:this.#environment,windowsHide:true,encoding:'utf8',timeout:40000,maxBuffer:16*1024*1024});
  }
  captureLogs(id:string) {
    if(!this.members.some(m=>m.id===id)||sha(fs.readFileSync(this.control.executable))!==this.control.executableSha256)throw Error('cohort_log_identity_changed');
    const result=spawnSync(this.control.executable,['logs',id],{env:this.#environment,windowsHide:true,encoding:'utf8',timeout:40000,maxBuffer:16*1024*1024});
    if(result.error||result.status!==0)throw Error('cohort_log_capture_failed');return {stdout:result.stdout,stderr:result.stderr};
  }
  private readOwnerRegistration() {
    const worker=this.members.find(m=>m.role==='worker');if(!worker)throw Error('cohort_worker_registration_required');
    const script="const fs=require('node:fs'),crypto=require('node:crypto'),a=require('node:assert/strict');const sha=b=>crypto.createHash('sha256').update(b).digest('hex');a.equal(process.getuid(),1000);const f='/out/backend-owner-registration.json',st=fs.lstatSync(f);a(st.isFile()&&!st.isSymbolicLink()&&st.size<=16384);const r=JSON.parse(fs.readFileSync(f,'utf8'));function check(x){a(Number.isSafeInteger(x.pid)&&x.pid>1);const p='/proc/'+x.pid;const fields=fs.readFileSync(p+'/stat','utf8').split(') ').at(-1).split(' ');a.equal(Number(fields[1]),x.parent);a.equal(fields[19],x.createdTicks);a.equal(sha(fs.readFileSync(p+'/exe')),x.exeSHA256);a.equal(sha(fs.readFileSync(p+'/cmdline')),x.argvSHA256);}check(r.parent);check(r.worker);a.equal(r.worker.parent,r.parent.pid);a(fs.readFileSync('/proc/'+r.parent.pid+'/cmdline','utf8').includes('/registered-worker-parent.mjs'));console.log(JSON.stringify({registration:r,parentScriptSHA256:sha(fs.readFileSync('/registered-worker-parent.mjs'))}));";
    const observed=object(JSON.parse(this.command(['exec',worker.id,'node','-e',script]))),registration=object(observed.registration);
    if(observed.parentScriptSHA256!==this.#registration.parentScriptSHA256||registration.schema!=='saturn.managed-worker-owner-registration.v1'||registration.nonce!==this.#registration.nonce||registration.actualPrivateIPC!==true||hash(registration.identity)!==hash(this.identity))throw Error('cohort_worker_owner_mismatch');
    return registration;
  }
  assertEngine() { if(this.command(['info','--format','{{.ID}}']).trim()!==this.control.engineId) throw Error('cohort_engine_changed'); }
  inspect(id: string) { const values=JSON.parse(this.command(['inspect',id])) as unknown[];if(values.length!==1)throw Error('cohort_engine_response_invalid');return object(values[0]); }
  private assertMember(m: DockerCohortMember,c: ObjectValue) {
    const config=object(c.Config),host=object(c.HostConfig),labels=object(config.Labels),restart=object(host.RestartPolicy);
    if(c.Id!==m.id||c.Created!==m.created||c.Image!==m.image||labels[this.control.ownershipLabel.key]!==this.control.ownershipLabel.value
      ||host.Privileged!==false||host.PidMode==='host'||restart.Name!=='no')throw Error('cohort_member_changed');
    const fingerprint=this.#fingerprints.get(m.id);if(fingerprint&&dockerCohortConfigurationSha256(c)!==fingerprint)throw Error('cohort_configuration_changed');
  }
  assertNoOtherWriters() {
    const ids=this.command(['ps','-q','--no-trunc']).trim().split(/\r?\n/).filter(Boolean);
    for(const id of ids) {
      if(this.members.some(m=>m.id===id))continue;
      const c=this.inspect(id),mounts=c.Mounts;
      if(!Array.isArray(mounts))throw Error('cohort_engine_response_invalid');
      if(mounts.some(v=>{const m=object(v);return m.RW===true&&typeof m.Name==='string'&&this.control.writerVolumes.includes(m.Name);}))throw Error('cohort_unregistered_writer');
    }
  }
  /** The original actual configuration stays private to the trusted controller.
   * This is for ordinary replacement creation, never public logs or HTTP. */
  replacementTemplates(): readonly ObjectValue[] { return this.members.map(m=>{const snapshot=this.#snapshots.get(m.id);if(!snapshot)throw Error('cohort_observation_required');return structuredClone(snapshot);}); }
  hasFailure() {
    this.assertEngine();
    return this.members.some(m=>{const c=this.inspect(m.id);this.assertMember(m,c);return object(c.State).Running===false;});
  }
  async fence() {
    if(this.#fenced)return this.#fenced;
    this.assertEngine();this.assertNoOtherWriters();
    if(!this.hasFailure())throw Error('cohort_actual_failure_required');
    const exits: ObjectValue[]=[];
    for(const m of this.members) {
      let c=this.inspect(m.id);this.assertMember(m,c);
      if(object(c.State).Running===true) {
        await this.record({schema:'saturn.engine-cohort-drain.v1',at:new Date().toISOString(),id:m.id,signal:'TERM',automatic:true});
        this.command(['kill','--signal','TERM',m.id]);
        const end=Date.now()+30000;
        do { await wait(100);c=this.inspect(m.id);this.assertMember(m,c); } while(object(c.State).Running===true&&Date.now()<end);
        if(object(c.State).Running===true) {
          await this.record({schema:'saturn.engine-cohort-hard-fence.v1',at:new Date().toISOString(),id:m.id,signal:'KILL',automatic:true,reason:'explicit_fence_after_drain_deadline'});
          this.command(['kill','--signal','KILL',m.id]);
        }
      }
      const text=this.command(['wait',m.id]).trim();if(!/^(?:0|[1-9][0-9]{0,2})$/.test(text))throw Error('cohort_exit_unknown');
      c=this.inspect(m.id);this.assertMember(m,c);const state=object(c.State);
      if(state.Running!==false||state.Pid!==0||state.OOMKilled!==false||Number(state.ExitCode)!==Number(text))throw Error('cohort_exit_unproved');
      const exit={...m,actualExit:Number(text),actualEngineWait:true,pid:0,oom:false,finishedAt:state.FinishedAt,instanceStartedAt:state.StartedAt,configurationSha256:this.#fingerprints.get(m.id)};
      // Persist actual daemon-backed exit before permanent removal. No volumes
      // are removed. The controller must retain application logs separately.
      await this.record({schema:'saturn.engine-cohort-exit.v1',at:new Date().toISOString(),...exit});exits.push(exit);
    }
    this.assertEngine();this.assertNoOtherWriters();
    for(const m of this.members){const c=this.inspect(m.id);this.assertMember(m,c);if(object(c.State).Running!==false)throw Error('cohort_restarted_before_fence');}
    this.command(['rm',...this.members.map(m=>m.id)]);
    this.assertRemoved();
    const proof=Object.freeze({schema:'saturn.authenticated-engine-cohort-fence.v1',recoveryId:this.recoveryId,identity:this.identity,engineId:this.control.engineId,ownerRegistrationSHA256:hash(this.#ownerRegistration),members:exits,oldContainerIdsPermanentlyRemoved:true,physicalEffectsReplayed:0});
    const fence=new EngineFencedBackendOwner(creationKey,this,proof);this.#fenced=fence;
    await this.record({at:new Date().toISOString(),...proof});return fence;
  }
  assertRemoved() {
    this.assertEngine();
    const ids=new Set(this.command(['ps','-a','-q','--no-trunc']).trim().split(/\r?\n/).filter(Boolean));
    if(this.members.some(m=>ids.has(m.id)))throw Error('cohort_old_container_restartable');
    this.assertNoOtherWriters();
  }
}
export class EngineFencedBackendOwner {
  readonly #cohort: DockerBackendCohort; readonly #proof: Readonly<ObjectValue>;
  constructor(key: symbol, cohort: DockerBackendCohort, proof: Readonly<ObjectValue>) {
    if(key!==creationKey)throw Error('authenticated_engine_fence_required');this.#cohort=cohort;this.#proof=proof;liveFences.add(this);
  }
  proof() { if(!liveFences.has(this))throw Error('authenticated_engine_fence_required');this.#cohort.assertRemoved();return structuredClone(this.#proof) as ObjectValue & {recoveryId:string;identity:ManagedBackendIdentity}; }
}
export function requireEngineFence(fence: EngineFencedBackendOwner) {
  if(!liveFences.has(fence))throw Error('authenticated_engine_fence_required');return fence.proof();
}
