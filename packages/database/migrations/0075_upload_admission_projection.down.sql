DO $restore$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b
   WHERE revision=75 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'upload admission predecessor missing'; END IF;
 EXECUTE definition;
END $restore$;
DROP INDEX operation_blocking_catalog_upload;
DELETE FROM sync_extension_function_backup WHERE revision=75 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
