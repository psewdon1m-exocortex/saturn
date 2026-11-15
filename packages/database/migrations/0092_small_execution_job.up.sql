-- R01 admission primitive only: immutable jobs for <=16 new small siblings.
-- No HTTP capability is enabled here. Originals, transfers and receipts remain
-- in the existing journal; no physical effect occurs in this transaction.
LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before job migration'; END IF;
END $$;
INSERT INTO sync_extension_function_backup VALUES(92,'catalog_upload_command(text,jsonb,jsonb,jsonb)',pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure));
INSERT INTO sync_extension_function_backup VALUES(92,'sync_policy_admission()',pg_get_functiondef('sync_policy_admission()'::regprocedure));
INSERT INTO sync_extension_function_backup VALUES(92,'catalog_guard_read_admission(uuid,uuid,uuid,uuid)',pg_get_functiondef('catalog_guard_read_admission(uuid,uuid,uuid,uuid)'::regprocedure));
ALTER TABLE sync_small_batch_budget ADD COLUMN execution_metadata_bytes bigint NOT NULL DEFAULT 0 CHECK(execution_metadata_bytes BETWEEN 0 AND 2147483647);
CREATE FUNCTION guard_small_execution_budget() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.execution_metadata_bytes<OLD.execution_metadata_bytes THEN RAISE EXCEPTION 'execution metadata budget cannot rewind'; END IF;
 IF NEW.metadata_bytes+NEW.execution_metadata_bytes>2147483647 THEN RAISE EXCEPTION 'admission_full'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER small_execution_budget_guard BEFORE INSERT OR UPDATE ON sync_small_batch_budget FOR EACH ROW EXECUTE FUNCTION guard_small_execution_budget();
REVOKE ALL ON FUNCTION guard_small_execution_budget() FROM PUBLIC;
CREATE TABLE sync_small_execution_jobs(
 id uuid PRIMARY KEY,
 root_id uuid NOT NULL REFERENCES catalog_guard_roots(root_id),
 device_id uuid NOT NULL REFERENCES devices(id),
 job_key text NOT NULL CHECK(job_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 plan_bytes text NOT NULL CHECK(octet_length(plan_bytes) BETWEEN 1 AND 1048576),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 members uuid[] NOT NULL CHECK(cardinality(members) BETWEEN 1 AND 16),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(root_id,device_id,job_key)
);
ALTER TABLE operation_journal ADD COLUMN upload_execution_job uuid REFERENCES sync_small_execution_jobs(id);
CREATE FUNCTION guard_small_execution_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE; plan jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'execution job is immutable'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=NEW.root_id;
 IF NOT FOUND OR current_user<>g.writer_owner OR session_user<>g.writer_login OR g.writer_contract<>'folder-file-cas-cj04.v1' THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 plan:=NEW.plan_bytes::jsonb;
 IF public.sync_small_batch_plan_valid(plan) IS NOT TRUE OR NEW.manifest_sha256<>encode(sha256(convert_to(NEW.plan_bytes,'UTF8')),'hex')
   OR NEW.job_key IS DISTINCT FROM plan->'manifest'->>'batch_id' OR NEW.root_id::text IS DISTINCT FROM plan->'manifest'->>'root_id'
   OR cardinality(NEW.members)<>jsonb_array_length(plan->'inputs')
   OR (SELECT count(DISTINCT id) FROM unnest(NEW.members) id)<>cardinality(NEW.members) THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
 RETURN NEW;
END $$;
-- The membership and all originals commit together, even though the immutable
-- job must exist before each row's admission trigger can consume its credit.
CREATE FUNCTION check_small_execution_job_members() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE plan jsonb;
BEGIN
 plan:=NEW.plan_bytes::jsonb;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'inputs') WITH ORDINALITY a(value,ord)
     LEFT JOIN public.operation_journal j ON j.id=NEW.members[a.ord::integer]
     WHERE j.id IS NULL OR j.sync_root_id IS DISTINCT FROM NEW.root_id OR j.upload_intent IS DISTINCT FROM a.value->'intent'
       OR j.upload_intent->>'deviceId' IS DISTINCT FROM NEW.device_id::text OR j.upload_intent_hash IS DISTINCT FROM public.catalog_upload_hash(a.value->'intent')
       OR j.idempotency_key IS DISTINCT FROM a.value->'intent'->>'idempotencyKey' OR j.upload_execution_job IS DISTINCT FROM NEW.id) THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER small_execution_job_guard BEFORE INSERT OR UPDATE OR DELETE ON sync_small_execution_jobs FOR EACH ROW EXECUTE FUNCTION guard_small_execution_job();
CREATE CONSTRAINT TRIGGER small_execution_job_members AFTER INSERT ON sync_small_execution_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_small_execution_job_members();
CREATE TRIGGER small_execution_job_no_truncate BEFORE TRUNCATE ON sync_small_execution_jobs FOR EACH STATEMENT EXECUTE FUNCTION sync_small_batch_no_truncate();
CREATE FUNCTION guard_small_execution_member() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.upload_execution_job IS NOT DISTINCT FROM OLD.upload_execution_job THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'execution job membership is immutable'; END IF;
 IF NEW.upload_execution_job IS NULL THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sync_small_execution_jobs e CROSS JOIN LATERAL unnest(e.members) WITH ORDINALITY m(id,ord)
   WHERE e.id=NEW.upload_execution_job AND m.id=NEW.id AND e.root_id=NEW.sync_root_id
     AND e.plan_bytes::jsonb->'inputs'->(m.ord::integer-1)->'intent'=NEW.upload_intent
     AND NEW.upload_effect_state='transport' AND NEW.sync_result IS NULL) THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER operation_small_execution_member BEFORE INSERT OR UPDATE ON operation_journal FOR EACH ROW EXECUTE FUNCTION guard_small_execution_member();
REVOKE ALL ON FUNCTION guard_small_execution_job(),check_small_execution_job_members(),guard_small_execution_member() FROM PUBLIC;

CREATE FUNCTION catalog_upload_accept_job_v1(credential jsonb,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE; d public.devices%ROWTYPE; p public.resources%ROWTYPE;
 saved public.sync_small_execution_jobs%ROWTYPE; plan jsonb; inputs jsonb; binding jsonb; wire text; root uuid; parent uuid; results jsonb; entries jsonb; registry jsonb; replayed boolean; execute_job boolean:=false;
 chain uuid[]:='{}'; inroot uuid[]:='{}'; cur uuid; n integer:=0; rh integer:=-1; topology jsonb:='[]'; paths jsonb:='[]';
BEGIN
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>(CASE WHEN payload ? 'execute' OR payload ? 'readOnly' THEN 2 ELSE 1 END)
   OR (payload ? 'execute' AND payload->'execute' IS DISTINCT FROM 'true'::jsonb)
   OR (payload ? 'readOnly' AND payload->'readOnly' IS DISTINCT FROM 'true'::jsonb)
   OR jsonb_typeof(payload->'planBytes') IS DISTINCT FROM 'string' OR octet_length(payload->>'planBytes') NOT BETWEEN 1 AND 1048576
   OR jsonb_typeof(credential) IS DISTINCT FROM 'object' OR octet_length(credential::text)>512
   OR (SELECT count(*) FROM jsonb_object_keys(credential))<>3 OR NOT credential ?& ARRAY['deviceId','tokenHash','deviceKind']
   OR jsonb_typeof(credential->'deviceId') IS DISTINCT FROM 'string' OR credential->>'deviceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(credential->'tokenHash') IS DISTINCT FROM 'string' OR credential->>'tokenHash' !~ '^[a-f0-9]{64}$'
   OR jsonb_typeof(credential->'deviceKind') IS DISTINCT FROM 'string' OR credential->>'deviceKind' NOT IN ('windows_sync','pluto') THEN RAISE EXCEPTION 'invalid_input'; END IF;
 wire:=payload->>'planBytes';plan:=wire::jsonb;execute_job:=payload ? 'execute';
 IF public.sync_small_batch_plan_valid(plan) IS NOT TRUE OR jsonb_array_length(plan->'inputs') NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 inputs:=plan->'inputs';binding:=(plan->'manifest')-ARRAY['schema','batch_id','rules_version','items'];
 root:=(binding->>'root_id')::uuid;parent:=(inputs->0->'intent'->>'parentId')::uuid;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(inputs) a WHERE a->'intent'->>'rootId' IS DISTINCT FROM root::text
   OR a->'intent'->>'parentId' IS DISTINCT FROM parent::text OR a->'intent'->>'deviceId' IS DISTINCT FROM credential->>'deviceId'
   OR a->'intent'->>'deviceKind' IS DISTINCT FROM credential->>'deviceKind' OR a->'intent'->>'requireAbsent' IS DISTINCT FROM 'true'
   OR a->'intent'->>'targetId' IS NOT NULL OR a->'intent'->>'expectedVersionId' IS NOT NULL
   OR (a->'intent'->>'sizeBytes')::bigint NOT BETWEEN 1 AND 262144) THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=root;
 IF NOT FOUND OR g.writer_contract<>'folder-file-cas-cj04.v1' OR current_user<>g.writer_owner OR session_user<>g.writer_login
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(inputs) a WHERE a->>'backendIdentity' IS DISTINCT FROM g.backend_identity) THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=root FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 SELECT * INTO d FROM public.devices WHERE id=(credential->>'deviceId')::uuid FOR SHARE;
 SELECT * INTO p FROM public.resources WHERE id=root;
 IF NOT FOUND OR d.id IS NULL OR d.state<>'active' OR NOT d.can_write OR d.token_hash IS DISTINCT FROM credential->>'tokenHash'
   OR d.device_kind IS DISTINCT FROM credential->>'deviceKind' OR d.sync_root_id IS DISTINCT FROM root OR d.scope_ids IS DISTINCT FROM ARRAY[root]
   OR (d.expires_at IS NOT NULL AND d.expires_at<=now()) OR p.status<>'active' OR p.type<>'folder'
   OR p.parent_id IS DISTINCT FROM (CASE WHEN d.device_kind='windows_sync' THEN '00000000-0000-7000-8000-000000000004'::uuid ELSE '00000000-0000-7000-8000-000000000009'::uuid END) THEN RAISE EXCEPTION 'authorization_changed'; END IF;
 SELECT * INTO saved FROM public.sync_small_execution_jobs WHERE root_id=root AND device_id=d.id AND job_key=plan->'manifest'->>'batch_id';
 replayed:=FOUND;
 IF (execute_job OR payload ? 'readOnly') AND NOT replayed THEN RAISE EXCEPTION 'batch_missing'; END IF;
 IF replayed AND saved.plan_bytes IS DISTINCT FROM wire THEN RAISE EXCEPTION 'operation_reused'; END IF;
 IF NOT replayed THEN
   IF c.epoch::text IS DISTINCT FROM binding->>'server_epoch' OR c.binding_version::text IS DISTINCT FROM binding->>'binding_version'
     OR c.descriptor_schema IS DISTINCT FROM binding->>'descriptor_schema'
     OR NOT (c.namespace_state='QUALIFYING' OR c.namespace_state='ACTIVE' AND public.catalog_guard_active_valid(g))
     OR (g.active_runtime IS NOT NULL AND (g.active_runtime->>'serverIdentity' IS DISTINCT FROM binding->>'server_identity'
       OR g.active_runtime->>'policyVersion' IS DISTINCT FROM binding->>'policy_version')) THEN RAISE EXCEPTION 'binding_invalid'; END IF;
   -- Admission of the next job waits for the previous unresolved work. Existing
   -- ordinary operations keep their former four-original ceiling unchanged.
   IF EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL) THEN RAISE EXCEPTION 'admission_full'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(inputs) a JOIN public.operation_journal j ON j.idempotency_key=a->'intent'->>'idempotencyKey') THEN RAISE EXCEPTION 'operation_reused'; END IF;
   IF c.namespace_state='ACTIVE' AND EXISTS(SELECT 1 FROM jsonb_array_elements(inputs) a WHERE (a->'intent'->>'sizeBytes')::numeric>(g.active_runtime->>'maximumFileBytes')::numeric) THEN RAISE EXCEPTION 'upload_too_large'; END IF;
   cur:=parent;
   LOOP
     IF cur=ANY(chain) OR n>130 THEN RAISE EXCEPTION 'membership_changed'; END IF;
     SELECT * INTO p FROM public.resources WHERE id=cur;
     IF NOT FOUND OR p.type<>'folder' OR p.status<>'active' OR (rh<0 AND p.metadata_version IS NULL) OR octet_length(p.storage_path)>4096 THEN RAISE EXCEPTION 'membership_changed'; END IF;
     chain:=array_append(chain,cur);
     IF rh<0 THEN inroot:=array_append(inroot,cur);topology:=topology||jsonb_build_array(jsonb_build_object('nodeId',p.id,'parentId',CASE WHEN p.id=root THEN NULL ELSE p.parent_id END,'name',p.name));paths:=paths||jsonb_build_array(jsonb_build_object('nodeId',p.id,'storagePath',p.storage_path)); END IF;
     IF cur=root THEN rh:=n; END IF;
     IF cur<>root AND EXISTS(SELECT 1 FROM public.sync_root_clock WHERE root_id=cur) THEN RAISE EXCEPTION 'membership_changed'; END IF;
     IF p.parent_id IS NULL THEN EXIT; END IF;cur:=p.parent_id;n:=n+1;
   END LOOP;
   IF cur<>'00000000-0000-7000-8000-000000000001'::uuid OR rh<0 OR rh>=128 THEN RAISE EXCEPTION 'membership_changed'; END IF;
   PERFORM id FROM public.resources WHERE id=ANY(chain) ORDER BY id FOR NO KEY UPDATE;
   IF EXISTS(SELECT 1 FROM unnest(chain) WITH ORDINALITY q(id,ord) LEFT JOIN public.resources r ON r.id=q.id
     WHERE r.id IS NULL OR r.parent_id IS DISTINCT FROM chain[q.ord::integer+1] OR r.type<>'folder' OR r.status<>'active')
     OR (SELECT jsonb_agg(jsonb_build_object('nodeId',r.id,'parentId',CASE WHEN r.id=root THEN NULL ELSE r.parent_id END,'name',r.name) ORDER BY q.ord)
       FROM unnest(inroot) WITH ORDINALITY q(id,ord) JOIN public.resources r ON r.id=q.id) IS DISTINCT FROM topology
     OR (SELECT jsonb_agg(jsonb_build_object('nodeId',r.id,'storagePath',r.storage_path) ORDER BY q.ord)
       FROM unnest(inroot) WITH ORDINALITY q(id,ord) JOIN public.resources r ON r.id=q.id) IS DISTINCT FROM paths THEN RAISE EXCEPTION 'membership_changed'; END IF;
   SELECT * INTO p FROM public.resources WHERE id=parent;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(inputs) a WHERE a->'intent'->'parentTopology' IS DISTINCT FROM topology
     OR octet_length(rtrim(p.storage_path,'/')||'/'||(a->'intent'->>'name'))>4096) THEN RAISE EXCEPTION 'membership_changed'; END IF;
   IF (SELECT count(DISTINCT lower(a->'intent'->>'name')) FROM jsonb_array_elements(inputs) a)<>jsonb_array_length(inputs)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(inputs) a JOIN public.resources r ON r.parent_id=parent AND lower(r.name)=lower(a->'intent'->>'name') AND r.status<>'trashed') THEN RAISE EXCEPTION 'precondition_failed'; END IF;
   registry:=public.sync_small_batch_command('register',binding,credential,plan);
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(registry->'items') a WHERE a->>'admitted' IS DISTINCT FROM 'true' OR a->>'uploadId' IS NOT NULL) THEN RAISE EXCEPTION 'operation_reused'; END IF;
   -- Exact plan bytes and the UUID membership array share the existing root
   -- metadata ceiling with transport declarations, including future old jobs.
   UPDATE public.sync_small_batch_budget SET execution_metadata_bytes=execution_metadata_bytes+octet_length(wire)+16*jsonb_array_length(inputs) WHERE root_id=root;
   IF NOT FOUND THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
   SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'node',gen_random_uuid(),'version',gen_random_uuid(),'token',gen_random_uuid(),
     'input',a.value,'hash',public.catalog_upload_hash(a.value->'intent')) ORDER BY a.ord) INTO entries FROM jsonb_array_elements(inputs) WITH ORDINALITY a(value,ord);
   SELECT jsonb_agg(a||jsonb_build_object('execution',jsonb_build_object('schema','saturn.catalog-upload-execution.v1','epoch',c.epoch,'bindingVersion',c.binding_version,
     'guardRevision',g.guard_revision,'backendIdentity',g.backend_identity,'nodeId',a->>'node','versionId',a->>'version','tempPath','_system/incoming/'||(a->>'id')||'.part',
     'targetPath',rtrim(p.storage_path,'/')||'/'||(a->'input'->'intent'->>'name'),'archivePath',NULL,'before',NULL,'pathTopology',paths)) ORDER BY ord) INTO entries FROM jsonb_array_elements(entries) WITH ORDINALITY e(a,ord);
   INSERT INTO public.upload_sessions(id,idempotency_key,parent_id,filename,temp_path,target_path,expected_size,expected_sha256,status,expires_at,require_absent,audit_actor_type,audit_actor_id)
   SELECT (a->>'id')::uuid,a->'input'->'intent'->>'idempotencyKey',parent,a->'input'->'intent'->>'name',a->'execution'->>'tempPath',a->'execution'->>'targetPath',
     (a->'input'->'intent'->>'sizeBytes')::bigint,a->'input'->'intent'->>'sha256','uploading',now()+interval '24 hours',true,'device_token',d.id::text FROM jsonb_array_elements(entries) a;
   INSERT INTO public.sync_small_execution_jobs(id,root_id,device_id,job_key,plan_bytes,manifest_sha256,members)
   VALUES(gen_random_uuid(),root,d.id,plan->'manifest'->>'batch_id',wire,encode(sha256(convert_to(wire,'UTF8')),'hex'),ARRAY(SELECT (a->>'id')::uuid FROM jsonb_array_elements(entries) WITH ORDINALITY e(a,ord) ORDER BY ord)) RETURNING * INTO saved;
   INSERT INTO public.operation_journal(id,operation_type,state,idempotency_key,upload_id,payload,upload_intent,upload_intent_hash,sync_root_id,sync_epoch,sync_intent_hash,upload_execution,upload_effect_state,upload_transfer,upload_transfer_backend_task,upload_execution_job)
   SELECT (a->>'id')::uuid,'upload','created',a->'input'->'intent'->>'idempotencyKey',(a->>'id')::uuid,jsonb_build_object('parentId',parent,'filename',a->'input'->'intent'->>'name'),
     a->'input'->'intent',a->>'hash',root,c.epoch,a->>'hash',a->'execution','transport',jsonb_build_object('token',a->>'token','offset','0','length',a->'input'->'intent'->>'sizeBytes','originalUploadId',a->>'id'),(a->>'token')::uuid,saved.id FROM jsonb_array_elements(entries) a;
 END IF;
 -- Reading accepted results never authorizes physical work. A separate fixed
 -- command rechecks the current entire job before issuing process-local permits.
 IF execute_job THEN
   IF c.epoch::text IS DISTINCT FROM binding->>'server_epoch' OR c.binding_version::text IS DISTINCT FROM binding->>'binding_version'
     OR c.descriptor_schema IS DISTINCT FROM binding->>'descriptor_schema' OR c.namespace_state<>'ACTIVE' OR NOT public.catalog_guard_active_valid(g)
     OR g.active_runtime->>'serverIdentity' IS DISTINCT FROM binding->>'server_identity'
     OR g.active_runtime->>'policyVersion' IS DISTINCT FROM binding->>'policy_version' THEN RAISE EXCEPTION 'binding_invalid'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.sync_root_policy WHERE root_id=root AND state='ACTIVE')
     OR NOT EXISTS(SELECT 1 FROM public.sync_backend_executor WHERE backend_identity=g.backend_identity AND state='RUNNING') THEN RAISE EXCEPTION 'backend_draining'; END IF;
   IF EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL AND NOT public.catalog_upload_private_read(j)) THEN RAISE EXCEPTION 'reconciliation_required'; END IF;
   IF EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.id=ANY(saved.members) AND j.sync_result IS NULL AND
     (j.upload_execution->>'guardRevision' IS DISTINCT FROM g.guard_revision::text
       OR (j.upload_intent->>'sizeBytes')::bigint>(g.active_runtime->>'maximumFileBytes')::bigint
       OR (j.upload_transfer IS NOT NULL AND j.upload_transfer_backend_task::text IS DISTINCT FROM j.upload_transfer->>'token'))) THEN RAISE EXCEPTION 'transfer_unresolved'; END IF;
 END IF;
 -- Current state is projected from the original journal, never a second mutable
 -- job state machine. A reconnect gets the same transfer and version identities.
 PERFORM id FROM public.operation_journal WHERE id=ANY(saved.members) ORDER BY id FOR SHARE;
 PERFORM id FROM public.upload_sessions WHERE id=ANY(saved.members) ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM public.operation_journal j JOIN public.upload_sessions u ON u.id=j.id WHERE j.id=ANY(saved.members))<>cardinality(saved.members) THEN RAISE EXCEPTION 'projection_mismatch'; END IF;
 SELECT jsonb_agg(jsonb_build_object('operationId',j.idempotency_key,'originalUploadId',j.id,'transfer',j.upload_transfer,
   'current',jsonb_build_object('execution',j.upload_execution,'claimToken',j.upload_claim_token,'session',jsonb_build_object(
     'uploadId',j.id,'operationId',j.id,'rootId',root,'intentHash',j.upload_intent_hash,'expectedSizeBytes',u.expected_size::text,
     'receivedSizeBytes',u.received_size::text,'phase',j.upload_effect_state,'transferPending',j.upload_transfer IS NOT NULL),'result',j.sync_result,'replayed',replayed)) ORDER BY m.ord)
 INTO results FROM unnest(saved.members) WITH ORDINALITY m(id,ord) JOIN public.operation_journal j ON j.id=m.id JOIN public.upload_sessions u ON u.id=j.id;
 RETURN jsonb_build_object('schema','saturn.small-execution-job.v1','manifestSha256',saved.manifest_sha256,'items',results,'replayed',replayed,'executionAdmitted',execute_job);
END $$;
REVOKE ALL ON FUNCTION catalog_upload_accept_job_v1(jsonb,jsonb) FROM PUBLIC;
DO $install$
DECLARE definition text; marker text; owner_name text;
BEGIN
 definition:=pg_get_functiondef('catalog_upload_command(text,jsonb,jsonb,jsonb)'::regprocedure);
 marker:=$body$ IF command='batch' THEN$body$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'job admission predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,$body$ IF command IN ('accept-job','start-job','status-job') THEN
   IF input IS DISTINCT FROM '{}'::jsonb OR jsonb_typeof(command_payload) IS DISTINCT FROM 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(command_payload))<>1 OR NOT command_payload ? 'planBytes' THEN RAISE EXCEPTION 'invalid_input'; END IF;
   RETURN public.catalog_upload_accept_job_v1(credential,CASE WHEN command='start-job' THEN command_payload||'{"execute":true}'::jsonb WHEN command='status-job' THEN command_payload||'{"readOnly":true}'::jsonb ELSE command_payload END);
 END IF;
 IF command='batch' THEN$body$);
 FOR owner_name IN SELECT DISTINCT writer_owner FROM public.catalog_guard_roots LOOP
   EXECUTE format('GRANT SELECT,INSERT ON public.sync_small_execution_jobs TO %I',owner_name);
   EXECUTE format('GRANT EXECUTE ON FUNCTION public.guard_small_execution_job(),public.check_small_execution_job_members(),public.guard_small_execution_member(),public.guard_small_execution_budget(),public.catalog_upload_accept_job_v1(jsonb,jsonb) TO %I',owner_name);
 END LOOP;
END $install$;

-- Admission credits count an immutable <=16-member metadata job once. Bytes
-- still count every original; large-file credits and actual backend workers
-- are unchanged. Only protected membership can consume the shared job credit.
DO $policy$
DECLARE definition text; marker text;
BEGIN
 definition:=replace(pg_get_functiondef('sync_policy_admission()'::regprocedure),E'\r\n',E'\n');
 marker:='ELSE (j.upload_intent->>''sizeBytes'')::bigint END bytes FROM public.operation_journal j';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'job policy upload projection mismatch'; END IF;
 definition:=replace(definition,marker,'ELSE (j.upload_intent->>''sizeBytes'')::bigint END bytes,coalesce(j.upload_execution_job,j.id) AS credit FROM public.operation_journal j');
 marker:='ELSE (s.input->''prepare''->''intent''->>''sizeBytes'')::bigint END FROM public.sync_stream_uploads s';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'job policy stream projection mismatch'; END IF;
 definition:=replace(definition,marker,'ELSE (s.input->''prepare''->''intent''->>''sizeBytes'')::bigint END,s.operation_id FROM public.sync_stream_uploads s');
 marker:='SELECT (j.namespace_intent->''input''->''source''->>''sizeBytes'')::bigint FROM public.operation_journal j';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'job policy clone projection mismatch'; END IF;
 definition:=replace(definition,marker,'SELECT (j.namespace_intent->''input''->''source''->>''sizeBytes'')::bigint,j.id FROM public.operation_journal j');
 marker:='coalesce(sum(bytes),0),count(*),count(*) FILTER';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'job policy credit count mismatch'; END IF;
 definition:=replace(definition,marker,'coalesce(sum(bytes),0),count(DISTINCT credit),count(*) FILTER');
 marker:=$body$OR jobs>=(CASE WHEN p.features ? 'scale-transfer-v2' THEN 8 ELSE 4 END)$body$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'job policy ceiling mismatch'; END IF;
 definition:=replace(definition,marker,$body$OR (jobs>=(CASE WHEN p.features ? 'scale-transfer-v2' THEN 8 ELSE 4 END)
   AND NOT (TG_TABLE_NAME='operation_journal' AND EXISTS(SELECT 1 FROM public.operation_journal j
     JOIN public.sync_small_execution_jobs e ON e.id=j.upload_execution_job
     WHERE e.id=(to_jsonb(NEW)->>'upload_execution_job')::uuid AND e.root_id=root AND (to_jsonb(NEW)->>'id')::uuid=ANY(e.members))))$body$);
 EXECUTE definition;
END $policy$;

-- Published-namespace reads may tolerate one bounded private job. The former
-- four-original path is unchanged, and any public claim/UNKNOWN still blocks.
CREATE OR REPLACE FUNCTION catalog_guard_read_admission(root uuid,epoch_value uuid,binding_value uuid,revision_value uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH pending AS MATERIALIZED (
   SELECT j AS journal,j.id,j.upload_execution_job AS job_id FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL LIMIT 17
 ) SELECT EXISTS(SELECT 1 FROM public.sync_root_clock c
   JOIN public.catalog_guard_roots g ON g.root_id=c.root_id JOIN public.resources r ON r.id=c.root_id
   WHERE c.root_id=root AND c.epoch=epoch_value AND c.binding_version=binding_value
     AND (c.namespace_state='QUALIFYING' OR c.namespace_state='ACTIVE' AND public.catalog_guard_active_valid(g)) AND c.descriptor_schema='saturn.current-namespace.v1'
     AND g.guard_revision=revision_value AND g.writer_contract IN ('folder-only-g1.v1','folder-file-cas-cj04.v1') AND r.status='active' AND r.type='folder'
     AND ((SELECT count(*) FROM pending)<=4 OR ((SELECT count(*) FROM pending)<=16
       AND (SELECT count(DISTINCT job_id) FROM pending)=1
       AND NOT EXISTS(SELECT 1 FROM pending p LEFT JOIN public.sync_small_execution_jobs e ON e.id=p.job_id
         WHERE e.id IS NULL OR e.root_id<>root OR NOT p.id=ANY(e.members))))
     AND NOT EXISTS(SELECT 1 FROM pending WHERE NOT public.catalog_upload_private_read(journal)))
$$;
DO $$ DECLARE runtime_name text; BEGIN
 FOR runtime_name IN SELECT DISTINCT runtime_role FROM catalog_guard_roots LOOP
   EXECUTE format('GRANT SELECT ON public.sync_small_execution_jobs TO %I',runtime_name);
 END LOOP;
END $$;
