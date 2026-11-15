DO $restore$
DECLARE definition text;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 IF EXISTS(SELECT 1 FROM catalog_upload_publication_groups) THEN RAISE EXCEPTION 'publication group history must be retained'; END IF;
 SELECT b.definition INTO definition FROM sync_extension_function_backup b WHERE revision=78 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
 IF definition IS NULL THEN RAISE EXCEPTION 'publication group predecessor missing'; END IF;
 EXECUTE definition;
END $restore$;
DROP TRIGGER operation_catalog_upload_group_guard ON operation_journal;
ALTER TABLE operation_journal DROP COLUMN upload_publication_group;
DROP TABLE catalog_upload_publication_groups;
DROP FUNCTION guard_catalog_upload_publication_group(),guard_catalog_upload_group_member(),catalog_upload_publication_group_v1();
DELETE FROM sync_extension_function_backup WHERE revision=78 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)';
