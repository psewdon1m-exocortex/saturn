LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $restore$
DECLARE row record;
BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before private pipeline rollback'; END IF;
 IF EXISTS(SELECT sync_root_id FROM operation_journal WHERE sync_result IS NULL AND upload_execution_job IS NOT NULL GROUP BY sync_root_id HAVING count(DISTINCT upload_execution_job)>1) THEN RAISE EXCEPTION 'drain accepted pipeline before rollback'; END IF;
 IF (SELECT count(*) FROM sync_extension_function_backup WHERE revision=97)<>2 THEN RAISE EXCEPTION 'private pipeline predecessors missing'; END IF;
 FOR row IN SELECT definition FROM sync_extension_function_backup WHERE revision=97 LOOP EXECUTE row.definition; END LOOP;
END $restore$;
DROP FUNCTION catalog_upload_job_pipeline_v1();
DELETE FROM sync_extension_function_backup WHERE revision=97;
