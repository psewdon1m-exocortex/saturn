DO $restore$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=88 AND identity='catalog_guard_active_valid(catalog_guard_roots)';
 IF definition IS NULL THEN RAISE EXCEPTION 'active proof predecessor missing'; END IF;
 EXECUTE definition;
END $restore$;
ALTER TABLE catalog_guard_roots DROP CONSTRAINT catalog_guard_active_proof_checked;
DELETE FROM sync_extension_function_backup WHERE revision=88 AND identity='catalog_guard_active_valid(catalog_guard_roots)';
