-- Explicit operator-proved recovery of one original single-transfer create.
-- No timeout, age, reconnect or device request creates recovery authority.
SELECT pg_advisory_xact_lock(1397967206);
INSERT INTO sync_extension_function_backup
 SELECT 123,p.oid::regprocedure::text,pg_get_functiondef(p.oid) FROM pg_proc p
 WHERE p.oid IN ('public.catalog_guard_rows()'::regprocedure,'public.renew_namespace_binding_version()'::regprocedure,'public.guard_catalog_upload_execution()'::regprocedure,
 'public.catalog_guard_statement()'::regprocedure,'public.catalog_guard_resource_insert_set()'::regprocedure);

CREATE TABLE catalog_upload_recovery_plans(
 id uuid PRIMARY KEY,root_id uuid NOT NULL REFERENCES catalog_guard_roots(root_id),operation_id uuid NOT NULL REFERENCES operation_journal(id),
 journal_sha256 text NOT NULL CHECK(journal_sha256 ~ '^[a-f0-9]{64}$'),session_sha256 text NOT NULL CHECK(session_sha256 ~ '^[a-f0-9]{64}$'),
 pending_sha256 text NOT NULL CHECK(pending_sha256 ~ '^[a-f0-9]{64}$'),expected_clock jsonb NOT NULL,
 original_binding uuid NOT NULL,backend_generation uuid NOT NULL,stopped_receipt jsonb NOT NULL,device_token_hash text NOT NULL,
 physical_proof jsonb NOT NULL,verified_at timestamptz NOT NULL,fence_sha256 text NOT NULL CHECK(fence_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'PREPARED' CHECK(state IN ('PREPARED','APPLYING','APPLIED')),
 applying_transaction text,result jsonb,applied_at timestamptz
);
REVOKE ALL ON catalog_upload_recovery_plans FROM PUBLIC;
CREATE UNIQUE INDEX catalog_upload_one_applied_recovery ON catalog_upload_recovery_plans(operation_id) WHERE state IN ('APPLYING','APPLIED');
CREATE FUNCTION guard_catalog_upload_recovery_plan() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.catalog_guard_roots%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'recovery_evidence_immutable'; END IF;
 IF TG_OP='INSERT' THEN
   IF current_user<>session_user OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass)
     OR NEW.state<>'PREPARED' OR NEW.applying_transaction IS NOT NULL OR NEW.result IS NOT NULL OR NEW.applied_at IS NOT NULL
     THEN RAISE EXCEPTION 'operator_recovery_proof_required' USING ERRCODE='42501'; END IF;
 ELSE
   SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=OLD.root_id;
   IF NOT FOUND OR current_user<>session_user OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass)
     OR (to_jsonb(OLD)-ARRAY['state','applying_transaction','result','applied_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['state','applying_transaction','result','applied_at'])
     OR NOT (OLD.state='PREPARED' AND NEW.state='APPLYING' AND NEW.applying_transaction=pg_current_xact_id()::text AND NEW.result IS NULL AND NEW.applied_at IS NULL
       OR OLD.state='APPLYING' AND NEW.state='APPLIED' AND OLD.applying_transaction=pg_current_xact_id()::text AND NEW.applying_transaction=OLD.applying_transaction AND NEW.result IS NOT NULL AND NEW.applied_at IS NOT NULL)
     THEN RAISE EXCEPTION 'recovery_evidence_immutable' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_upload_recovery_evidence BEFORE INSERT OR UPDATE OR DELETE ON catalog_upload_recovery_plans FOR EACH ROW EXECUTE FUNCTION guard_catalog_upload_recovery_plan();

CREATE FUNCTION catalog_upload_recovery_statement_row(table_name text,old_row jsonb,new_row jsonb) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE p public.catalog_upload_recovery_plans%ROWTYPE;j public.operation_journal%ROWTYPE;e jsonb;i jsonb;
BEGIN
 IF current_user<>session_user OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass) THEN RETURN false; END IF;
 FOR p IN SELECT * FROM public.catalog_upload_recovery_plans WHERE state='APPLYING' AND applying_transaction=pg_current_xact_id()::text LOOP
   SELECT * INTO j FROM public.operation_journal WHERE id=p.operation_id;e:=j.upload_execution;i:=j.upload_intent;
   IF table_name='resources' AND old_row IS NULL THEN
     IF new_row->>'id'=e->>'nodeId' AND new_row->>'parent_id'=i->>'parentId' AND new_row->>'name'=i->>'name' AND new_row->>'type'='file'
       AND new_row->>'storage_path'=e->>'targetPath' AND new_row->>'current_version_id'=e->>'versionId' AND new_row->>'sha256'=i->>'sha256'
       AND new_row->>'size_bytes'=i->>'sizeBytes' AND new_row->>'status'='active' AND new_row->>'sync_availability'='AVAILABLE' THEN RETURN true; END IF;
   ELSIF table_name='file_versions' AND old_row IS NULL THEN
     IF new_row->>'id'=e->>'versionId' AND new_row->>'resource_id'=e->>'nodeId' AND new_row->>'storage_path'=e->>'targetPath'
       AND new_row->>'size_bytes'=i->>'sizeBytes' AND new_row->>'sha256'=i->>'sha256' AND new_row->>'state'='active' THEN RETURN true; END IF;
   ELSIF table_name='upload_sessions' AND old_row IS NOT NULL THEN
     IF old_row->>'id'=j.id::text AND new_row->>'id'=j.id::text AND old_row->>'status'='committing' AND new_row->>'status'='active'
       AND new_row->>'resource_id'=e->>'nodeId' AND (old_row-ARRAY['status','resource_id','updated_at'])=(new_row-ARRAY['status','resource_id','updated_at']) THEN RETURN true; END IF;
   ELSIF table_name='operation_journal' AND old_row IS NOT NULL THEN
     IF old_row->>'id'=p.operation_id::text AND new_row->>'id'=p.operation_id::text AND old_row->>'upload_effect_state'='reconciliation_required'
       AND new_row->>'upload_effect_state'='published' AND new_row->>'resource_id'=e->>'nodeId' AND new_row->>'upload_published_version_id'=e->>'versionId'
       AND encode(sha256(convert_to(old_row::text,'UTF8')),'hex')=p.journal_sha256 THEN RETURN true; END IF;
   ELSIF table_name='sync_root_changes' AND old_row IS NULL THEN
     IF new_row->>'root_id'=p.root_id::text AND new_row->>'operation_id'=p.operation_id::text AND (new_row->>'seq')::bigint>(p.expected_clock->>'seq')::bigint
       AND (new_row->>'seq')::bigint<=(p.expected_clock->>'seq')::bigint+129
       AND (new_row->>'node_id'=e->>'nodeId' OR EXISTS(SELECT 1 FROM jsonb_array_elements(e->'pathTopology') parent WHERE parent->>'nodeId'=new_row->>'node_id')) THEN RETURN true; END IF;
   END IF;
 END LOOP;RETURN false;
END $$;

CREATE FUNCTION catalog_upload_recover_original_v1(payload jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE plan public.catalog_upload_recovery_plans%ROWTYPE;g public.catalog_guard_roots%ROWTYPE;c public.sync_root_clock%ROWTYPE;
 j public.operation_journal%ROWTYPE;u public.upload_sessions%ROWTYPE;d public.devices%ROWTYPE;b public.sync_backend_executor%ROWTYPE;
 written public.sync_backend_tasks%ROWTYPE;renamed public.sync_backend_tasks%ROWTYPE;e jsonb;i jsonb;value jsonb;pending text;
 p public.resources%ROWTYPE;r public.resources%ROWTYPE;chain uuid[]:='{}';inroot uuid[]:='{}';cur uuid;n integer:=0;rh integer:=-1;
 topology jsonb:='[]';paths jsonb:='[]';seq bigint;firstseq bigint;published timestamptz;receipt jsonb;description jsonb;
BEGIN
 IF current_user<>session_user OR current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass)
   THEN RAISE EXCEPTION 'operator_recovery_proof_required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(payload))<>1
   OR jsonb_typeof(payload->'planId') IS DISTINCT FROM 'string' OR payload->>'planId' !~ '^[a-f0-9-]{36}$' THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO plan FROM public.catalog_upload_recovery_plans WHERE id=(payload->>'planId')::uuid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'operator_recovery_proof_required'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=plan.root_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=plan.root_id FOR UPDATE;
 SELECT * INTO j FROM public.operation_journal WHERE id=plan.operation_id FOR UPDATE;
 SELECT * INTO u FROM public.upload_sessions WHERE id=plan.operation_id FOR UPDATE;
 IF plan.state='APPLIED' THEN
   IF j.upload_effect_state<>'published' OR j.sync_result IS DISTINCT FROM plan.result->'publication' THEN RAISE EXCEPTION 'recovery_outcome_changed'; END IF;
   RETURN plan.result;
 END IF;
 IF plan.state<>'PREPARED' OR plan.verified_at>clock_timestamp() OR clock_timestamp()-plan.verified_at>interval '30 seconds' THEN RAISE EXCEPTION 'recovery_proof_expired'; END IF;
 SELECT * INTO b FROM public.sync_backend_executor WHERE backend_identity=g.backend_identity FOR UPDATE;
 IF NOT FOUND OR b.state<>'STOPPED' OR b.owner_id IS NOT NULL OR b.fencing_token IS NOT NULL OR b.generation<>plan.backend_generation
   OR b.stopped_receipt IS DISTINCT FROM plan.stopped_receipt OR b.stopped_receipt->'connectionsClosed' IS DISTINCT FROM 'true'::jsonb
   OR g.active_runtime->>'backendGeneration' IS DISTINCT FROM b.generation::text
   OR EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=g.backend_identity AND state IN ('QUEUED','RUNNING','UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.sync_backend_read_slots WHERE backend_identity=g.backend_identity) THEN RAISE EXCEPTION 'backend_not_drained'; END IF;
 IF c.namespace_state<>'BACKEND_UNCERTAIN' OR jsonb_build_object('epoch',c.epoch,'binding',c.binding_version,'seq',c.published_seq::text,'state',c.namespace_state) IS DISTINCT FROM plan.expected_clock
   OR public.catalog_guard_active_valid(g) IS DISTINCT FROM true THEN RAISE EXCEPTION 'recovery_binding_changed'; END IF;
 IF j.id IS NULL OR u.id IS NULL OR j.sync_root_id<>g.root_id OR j.state<>'committing' OR j.upload_effect_state<>'reconciliation_required' OR j.sync_result IS NOT NULL
   OR j.upload_claim_token IS NULL OR j.upload_transfer IS NOT NULL OR j.upload_publication_group IS NOT NULL OR j.upload_execution_job IS NOT NULL
   OR encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex')<>plan.journal_sha256
   OR encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex')<>plan.session_sha256 THEN RAISE EXCEPTION 'original_recovery_changed'; END IF;
 e:=j.upload_execution;i:=j.upload_intent;
 IF i->>'schema'<>'saturn.upload-intent.v2' OR NOT public.catalog_upload_intent_valid(i) OR j.upload_intent_hash IS DISTINCT FROM public.catalog_upload_hash(i)
   OR e->>'schema'<>'saturn.catalog-upload-execution.v1' OR e->'before' IS DISTINCT FROM 'null'::jsonb OR e->>'archivePath' IS NOT NULL
   OR i->>'targetId' IS NOT NULL OR i->>'expectedVersionId' IS NOT NULL OR i->'requireAbsent' IS DISTINCT FROM 'true'::jsonb
   OR e->>'guardRevision' IS DISTINCT FROM g.guard_revision::text OR e->>'epoch' IS DISTINCT FROM c.epoch::text
   OR e->>'bindingVersion' IS DISTINCT FROM plan.original_binding::text OR e->>'backendIdentity' IS DISTINCT FROM g.backend_identity
   OR u.expected_size NOT BETWEEN 1 AND 8388608 OR u.received_size<>u.expected_size OR u.expected_sha256 IS DISTINCT FROM i->>'sha256' OR u.actual_sha256 IS DISTINCT FROM i->>'sha256'
   OR u.expected_size::text IS DISTINCT FROM i->>'sizeBytes' OR u.status<>'committing'
   OR EXISTS(SELECT 1 FROM public.resources WHERE id=(e->>'nodeId')::uuid OR storage_path=e->>'targetPath')
   OR EXISTS(SELECT 1 FROM public.file_versions WHERE id=(e->>'versionId')::uuid OR resource_id=(e->>'nodeId')::uuid)
   OR EXISTS(SELECT 1 FROM public.sync_stream_uploads WHERE operation_id=j.id) THEN RAISE EXCEPTION 'unsupported_original_recovery'; END IF;
 PERFORM id FROM public.operation_journal WHERE sync_root_id=g.root_id AND sync_result IS NULL ORDER BY id FOR UPDATE;
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb)::text,'UTF8')),'hex') INTO pending
   FROM public.operation_journal x WHERE x.sync_root_id=g.root_id AND x.sync_result IS NULL;
 IF pending IS DISTINCT FROM plan.pending_sha256 OR EXISTS(SELECT 1 FROM public.operation_journal x WHERE x.sync_root_id=g.root_id AND x.sync_result IS NULL AND x.id<>j.id
     AND NOT coalesce(x.upload_execution IS NOT NULL AND x.upload_effect_state IN ('transport','verified') AND x.upload_claim_token IS NULL
       AND x.upload_execution->>'epoch'=e->>'epoch' AND x.upload_execution->>'bindingVersion'=e->>'bindingVersion'
       AND x.upload_execution->>'guardRevision'=e->>'guardRevision' AND x.upload_execution->>'backendIdentity'=g.backend_identity,false)) THEN RAISE EXCEPTION 'recovery_membership_changed'; END IF;
 SELECT * INTO d FROM public.devices WHERE id=(i->>'deviceId')::uuid FOR SHARE;
 IF NOT FOUND OR d.state<>'active' OR NOT d.can_read OR NOT d.can_write OR d.device_kind IS DISTINCT FROM i->>'deviceKind' OR d.sync_root_id<>g.root_id
   OR d.scope_ids IS DISTINCT FROM ARRAY[g.root_id] OR d.token_hash IS DISTINCT FROM plan.device_token_hash OR d.expires_at IS NOT NULL AND d.expires_at<=now()
   THEN RAISE EXCEPTION 'authorization_changed'; END IF;
 IF jsonb_typeof(plan.physical_proof) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(plan.physical_proof))<>6
   OR NOT plan.physical_proof ?& ARRAY['targetPath','sizeBytes','sha256','tempAbsent','writeTaskId','renameTaskId']
   OR plan.physical_proof->>'targetPath' IS DISTINCT FROM e->>'targetPath' OR plan.physical_proof->>'sizeBytes' IS DISTINCT FROM i->>'sizeBytes'
   OR plan.physical_proof->>'sha256' IS DISTINCT FROM i->>'sha256' OR plan.physical_proof->'tempAbsent' IS DISTINCT FROM 'true'::jsonb
   OR plan.physical_proof->>'writeTaskId' IS DISTINCT FROM j.upload_last_transfer->>'token'
   OR j.upload_last_transfer->>'offset'<>'0' OR j.upload_last_transfer->>'length' IS DISTINCT FROM i->>'sizeBytes'
   OR j.upload_last_transfer->>'originalUploadId' IS DISTINCT FROM j.id::text THEN RAISE EXCEPTION 'physical_recovery_proof_invalid'; END IF;
 SELECT * INTO written FROM public.sync_backend_tasks WHERE id=(plan.physical_proof->>'writeTaskId')::uuid FOR SHARE;
 SELECT * INTO renamed FROM public.sync_backend_tasks WHERE id=(plan.physical_proof->>'renameTaskId')::uuid FOR SHARE;
 IF written.id IS NULL OR renamed.id IS NULL OR written.state<>'DONE' OR renamed.state<>'DONE' OR written.command<>'write' OR renamed.command<>'rename'
   OR written.backend_identity<>g.backend_identity OR renamed.backend_identity<>g.backend_identity OR written.generation<>b.generation OR renamed.generation<>b.generation
   OR written.owner_id::text IS DISTINCT FROM b.stopped_receipt->>'ownerId' OR renamed.owner_id IS DISTINCT FROM written.owner_id
   OR written.fencing_token::text IS DISTINCT FROM b.stopped_receipt->>'fencingToken' OR renamed.fencing_token IS DISTINCT FROM written.fencing_token
   OR written.payload->>'path' IS DISTINCT FROM e->>'tempPath' OR written.payload->>'schema'<>'saturn.backend-write-once.v1'
   OR written.payload->'payloadRef'->>'sha256' IS DISTINCT FROM i->>'sha256' OR written.payload->'payloadRef'->>'size' IS DISTINCT FROM i->>'sizeBytes'
   OR written.result IS DISTINCT FROM to_jsonb(u.expected_size) OR renamed.payload IS DISTINCT FROM jsonb_build_object('source',e->>'tempPath','destination',e->>'targetPath')
   OR renamed.created_at<written.updated_at THEN RAISE EXCEPTION 'original_effect_receipt_invalid'; END IF;
 -- Recheck the complete original namespace preimage, including common
 -- ancestors. Only a create with one conclusively completed write+rename is
 -- supported; no overwrite adoption, compensation or physical replay.
 cur:=(i->>'parentId')::uuid;
 LOOP
   IF cur=ANY(chain) OR n>130 THEN RAISE EXCEPTION 'membership_changed'; END IF;
   SELECT * INTO p FROM public.resources WHERE id=cur;
   IF NOT FOUND OR p.type<>'folder' OR p.status<>'active' OR (rh<0 AND p.metadata_version IS NULL) THEN RAISE EXCEPTION 'membership_changed'; END IF;
   chain:=array_append(chain,cur);
   IF rh<0 THEN
     inroot:=array_append(inroot,cur);
     topology:=topology||jsonb_build_array(jsonb_build_object('nodeId',p.id,'parentId',CASE WHEN p.id=g.root_id THEN NULL ELSE p.parent_id END,'name',p.name));
     paths:=paths||jsonb_build_array(jsonb_build_object('nodeId',p.id,'storagePath',p.storage_path));
   END IF;
   IF cur=g.root_id THEN rh:=n; END IF;
   IF cur<>g.root_id AND EXISTS(SELECT 1 FROM public.sync_root_clock WHERE root_id=cur) THEN RAISE EXCEPTION 'membership_changed'; END IF;
   IF p.parent_id IS NULL THEN EXIT; END IF;cur:=p.parent_id;n:=n+1;
 END LOOP;
 IF cur<>'00000000-0000-7000-8000-000000000001'::uuid OR rh<0 OR rh>=128 OR topology IS DISTINCT FROM i->'parentTopology'
   OR paths IS DISTINCT FROM e->'pathTopology' THEN RAISE EXCEPTION 'membership_changed'; END IF;
 PERFORM id FROM public.resources WHERE id=ANY(chain) ORDER BY id FOR NO KEY UPDATE;
 SELECT * INTO p FROM public.resources WHERE id=(i->>'parentId')::uuid;
 IF rtrim(p.storage_path,'/')||'/'||(i->>'name') IS DISTINCT FROM e->>'targetPath'
   OR EXISTS(SELECT 1 FROM public.resources WHERE parent_id=p.id AND lower(name)=lower(i->>'name') AND status<>'trashed') THEN RAISE EXCEPTION 'precondition_failed'; END IF;
 IF c.published_seq>9223372036854775807-cardinality(inroot)-1 THEN RAISE EXCEPTION 'counter_exhausted'; END IF;
 -- The witnessed continuity transition and publication are one transaction;
 -- any failed precondition rolls back all state, including the old binding.
 UPDATE public.catalog_upload_recovery_plans SET state='APPLYING',applying_transaction=pg_current_xact_id()::text WHERE id=plan.id;
 UPDATE public.sync_root_clock SET namespace_state='ACTIVE',binding_version=plan.original_binding,updated_at=now() WHERE root_id=g.root_id;
 INSERT INTO public.resources(id,type,parent_id,name,storage_path,mime_type,size_bytes,sha256,status,sync_availability,current_version_id)
   VALUES((e->>'nodeId')::uuid,'file',p.id,i->>'name',e->>'targetPath','application/octet-stream',u.expected_size,i->>'sha256','active','AVAILABLE',(e->>'versionId')::uuid) RETURNING * INTO r;
 INSERT INTO public.file_versions(id,resource_id,storage_path,sha256,size_bytes,mime_type,reason)
   VALUES((e->>'versionId')::uuid,r.id,r.storage_path,r.sha256,r.size_bytes,r.mime_type,'initial') RETURNING created_at INTO published;
 firstseq:=c.published_seq+1;seq:=firstseq;description:=public.catalog_namespace_description(r,g.root_id);
 INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(g.root_id,c.epoch,seq,r.id,j.id,jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',r.id,'kind','upsert','description',description,'reason','upload.publish','actor',jsonb_build_object('type','device_token','id',d.id)));
 UPDATE public.resources SET size_bytes=size_bytes+u.expected_size,updated_at=now() WHERE id=ANY(chain);
 -- Preserve verified folder availability after the ordinary metadata trigger
 -- has invalidated an operator-origin size update; no file bytes are adopted.
 UPDATE public.resources SET sync_availability='AVAILABLE' WHERE id=ANY(inroot) AND sync_availability IS DISTINCT FROM 'AVAILABLE';
 FOR r IN SELECT * FROM public.resources WHERE id=ANY(inroot) ORDER BY id LOOP
   seq:=seq+1;INSERT INTO public.sync_root_changes(root_id,epoch,seq,node_id,operation_id,document) VALUES(g.root_id,c.epoch,seq,r.id,j.id,jsonb_build_object('schema','saturn.current-namespace-change.v1','nodeId',r.id,'kind','upsert','description',public.catalog_namespace_description(r,g.root_id),'reason','upload.ancestor','actor',jsonb_build_object('type','device_token','id',d.id)));
 END LOOP;
 receipt:=jsonb_build_object('schema','saturn.upload-publication.v1','uploadId',j.id,'operationId',j.id,'intentHash',j.upload_intent_hash,'rootId',g.root_id,'resourceId',e->>'nodeId','versionId',e->>'versionId','parentId',p.id,'name',i->>'name','sizeBytes',u.expected_size::text,'sha256',i->>'sha256','etag','"sha256-'||(i->>'sha256')||'"','publishedAt',to_char(published AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 value:=jsonb_build_object('schema','saturn.catalog-upload-result.v2','status','PUBLISHED','uploadId',j.id,'operationId',j.id,'rootId',g.root_id,'intentHash',j.upload_intent_hash,'publicationReceipt',receipt,'publishedDescription',description,'firstSeq',firstseq::text,'lastSeq',seq::text);
 UPDATE public.upload_sessions SET status='active',resource_id=(e->>'nodeId')::uuid,updated_at=now() WHERE id=j.id;
 UPDATE public.operation_journal SET state='active',resource_id=(e->>'nodeId')::uuid,upload_effect_state='published',upload_receipt=receipt,upload_published_version_id=(e->>'versionId')::uuid,sync_first_seq=firstseq,sync_last_seq=seq,sync_result=value,error_code=NULL,updated_at=now() WHERE id=j.id;
 UPDATE public.sync_root_clock SET published_seq=seq,updated_at=now() WHERE root_id=g.root_id;
 value:=jsonb_build_object('schema','saturn.original-upload-recovery.v1','planId',plan.id,'publication',value,'originalBinding',plan.original_binding,'backendGeneration',b.generation);
 UPDATE public.catalog_upload_recovery_plans SET state='APPLIED',result=value,applied_at=clock_timestamp() WHERE id=plan.id;
 RETURN value;
END $$;
REVOKE ALL ON FUNCTION catalog_upload_recover_original_v1(jsonb),guard_catalog_upload_recovery_plan() FROM PUBLIC;

DO $upgrade$ DECLARE definition text; needle text; BEGIN
 definition:=pg_get_functiondef('public.catalog_guard_resource_insert_set()'::regprocedure);
 needle:='IF current_user<>g.writer_owner OR session_user<>g.writer_login THEN';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'resource statement recovery source mismatch'; END IF;
 definition:=replace(definition,needle,$insert$IF current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass) THEN
     IF (SELECT count(*)>0 AND bool_and(public.catalog_upload_recovery_statement_row(TG_TABLE_NAME,NULL,to_jsonb(n))) FROM new_rows n) THEN CONTINUE; END IF;
   END IF;
   IF current_user<>g.writer_owner OR session_user<>g.writer_login THEN$insert$);EXECUTE definition;
 definition:=pg_get_functiondef('public.catalog_guard_statement()'::regprocedure);
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'catalog statement recovery source mismatch'; END IF;
 definition:=replace(definition,needle,$statement$IF current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass) THEN
     IF TG_OP='INSERT' THEN
       IF (SELECT count(*)>0 AND bool_and(public.catalog_upload_recovery_statement_row(TG_TABLE_NAME,NULL,to_jsonb(n))) FROM new_rows n) THEN CONTINUE; END IF;
     ELSE
       IF (SELECT count(*)=(SELECT count(*) FROM new_rows) AND count(*)=(SELECT count(*) FROM old_rows)
         AND bool_and(public.catalog_upload_recovery_statement_row(TG_TABLE_NAME,to_jsonb(o),to_jsonb(n))) FROM new_rows n JOIN old_rows o ON to_jsonb(n)->>'id'=to_jsonb(o)->>'id') THEN CONTINUE; END IF;
     END IF;
   END IF;
   IF current_user<>g.writer_owner OR session_user<>g.writer_login THEN$statement$);EXECUTE definition;
 definition:=pg_get_functiondef('public.guard_catalog_upload_execution()'::regprocedure);
 needle:='(OLD.upload_effect_state=''physical_pending'' AND NEW.upload_effect_state IN (''published'',''reconciliation_required''))';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'original lifecycle recovery source mismatch'; END IF;
 definition:=replace(definition,needle,$lifecycle$(OLD.upload_effect_state='physical_pending' AND NEW.upload_effect_state IN ('published','reconciliation_required')) OR
       (OLD.upload_effect_state='reconciliation_required' AND NEW.upload_effect_state='published'
        AND current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass)
        AND NEW.resource_id::text=OLD.upload_execution->>'nodeId' AND NEW.upload_published_version_id::text=OLD.upload_execution->>'versionId'
        AND EXISTS(SELECT 1 FROM public.catalog_upload_recovery_plans p WHERE p.operation_id=OLD.id AND p.root_id=OLD.sync_root_id
          AND p.state='APPLYING' AND p.applying_transaction=pg_current_xact_id()::text
          AND p.journal_sha256=encode(sha256(convert_to(to_jsonb(OLD)::text,'UTF8')),'hex')))$lifecycle$);EXECUTE definition;
 definition:=pg_get_functiondef('public.catalog_guard_rows()'::regprocedure);
 needle:='-- Exact offline ACTIVE transition, never a callback/GUC/request permit.';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'catalog recovery guard source mismatch'; END IF;
 definition:=replace(definition,needle,$guard$
   -- An operator-owned durable recovery plan, fully checked by the fixed
   -- function in this same transaction. Runtime/writer roles cannot prepare
   -- or apply plans; privileged writer functions remain byte-for-byte pinned.
   IF current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass)
     AND EXISTS(SELECT 1 FROM public.catalog_upload_recovery_plans p JOIN public.operation_journal j ON j.id=p.operation_id JOIN public.catalog_guard_roots origin ON origin.root_id=p.root_id
       WHERE p.state='APPLYING' AND p.applying_transaction=pg_current_xact_id()::text AND (
         p.root_id=g.root_id AND (
           TG_TABLE_NAME='resources' AND (row->>'id'=j.upload_execution->>'nodeId' OR EXISTS(SELECT 1 FROM jsonb_array_elements(j.upload_execution->'pathTopology') parent WHERE parent->>'nodeId'=row->>'id'))
           OR TG_TABLE_NAME='file_versions' AND row->>'id'=j.upload_execution->>'versionId' AND row->>'resource_id'=j.upload_execution->>'nodeId'
           OR TG_TABLE_NAME='upload_sessions' AND row->>'id'=j.id::text
           OR TG_TABLE_NAME='operation_journal' AND row->>'id'=j.id::text
           OR TG_TABLE_NAME='sync_root_clock' AND row->>'root_id'=p.root_id::text
           OR TG_TABLE_NAME='sync_root_changes' AND row->>'root_id'=p.root_id::text AND row->>'operation_id'=j.id::text)
         OR TG_TABLE_NAME='resources' AND TG_OP='UPDATE' AND (row->>'id')::uuid=ANY(origin.control_ancestor_ids)
           AND (to_jsonb(OLD)-ARRAY['size_bytes','metadata_version','updated_at'])=(to_jsonb(NEW)-ARRAY['size_bytes','metadata_version','updated_at'])
           AND (to_jsonb(NEW)->>'size_bytes')::bigint=(to_jsonb(OLD)->>'size_bytes')::bigint+(j.upload_intent->>'sizeBytes')::bigint)) THEN CONTINUE; END IF;
   -- Exact offline ACTIVE transition, never a callback/GUC/request permit.
$guard$);EXECUTE definition;
 definition:=pg_get_functiondef('public.renew_namespace_binding_version()'::regprocedure);
 needle:='ELSIF TG_OP=''INSERT'' THEN';IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'binding recovery source mismatch'; END IF;
 definition:=replace(definition,needle,$binding$ELSIF TG_OP='UPDATE' AND OLD.namespace_state='BACKEND_UNCERTAIN' AND NEW.namespace_state='ACTIVE'
   AND NEW.epoch=OLD.epoch AND NEW.descriptor_schema=OLD.descriptor_schema AND NEW.published_seq=OLD.published_seq
   AND EXISTS(SELECT 1 FROM public.catalog_upload_recovery_plans p JOIN public.catalog_guard_roots g ON g.root_id=p.root_id
     WHERE p.root_id=OLD.root_id AND p.state='APPLYING' AND p.applying_transaction=pg_current_xact_id()::text
       AND current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass) AND p.original_binding=NEW.binding_version
       AND p.expected_clock=jsonb_build_object('epoch',OLD.epoch,'binding',OLD.binding_version,'seq',OLD.published_seq::text,'state',OLD.namespace_state))
 THEN NULL;
 ELSIF TG_OP='INSERT' THEN$binding$);EXECUTE definition;
END $upgrade$;
-- Existing trigger invokers may evaluate the proof classifier during normal
-- writes. Read-only proof access grants no preparation/application authority;
-- token hashes are already available in the existing devices catalogue.
DO $proof_read$ DECLARE role_name text;BEGIN
 FOR role_name IN SELECT runtime_role::text FROM public.catalog_guard_roots UNION SELECT writer_owner::text FROM public.catalog_guard_roots LOOP
   EXECUTE format('GRANT SELECT ON public.catalog_upload_recovery_plans TO %I',role_name);
 END LOOP;
END $proof_read$;
