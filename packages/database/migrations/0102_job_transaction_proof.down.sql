LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE row record; BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before transaction proof rollback'; END IF;
 IF (SELECT count(*) FROM sync_extension_function_backup WHERE revision=102)<>2 THEN RAISE EXCEPTION 'transaction proof backup missing'; END IF;
 FOR row IN SELECT definition FROM sync_extension_function_backup WHERE revision=102 LOOP EXECUTE row.definition; END LOOP;
END $$;
DROP FUNCTION catalog_upload_stored_transport(operation_journal);
DELETE FROM sync_extension_function_backup WHERE revision=102;
