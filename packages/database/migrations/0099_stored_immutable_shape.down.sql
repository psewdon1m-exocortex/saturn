LOCK TABLE sync_backend_executor,catalog_guard_roots IN SHARE ROW EXCLUSIVE MODE;
DO $$ DECLARE row record; BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before shape rollback'; END IF;
 IF (SELECT count(*) FROM sync_extension_function_backup WHERE revision=99)<>5 THEN RAISE EXCEPTION 'stored shape backup missing'; END IF;
 FOR row IN SELECT definition FROM sync_extension_function_backup WHERE revision=99 LOOP EXECUTE row.definition; END LOOP;
END $$;
DROP FUNCTION sync_small_batch_known_shape(jsonb),catalog_upload_known_intent(text,jsonb);
DELETE FROM sync_extension_function_backup WHERE revision=99;
