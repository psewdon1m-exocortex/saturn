LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $restore$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before set publication rollback'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=91 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'set publication predecessor missing'; END IF;
 EXECUTE definition;
END $restore$;
-- Only execution changes; originals, versions, receipts and groups use the
-- previous schema and remain readable/recoverable by the previous command.
DROP FUNCTION catalog_upload_publish_set_v1(jsonb,jsonb);
DELETE FROM sync_extension_function_backup WHERE revision=91;
