LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE definition text; BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before registration proof rollback'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=104 AND identity='catalog_upload_execute_job_v1(jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'registration proof backup missing'; END IF;
 EXECUTE definition;
END $$;
DELETE FROM sync_extension_function_backup WHERE revision=104;
