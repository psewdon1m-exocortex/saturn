-- Limited readonly successor. No ACTIVE authority, enrollment or capabilities.
-- Existing migrations remain immutable.
-- Private transfer records do not make the published namespace incomplete. Public claims and
-- arbitrary unresolved operations still close admission. No physical I/O is performed here.
DO $guarded_runtime_install$ BEGIN
 EXECUTE replace($guarded_runtime_ddl$
CREATE FUNCTION catalog_upload_private_read(j public.operation_journal) RETURNS boolean
 LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.sync_root_clock%ROWTYPE; g public.catalog_guard_roots%ROWTYPE; u public.upload_sessions%ROWTYPE;
 entry jsonb; witness jsonb; p public.resources%ROWTYPE; previous_parent uuid; n integer:=0;
BEGIN
 IF j.sync_result IS NOT NULL OR NOT public.catalog_upload_transport(j)
   OR j.state<>'created' OR j.resource_id IS NOT NULL OR j.error_code IS NOT NULL
   OR j.upload_claim_token IS NOT NULL OR j.upload_receipt IS NOT NULL OR j.upload_published_version_id IS NOT NULL
   OR j.sync_first_seq IS NOT NULL OR j.sync_last_seq IS NOT NULL THEN RETURN false; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=j.sync_root_id;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=j.sync_root_id;
 SELECT * INTO u FROM public.upload_sessions WHERE id=j.id;
 IF c.root_id IS NULL OR g.root_id IS NULL OR u.id IS NULL
   OR c.namespace_state NOT IN ('QUALIFYING','ACTIVE') OR c.descriptor_schema<>'saturn.current-namespace.v1'
   OR g.writer_contract<>'folder-file-cas-cj04.v1'
   OR j.sync_epoch IS DISTINCT FROM c.epoch OR j.upload_execution->>'epoch' IS DISTINCT FROM c.epoch::text
   OR j.upload_execution->>'bindingVersion' IS DISTINCT FROM c.binding_version::text
   OR j.upload_execution->>'guardRevision' IS DISTINCT FROM g.guard_revision::text
   OR j.upload_execution->>'backendIdentity' IS DISTINCT FROM g.backend_identity
   OR u.idempotency_key IS DISTINCT FROM j.idempotency_key OR j.idempotency_key IS DISTINCT FROM j.upload_intent->>'idempotencyKey'
   OR u.parent_id::text IS DISTINCT FROM j.upload_intent->>'parentId' OR u.filename IS DISTINCT FROM j.upload_intent->>'name'
   OR u.temp_path IS DISTINCT FROM j.upload_execution->>'tempPath' OR u.target_path IS DISTINCT FROM j.upload_execution->>'targetPath'
   OR u.expected_size::text IS DISTINCT FROM j.upload_intent->>'sizeBytes' OR u.expected_sha256 IS DISTINCT FROM j.upload_intent->>'sha256'
   OR u.overwrite_resource_id::text IS DISTINCT FROM j.upload_intent->>'targetId'
   OR u.expected_version_id::text IS DISTINCT FROM j.upload_intent->>'expectedVersionId'
   OR u.require_absent IS DISTINCT FROM (j.upload_intent->>'requireAbsent')::boolean
   OR u.resource_id IS NOT NULL OR u.received_size<0 OR u.received_size>u.expected_size
   OR u.audit_actor_type IS DISTINCT FROM 'device_token' OR u.audit_actor_id IS DISTINCT FROM j.upload_intent->>'deviceId'
   OR (j.upload_effect_state='transport' AND (u.status NOT IN ('created','uploading') OR u.actual_sha256 IS NOT NULL))
   OR (j.upload_effect_state='verified' AND (u.status<>'verifying' OR u.received_size<>u.expected_size OR u.actual_sha256 IS DISTINCT FROM u.expected_sha256))
   THEN RETURN false; END IF;
 IF j.upload_transfer IS NOT NULL AND ((j.upload_transfer->>'offset')::bigint<>u.received_size
   OR (j.upload_transfer->>'offset')::numeric+(j.upload_transfer->>'length')::numeric>u.expected_size OR u.status<>'uploading') THEN RETURN false; END IF;
 IF j.upload_last_transfer IS NOT NULL AND (j.upload_last_transfer->>'offset')::numeric+(j.upload_last_transfer->>'length')::numeric<>u.received_size THEN RETURN false; END IF;
 IF u.received_size>0 AND j.upload_last_transfer IS NULL THEN RETURN false; END IF;
 -- An exclusive temp is sealed to the exact currently active parent/root chain. No current
 -- target descriptor/version comparison is needed: a stale private CAS has no public effect.
 FOR entry IN SELECT value FROM jsonb_array_elements(j.upload_execution->'pathTopology') LOOP
   SELECT * INTO p FROM public.resources WHERE id=(entry->>'nodeId')::uuid LIMIT 1;
   witness:=j.upload_intent->'parentTopology'->n;
   IF NOT FOUND OR p.type<>'folder' OR p.status<>'active' OR p.metadata_version IS NULL
     OR p.storage_path IS DISTINCT FROM entry->>'storagePath'
     OR (n>0 AND p.id IS DISTINCT FROM previous_parent)
     OR (j.upload_intent->>'schema'='saturn.upload-intent.v2' AND
       (witness->>'nodeId' IS DISTINCT FROM p.id::text OR witness->>'name' IS DISTINCT FROM p.name
        OR witness->>'parentId' IS DISTINCT FROM CASE WHEN p.id=c.root_id THEN NULL ELSE p.parent_id::text END))
     OR (p.id<>c.root_id AND EXISTS(SELECT 1 FROM public.sync_root_clock WHERE root_id=p.id)) THEN RETURN false; END IF;
   previous_parent:=p.parent_id;n:=n+1;
 END LOOP;
 RETURN n BETWEEN 1 AND 128 AND p.id=c.root_id
   AND u.target_path=rtrim((j.upload_execution->'pathTopology'->0->>'storagePath'),'/')||'/'||u.filename;
END $$;
CREATE FUNCTION catalog_guard_read_admission(root uuid,epoch_value uuid,binding_value uuid,revision_value uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.sync_root_clock c
   JOIN public.catalog_guard_roots g ON g.root_id=c.root_id JOIN public.resources r ON r.id=c.root_id
   WHERE c.root_id=root AND c.epoch=epoch_value AND c.binding_version=binding_value
     AND c.namespace_state='QUALIFYING' AND c.descriptor_schema='saturn.current-namespace.v1'
     AND g.guard_revision=revision_value AND g.writer_contract IN ('folder-only-g1.v1','folder-file-cas-cj04.v1')
     AND r.status='active' AND r.type='folder'
     AND (SELECT count(*) FROM (SELECT j.id FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL LIMIT 5) bounded)<=4
     AND NOT EXISTS(SELECT 1 FROM (SELECT j AS journal FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL LIMIT 5) pending
       WHERE NOT public.catalog_upload_private_read(pending.journal)))
$$;
$guarded_runtime_ddl$,'public.',quote_ident(current_schema())||'.');
END $guarded_runtime_install$;
