-- Exact offline continuation of an original claim whose rename was NEVER
-- accepted by the effect queue. Requires full original private SHA and target
-- absence, a witnessed stopped writer and unchanged namespace/device/preimage.
-- No UNKNOWN backend task can be cleared and no physical receipt is invented.
SELECT pg_advisory_xact_lock(1397967206);
INSERT INTO sync_extension_function_backup SELECT 125,p.oid::regprocedure::text,pg_get_functiondef(p.oid) FROM pg_proc p
 WHERE p.oid IN('public.catalog_upload_recovery_statement_row(text,jsonb,jsonb)'::regprocedure,'public.guard_catalog_upload_execution()'::regprocedure);
DROP INDEX catalog_upload_one_applied_recovery;
CREATE UNIQUE INDEX catalog_upload_one_applied_recovery ON catalog_upload_recovery_plans(operation_id,journal_sha256) WHERE state IN('APPLYING','APPLIED');
CREATE FUNCTION catalog_upload_resume_unstarted_v1(payload jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
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
   IF plan.result->>'schema'<>'saturn.original-upload-resume.v1' OR j.upload_claim_token::text IS DISTINCT FROM plan.result->>'claimToken'
     OR j.upload_execution->>'nodeId' IS DISTINCT FROM plan.result->>'nodeId' OR j.upload_execution->>'versionId' IS DISTINCT FROM plan.result->>'versionId' THEN RAISE EXCEPTION 'recovery_outcome_changed'; END IF;
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
 IF jsonb_typeof(plan.physical_proof) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(plan.physical_proof))<>7
   OR NOT plan.physical_proof ?& ARRAY['targetPath','sizeBytes','sha256','tempAbsent','targetAbsent','writeTaskId','renameTaskId']
   OR plan.physical_proof->>'targetPath' IS DISTINCT FROM e->>'targetPath' OR plan.physical_proof->>'sizeBytes' IS DISTINCT FROM i->>'sizeBytes'
   OR plan.physical_proof->>'sha256' IS DISTINCT FROM i->>'sha256' OR plan.physical_proof->'tempAbsent' IS DISTINCT FROM 'false'::jsonb OR plan.physical_proof->'targetAbsent' IS DISTINCT FROM 'true'::jsonb OR plan.physical_proof->'renameTaskId' IS DISTINCT FROM 'null'::jsonb
   OR plan.physical_proof->>'writeTaskId' IS DISTINCT FROM j.upload_last_transfer->>'token'
   OR j.upload_last_transfer->>'offset'<>'0' OR j.upload_last_transfer->>'length' IS DISTINCT FROM i->>'sizeBytes'
   OR j.upload_last_transfer->>'originalUploadId' IS DISTINCT FROM j.id::text THEN RAISE EXCEPTION 'physical_recovery_proof_invalid'; END IF;
 SELECT * INTO written FROM public.sync_backend_tasks WHERE id=(plan.physical_proof->>'writeTaskId')::uuid FOR SHARE;
 IF written.id IS NULL OR written.state<>'DONE' OR written.command<>'write' OR written.backend_identity<>g.backend_identity OR written.generation<>b.generation
   OR written.owner_id::text IS DISTINCT FROM b.stopped_receipt->>'ownerId' OR written.fencing_token::text IS DISTINCT FROM b.stopped_receipt->>'fencingToken'
   OR written.payload->>'path' IS DISTINCT FROM e->>'tempPath' OR written.payload->>'schema'<>'saturn.backend-write-once.v1'
   OR written.payload->'payloadRef'->>'sha256' IS DISTINCT FROM i->>'sha256' OR written.payload->'payloadRef'->>'size' IS DISTINCT FROM i->>'sizeBytes'
   OR written.result IS DISTINCT FROM to_jsonb(u.expected_size)
   OR EXISTS(SELECT 1 FROM public.sync_backend_tasks t WHERE t.backend_identity=g.backend_identity AND t.command='rename'
     AND t.payload=jsonb_build_object('source',e->>'tempPath','destination',e->>'targetPath')) THEN RAISE EXCEPTION 'original_effect_receipt_invalid'; END IF;
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
 -- A proved never-accepted rename resumes the SAME retained claim. This
 -- creates no receipt of publication and performs no physical operation.
 UPDATE public.catalog_upload_recovery_plans SET state='APPLYING',applying_transaction=pg_current_xact_id()::text WHERE id=plan.id;
 UPDATE public.sync_root_clock SET namespace_state='ACTIVE',binding_version=plan.original_binding,updated_at=now() WHERE root_id=g.root_id;
 UPDATE public.operation_journal SET upload_effect_state='physical_pending',error_code=NULL,updated_at=now() WHERE id=j.id;
 value:=jsonb_build_object('schema','saturn.original-upload-resume.v1','status','ORIGINAL_CLAIM_RESUMABLE','planId',plan.id,'operationId',j.id,
   'rootId',g.root_id,'nodeId',e->>'nodeId','versionId',e->>'versionId','claimToken',j.upload_claim_token,'originalBinding',plan.original_binding,'backendGeneration',b.generation);
 UPDATE public.catalog_upload_recovery_plans SET state='APPLIED',result=value,applied_at=clock_timestamp() WHERE id=plan.id;
 RETURN value;
END $$;
REVOKE ALL ON FUNCTION catalog_upload_resume_unstarted_v1(jsonb) FROM PUBLIC;

DO $upgrade$ DECLARE definition text;needle text;BEGIN
 definition:=pg_get_functiondef('public.catalog_upload_recovery_statement_row(text,jsonb,jsonb)'::regprocedure);
 needle:='ELSIF table_name=''operation_journal'' AND old_row IS NOT NULL THEN';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'unstarted statement predecessor changed'; END IF;
 definition:=replace(definition,needle,$statement$ELSIF table_name='operation_journal' AND old_row IS NOT NULL THEN
     IF old_row->>'id'=p.operation_id::text AND new_row->>'id'=p.operation_id::text AND old_row->>'upload_effect_state'='reconciliation_required'
       AND new_row->>'upload_effect_state'='physical_pending' AND (old_row-ARRAY['upload_effect_state','error_code','updated_at'])=(new_row-ARRAY['upload_effect_state','error_code','updated_at'])
       AND new_row->'error_code'='null'::jsonb AND p.physical_proof->'renameTaskId'='null'::jsonb AND p.physical_proof->'targetAbsent'='true'::jsonb
       AND encode(sha256(convert_to(old_row::text,'UTF8')),'hex')=p.journal_sha256 THEN RETURN true; END IF;$statement$);EXECUTE definition;
 definition:=pg_get_functiondef('public.guard_catalog_upload_execution()'::regprocedure);
 needle:='(OLD.upload_effect_state=''physical_pending'' AND NEW.upload_effect_state IN (''published'',''reconciliation_required''))';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'unstarted lifecycle predecessor changed'; END IF;
 definition:=replace(definition,needle,$lifecycle$(OLD.upload_effect_state='reconciliation_required' AND NEW.upload_effect_state='physical_pending'
   AND current_user=session_user AND current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.catalog_upload_recovery_plans'::regclass)
   AND (to_jsonb(OLD)-ARRAY['upload_effect_state','error_code','updated_at'])=(to_jsonb(NEW)-ARRAY['upload_effect_state','error_code','updated_at'])
   AND EXISTS(SELECT 1 FROM public.catalog_upload_recovery_plans p WHERE p.operation_id=OLD.id AND p.root_id=OLD.sync_root_id
     AND p.state='APPLYING' AND p.applying_transaction=pg_current_xact_id()::text AND p.physical_proof->'renameTaskId'='null'::jsonb
     AND p.physical_proof->'targetAbsent'='true'::jsonb AND p.journal_sha256=encode(sha256(convert_to(to_jsonb(OLD)::text,'UTF8')),'hex')))
   OR (OLD.upload_effect_state='physical_pending' AND NEW.upload_effect_state IN ('published','reconciliation_required'))$lifecycle$);EXECUTE definition;
END $upgrade$;
