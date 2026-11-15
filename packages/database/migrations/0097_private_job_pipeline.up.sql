-- Two bounded private sibling jobs may overlap materialization. Public
-- publication still owns the existing FIFO root slot, and UNKNOWN blocks new
-- admission. This is not a general relaxation of the namespace conflict gate.
LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before private pipeline migration'; END IF;
END $$;
INSERT INTO sync_extension_function_backup SELECT 97,p.oid::regprocedure::text,pg_get_functiondef(p.oid) FROM pg_proc p
 WHERE p.oid IN ('catalog_upload_accept_job_v1(jsonb,jsonb)'::regprocedure,'catalog_guard_read_admission(uuid,uuid,uuid,uuid)'::regprocedure);
DO $install$
DECLARE definition text; marker text;
BEGIN
 definition:=pg_get_functiondef('catalog_upload_accept_job_v1(jsonb,jsonb)'::regprocedure);
 marker:=$m$IF EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL) THEN RAISE EXCEPTION 'admission_full'; END IF;$m$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'private pipeline predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,$m$
   IF EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL) THEN
     IF (SELECT count(*) FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL)>16
       OR (SELECT count(DISTINCT j.upload_execution_job) FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL)<>1
       OR EXISTS(SELECT 1 FROM public.operation_journal j LEFT JOIN public.sync_small_execution_jobs e ON e.id=j.upload_execution_job
         WHERE j.sync_root_id=root AND j.sync_result IS NULL AND (e.id IS NULL OR e.root_id<>root OR e.device_id<>d.id OR NOT j.id=ANY(e.members)
           OR j.upload_intent->>'parentId' IS DISTINCT FROM parent::text OR j.upload_intent->>'requireAbsent' IS DISTINCT FROM 'true'
           OR j.upload_execution->'before' IS DISTINCT FROM 'null'::jsonb OR public.catalog_upload_private_read(j) IS NOT TRUE))
     THEN RAISE EXCEPTION 'admission_full'; END IF;
     IF EXISTS(SELECT 1 FROM public.operation_journal j CROSS JOIN jsonb_array_elements(inputs) a
       WHERE j.sync_root_id=root AND j.sync_result IS NULL AND lower(j.upload_intent->>'name')=lower(a->'intent'->>'name'))
     THEN RAISE EXCEPTION 'precondition_failed'; END IF;
   END IF;
 $m$);
 definition:=pg_get_functiondef('catalog_guard_read_admission(uuid,uuid,uuid,uuid)'::regprocedure);
 IF strpos(definition,'LIMIT 17')=0 OR strpos(definition,'pending) <= 16')=0 OR strpos(definition,'pending) = 1')=0 THEN
   -- SQL function bodies preserve their source spacing, unlike view deparsing.
   IF strpos(definition,'LIMIT 17')=0 OR strpos(definition,'pending)<=16')=0 OR strpos(definition,'pending)=1')=0 THEN RAISE EXCEPTION 'private read predecessor mismatch'; END IF;
 END IF;
 definition:=replace(definition,'LIMIT 17','LIMIT 33');
 definition:=replace(replace(definition,'pending)<=16','pending)<=32'),'pending) <= 16','pending) <= 32');
 definition:=replace(replace(definition,'pending)=1','pending) BETWEEN 1 AND 2'),'pending) = 1','pending) BETWEEN 1 AND 2');
 EXECUTE definition;
END $install$;
CREATE FUNCTION catalog_upload_job_pipeline_v1() RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$ SELECT true $$;
REVOKE ALL ON FUNCTION catalog_upload_job_pipeline_v1() FROM PUBLIC;
