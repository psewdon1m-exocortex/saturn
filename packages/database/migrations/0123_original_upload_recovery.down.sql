SELECT pg_advisory_xact_lock(1397967206);
DO $rollback$ DECLARE item record;BEGIN
 IF EXISTS(SELECT 1 FROM public.catalog_upload_recovery_plans) THEN RAISE EXCEPTION 'recovery_evidence_requires_retention'; END IF;
 FOR item IN SELECT definition FROM public.sync_extension_function_backup WHERE revision=123 LOOP EXECUTE item.definition;END LOOP;
END $rollback$;
DROP TABLE catalog_upload_recovery_plans;
DROP FUNCTION catalog_upload_recover_original_v1(jsonb);
DROP FUNCTION guard_catalog_upload_recovery_plan();
DROP FUNCTION catalog_upload_recovery_statement_row(text,jsonb,jsonb);
DELETE FROM sync_extension_function_backup WHERE revision=123;
