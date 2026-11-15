-- The guarded registry fully validates and persists the exact plan first in
-- this same transaction. Later checks consume that protected syntax proof.
LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before registration proof migration'; END IF;
END $$;
INSERT INTO sync_extension_function_backup VALUES(104,'catalog_upload_execute_job_v1(jsonb,jsonb)',pg_get_functiondef('catalog_upload_execute_job_v1(jsonb,jsonb)'::regprocedure));
DO $install$
DECLARE definition text; marker text;
BEGIN
 definition:=pg_get_functiondef('catalog_upload_execute_job_v1(jsonb,jsonb)'::regprocedure);
 marker:=$m$registry:=public.sync_small_batch_command('register',binding,credential,plan);$m$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'registration proof predecessor mismatch'; END IF;
 definition:=replace(definition,marker,'-- Registry and its guards already succeeded in this transaction.');
 marker:='IF public.sync_small_batch_known_shape(plan) IS NOT TRUE';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'registration syntax predecessor mismatch'; END IF;
 definition:=replace(definition,marker,$m$binding:=(plan->'manifest')-ARRAY['schema','batch_id','rules_version','items'];
 registry:=public.sync_small_batch_command('register',binding,credential,plan);
 IF public.sync_small_batch_known_shape(plan) IS NOT TRUE$m$);
 marker:=$m$IF EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL
     AND (replayed OR j.upload_execution_job IS DISTINCT FROM saved.id)
     AND NOT public.catalog_upload_private_read(j))$m$;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'sibling proof predecessor mismatch'; END IF;
 -- Fresh admission already checked all preexisting private siblings before
 -- inserting its new originals. The root clock is locked throughout; no
 -- guarded topology/transfer mutation can invalidate that proof in between.
 -- Replays perform the full current check, and all final ACTIVE/backend checks
 -- immediately above this predicate are retained for both paths.
 EXECUTE replace(definition,marker,$m$IF replayed AND EXISTS(SELECT 1 FROM public.operation_journal j WHERE j.sync_root_id=root AND j.sync_result IS NULL
     AND NOT public.catalog_upload_private_read(j))$m$);
END $install$;
