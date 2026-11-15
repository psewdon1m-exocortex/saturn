LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE definition text; BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before single request rollback'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=101 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'single request backup missing'; END IF;
 EXECUTE definition;
END $$;
DROP FUNCTION catalog_upload_execute_job_v1(jsonb,jsonb),catalog_upload_job_single_request_v1();
DELETE FROM sync_extension_function_backup WHERE revision=101;
