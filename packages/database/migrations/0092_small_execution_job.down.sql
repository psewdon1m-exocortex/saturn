LOCK TABLE sync_backend_executor,catalog_guard_roots,sync_small_execution_jobs IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE definition text; BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before job rollback'; END IF;
 -- Disabling new admissions must retain readers for every accepted manifest.
 -- A destructive schema rollback is allowed only before any job was accepted.
 IF EXISTS(SELECT 1 FROM sync_small_execution_jobs) THEN RAISE EXCEPTION 'accepted execution jobs require their reader'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=92 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'job admission backup missing'; END IF;
 EXECUTE definition;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=92 AND identity='sync_policy_admission()';
 IF definition IS NULL THEN RAISE EXCEPTION 'job policy backup missing'; END IF;
 EXECUTE definition;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=92 AND identity='catalog_guard_read_admission(uuid,uuid,uuid,uuid)';
 IF definition IS NULL THEN RAISE EXCEPTION 'job read admission backup missing'; END IF;
 EXECUTE definition;
END $$;
DROP TRIGGER small_execution_budget_guard ON sync_small_batch_budget;
ALTER TABLE sync_small_batch_budget DROP COLUMN execution_metadata_bytes;
DROP FUNCTION guard_small_execution_budget();
DROP FUNCTION catalog_upload_accept_job_v1(jsonb,jsonb);
DROP TRIGGER operation_small_execution_member ON operation_journal;
ALTER TABLE operation_journal DROP COLUMN upload_execution_job;
DROP TABLE sync_small_execution_jobs;
DROP FUNCTION guard_small_execution_job();
DROP FUNCTION check_small_execution_job_members();
DROP FUNCTION guard_small_execution_member();
DELETE FROM sync_extension_function_backup WHERE revision=92;
