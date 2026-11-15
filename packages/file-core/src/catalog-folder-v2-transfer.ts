import {randomUUID} from "node:crypto";
import type {StorageAdapter} from "@saturn/storage";
import type {FileRepository} from "./repository.js";
import type {CatalogFolderAuthority} from "./catalog-folder-authority.js";
import {CatalogFolderError} from "./catalog-folder-intent.js";
import {parseCatalogFolderRequestV2,type CatalogFolderRequestV2,type CatalogFolderOutcomeV2} from "./catalog-folder-v2-intent.js";
import type {CatalogFolderV2DatabaseCoordinator,PreparedCatalogFolderV2} from "./catalog-folder-v2-database.js";
import type {CatalogRootAdmission} from "./catalog-root-admission.js";

/** Inactive physical executor. Exclusive mkdir only; no ownership from stat, adoption or compensation.
 * Four operations/process, bounded target-lock wait; global backend/takeover fencing remains separate. */
export class CatalogFolderV2TransferExecutor {
  #active=0;
  constructor(private readonly coordinator:CatalogFolderV2DatabaseCoordinator,private readonly repository:FileRepository,private readonly storage:StorageAdapter,private readonly admission?:CatalogRootAdmission){}
  async ensure(request:CatalogFolderRequestV2,proof:CatalogFolderAuthority,backendIdentity:string,signal?:AbortSignal):Promise<CatalogFolderOutcomeV2> {
    request=parseCatalogFolderRequestV2(request);if(signal?.aborted)throw new CatalogFolderError("cancelled");
    const parsed=request;
    return this.admission?this.admission.run(parsed.rootId,()=>this.#ensure(parsed,proof,backendIdentity,signal),signal):this.#ensure(parsed,proof,backendIdentity,signal);
  }
  async #ensure(request:CatalogFolderRequestV2,proof:CatalogFolderAuthority,backendIdentity:string,signal?:AbortSignal):Promise<CatalogFolderOutcomeV2> {
    if(this.#active>=4)throw new CatalogFolderError("admission_full");this.#active++;
    const lockId=randomUUID(),keys=[`catalog-folder:${request.operationId}`,`upload-target:${request.parentId}:${request.name.toLowerCase()}`,`resource:${request.parentId}`];let locked=false;
    try {
      const deadline=Date.now()+2000;
      do {if(signal?.aborted)throw new CatalogFolderError("cancelled");locked=await this.repository.acquireLocks(lockId,keys,new Date(Date.now()+3600000));if(locked)break;await new Promise(resolve=>setTimeout(resolve,25));}while(Date.now()<deadline);
      if(!locked)throw new CatalogFolderError("admission_full");
      const prepared=await this.coordinator.prepare(request,proof,backendIdentity,signal);if(prepared.outcome)return prepared.outcome;
      if(prepared.phase!=="prepared")throw new CatalogFolderError("reconciliation_required");
      const token=randomUUID();let claimed:PreparedCatalogFolderV2;
      try{claimed=await this.coordinator.claim(prepared,proof,token);}catch(error){
        const current=await this.coordinator.inspect(prepared,proof).catch(()=>undefined);if(current?.outcome)return current.outcome;
        if(current?.phase==="physical_pending"&&current.claimToken===token){await this.coordinator.markUnknown(current).catch(()=>undefined);throw new CatalogFolderError("reconciliation_required",{cause:error});}
        throw error;
      }
      if(claimed.outcome)return claimed.outcome;if(claimed.phase!=="physical_pending"||claimed.claimToken!==token)throw new CatalogFolderError("reconciliation_required");
      try {
        if(signal?.aborted)throw new CatalogFolderError("cancelled");await this.storage.mkdir(claimed.storagePath);
        const committed=await this.coordinator.commit(claimed,proof,signal);if(!committed.outcome)throw new CatalogFolderError("projection_mismatch");return committed.outcome;
      }catch(error){
        const current=await this.coordinator.inspect(claimed,proof).catch(()=>undefined);if(current?.outcome)return current.outcome;
        await this.coordinator.markUnknown(claimed).catch(()=>undefined);throw new CatalogFolderError("reconciliation_required",{cause:error});
      }
    }finally{try{if(locked)await this.repository.releaseLocks(lockId);}finally{this.#active--;}}
  }
}
