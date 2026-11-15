SELECT pg_advisory_xact_lock(1397967206);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM catalog_upload_recovery_plans WHERE state='APPLIED' AND result->>'schema'='saturn.original-upload-resume.v1') THEN RAISE EXCEPTION 'recovery_evidence_requires_retention'; END IF; END $$;
DO $$ DECLARE r record;BEGIN FOR r IN SELECT definition FROM sync_extension_function_backup WHERE revision=125 LOOP EXECUTE r.definition; END LOOP;END $$;
DROP FUNCTION catalog_upload_resume_unstarted_v1(jsonb);
DROP INDEX catalog_upload_one_applied_recovery;
CREATE UNIQUE INDEX catalog_upload_one_applied_recovery ON catalog_upload_recovery_plans(operation_id) WHERE state IN('APPLYING','APPLIED');
DELETE FROM sync_extension_function_backup WHERE revision=125;
