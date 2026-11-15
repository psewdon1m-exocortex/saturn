DO $restore$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=86 AND identity='catalog_guard_rows()';
 IF definition IS NULL THEN RAISE EXCEPTION 'scope anchors predecessor missing'; END IF;
 EXECUTE definition;
END $restore$;
DELETE FROM sync_extension_function_backup WHERE revision=86 AND identity='catalog_guard_rows()';
