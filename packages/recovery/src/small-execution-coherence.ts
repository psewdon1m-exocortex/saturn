import type {Database} from '@saturn/database';
type RecoverySql=Parameters<Parameters<Database['transaction']>[0]>[0];
type Column=Readonly<{table_name:string;column_name:string;data_type:string}>;
const jobColumns:Record<string,string>={id:'uuid',root_id:'uuid',device_id:'uuid',job_key:'text',plan_bytes:'text',manifest_sha256:'text',members:'ARRAY',created_at:'timestamp with time zone'};
export interface SmallExecutionCoherence {
  readonly smallExecutionJobShape:'saturn.small-execution-job.v1';
  readonly smallExecutionJobs:string;
  readonly smallExecutionMembers:string;
}
/** Recovery-only structural/coherence checks in the same bounded snapshot.
 * No ingress cache, backend-byte proof or permission to execute a stored job. */
export async function inspectSmallExecutionJobs(sql:Pick<RecoverySql,'unsafe'>,columns:readonly Column[]):Promise<SmallExecutionCoherence|undefined>{
  const job=columns.filter(c=>c.table_name==='sync_small_execution_jobs'),member=columns.find(c=>c.table_name==='operation_journal'&&c.column_name==='upload_execution_job');
  const present=(await sql.unsafe<{present:boolean}[]>(`SELECT to_regprocedure('public.catalog_upload_accept_job_v1(jsonb,jsonb)') IS NOT NULL AS present`))[0]?.present;
  const budget=columns.find(c=>c.table_name==='sync_small_batch_budget'&&c.column_name==='execution_metadata_bytes');
  if(!job.length&&!member&&!present&&!budget)return;
  if(!present||member?.data_type!=='uuid'||budget?.data_type!=='bigint'||job.length!==Object.keys(jobColumns).length||job.some(c=>jobColumns[c.column_name]!==c.data_type))throw Error('Unknown execution job schema; recovery is blocked');
  const guards=(await sql.unsafe<{ready:boolean}[]>(`SELECT
    (SELECT count(*)=3 FROM pg_trigger WHERE tgrelid='public.sync_small_execution_jobs'::regclass AND tgenabled IN ('O','A') AND
      ((tgname='small_execution_job_guard' AND tgfoid=to_regprocedure('public.guard_small_execution_job()'))
       OR (tgname='small_execution_job_members' AND tgfoid=to_regprocedure('public.check_small_execution_job_members()') AND tgdeferrable AND tginitdeferred)
       OR (tgname='small_execution_job_no_truncate' AND tgfoid=to_regprocedure('public.sync_small_batch_no_truncate()'))))
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.operation_journal'::regclass AND tgname='operation_small_execution_member'
      AND tgenabled IN ('O','A') AND tgfoid=to_regprocedure('public.guard_small_execution_member()'))
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.sync_small_batch_budget'::regclass AND tgname='small_execution_budget_guard'
      AND tgenabled IN ('O','A') AND tgfoid=to_regprocedure('public.guard_small_execution_budget()'))
    AND (SELECT count(*)=2 FROM pg_constraint WHERE conrelid='public.sync_small_execution_jobs'::regclass AND contype='f' AND convalidated)
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.operation_journal'::regclass AND confrelid='public.sync_small_execution_jobs'::regclass AND contype='f' AND convalidated)
    AND (SELECT count(*)=2 FROM pg_constraint WHERE conrelid='public.sync_small_execution_jobs'::regclass AND contype IN ('p','u') AND convalidated)
    AND (SELECT count(*)=4 FROM pg_constraint WHERE conrelid='public.sync_small_execution_jobs'::regclass AND contype='c' AND convalidated) AS ready`))[0]?.ready;
  if(!guards)throw Error('Incomplete execution job guards; recovery is blocked');
  const invalidJob=`
      public.sync_small_batch_plan_valid(e.plan_bytes::jsonb) IS NOT TRUE
      OR encode(sha256(convert_to(e.plan_bytes,'UTF8')),'hex') IS DISTINCT FROM e.manifest_sha256
      OR e.root_id::text IS DISTINCT FROM e.plan_bytes::jsonb->'manifest'->>'root_id'
      OR e.job_key IS DISTINCT FROM e.plan_bytes::jsonb->'manifest'->>'batch_id'
      OR cardinality(e.members)<>jsonb_array_length(e.plan_bytes::jsonb->'inputs')
      OR cardinality(e.members)<>(SELECT count(DISTINCT id) FROM unnest(e.members) id)
      OR NOT EXISTS(SELECT 1 FROM public.sync_small_batches b WHERE b.root_id=e.root_id AND b.device_id=e.device_id AND b.batch_key=e.job_key AND b.plan=e.plan_bytes::jsonb)
      OR EXISTS(SELECT 1 FROM unnest(e.members) WITH ORDINALITY m(id,ord) LEFT JOIN public.operation_journal j ON j.id=m.id
        WHERE j.id IS NULL OR j.upload_execution_job IS DISTINCT FROM e.id OR j.sync_root_id IS DISTINCT FROM e.root_id
          OR j.upload_intent IS DISTINCT FROM e.plan_bytes::jsonb->'inputs'->(m.ord::integer-1)->'intent'
          OR j.upload_intent->>'deviceId' IS DISTINCT FROM e.device_id::text)`;
  const state=(await sql.unsafe<{valid:boolean;jobs:string;members:string}[]>(`SELECT
    NOT EXISTS(SELECT 1 FROM public.operation_journal j LEFT JOIN public.sync_small_execution_jobs e ON e.id=j.upload_execution_job
      WHERE j.upload_execution_job IS NOT NULL AND (e.id IS NULL OR NOT j.id=ANY(e.members)))
    AND NOT EXISTS(SELECT 1 FROM public.sync_small_batch_budget b FULL JOIN
      (SELECT root_id,sum(octet_length(plan_bytes)+16*cardinality(members)) AS bytes FROM public.sync_small_execution_jobs GROUP BY root_id) e USING(root_id)
      WHERE b.root_id IS NULL OR b.execution_metadata_bytes<>coalesce(e.bytes,0) OR b.metadata_bytes+b.execution_metadata_bytes>2147483647) AS valid,
    (SELECT count(*)::text FROM public.sync_small_execution_jobs) AS jobs,
    (SELECT coalesce(sum(cardinality(members)),0)::text FROM public.sync_small_execution_jobs) AS members`))[0];
  if(!state?.valid)throw Error('Incoherent execution job originals; recovery is blocked');
  // Preserve the same-cut predicates and deadlines while bounding expensive
  // plan checks independently of the total number of retained jobs.
  let cursor:string|null=null,checked=0n;
  for(;;){
    const page:{valid:boolean;count:number;last_id:string|null}|undefined=(await sql.unsafe<{valid:boolean;count:number;last_id:string|null}[]>(`
      WITH candidates AS MATERIALIZED (
        SELECT * FROM public.sync_small_execution_jobs WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 32
      ) SELECT NOT EXISTS(SELECT 1 FROM candidates e WHERE ${invalidJob}) AS valid,
        (SELECT count(*)::int FROM candidates) AS count,
        (SELECT id::text FROM candidates ORDER BY id DESC LIMIT 1) AS last_id
    `,[cursor]))[0];
    if(!page?.valid)throw Error('Incoherent execution job originals; recovery is blocked');
    if(!Number.isInteger(page.count)||page.count<0||page.count>32
      ||(page.count===0?page.last_id!==null:page.last_id===null||page.last_id===cursor))throw Error('Invalid execution job validation page; recovery is blocked');
    checked+=BigInt(page.count);
    if(page.count<32)break;
    cursor=page.last_id;
  }
  if(checked!==BigInt(state.jobs))throw Error('Incomplete execution job validation; recovery is blocked');
  return {smallExecutionJobShape:'saturn.small-execution-job.v1',smallExecutionJobs:state.jobs,smallExecutionMembers:state.members};
}
