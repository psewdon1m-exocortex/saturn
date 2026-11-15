import type { Database } from "@saturn/database";
import { z } from "zod";
import type { MetadataExportBudget } from "./types.js";
import { inspectSmallBatchRegistry, smallBatchTables } from "./small-batch-coherence.js";
import {inspectSmallExecutionJobs} from './small-execution-coherence.js';

const decimalCount = z.string().regex(/^(0|[1-9][0-9]*)$/).max(20);
export const coherenceSchema = z.object({
  schema: z.literal("saturn.backup-coherence.v1"), snapshotId: z.string().regex(/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/),
  snapshotStartedAt: z.string().min(1).max(100),
  journal: z.object({ shape: z.enum(["legacy", "sync-root-journal.v1"]),
    registeredRoots: decimalCount, changes: decimalCount, boundOperations: decimalCount,
    pendingOperations: decimalCount, finalReceipts: decimalCount,
    dumpPolicy: z.enum(["legacy-transient", "durable-journal-with-upload-dependencies"]),
    uploadIntents: decimalCount.optional(), uploadReceipts: decimalCount.optional(),
    catalogIntents: decimalCount.optional(), catalogResults: decimalCount.optional(),
    catalogGuardShape: z.enum(["folder-only-g1.v1","folder-file-cas-cj04.v1"]).optional(), catalogGuardRoots: decimalCount.optional(),
    activeRuntimeShape: z.literal("saturn.catalog-active.v1").optional(), activeRuntimeRoots: decimalCount.optional(),
    catalogUploadShape:z.literal("saturn.catalog-upload-execution.v1").optional(),catalogUploadOperations:decimalCount.optional(),
    catalogFolderV2Shape:z.literal("saturn.catalog-folder-intent.v2").optional(),catalogFolderV2Operations:decimalCount.optional(),
    folderRevalidationShape:z.literal("saturn.catalog-folder-revalidation-intent.v1").optional(),folderRevalidationOperations:decimalCount.optional(),
    smallBatchShape:z.literal("saturn.small-file-batch.v1").optional(),smallBatchOperations:decimalCount.optional(),
    smallBatches:decimalCount.optional(),smallBatchMetadataBytes:decimalCount.optional(),
    smallExecutionJobShape:z.literal('saturn.small-execution-job.v1').optional(),smallExecutionJobs:decimalCount.optional(),smallExecutionMembers:decimalCount.optional(),
    namespaceShape: z.literal("saturn.current-namespace.v1").optional(), namespaceBindings: decimalCount.optional(), metadataVersions: decimalCount.optional(),
  }).strict().superRefine((value,context)=>{
    const jobFields=[value.smallExecutionJobShape,value.smallExecutionJobs,value.smallExecutionMembers];
    if(jobFields.filter(v=>v!==undefined).length%3!==0
      ||(jobFields.slice(1).some(v=>v!==undefined&&v!=='0')&&value.dumpPolicy!=='durable-journal-with-upload-dependencies'))
      context.addIssue({code:'custom',message:'Incomplete execution job coherence shape'});
    const batchFields=[value.smallBatchShape,value.smallBatchOperations,value.smallBatches,value.smallBatchMetadataBytes];
    if(batchFields.filter(v=>v!==undefined).length%4!==0
      ||(batchFields.slice(1).some(v=>v!==undefined&&v!=="0")&&value.dumpPolicy!=="durable-journal-with-upload-dependencies"))
      context.addIssue({code:"custom",message:"Incomplete small batch coherence shape"});
    if((value.folderRevalidationShape===undefined)!==(value.folderRevalidationOperations===undefined)
      ||(value.folderRevalidationOperations!==undefined&&value.folderRevalidationOperations!=="0"&&value.dumpPolicy!=="durable-journal-with-upload-dependencies")
      ||(value.folderRevalidationOperations!==undefined&&/^(0|[1-9][0-9]{0,19})$/.test(value.folderRevalidationOperations)
        &&/^(0|[1-9][0-9]{0,19})$/.test(value.boundOperations)&&BigInt(value.folderRevalidationOperations)>BigInt(value.boundOperations)))
      context.addIssue({code:"custom",message:"Incomplete folder revalidation coherence shape"});
    if ((value.activeRuntimeShape === undefined) !== (value.activeRuntimeRoots === undefined)
      || (value.activeRuntimeRoots !== undefined && value.activeRuntimeRoots !== "0" && value.dumpPolicy !== "durable-journal-with-upload-dependencies"))
      context.addIssue({code:"custom",message:"Incomplete ACTIVE deployment coherence shape"});
    if((value.catalogFolderV2Shape===undefined)!==(value.catalogFolderV2Operations===undefined)
      ||(value.catalogFolderV2Operations!==undefined&&value.catalogFolderV2Operations!=="0"&&value.dumpPolicy!=="durable-journal-with-upload-dependencies"))
      context.addIssue({code:"custom",message:"Incomplete modern folder coherence shape"});
    if((value.catalogUploadShape===undefined)!==(value.catalogUploadOperations===undefined)
      ||(value.catalogUploadOperations!==undefined&&value.catalogUploadOperations!=="0"&&value.dumpPolicy!=="durable-journal-with-upload-dependencies"))
      context.addIssue({code:"custom",message:"Incomplete catalog upload execution coherence shape"});
    if((value.catalogGuardShape===undefined)!==(value.catalogGuardRoots===undefined)
      ||(value.catalogGuardRoots!==undefined&&value.catalogGuardRoots!=="0"&&value.dumpPolicy!=="durable-journal-with-upload-dependencies"))
      context.addIssue({code:"custom",message:"Incomplete catalog guard coherence shape"});
    if((value.catalogIntents===undefined)!==(value.catalogResults===undefined)
      ||(value.catalogIntents!==undefined&&value.catalogResults!==undefined
        && /^(0|[1-9][0-9]{0,19})$/.test(value.catalogIntents) && /^(0|[1-9][0-9]{0,19})$/.test(value.catalogResults)
        &&(BigInt(value.catalogResults)>BigInt(value.catalogIntents)||(value.catalogIntents!=="0"&&value.dumpPolicy!=="durable-journal-with-upload-dependencies"))))
      context.addIssue({code:"custom",message:"Incomplete or inconsistent catalog folder coherence shape"});
    if ([value.namespaceShape,value.namespaceBindings,value.metadataVersions].filter(v=>v!==undefined).length % 3 !== 0)
      context.addIssue({code:"custom",message:"Incomplete current namespace coherence shape"});
    if (value.namespaceBindings !== undefined && value.namespaceBindings!=="0" && value.dumpPolicy!=="durable-journal-with-upload-dependencies")
      context.addIssue({code:"custom",message:"Namespace binding requires durable recovery dependencies"});
    if (value.namespaceBindings!==undefined && /^(0|[1-9][0-9]{0,19})$/.test(value.namespaceBindings)
      && /^(0|[1-9][0-9]{0,19})$/.test(value.registeredRoots) && BigInt(value.namespaceBindings)>BigInt(value.registeredRoots))
      context.addIssue({code:"custom",message:"Namespace binding exceeds registered roots"});
    if((value.uploadIntents===undefined)!==(value.uploadReceipts===undefined)) {
      context.addIssue({code:"custom",message:"Incomplete upload publication coherence counts"});
    }
    if(value.uploadIntents!==undefined && value.uploadReceipts!==undefined
      && /^(0|[1-9][0-9]{0,19})$/.test(value.uploadIntents) && /^(0|[1-9][0-9]{0,19})$/.test(value.uploadReceipts)
      && (BigInt(value.uploadReceipts)>BigInt(value.uploadIntents)
        || (value.uploadIntents!=="0" && value.dumpPolicy!=="durable-journal-with-upload-dependencies"))) {
      context.addIssue({code:"custom",message:"Inconsistent upload publication coherence policy"});
    }
  }),
  clockCutMember: z.enum(["metadata/sync_root_clock.jsonl"]).nullable(),
  databaseDumpSha256: z.string().regex(/^[a-f0-9]{64}$/), metadataAuthority: z.literal("diagnostic-only-same-cut"),
  registeredRootRecovery: z.literal("blocked-requires-backend-reconciliation"),
}).strict();

export interface RecoverySnapshot {
  readonly snapshotId: string;
  readonly startedAt: string;
  readonly signal: AbortSignal;
  readonly journal: JournalSnapshotState;
  readonly exportBudget?: MetadataExportBudget;
  query<T extends readonly Record<string, unknown>[]>(text: string, parameters?: readonly unknown[]): Promise<T>;
}

export interface JournalSnapshotState {
  readonly shape: "legacy" | "sync-root-journal.v1";
  readonly registeredRoots: string;
  readonly changes: string;
  readonly boundOperations: string;
  readonly pendingOperations: string;
  readonly finalReceipts: string;
  readonly dumpPolicy: "legacy-transient" | "durable-journal-with-upload-dependencies";
  readonly uploadIntents?: string | undefined;
  readonly uploadReceipts?: string | undefined;
  readonly catalogIntents?: string | undefined;
  readonly catalogResults?: string | undefined;
  readonly catalogGuardShape?: "folder-only-g1.v1"|"folder-file-cas-cj04.v1" | undefined;
  readonly catalogGuardRoots?: string | undefined;
  readonly activeRuntimeShape?: "saturn.catalog-active.v1" | undefined;
  readonly activeRuntimeRoots?: string | undefined;
  readonly catalogUploadShape?:"saturn.catalog-upload-execution.v1"|undefined;
  readonly catalogUploadOperations?:string|undefined;
  readonly catalogFolderV2Shape?:"saturn.catalog-folder-intent.v2"|undefined;
  readonly catalogFolderV2Operations?:string|undefined;
  readonly folderRevalidationShape?:"saturn.catalog-folder-revalidation-intent.v1"|undefined;
  readonly folderRevalidationOperations?:string|undefined;
  readonly smallBatchShape?:"saturn.small-file-batch.v1"|undefined;
  readonly smallBatchOperations?:string|undefined;
  readonly smallBatches?:string|undefined;
  readonly smallBatchMetadataBytes?:string|undefined;
  readonly smallExecutionJobShape?:'saturn.small-execution-job.v1'|undefined;
  readonly smallExecutionJobs?:string|undefined;
  readonly smallExecutionMembers?:string|undefined;
  readonly namespaceShape?: "saturn.current-namespace.v1" | undefined;
  readonly namespaceBindings?: string | undefined;
  readonly metadataVersions?: string | undefined;
}

type RecoverySql = Parameters<Parameters<Database["transaction"]>[0]>[0];

// This is a schema/cut check, not proof of writer coverage or backend bytes.
export async function inspectJournal(sql: Pick<RecoverySql, "unsafe">): Promise<JournalSnapshotState> {
  const columns = await sql.unsafe<{ table_name: string; column_name: string; data_type: string }[]>(`
    SELECT table_name,column_name,data_type FROM information_schema.columns
    WHERE table_schema='public' AND (table_name IN ('sync_root_clock','sync_root_changes','catalog_guard_roots','sync_small_batch_budget','sync_small_batch_operations','sync_small_batches','sync_small_execution_jobs')
      OR (table_name='operation_journal' AND (column_name LIKE 'sync_%' OR column_name LIKE 'catalog_%'
        OR column_name IN ('upload_intent','upload_intent_hash','upload_receipt','upload_published_version_id')
        OR column_name LIKE 'upload_execution%' OR column_name LIKE 'upload_effect_%' OR column_name LIKE 'upload_transfer%' OR column_name LIKE 'upload_last_transfer%' OR column_name LIKE 'upload_claim_%'))
      OR (table_name='resources' AND (column_name LIKE 'metadata_%' OR column_name LIKE 'sync_availability%')))
  `);
  const required: Record<string, Record<string, string>> = {
    sync_root_clock: { root_id: "uuid", epoch: "uuid", published_seq: "bigint", retained_after_seq: "bigint", updated_at: "timestamp with time zone" },
    sync_root_changes: { root_id: "uuid", epoch: "uuid", seq: "bigint", node_id: "uuid", operation_id: "uuid", document: "jsonb", committed_at: "timestamp with time zone" },
    operation_journal: { sync_root_id: "uuid", sync_epoch: "uuid", sync_first_seq: "bigint", sync_last_seq: "bigint", sync_intent_hash: "text", sync_result: "jsonb" },
  };
  const empty = { registeredRoots: "0", changes: "0", boundOperations: "0", pendingOperations: "0", finalReceipts: "0" };
  if (columns.length === 0) return { shape: "legacy", ...empty, dumpPolicy: "legacy-transient" };
  for (const [table, fields] of Object.entries(required)) for (const [column, type] of Object.entries(fields)) {
    if (!columns.some(row => row.table_name === table && row.column_name === column && row.data_type === type)) {
      throw new Error("Unknown or incomplete sync journal schema; recovery is blocked");
    }
  }
  const uploadFields:Record<string,string>={upload_intent:'jsonb',upload_intent_hash:'text',upload_receipt:'jsonb',upload_published_version_id:'uuid'};
  const executionFields:Record<string,string>={upload_execution:'jsonb',upload_effect_state:'text',upload_transfer:'jsonb',upload_last_transfer:'jsonb',upload_claim_token:'uuid'};
  const catalogFields:Record<string,string>={catalog_intent:'jsonb',catalog_effect_state:'text'};
  const folderV2Fields:Record<string,string>={catalog_claim_token:'uuid'};
  const namespaceFields:Record<string,Record<string,string>>={resources:{metadata_version:'uuid',sync_availability:'text'},sync_root_clock:{namespace_state:'text',binding_version:'uuid',descriptor_schema:'text'}};
  const guardFields:Record<string,string>={root_id:'uuid',guard_revision:'uuid',writer_contract:'text',runtime_role:'text',writer_login:'text',writer_owner:'text',backend_identity:'text',control_ancestor_ids:'ARRAY'};
  for(const row of columns)if(!(row.column_name in (required[row.table_name] ?? {}))
    && !smallBatchTables.some(table=>table===row.table_name)
    && row.table_name!=='sync_small_execution_jobs'
    && !(row.table_name==='operation_journal'&&['upload_execution_job','upload_transfer_backend_task'].includes(row.column_name)&&row.data_type==='uuid')
    && !(row.column_name in (namespaceFields[row.table_name] ?? {}))
    && !(row.table_name==='catalog_guard_roots'&&(row.column_name in guardFields||row.column_name==='active_runtime'))
    && !(row.table_name==='operation_journal' && (row.column_name in uploadFields||row.column_name in catalogFields||row.column_name in executionFields||row.column_name in folderV2Fields))) throw new Error('Unknown sync namespace/journal schema; recovery is blocked');
  const hasFolderV2Shape=columns.some(row=>row.table_name==='operation_journal'&&row.column_name in folderV2Fields);
  const registryFunctions=(await sql.unsafe<{present:boolean;small_batch_function?:boolean}[]>(`SELECT to_regprocedure('public.catalog_folder_v2_command(text,jsonb,jsonb,jsonb)') IS NOT NULL AS present,
    to_regprocedure('public.sync_small_batch_command(text,jsonb,jsonb,jsonb)') IS NOT NULL AS small_batch_function`))[0];
  const hasFolderV2Function=registryFunctions?.present;
  const hasSmallBatch=columns.some(row=>smallBatchTables.some(table=>table===row.table_name));
  if(hasSmallBatch!==Boolean(registryFunctions?.small_batch_function))throw new Error('Incomplete small batch registry schema; recovery is blocked');
  const smallBatch=hasSmallBatch?await inspectSmallBatchRegistry(sql,columns):undefined;
  const smallExecution=await inspectSmallExecutionJobs(sql,columns);
  if(columns.some(c=>c.table_name==='operation_journal'&&c.column_name==='upload_transfer_backend_task')){
    const replayable=(await sql.unsafe<{ready:boolean}[]>(`SELECT to_regprocedure('public.catalog_upload_replayable_chunk_v1()') IS NOT NULL
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operation_journal'::regclass AND conname='operation_upload_transfer_backend_task' AND contype='c' AND convalidated) AS ready`))[0]?.ready;
    if(!replayable)throw new Error('Incomplete replayable transfer schema; recovery is blocked');
  }
  if(hasFolderV2Shape!==hasFolderV2Function)throw new Error('Unknown or incomplete modern folder schema; recovery is blocked');
  if(hasFolderV2Shape){
    for(const[column,type]of Object.entries(folderV2Fields))if(!columns.some(row=>row.table_name==='operation_journal'&&row.column_name===column&&row.data_type===type))throw new Error('Unknown modern folder claim schema; recovery is blocked');
    const ready=(await sql.unsafe<{ready:boolean}[]>(`SELECT
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operation_journal'::regclass AND conname='operation_catalog_folder_shape' AND contype='c' AND convalidated)
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass AND tgname='operation_catalog_folder_v2_claim_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.catalog_folder_v2_command(text,jsonb,jsonb,jsonb)') AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, pg_temp'])
      AND to_regprocedure('public.catalog_folder_v2_stored(public.operation_journal,boolean)') IS NOT NULL
      AND to_regprocedure('public.catalog_folder_v2_intent_valid(jsonb)') IS NOT NULL
      AND to_regprocedure('public.catalog_folder_shape_v1(public.operation_journal)') IS NOT NULL AS ready`))[0]?.ready;
    if(!ready)throw new Error('Unknown modern folder constraints/functions; recovery is blocked');
  }
  const hasExecutionShape=columns.some(row=>row.table_name==='operation_journal'&&row.column_name in executionFields);
  const activeColumn = columns.find(row => row.table_name === 'catalog_guard_roots' && row.column_name === 'active_runtime');
  const migrationTable=(await sql.unsafe<{present:boolean}[]>(`SELECT to_regclass('public._vault_migrations') IS NOT NULL AS present`))[0]?.present;
  const lifecycleRequired = migrationTable ? (await sql.unsafe<{required:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM public._vault_migrations WHERE name='0065_sync_lifecycle') AS required`))[0]?.required === true : false;
  // Migration 65 preserves the original validator as _v1 and adds an SQL
  // wrapper for adopted roots. Admit that exact generation, not any language.
  const activeFunctions = await sql.unsafe<{name:string;ready:boolean}[]>(`SELECT p.proname AS name,
    p.proconfig=ARRAY['search_path=pg_catalog, pg_temp'] AND
      ((p.oid=to_regprocedure('public.catalog_guard_active_shape(jsonb)') AND p.prorettype='bool'::regtype AND p.provolatile='i' AND NOT p.prosecdef
        AND l.lanname='${lifecycleRequired ? "sql" : "plpgsql"}'
        ${lifecycleRequired ? `AND EXISTS(SELECT 1 FROM pg_proc original JOIN pg_language language ON language.oid=original.prolang
          WHERE original.oid=to_regprocedure('public.catalog_guard_active_shape_v1(jsonb)') AND original.prorettype='bool'::regtype
            AND original.provolatile='i' AND NOT original.prosecdef AND language.lanname='plpgsql'
            AND original.proconfig=ARRAY['search_path=pg_catalog, pg_temp'])` : ""})
       OR (p.proname IN ('catalog_guard_active_valid','catalog_guard_activation_preflight') AND p.provolatile='s' AND NOT p.prosecdef AND l.lanname='sql')
       OR (p.proname IN ('catalog_guard_activate_empty','catalog_guard_backend_uncertain','outside_folder_commit') AND p.prosecdef AND l.lanname='plpgsql')
       OR (p.proname IN ('outside_folder_identity_guard','outside_folder_pending_guard') AND NOT p.prosecdef AND p.prorettype='trigger'::regtype AND l.lanname='plpgsql')) AS ready
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.proname IN ('catalog_guard_active_shape','catalog_guard_active_valid','catalog_guard_activation_preflight','catalog_guard_activate_empty','catalog_guard_backend_uncertain','outside_folder_commit','outside_folder_identity_guard','outside_folder_pending_guard') LIMIT 9`);
  const privateReadFunctions=await sql.unsafe<{name:string;ready:boolean}[]>(`SELECT p.proname AS name,
    NOT p.prosecdef AND p.provolatile='s' AND p.prorettype='bool'::regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']
      AND ((p.oid=to_regprocedure('public.catalog_upload_private_read(public.operation_journal)') AND l.lanname='plpgsql')
        OR (p.oid=to_regprocedure('public.catalog_guard_read_admission(uuid,uuid,uuid,uuid)') AND l.lanname='sql')) AS ready
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.proname IN ('catalog_upload_private_read','catalog_guard_read_admission') LIMIT 3`);
  const privateReadRequired=migrationTable?(await sql.unsafe<{required:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM public._vault_migrations WHERE name='0057_private_transfer_read_admission') AS required`))[0]?.required:false;
  const activeRequired = migrationTable ? (await sql.unsafe<{required:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM public._vault_migrations WHERE name='0058_guarded_runtime_activation') AS required`))[0]?.required : false;
  const revalidationFunctions=await sql.unsafe<{name:string;ready:boolean}[]>(`SELECT p.proname AS name,
    p.proconfig=ARRAY['search_path=pg_catalog, pg_temp'] AND
      ((p.oid=to_regprocedure('public.catalog_folder_revalidation_command(text,jsonb,jsonb)') AND p.prosecdef AND p.provolatile='v' AND l.lanname='plpgsql')
       OR (p.oid=to_regprocedure('public.catalog_folder_revalidation_input(jsonb)') AND NOT p.prosecdef AND p.provolatile='i' AND l.lanname='plpgsql')
       OR (p.oid=to_regprocedure('public.catalog_folder_revalidation_hash(jsonb)') AND NOT p.prosecdef AND p.provolatile='i' AND l.lanname='sql')
       OR (p.oid=to_regprocedure('public.catalog_folder_revalidation_shape(public.operation_journal)') AND NOT p.prosecdef AND p.provolatile='i' AND l.lanname='plpgsql')
       OR (p.oid=to_regprocedure('public.guard_catalog_folder_revalidation()') AND NOT p.prosecdef AND p.prorettype='trigger'::regtype AND l.lanname='plpgsql')) AS ready
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='public' AND p.proname IN ('catalog_folder_revalidation_command','catalog_folder_revalidation_input','catalog_folder_revalidation_hash','catalog_folder_revalidation_shape','guard_catalog_folder_revalidation') LIMIT 6`);
  const revalidationRequired=(await sql.unsafe<{required:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM public.operation_journal WHERE operation_type='folder_revalidate')
    ${migrationTable?"OR EXISTS(SELECT 1 FROM public._vault_migrations WHERE name='0059_offline_folder_revalidation')":""} AS required`))[0]?.required;
  const hasRevalidation=revalidationFunctions.length!==0;
  if((hasRevalidation||revalidationRequired)&&(revalidationFunctions.length!==5||revalidationFunctions.some(f=>!f.ready)))
    throw new Error('Unknown or incomplete folder revalidation schema; recovery is blocked');
  if(hasRevalidation){
    const ready=(await sql.unsafe<{ready:boolean}[]>(`SELECT
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operation_journal'::regclass AND conname='operation_folder_revalidation_shape' AND contype='c' AND convalidated)
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass AND tgname='operation_folder_revalidation_guard' AND tgenabled IN ('O','A') AND tgfoid=to_regprocedure('public.guard_catalog_folder_revalidation()'))
      AND NOT EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.operation_type='folder_revalidate' AND public.catalog_folder_revalidation_shape(j) IS DISTINCT FROM true) AS ready`))[0]?.ready;
    if(!ready)throw new Error('Unknown folder revalidation constraints/history; recovery is blocked');
  }
  if ((activeColumn !== undefined || activeFunctions.length !== 0 || activeRequired)
    && (activeColumn?.data_type !== 'jsonb' || activeFunctions.length !== 8 || activeFunctions.some(f => !f.ready) || !hasExecutionShape))
    throw new Error('Unknown or incomplete ACTIVE deployment schema; recovery is blocked');
  if (activeColumn) {
    const ready = (await sql.unsafe<{ready:boolean}[]>(`SELECT
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.catalog_guard_roots'::regclass AND conname='catalog_guard_active_shape' AND contype='c' AND convalidated)
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass AND tgname='outside_folder_original_guard' AND tgenabled IN ('O','A') AND tgfoid=to_regprocedure('public.outside_folder_identity_guard()'))
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.resources'::regclass AND tgname='outside_folder_pending_identity_guard' AND tgenabled IN ('O','A') AND tgfoid=to_regprocedure('public.outside_folder_pending_guard()'))
      AND NOT EXISTS(SELECT 1 FROM public.catalog_guard_roots g WHERE g.active_runtime IS NOT NULL AND NOT public.catalog_guard_active_valid(g)) AS ready`))[0]?.ready;
    if (!ready) throw new Error('Unknown ACTIVE deployment constraints/metadata; recovery is blocked');
  }
  if(privateReadRequired&&privateReadFunctions.length!==2)throw new Error('Unknown or incomplete private transfer read admission; recovery is blocked');
  if(privateReadFunctions.length!==0 && (privateReadFunctions.length!==2||!hasExecutionShape||privateReadFunctions.some(p=>!p.ready)))
    throw new Error('Unknown or incomplete private transfer read admission; recovery is blocked');
  if(hasExecutionShape){
    for(const [column,type]of Object.entries(executionFields))if(!columns.some(row=>row.table_name==='operation_journal'&&row.column_name===column&&row.data_type===type))throw new Error('Unknown or incomplete catalog upload execution schema; recovery is blocked');
    const ready=(await sql.unsafe<{ready:boolean}[]>(`SELECT
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operation_journal'::regclass AND conname='operation_catalog_upload_shape' AND contype='c' AND convalidated)
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass AND tgname='operation_catalog_upload_execution_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.catalog_upload_command(text,jsonb,jsonb,jsonb)') AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, pg_temp'])
      AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.catalog_guard_upgrade_file(uuid)') AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, pg_temp'])
      AND NOT EXISTS(SELECT 1 FROM public.catalog_guard_roots WHERE writer_contract NOT IN ('folder-only-g1.v1','folder-file-cas-cj04.v1')) AS ready`))[0]?.ready;
    if(!ready)throw new Error('Unknown catalog upload constraints/functions; recovery is blocked');
  }
  const hasGuardShape=columns.some(row=>row.table_name==='catalog_guard_roots');
  if(hasGuardShape) {
    for(const [column,type] of Object.entries(guardFields))if(!columns.some(row=>row.table_name==='catalog_guard_roots'&&row.column_name===column&&row.data_type===type))
      throw new Error('Unknown or incomplete catalog guard schema; recovery is blocked');
    const guardReady=(await sql.unsafe<{ready:boolean}[]>(`SELECT
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='catalog_guard_roots' AND column_name='control_ancestor_ids' AND udt_name='_uuid')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.catalog_guard_roots'::regclass AND contype='p')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.catalog_guard_roots'::regclass AND contype='f' AND confrelid='public.sync_root_clock'::regclass)
      AND to_regclass('public.operation_sync_unresolved_read_admission') IS NOT NULL
      AND
      (SELECT count(*)=12 FROM pg_trigger WHERE tgrelid IN ('public.resources'::regclass,'public.file_versions'::regclass,'public.upload_sessions'::regclass,'public.operation_journal'::regclass,'public.sync_root_clock'::regclass,'public.sync_root_changes'::regclass)
        AND tgname IN ('catalog_guard_rows','catalog_guard_truncate') AND tgenabled IN ('O','A'))
      AND (SELECT count(*)=2 FROM pg_trigger WHERE tgrelid='public.catalog_guard_roots'::regclass AND tgname IN ('catalog_guard_registration','catalog_guard_policy_truncate') AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.devices'::regclass AND tgname='catalog_guard_device_binding' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.catalog_folder_command(text,jsonb,jsonb)') AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']) AS ready`))[0]?.ready;
    if(!guardReady)throw new Error('Unknown catalog guard constraints/functions; recovery is blocked');
  }
  const hasCatalogShape=columns.some(row=>row.table_name==='operation_journal'&&row.column_name in catalogFields);
  if(hasCatalogShape)for(const [column,type] of Object.entries(catalogFields))if(!columns.some(row=>row.table_name==='operation_journal'&&row.column_name===column&&row.data_type===type))
    throw new Error('Unknown or incomplete catalog folder schema; recovery is blocked');
  const hasNamespaceShape=columns.some(row=>row.column_name in (namespaceFields[row.table_name] ?? {}));
  if(hasNamespaceShape)for(const [table,fields] of Object.entries(namespaceFields))for(const [column,type] of Object.entries(fields)) {
    if(!columns.some(row=>row.table_name===table && row.column_name===column && row.data_type===type)) throw new Error('Unknown or incomplete current namespace schema; recovery is blocked');
  }
  const hasUploadShape=columns.some(row=>row.table_name==='operation_journal' && row.column_name in uploadFields);
  if(hasUploadShape)for(const [column,type] of Object.entries(uploadFields)) {
    if(!columns.some(row=>row.table_name==='operation_journal' && row.column_name===column && row.data_type===type)) {
      throw new Error('Unknown or incomplete upload publication schema; recovery is blocked');
    }
  }
  // The immutable receipt guard and FKs are part of the supported shape.
  const guard = await sql.unsafe<{ ready: boolean }[]>(`SELECT
    EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass
      AND tgname='operation_sync_receipt_guard' AND tgenabled IN ('O','A'))
    AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sync_root_changes'::regclass AND contype='p')
    AND (SELECT count(*)=2 FROM pg_constraint WHERE conrelid='public.sync_root_changes'::regclass AND contype='f')
    ${hasUploadShape ? `AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass AND tgname='operation_upload_publication_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.upload_sessions'::regclass AND tgname='sealed_upload_session_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass AND tgname='operation_upload_publication_truncate_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.upload_sessions'::regclass AND tgname='sealed_upload_session_truncate_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operation_journal'::regclass AND conname='operation_upload_publication_shape' AND contype='c')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operation_journal'::regclass AND confrelid='public.file_versions'::regclass AND contype='f')` : ''}
    ${hasNamespaceShape ? `AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.resources'::regclass AND tgname='resource_metadata_version_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.sync_root_clock'::regclass AND tgname='namespace_binding_version_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.resources'::regclass AND conname='resources_sync_availability_shape' AND contype='c')
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.sync_root_clock'::regclass AND conname='sync_root_namespace_shape' AND contype='c')` : ''}
    ${hasCatalogShape ? `AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass AND tgname='operation_catalog_folder_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass AND tgname='operation_catalog_folder_truncate_guard' AND tgenabled IN ('O','A'))
      AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operation_journal'::regclass AND conname='operation_catalog_folder_shape' AND contype='c')` : ''}
    AS ready`);
  if (!guard[0]?.ready) throw new Error("Unknown sync journal constraints; recovery is blocked");
  const counts = (await sql.unsafe<{ registered_roots: string; changes: string; bound_operations: string; pending_operations: string; final_receipts: string;upload_intents?:string;upload_receipts?:string;catalog_intents?:string;catalog_results?:string;namespace_bindings?:string;metadata_versions?:string;catalog_guard_roots?:string;catalog_upload_operations?:string;catalog_folder_v2_operations?:string;active_runtime_roots?:string;folder_revalidation_operations?:string }[]>(`
    SELECT (SELECT count(*)::text FROM public.sync_root_clock) AS registered_roots,
      (SELECT count(*)::text FROM public.sync_root_changes) AS changes,
      count(*) FILTER (WHERE sync_root_id IS NOT NULL)::text AS bound_operations,
      count(*) FILTER (WHERE sync_root_id IS NOT NULL AND sync_result IS NULL)::text AS pending_operations,
      count(*) FILTER (WHERE sync_root_id IS NOT NULL AND sync_result IS NOT NULL)::text AS final_receipts
      ${hasUploadShape ? `,count(*) FILTER(WHERE upload_intent IS NOT NULL)::text AS upload_intents,
        count(*) FILTER(WHERE upload_receipt IS NOT NULL)::text AS upload_receipts` : ''}
      ${hasCatalogShape ? `,count(*) FILTER(WHERE catalog_intent IS NOT NULL)::text AS catalog_intents,
        count(*) FILTER(WHERE catalog_intent IS NOT NULL AND sync_result IS NOT NULL)::text AS catalog_results` : ''}
      ${hasNamespaceShape ? `,(SELECT count(*)::text FROM public.sync_root_clock WHERE namespace_state<>'LEGACY') AS namespace_bindings,
        (SELECT count(*)::text FROM public.resources WHERE metadata_version IS NOT NULL) AS metadata_versions` : ''}
      ${hasGuardShape ? `,(SELECT count(*)::text FROM public.catalog_guard_roots) AS catalog_guard_roots` : ''}
      ${activeColumn ? `,(SELECT count(*)::text FROM public.catalog_guard_roots WHERE active_runtime IS NOT NULL) AS active_runtime_roots` : ''}
      ${hasExecutionShape?`,count(*) FILTER(WHERE upload_execution IS NOT NULL)::text AS catalog_upload_operations`:''}
      ${hasFolderV2Shape?`,count(*) FILTER(WHERE catalog_intent->>'schema'='saturn.catalog-folder-intent.v2')::text AS catalog_folder_v2_operations`:''}
      ${hasRevalidation?`,count(*) FILTER(WHERE operation_type='folder_revalidate')::text AS folder_revalidation_operations`:''}
    FROM public.operation_journal
  `))[0];
  if (counts === undefined) throw new Error("Journal snapshot counts are unavailable");
  if (counts.registered_roots === "0" && (counts.changes !== "0" || counts.bound_operations !== "0")) throw new Error("Orphan durable journal state; recovery is blocked");
  return { shape: "sync-root-journal.v1", registeredRoots: counts.registered_roots, changes: counts.changes,
    ...smallBatch,
    ...smallExecution,
    boundOperations: counts.bound_operations, pendingOperations: counts.pending_operations, finalReceipts: counts.final_receipts,
    ...(hasUploadShape ? {uploadIntents:counts.upload_intents ?? '0',uploadReceipts:counts.upload_receipts ?? '0'} : {}),
    ...(hasCatalogShape ? {catalogIntents:counts.catalog_intents??'0',catalogResults:counts.catalog_results??'0'} : {}),
    ...(hasGuardShape ? {catalogGuardShape:hasExecutionShape?'folder-file-cas-cj04.v1' as const:'folder-only-g1.v1' as const,catalogGuardRoots:counts.catalog_guard_roots??'0'} : {}),
    ...(activeColumn ? {activeRuntimeShape:'saturn.catalog-active.v1' as const,activeRuntimeRoots:counts.active_runtime_roots??'0'} : {}),
    ...(hasExecutionShape?{catalogUploadShape:'saturn.catalog-upload-execution.v1' as const,catalogUploadOperations:counts.catalog_upload_operations??'0'}:{}),
    ...(hasFolderV2Shape?{catalogFolderV2Shape:'saturn.catalog-folder-intent.v2' as const,catalogFolderV2Operations:counts.catalog_folder_v2_operations??'0'}:{}),
    ...(hasRevalidation?{folderRevalidationShape:'saturn.catalog-folder-revalidation-intent.v1' as const,folderRevalidationOperations:counts.folder_revalidation_operations??'0'}:{}),
    ...(hasNamespaceShape ? {namespaceShape:'saturn.current-namespace.v1' as const,namespaceBindings:counts.namespace_bindings ?? '0',metadataVersions:counts.metadata_versions ?? '0'} : {}),
    dumpPolicy: counts.registered_roots === "0" && (counts.upload_intents ?? '0') === '0' && (counts.catalog_intents??'0')==='0' ? "legacy-transient" : "durable-journal-with-upload-dependencies" };
}

export function assertUnregisteredRecovery(state: JournalSnapshotState): void {
  if (state.registeredRoots !== "0" || state.boundOperations !== "0" || state.changes !== "0"
    || (state.smallBatchOperations??'0')!=='0'||(state.smallBatches??'0')!=='0'||(state.smallBatchMetadataBytes??'0')!=='0'
    || (state.smallExecutionJobs??'0')!=='0'||(state.smallExecutionMembers??'0')!=='0'
    || (state.uploadIntents ?? '0') !== '0' || (state.uploadReceipts ?? '0') !== '0' || (state.catalogIntents??'0')!=='0' || (state.catalogResults??'0')!=='0' || (state.catalogGuardRoots??'0')!=='0'||(state.catalogUploadOperations??'0')!=='0'||(state.catalogFolderV2Operations??'0')!=='0'||(state.activeRuntimeRoots??'0')!=='0'||(state.folderRevalidationOperations??'0')!=='0') {
    throw new Error("Durable sync roots or sealed upload identities require explicit backend reconciliation; automatic recovery is blocked");
  }
}

export async function guardRecoveryMutation(sql: Pick<RecoverySql, "unsafe">): Promise<void> {
  const shape = await inspectJournal(sql);
  if (shape.shape !== "legacy") {
    // Prevent a registration/receipt transaction from committing between this
    // check and schema replacement. No HTTP/SFTP occurs under these locks.
    await sql.unsafe("LOCK TABLE public.sync_root_clock,public.sync_root_changes,public.operation_journal IN SHARE MODE");
    assertUnregisteredRecovery(await inspectJournal(sql));
  }
}

export async function withRecoverySnapshot<T>(database: Database, timeoutMs: number, signal: AbortSignal | undefined,
  action: (snapshot: RecoverySnapshot) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Consistent backup snapshot deadline exceeded")), timeoutMs);
  const combined = signal === undefined ? timeout.signal : AbortSignal.any([timeout.signal, signal]);
  try {
    combined.throwIfAborted();
    return await database.transaction(async sql => {
      await sql.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await sql.unsafe(`SET LOCAL statement_timeout = '${String(Math.min(timeoutMs, 10_000))}ms'`);
      await sql.unsafe(`SET LOCAL idle_in_transaction_session_timeout = '${String(timeoutMs)}ms'`);
      const query = async <R extends readonly Record<string, unknown>[]>(text: string, parameters: readonly unknown[] = []): Promise<R> => {
        combined.throwIfAborted();
        const pending = sql.unsafe<R & Record<string, unknown>[]>(text, [...parameters] as never[]);
        const abort = () => { pending.cancel(); };
        combined.addEventListener("abort", abort, { once: true });
        try { const result = await pending; combined.throwIfAborted(); return result as R; }
        finally { combined.removeEventListener("abort", abort); }
      };
      const journal = await inspectJournal({ unsafe: query } as Pick<RecoverySql, "unsafe">);
      combined.throwIfAborted();
      const row = (await query<{ snapshot_id: string; started_at: string }[]>(
        "SELECT pg_export_snapshot() AS snapshot_id, transaction_timestamp()::text AS started_at"))[0];
      if (row === undefined || !/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/.test(row.snapshot_id)) throw new Error("Invalid exported PostgreSQL snapshot identity");
      const result = await action({ snapshotId: row.snapshot_id, startedAt: row.started_at, journal, signal: combined, query });
      combined.throwIfAborted();
      return result;
    });
  } catch(error) {
    if(timeout.signal.aborted)throw new Error('Consistent backup snapshot deadline exceeded',{cause:error});
    throw error;
  } finally { clearTimeout(timer); }
}
