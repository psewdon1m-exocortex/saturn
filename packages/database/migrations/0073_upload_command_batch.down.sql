DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM sync_backend_executor WHERE state<>'STOPPED') THEN RAISE EXCEPTION 'backend must be stopped before rollback'; END IF;
 EXECUTE (SELECT definition FROM sync_extension_function_backup WHERE revision=73 AND identity='catalog_upload_command(text,jsonb,jsonb,jsonb)');
END $$;
DELETE FROM sync_extension_function_backup WHERE revision=73;
