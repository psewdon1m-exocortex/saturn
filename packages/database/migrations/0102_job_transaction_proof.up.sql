-- Reuse protected syntax and the creation checks of this transaction, never
-- a cached authorization/topology decision across transactions or processes.
LOCK TABLE sync_backend_executor,catalog_guard_roots,operation_journal IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before transaction proof migration'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='operation_journal'::regclass AND conname='operation_catalog_upload_shape' AND convalidated
   AND pg_get_constraintdef(oid)='CHECK ((catalog_upload_shape(operation_journal.*) IS TRUE))') THEN RAISE EXCEPTION 'validated upload shape prerequisite missing'; END IF;
END $$;
INSERT INTO sync_extension_function_backup SELECT 102,p.oid::regprocedure::text,pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.oid IN (
 'catalog_upload_private_read(operation_journal)'::regprocedure,'catalog_upload_execute_job_v1(jsonb,jsonb)'::regprocedure);
CREATE FUNCTION catalog_upload_stored_transport(j public.operation_journal) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 -- Complete row equality matters: arbitrary synthetic composites must retain
 -- the old pure validation. The table CHECK remains fully enforced on writes.
 IF EXISTS(SELECT 1 FROM public.operation_journal saved WHERE saved.id=j.id AND saved IS NOT DISTINCT FROM j) THEN
   RETURN coalesce(j.upload_execution IS NOT NULL AND j.upload_effect_state IN ('transport','verified') AND j.sync_result IS NULL,false);
 END IF;
 RETURN public.catalog_upload_transport(j);
END $$;
DO $install$
DECLARE definition text; marker text;
BEGIN
 definition:=pg_get_functiondef('catalog_upload_private_read(operation_journal)'::regprocedure);
 marker:='public.catalog_upload_transport(j)';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'private transport predecessor mismatch'; END IF;
 EXECUTE replace(definition,marker,'public.catalog_upload_stored_transport(j)');
 definition:=pg_get_functiondef('catalog_upload_execute_job_v1(jsonb,jsonb)'::regprocedure);
 marker:=$m$j.sync_root_id=root AND j.sync_result IS NULL AND NOT public.catalog_upload_private_read(j)$m$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'fresh job proof predecessor mismatch'; END IF;
 -- Only these freshly inserted members have already passed every creation
 -- check under the locked root/device/parent rows in this same transaction.
 -- Existing other jobs and every replay keep the full current private reader.
 EXECUTE replace(definition,marker,$m$j.sync_root_id=root AND j.sync_result IS NULL
     AND (replayed OR j.upload_execution_job IS DISTINCT FROM saved.id)
     AND NOT public.catalog_upload_private_read(j)$m$);
END $install$;
