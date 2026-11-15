-- Forward maintenance scheduling fix. No version, receipt, original, or pin is discarded.
-- The changed definer source requires ordinary reviewed runtime requalification;
-- this migration does not reactivate an existing guarded root.

CREATE OR REPLACE FUNCTION sync_retention_schedule() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE roots uuid[]; root uuid;
BEGIN
 roots:=public.catalog_guard_scope(NEW.resource_id,false);
 IF cardinality(roots)<>1 THEN RETURN NEW; END IF;root:=roots[1];
 -- The eleventh active version is the first possible retention candidate.
 -- Do not put every single-version bulk upload into a maintenance FIFO.
 IF NOT EXISTS(SELECT 1 FROM public.file_versions WHERE resource_id=NEW.resource_id AND state='active' OFFSET 10 LIMIT 1) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.sync_root_policy WHERE root_id=root)
   AND EXISTS(SELECT 1 FROM public.devices WHERE sync_root_id=root AND device_kind='pluto') THEN
   INSERT INTO public.sync_retention_work(root_id,resource_id) VALUES(root,NEW.resource_id)
     ON CONFLICT(resource_id) DO UPDATE SET requested_at=now();
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION sync_retention_command(root uuid,identity jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_variable
DECLARE g public.catalog_guard_roots%ROWTYPE; c public.sync_root_clock%ROWTYPE; b public.sync_backend_executor%ROWTYPE;
 w public.sync_retention_work%ROWTYPE; r public.resources%ROWTYPE; v public.file_versions%ROWTYPE;
 original public.sync_retention_originals%ROWTYPE; task public.sync_backend_tasks%ROWTYPE;
 body jsonb; response jsonb; taskid uuid; remaining integer; planned integer:=0; completed integer:=0; resumed integer:=0;
BEGIN
 IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR octet_length(identity::text)>2048 THEN RAISE EXCEPTION 'invalid_input'; END IF;
 SELECT * INTO g FROM public.catalog_guard_roots WHERE root_id=root;
 IF g.root_id IS NULL OR session_user<>g.writer_login OR current_user<>g.writer_owner
   OR g.backend_identity IS DISTINCT FROM identity->>'backendIdentity' OR g.writer_contract<>'folder-file-cas-cj04.v1' THEN RAISE EXCEPTION 'binding_invalid'; END IF;
 SELECT * INTO c FROM public.sync_root_clock WHERE root_id=root FOR UPDATE;
 SELECT * INTO b FROM public.sync_backend_executor WHERE backend_identity=g.backend_identity FOR UPDATE;
 IF b.generation::text IS DISTINCT FROM identity->>'generation' OR b.writer_login<>g.writer_login OR b.writer_owner<>g.writer_owner THEN RAISE EXCEPTION 'binding_invalid'; END IF;

 -- Only these immutable expired-version deletions can resume after a reviewed
 -- external fence. A lease timeout, process age or missing ACK is never proof.
 FOR original IN SELECT o.* FROM public.sync_retention_originals o JOIN public.sync_backend_tasks t ON t.id=o.task_id
   WHERE o.root_id=root AND o.state='QUEUED' AND (t.state='DONE' OR t.state IN ('UNKNOWN','REJECTED') AND t.generation<>b.generation)
   ORDER BY o.created_at,o.version_id LIMIT 16 FOR UPDATE OF o LOOP
   SELECT * INTO task FROM public.sync_backend_tasks WHERE id=original.task_id FOR UPDATE;
   IF task.backend_identity<>b.backend_identity OR task.command<>'delete'
     OR task.payload IS DISTINCT FROM jsonb_build_object('path',original.storage_path,'retention',jsonb_build_object('resourceId',original.resource_id,'versionId',original.version_id,'sizeBytes',original.size_bytes::text,'sha256',original.sha256))
     OR NOT EXISTS(SELECT 1 FROM public.file_versions WHERE id=original.version_id AND resource_id=original.resource_id AND storage_path=original.storage_path AND state='expired')
     OR EXISTS(SELECT 1 FROM public.resources WHERE current_version_id=original.version_id)
     OR EXISTS(SELECT 1 FROM public.laboratory_assets WHERE pinned_version_id=original.version_id) THEN RAISE EXCEPTION 'retention_original_changed'; END IF;
   IF task.state='DONE' THEN
     UPDATE public.sync_retention_originals SET state='DELETED',completed_at=now(),receipt=jsonb_build_object('schema','saturn.retention-receipt.v1','versionId',original.version_id,'taskId',task.id,'generation',task.generation,'status','DELETED') WHERE version_id=original.version_id;
     completed:=completed+1;
   ELSIF task.state IN ('UNKNOWN','REJECTED') AND task.generation<>b.generation
     AND b.state IN ('UNKNOWN','STOPPED','RUNNING')
     AND EXISTS(SELECT 1 FROM public.sync_backend_handoffs h WHERE h.backend_identity=b.backend_identity AND h.previous_generation=task.generation AND h.next_generation=b.generation AND h.receipt->>'oldConnectionsClosed'='true') THEN
     UPDATE public.sync_backend_tasks SET state='QUEUED',generation=b.generation,owner_id=NULL,fencing_token=NULL,error_code=NULL,updated_at=now() WHERE id=task.id;
     resumed:=resumed+1;
   END IF;
 END LOOP;
 IF resumed>0 AND b.state='UNKNOWN' AND b.owner_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.sync_backend_tasks WHERE backend_identity=b.backend_identity AND state IN ('RUNNING','UNKNOWN')) THEN
   UPDATE public.sync_backend_executor SET state='STOPPED',updated_at=now() WHERE backend_identity=b.backend_identity;
 END IF;
 IF b.state<>'RUNNING' OR c.namespace_state<>'ACTIVE' OR NOT public.catalog_guard_active_valid(g)
   OR NOT EXISTS(SELECT 1 FROM public.sync_root_policy WHERE root_id=root AND state='ACTIVE') THEN
   RETURN jsonb_build_object('planned',planned,'completed',completed,'resumed',resumed,'deferred','backend_or_root_not_active');
 END IF;
 -- Bound maintenance across ALL roots/processes sharing this backend. Do not
 -- fill the generic writer FIFO with archive hashing/deletion ahead of sync.
 SELECT 2-count(*)::integer INTO remaining FROM public.sync_retention_originals o JOIN public.sync_backend_tasks t ON t.id=o.task_id
   WHERE o.backend_identity=b.backend_identity AND t.state IN ('QUEUED','RUNNING','UNKNOWN');
 IF remaining<=0 THEN RETURN jsonb_build_object('planned',0,'completed',completed,'resumed',resumed,'deferred','retention_budget'); END IF;
 -- A retained original may still need old bytes (including clone, batch and
 -- stream originals not yet in the publication journal). Do not infer safety
 -- from elapsed time; wait until the original has a durable terminal outcome.
 IF EXISTS(SELECT 1 FROM public.operation_journal WHERE sync_root_id=root AND sync_result IS NULL)
   OR EXISTS(SELECT 1 FROM public.sync_stream_uploads s WHERE s.root_id=root AND s.state<>'PUBLISHED' AND NOT EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.id=s.operation_id AND j.sync_result IS NOT NULL)) THEN
   RETURN jsonb_build_object('planned',0,'completed',completed,'resumed',resumed,'deferred','originals_pending');
 END IF;
 -- Retire a bounded page of obsolete scheduling metadata from old writers.
 -- Immutable delete originals and explicit pins are never removed here.
 FOR w IN SELECT q.* FROM public.sync_retention_work q JOIN public.resources queued ON queued.id=q.resource_id
   WHERE q.root_id=root AND queued.current_version_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.file_versions f WHERE f.resource_id=queued.id AND f.state='active' AND f.id<>queued.current_version_id OFFSET 9 LIMIT 1)
   ORDER BY q.attempted_at,q.resource_id LIMIT 16 FOR UPDATE OF q LOOP
   DELETE FROM public.sync_retention_work WHERE resource_id=w.resource_id;
 END LOOP;
 -- A large pre-upgrade queue of single versions must not delay real excess.
 -- Fair rotation remains between resources with excess history, including pins.
 SELECT q.* INTO w FROM public.sync_retention_work q JOIN public.resources queued ON queued.id=q.resource_id
   WHERE q.root_id=root
     AND EXISTS(SELECT 1 FROM public.file_versions f WHERE f.resource_id=queued.id AND f.state='active' AND f.id<>queued.current_version_id OFFSET 9 LIMIT 1)
   ORDER BY q.attempted_at,q.resource_id LIMIT 1 FOR UPDATE OF q;
 IF w.resource_id IS NULL THEN RETURN jsonb_build_object('planned',0,'completed',completed,'resumed',resumed); END IF;
 SELECT * INTO r FROM public.resources WHERE id=w.resource_id FOR NO KEY UPDATE;
 UPDATE public.sync_retention_work SET attempted_at=clock_timestamp() WHERE resource_id=w.resource_id;
 IF r.type<>'file' OR r.status<>'active' OR r.current_version_id IS NULL OR r.sync_availability IS DISTINCT FROM 'AVAILABLE'
   OR public.catalog_guard_scope(r.id,false) IS DISTINCT FROM ARRAY[root]
   OR NOT EXISTS(SELECT 1 FROM public.devices WHERE sync_root_id=root AND device_kind='pluto') THEN
   RETURN jsonb_build_object('planned',0,'completed',completed,'resumed',resumed,'deferred','resource_not_eligible');
 END IF;
 -- Keep current even when its timestamp is older; then keep exactly nine
 -- newest active historical versions. Extra pins remain outside that count.
 FOR v IN SELECT * FROM public.file_versions f WHERE f.resource_id=r.id AND f.state='active' AND f.id<>r.current_version_id
   AND f.id NOT IN (SELECT kept.id FROM public.file_versions kept WHERE kept.resource_id=r.id AND kept.state='active' AND kept.id<>r.current_version_id ORDER BY kept.created_at DESC,kept.id DESC LIMIT 9)
   AND NOT EXISTS(SELECT 1 FROM public.laboratory_assets WHERE pinned_version_id=f.id)
   AND NOT EXISTS(SELECT 1 FROM public.sync_small_batch_operations s WHERE s.root_id=root AND s.declaration->'input'->'intent'->>'expectedVersionId'=f.id::text
     AND NOT EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.idempotency_key=s.operation_key AND j.sync_root_id=root AND j.upload_intent=s.declaration->'input'->'intent' AND j.sync_result IS NOT NULL))
   ORDER BY f.created_at DESC,f.id DESC LIMIT remaining FOR UPDATE LOOP
   IF EXISTS(SELECT 1 FROM public.laboratory_assets WHERE pinned_version_id=v.id) THEN CONTINUE; END IF;
   IF v.storage_path=r.storage_path OR NOT(v.storage_path='_system/versions/'||r.id::text||'/'||v.id::text OR starts_with(v.storage_path,'_system/versions/'||r.id::text||'/'||v.id::text||'/')) THEN
     RAISE EXCEPTION 'retention_path_invalid';
   END IF;
   taskid:=gen_random_uuid();body:=jsonb_build_object('path',v.storage_path,'retention',jsonb_build_object('resourceId',r.id,'versionId',v.id,'sizeBytes',v.size_bytes::text,'sha256',v.sha256));
   response:=public.sync_backend_command('submit',identity,jsonb_build_object('id',taskid,'command','delete','body',body,'reservedBytes','0'));
   IF response->>'state' IS DISTINCT FROM 'QUEUED' THEN RAISE EXCEPTION 'retention_queue_unavailable'; END IF;
   UPDATE public.file_versions SET state='expired' WHERE id=v.id;
   INSERT INTO public.sync_retention_originals(version_id,root_id,resource_id,backend_identity,task_id,storage_path,size_bytes,sha256,state)
     VALUES(v.id,root,r.id,b.backend_identity,taskid,v.storage_path,v.size_bytes,v.sha256,'QUEUED');
   planned:=planned+1;
 END LOOP;
 -- Keep work with excess pinned history so releasing a pin is eventually
 -- revisited even without another upload. attempted_at provides fair rotation.
 IF NOT EXISTS(SELECT 1 FROM public.file_versions WHERE resource_id=r.id AND state='active' AND id<>r.current_version_id OFFSET 9 LIMIT 1) THEN
   DELETE FROM public.sync_retention_work WHERE resource_id=r.id;
 END IF;
 RETURN jsonb_build_object('planned',planned,'completed',completed,'resumed',resumed);
END $$;

CREATE OR REPLACE FUNCTION sync_retention_schedule_root() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.active_runtime IS NOT NULL AND EXISTS(SELECT 1 FROM public.sync_root_policy WHERE root_id=NEW.root_id)
   AND EXISTS(SELECT 1 FROM public.devices WHERE sync_root_id=NEW.root_id AND device_kind='pluto') THEN
   INSERT INTO public.sync_retention_work(root_id,resource_id)
     SELECT NEW.root_id,r.id FROM public.resources r WHERE r.type='file' AND public.catalog_guard_scope(r.id,false)=ARRAY[NEW.root_id]
       AND EXISTS(SELECT 1 FROM public.file_versions v WHERE v.resource_id=r.id AND v.state='active' OFFSET 10 LIMIT 1)
     ON CONFLICT(resource_id) DO UPDATE SET requested_at=now();
 END IF;
 RETURN NEW;
END $$;
