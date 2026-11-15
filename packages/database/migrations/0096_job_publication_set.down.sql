LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $restore$
DECLARE saved record;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before job publication rollback'; END IF;
 IF EXISTS(SELECT 1 FROM catalog_upload_publication_groups WHERE cardinality(members)>4) THEN RAISE EXCEPTION 'retained job publication reader required'; END IF;
 FOR saved IN SELECT definition FROM sync_extension_function_backup WHERE revision=96 LOOP EXECUTE saved.definition; END LOOP;
END $restore$;
DROP TRIGGER catalog_upload_job_set_guard ON catalog_upload_publication_groups;
DROP FUNCTION guard_job_publication_set();
DROP FUNCTION catalog_upload_job_publication_v1();
ALTER TABLE catalog_upload_publication_groups DROP CONSTRAINT catalog_upload_publication_groups_members_check;
ALTER TABLE catalog_upload_publication_groups ADD CONSTRAINT catalog_upload_publication_groups_members_check CHECK(cardinality(members) BETWEEN 1 AND 4);
DELETE FROM sync_extension_function_backup WHERE revision=96;
