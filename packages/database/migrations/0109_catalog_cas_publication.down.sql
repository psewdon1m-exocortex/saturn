LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $restore$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before CAS set rollback'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=109 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'CAS set predecessor missing'; END IF;
 EXECUTE definition;
END $restore$;
-- All originals/groups use the old schema. Ordinary status and recovery survive.
DROP FUNCTION catalog_upload_cas_publication_v1();
DROP FUNCTION catalog_upload_claim_cas_set_v1(jsonb,jsonb),catalog_upload_publish_cas_set_v1(jsonb,jsonb);
DELETE FROM sync_extension_function_backup WHERE revision=109;
