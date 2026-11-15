DO $restore$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 IF EXISTS(SELECT 1 FROM operation_journal WHERE upload_transfer_backend_task IS NOT NULL) THEN RAISE EXCEPTION 'pending transfer identity must be retained'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=82 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'replayable chunk predecessor missing'; END IF;
 EXECUTE definition;
END $restore$;
ALTER TABLE operation_journal DROP CONSTRAINT operation_upload_transfer_backend_task;
ALTER TABLE operation_journal DROP COLUMN upload_transfer_backend_task;
DROP FUNCTION catalog_upload_replayable_chunk_v1();
DELETE FROM sync_extension_function_backup WHERE revision=82 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
