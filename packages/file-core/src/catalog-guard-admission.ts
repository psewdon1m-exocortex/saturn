import type { TransactionSql } from "postgres";
import type { Database } from "@saturn/database";
import { CatalogFolderError } from "./catalog-folder-intent.js";

export interface GuardedNamespaceBinding {
  readonly rootId:string;readonly epoch:string;readonly bindingVersion:string;readonly guardRevision:string;
}
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export interface CatalogMutationGuard {assertOutside(nodeIds:readonly string[]):Promise<void>}
/** Cooperating current-binary fixture pre-I/O fence, under the offline enrollment/drain prerequisite.
 * It cannot fence an old process with a storage credential or arbitrary administrator/DDL. */
export class PostgresCatalogMutationGuard implements CatalogMutationGuard {
  constructor(private readonly database:Database) {}
  async assertOutside(nodeIds:readonly string[]):Promise<void> {
    if(nodeIds.length<1||nodeIds.length>500||nodeIds.some(id=>!UUID.test(id)))throw new CatalogFolderError("invalid_input");
    if(!await this.database.catalogGuardOutside(nodeIds))throw new CatalogFolderError("binding_invalid");
  }
}
/** Caller holds/acquires the root clock first. The qualified successor excludes only fixed-lifecycle
 * exclusive private uploads. Original public/UNKNOWN/folder operations still close admission.
 * Without the additive successor migration, preserve the original conservative prerequisite. */
export async function assertGuardedNamespaceAdmission(sql:TransactionSql,binding:GuardedNamespaceBinding):Promise<void> {
  if(Object.values(binding).some(v=>typeof v!=="string"||!UUID.test(v)))throw new CatalogFolderError("binding_invalid");
  const row=(await sql<{private_read_classifier:boolean}[]>`SELECT c.root_id,c.epoch,
    to_regprocedure('public.catalog_guard_read_admission(uuid,uuid,uuid,uuid)') IS NOT NULL AS private_read_classifier FROM public.sync_root_clock c
    WHERE c.root_id=${binding.rootId} FOR SHARE`)[0];
  if(!row)throw new CatalogFolderError("binding_invalid");
  if(row.private_read_classifier){
    const allowed=(await sql<{allowed:boolean}[]>`SELECT public.catalog_guard_read_admission(${binding.rootId}::uuid,${binding.epoch}::uuid,${binding.bindingVersion}::uuid,${binding.guardRevision}::uuid) AS allowed`)[0]?.allowed;
    if(!allowed)throw new CatalogFolderError("reconciliation_required");return;
  }
  const allowed=(await sql<{allowed:boolean}[]>`SELECT EXISTS(SELECT 1 FROM public.sync_root_clock c
    JOIN public.catalog_guard_roots g ON g.root_id=c.root_id
    JOIN public.resources r ON r.id=c.root_id
    WHERE c.root_id=${binding.rootId} AND c.epoch=${binding.epoch} AND c.binding_version=${binding.bindingVersion}
      AND c.namespace_state='QUALIFYING' AND c.descriptor_schema='saturn.current-namespace.v1'
      AND g.guard_revision=${binding.guardRevision} AND g.writer_contract IN ('folder-only-g1.v1','folder-file-cas-cj04.v1')
      AND r.status='active' AND r.type='folder'
      AND NOT EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.sync_root_id=c.root_id AND j.sync_result IS NULL)) AS allowed`)[0]?.allowed;
  if(!allowed)throw new CatalogFolderError("reconciliation_required");
}
